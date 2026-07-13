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
)

var (
	pinPattern = regexp.MustCompile(`^\d{4,8}$`)
	avatarSet  = []string{"🦊", "🐼", "🐨", "🐯", "🦁", "🐸", "🐵", "🐧", "🦉", "🐝", "🦄", "🐙", "🐢", "🐳", "⭐", "⚡"}
	adjectives = []string{"Luna", "Brava", "Azul", "Fugaz", "Clara", "Norte", "Libre", "Chispa", "Aurora", "Rayo", "Menta", "Nube"}
	nouns      = []string{"Cuadrilla", "Cometa", "Farol", "Brújula", "Verbena", "Peña", "Ronda", "Refugio", "Mapa", "Equipo", "Punto", "Nido"}
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}

		// MVP local allowlist. Harden with ALLOWED_ORIGINS before public deployment.
		return strings.HasPrefix(origin, "http://localhost") ||
			strings.HasPrefix(origin, "https://localhost") ||
			strings.HasPrefix(origin, "http://127.0.0.1")
	},
}

type createRoomRequest struct {
	Name string `json:"name"`
}

func main() {
	addr := env("ADDR", defaultAddr)
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
	mux.HandleFunc("POST /api/rooms", createRoomHandler(hub))
	mux.HandleFunc("GET /api/rooms/{roomID}", roomInfoHandler(hub))
	mux.HandleFunc("GET /ws/rooms/{roomID}", websocketHandler(hub))

	staticPath, err := filepath.Abs(staticDir)
	if err != nil {
		log.Fatalf("invalid static dir: %v", err)
	}
	mux.HandleFunc("/", spaFileServer(staticPath))

	server := &http.Server{
		Addr:              addr,
		Handler:           securityHeaders(mux),
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

		roomName := sanitizeRoomName(payload.Name)
		if roomName == "" {
			roomName = randomRoomName()
		}

		room := hub.CreateRoom(roomID, roomName)

		writeJSON(w, http.StatusCreated, map[string]any{
			"roomId": room.ID,
			"name":   room.Name,
			"url":    "/room/" + room.ID,
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

func websocketHandler(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		roomID := r.PathValue("roomID")
		nickname := sanitizeNickname(r.URL.Query().Get("nick"))
		pin := strings.TrimSpace(r.URL.Query().Get("pin"))
		avatar := sanitizeAvatar(r.URL.Query().Get("avatar"))

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

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("websocket upgrade error: %v", err)
			return
		}

		clientID, err := randomURLSafe(6)
		if err != nil {
			_ = conn.Close()
			return
		}

		client := realtime.NewClient(realtime.ClientConfig{
			ID:       clientID,
			Nickname: nickname,
			PIN:      pin,
			Avatar:   avatar,
			Conn:     conn,
		})
		if err := hub.JoinRoom(roomID, client); err != nil {
			_ = conn.WriteJSON(realtime.OutboundMessage{Type: "error", Data: map[string]string{"message": err.Error()}})
			_ = conn.Close()
			return
		}

		go client.WritePump(hub)
		go client.ReadPump(hub, roomID)
	}
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

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "geolocation=(self), camera=(), microphone=(), payment=()")
		next.ServeHTTP(w, r)
	})
}

func spaFileServer(staticDir string) http.HandlerFunc {
	fs := http.FileServer(http.Dir(staticDir))

	return func(w http.ResponseWriter, r *http.Request) {
		path := filepath.Join(staticDir, filepath.Clean(r.URL.Path))
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			fs.ServeHTTP(w, r)
			return
		}

		if strings.HasPrefix(r.URL.Path, "/room/") {
			http.ServeFile(w, r, filepath.Join(staticDir, "room.html"))
			return
		}

		http.ServeFile(w, r, filepath.Join(staticDir, "index.html"))
	}
}
