# LastSeen PWA

LastSeen is an ephemeral, mobile-first Progressive Web App for real-time group safety coordination.

It allows small groups to share their live location during crowded events, festivals, nightlife outings or family gatherings without installing a native app, creating an account, sharing a phone number or storing persistent personal data.

## Core principles

- No App Store or Play Store download
- No user accounts
- No email or phone number
- Ephemeral in-memory rooms
- Real-time WebSocket location sharing
- Privacy-first architecture
- Automatic room expiration
- Last known position retained while the room is alive

## Tech stack

- Backend: Go
- Real-time transport: WebSockets
- Persistence: in-memory only
- Frontend: Progressive Web App
- Maps: Leaflet + OpenStreetMap
- Deployment: HTTPS reverse proxy + containerized backend

## MVP scope

- Ephemeral rooms
- Temporary nicknames
- Live location sharing
- Up to 3 concurrent users per free room
- Last seen status after disconnect
- Mobile PWA installability
- Offline-first shell loading

## Premium roadmap

- Dynamic group geofencing
- Rescue compass mode
- Panic / wake-up command
- Emergency low-battery telemetry
