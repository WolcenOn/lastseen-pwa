package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/WolcenOn/lastseen-pwa/backend/internal/realtime"
	"github.com/gorilla/websocket"
)

const (
	defaultAddr       = ":8080"
	defaultStaticDir  = "../web"
	defaultRoomTTL    = 3 * time.Hour
	defaultMaxFree    = 3
	shutdownTimeout   = 10 * time.Second
	readHeaderTimeout = 5 * time.Second
	backendVersion    = "2026-07-16-railway-cache-bust"
)

var (
	pinPattern      = regexp.MustCompile(`^\d{4,8}$`)
	clientIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{6,48}$`)
	avatarSet       = []string{"🦊", "🐼", "🐨", "🐯", "🦁", "🐸", "🐵", "🐧", "🦉", "🐝", "🦄", "🐙", "🐢", "🐳", "⭐", "⚡"}
	adjectives      = []string{"Luna", "Brava", "Azul", "Fugaz", "Clara", "Norte", "Libre", "Chispa", "Aurora", "Rayo", "Menta", "Nube"}
	nouns           = []string{"Cuadrilla", "Cometa", "Farol", "Brújula", "Verbena", "Peña", "Ronda", "Refugio", "Mapa", "Equipo", "Punto", "Nido"}
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		return origin == "" || isAllowedOrigin(origin)
	},
}

type createRoomRequest struct {
	Name       string `json:"name"`
	TTLMinutes int    `json:"ttlMinutes"`
}

type updateRoomRequest struct {
	CreatorToken string `json:"creatorToken"`
	TTLMinutes   int    `json:"ttlMinutes"`
}

func main() {
	addr := resolveAddr()
	staticDir := env("STATIC_DIR", defaultStaticDir)

	hub := realtime.NewHub(realtime.HubConfig{
		RoomTTL:          defaultRoomTTL,
		MaxFreeClients:   defaultMaxFree,
		CleanupInterval:  time.Minute,
		ClientWriteWait:  8 * time.Second,
		ClientPongWait:   60 * time.Second,
		ClientPingPeriod: 45 * time.Second,
	})

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go hub.Run(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", healthHandler)
	mux.HandleFunc("POST /api/rooms", createRoomHandler(hub))
	mux.HandleFunc("GET /api/rooms/{roomID}", roomInfoHandler(hub))
	mux.HandleFunc("PATCH /api/rooms/{roomID}", updateRoomHandler(hub))
	mux.HandleFunc("DELETE /api/rooms/{roomID}", deleteRoomHandler(hub))
	mux.HandleFunc("GET /ws/rooms/{roomID}", websocketHandler(hub))

	staticPath, err := filepath.Abs(staticDir)
	if err != nil {
		log.Fatalf("invalid static dir: %v", err)
	}
	mux.HandleFunc("/", spaFileServer(staticPath))

	server := &http.Server{
		Addr:              addr,
		Handler:           securityHeaders(corsMiddleware(mux)),
		ReadHeaderTimeout: readHeaderTimeout,
	}

	go func() {
		log.Printf("lastseen server listening on %s", addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server error: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("shutdown requested")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()

	hub.CloseAll()
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("server shutdown error: %v", err)
	}
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-LastSeen-Version", backendVersion)
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"version": backendVersion,
		"features": map[string]bool{
			"creatorToken":        true,
			"participantSnapshot": true,
		},
	})
}

func createRoomHandler(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var payload createRoomRequest
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&payload)
		}

		roomID, err := randomURLSafe(9)
		if err != nil {
			http.Error(w, "failed to create room", http.StatusInternalServerError)
			return
		}
		creatorToken, err := randomURLSafe(24)
		if err != nil {
			http.Error(w, "failed to create room", http.StatusInternalServerError)
			return
		}

		roomName := sanitizeRoomName(payload.Name)
		if roomName == "" {
			roomName = randomRoomName()
		}

		ttl := ttlFromMinutes(payload.TTLMinutes, defaultRoomTTL)
		room := hub.CreateRoom(roomID, roomName, creatorToken, ttl)

		writeJSON(w, http.StatusCreated, map[string]any{
			"roomId":       room.ID,
			"name":         room.Name,
			"url":          "/room/" + room.ID,
			"creatorToken": creatorToken,
			"ttl":          int64(ttl.Seconds()),
		})
	}
}

func roomInfoHandler(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		roomID := r.PathValue("roomID")
		if roomID == "" {
			http.Error(w, "missing room id", http.StatusBadRequest)
			return
		}

		room, ok := hub.RoomInfo(roomID)
		if !ok {
			http.Error(w, "room not found", http.StatusNotFound)
			return
		}

		writeJSON(w, http.StatusOK, room)
	}
}

func updateRoomHandler(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var payload updateRoomRequest
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&payload)
		}
		if payload.CreatorToken == "" {
			payload.CreatorToken = r.Header.Get("X-Creator-Token")
		}

		public, err := hub.UpdateRoomTTL(r.PathValue("roomID"), payload.CreatorToken, ttlFromMinutes(payload.TTLMinutes, defaultRoomTTL))
		writeRoomAdminResult(w, public, err)
	}
}

func deleteRoomHandler(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		creatorToken := r.Header.Get("X-Creator-Token")
		if creatorToken == "" && r.Body != nil {
			var payload updateRoomRequest
			_ = json.NewDecoder(r.Body).Decode(&payload)
			creatorToken = payload.CreatorToken
		}

		public, err := hub.EndRoom(r.PathValue("roomID"), creatorToken)
		writeRoomAdminResult(w, public, err)
	}
}

func websocketHandler(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		roomID := r.PathValue("roomID")
		nickname := sanitizeNickname(r.URL.Query().Get("nick"))
		pin := strings.TrimSpace(r.URL.Query().Get("pin"))
		avatar := sanitizeAvatar(r.URL.Query().Get("avatar"))
		clientID := sanitizeClientID(r.URL.Query().Get("id"))

		if roomID == "" {
			http.Error(w, "missing room id", http.StatusBadRequest)
			return
		}
		if nickname == "" {
			http.Error(w, "missing nickname", http.StatusBadRequest)
			return
		}
		if !pinPattern.MatchString(pin) {
			http.Error(w, "invalid pin", http.StatusBadRequest)
			return
		}
		if avatar == "" {
			avatar = avatarSet[0]
		}
		if clientID == "" {
			var err error
			clientID, err = randomURLSafe(9)
			if err != nil {
				http.Error(w, "failed to create client", http.StatusInternalServerError)
				return
			}
		}

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("websocket upgrade error: %v", err)
			return
		}

		sessionID, err := randomURLSafe(9)
		if err != nil {
			_ = conn.Close()
			return
		}

		client := realtime.NewClient(realtime.ClientConfig{
			ID:        clientID,
			SessionID: sessionID,
			Nickname:  nickname,
			PIN:       pin,
			Avatar:    avatar,
			Conn:      conn,
		})
		if err := hub.JoinRoom(roomID, client); err != nil {
			_ = conn.WriteJSON(joinErrorMessage(err))
			_ = conn.Close()
			return
		}

		go client.WritePump(hub)
		go client.ReadPump(hub, roomID)
	}
}

func joinErrorMessage(err error) realtime.OutboundMessage {
	if errors.Is(err, realtime.ErrNicknameTaken) {
		return realtime.OutboundMessage{Type: "error", Data: map[string]string{"code": "nickname_taken", "message": "Ese mote ya está en uso en esta sala. Elige otro."}}
	}
	return realtime.OutboundMessage{Type: "error", Data: map[string]string{"code": "join_failed", "message": err.Error()}}
}

func writeRoomAdminResult(w http.ResponseWriter, public realtime.PublicRoom, err error) {
	if err == nil {
		writeJSON(w, http.StatusOK, public)
		return
	}

	switch {
	case errors.Is(err, realtime.ErrRoomNotFound):
		http.Error(w, "room not found", http.StatusNotFound)
	case errors.Is(err, realtime.ErrForbidden):
		http.Error(w, "invalid creator token", http.StatusForbidden)
	case errors.Is(err, realtime.ErrRoomClosed):
		http.Error(w, "room is closed or ttl is invalid", http.StatusBadRequest)
	default:
		http.Error(w, "room update failed", http.StatusInternalServerError)
	}
}

func resolveAddr() string {
	port := strings.TrimSpace(os.Getenv("PORT"))
	if port != "" {
		return ":" + strings.TrimPrefix(port, ":")
	}
	return env("ADDR", defaultAddr)
}

func env(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func randomRoomName() string {
	left := adjectives[randomIndex(len(adjectives))]
	right := nouns[randomIndex(len(nouns))]
	return left + " " + right
}

func randomIndex(max int) int {
	if max <= 1 {
		return 0
	}

	buf := make([]byte, 1)
	if _, err := rand.Read(buf); err != nil {
		return 0
	}

	return int(buf[0]) % max
}

func sanitizeRoomName(value string) string {
	value = strings.Join(strings.Fields(strings.TrimSpace(value)), " ")
	if utf8.RuneCountInString(value) > 36 {
		return string([]rune(value)[:36])
	}
	return value
}

func sanitizeNickname(value string) string {
	value = strings.Join(strings.Fields(strings.TrimSpace(value)), " ")
	if utf8.RuneCountInString(value) > 24 {
		return string([]rune(value)[:24])
	}
	return value
}

func sanitizeAvatar(value string) string {
	value = strings.TrimSpace(value)
	for _, allowed := range avatarSet {
		if value == allowed {
			return value
		}
	}
	return ""
}

func sanitizeClientID(value string) string {
	value = strings.TrimSpace(value)
	if clientIDPattern.MatchString(value) {
		return value
	}
	return ""
}

func ttlFromMinutes(minutes int, fallback time.Duration) time.Duration {
	if minutes <= 0 {
		return fallback
	}
	ttl := time.Duration(minutes) * time.Minute
	if ttl < realtime.MinRoomTTL {
		return realtime.MinRoomTTL
	}
	if ttl > realtime.MaxRoomTTL {
		return realtime.MaxRoomTTL
	}
	return ttl
}

func randomURLSafe(size int) (string, error) {
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
