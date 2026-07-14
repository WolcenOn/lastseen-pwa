# Railway setup checklist

## 1. Create service

- Railway → New Project
- Deploy from GitHub repo
- Select `WolcenOn/lastseen-pwa`
- Set service root directory to `/backend`

## 2. Environment variables

Add:

```txt
ALLOWED_ORIGINS=https://wolcenon.github.io,http://localhost:8080,http://127.0.0.1:8080
STATIC_DIR=
```

Do not add `PORT`; Railway provides it.

## 3. Public domain

- Open the Railway service settings
- Generate public domain
- Copy the HTTPS URL

## 4. Health check

Open:

```txt
https://YOUR-RAILWAY-DOMAIN/api/health
```

Expected response:

```json
{"status":"ok"}
```

## 5. GitHub Pages variable

GitHub repo → Settings → Secrets and variables → Actions → Variables → New repository variable:

```txt
LASTSEEN_API_BASE_URL=https://YOUR-RAILWAY-DOMAIN
```

## 6. Deploy Pages

Run the `Deploy PWA to GitHub Pages` workflow manually or merge to `main` after enabling GitHub Pages with GitHub Actions as source.
