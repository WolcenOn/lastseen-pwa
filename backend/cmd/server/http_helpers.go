package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func isAllowedOrigin(origin string) bool {
	origin = strings.TrimSpace(origin)
	if origin == "" {
		return true
	}

	allowed := strings.Split(os.Getenv("ALLOWED_ORIGINS"), ",")
	for _, item := range allowed {
		candidate := strings.TrimSpace(item)
		if candidate == "" {
			continue
		}
		if candidate == "*" || candidate == origin {
			return true
		}
	}

	return strings.HasPrefix(origin, "http://localhost:") || strings.HasPrefix(origin, "http://127.0.0.1:")
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if isAllowedOrigin(origin) {
			if origin != "" {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Creator-Token")
		}

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

func spaFileServer(staticPath string) http.HandlerFunc {
	files := http.FileServer(http.Dir(staticPath))

	return func(w http.ResponseWriter, r *http.Request) {
		path := filepath.Clean(r.URL.Path)
		if path == "." || path == string(filepath.Separator) {
			path = "index.html"
		}

		candidate := filepath.Join(staticPath, strings.TrimPrefix(path, "/"))
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			files.ServeHTTP(w, r)
			return
		}

		http.ServeFile(w, r, filepath.Join(staticPath, "index.html"))
	}
}
