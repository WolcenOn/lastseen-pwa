package config

import (
	"os"
	"strings"
)

type Config struct {
	Addr           string
	StaticDir      string
	AllowedOrigins string
}

func Load() Config {
	return Config{
		Addr:           resolveAddr(),
		StaticDir:      strings.TrimSpace(os.Getenv("STATIC_DIR")),
		AllowedOrigins: strings.TrimSpace(os.Getenv("ALLOWED_ORIGINS")),
	}
}

func resolveAddr() string {
	port := strings.TrimSpace(os.Getenv("PORT"))
	if port != "" {
		return ":" + port
	}

	addr := strings.TrimSpace(os.Getenv("ADDR"))
	if addr != "" {
		return addr
	}

	return ":8080"
}
