package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

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
		roomID, err := randomURLSafe(9)
		if err != nil {
			http.Error(w, "failed to create room", http.StatusInternalServerError)
			return
		}

		room := hub.CreateRoom(roomID)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"roomId":"` + room.ID + `","url":"/room/` + room.ID + `"}`))
	}
}

func websocketHandler(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		roomID := r.PathValue("roomID")
		nickname := strings.TrimSpace(r.URL.Query().Get("nick"))

		if roomID == "" {
			http.Error(w, "missing room id", http.StatusBadRequest)
			return
		}
		if nickname == "" {
			http.Error(w, "missing nickname", http.StatusBadRequest)
			return
		}
		if len(nickname) > 24 {
			http.Error(w, "nickname too long", http.StatusBadRequest)
			return
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

		client := realtime.NewClient(realtime.ClientConfig{ID: clientID, Nickname: nickname, Conn: conn})
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

func randomURLSafe(size int) (string, error) {
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
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
