# Deployment: Railway backend + GitHub Pages frontend

This project supports two modes:

1. Local development: Go serves the backend API, WebSocket endpoint and static PWA from one origin.
2. Public testing: GitHub Pages serves the PWA and Railway runs the Go backend.

## Railway service

Create a new Railway project from this GitHub repository and configure the service root as:

```txt
/backend
```

Recommended Railway variables:

```txt
ALLOWED_ORIGINS=https://wolcenon.github.io,http://localhost:8080,http://127.0.0.1:8080
STATIC_DIR=
```

Do not set `PORT` manually. Railway provides it at runtime.

After the first deploy, generate a public Railway domain and copy its HTTPS URL.

Example:

```txt
https://lastseen-pwa-production.up.railway.app
```

## GitHub Pages

Set this repository variable in GitHub:

```txt
LASTSEEN_API_BASE_URL=https://YOUR-RAILWAY-DOMAIN.up.railway.app
```

Then enable GitHub Pages using GitHub Actions as the source.

You can also run the workflow manually and provide `api_base_url`.

## Runtime checks

Backend health:

```txt
https://YOUR-RAILWAY-DOMAIN.up.railway.app/api/health
```

PWA URL:

```txt
https://wolcenon.github.io/lastseen-pwa/
```

Room links will look like:

```txt
https://wolcenon.github.io/lastseen-pwa/room/{roomID}
```

The PWA will call Railway for REST and WebSocket traffic.
