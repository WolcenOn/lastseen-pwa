package httpx

import (
	"net/http"
	"strings"
)

type OriginPolicy struct {
	allowed map[string]struct{}
}

func NewOriginPolicy(raw string) OriginPolicy {
	allowed := make(map[string]struct{})
	for _, item := range strings.Split(raw, ",") {
		origin := strings.TrimSpace(item)
		if origin == "" {
			continue
		}
		allowed[origin] = struct{}{}
	}

	return OriginPolicy{allowed: allowed}
}

func (p OriginPolicy) Allows(origin string) bool {
	origin = strings.TrimSpace(origin)
	if origin == "" {
		return true
	}

	if _, ok := p.allowed[origin]; ok {
		return true
	}

	return strings.HasPrefix(origin, "http://localhost") ||
		strings.HasPrefix(origin, "http://127.0.0.1") ||
		strings.HasPrefix(origin, "https://localhost")
}

func CORS(policy OriginPolicy, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if policy.Allows(origin) && origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		}

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}
