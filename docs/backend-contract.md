# LastSeen backend client contract

This document defines the backend contract that every LastSeen client should use.

The goal is to keep product behaviour in the backend so that the current PWA and future native clients, including Android/Kotlin, can interoperate without duplicating business rules in each frontend.

## Versions

- Backend version: exposed by `GET /api/health` as `version`.
- Protocol version: exposed as `protocolVersion`.
- Current protocol: `lastseen-v2`.

## Health

```http
GET /api/health
```

Response:

```json
{
  "status": "ok",
  "version": "2026-07-16-railway-cache-bust",
  "protocolVersion": "lastseen-v2",
  "features": {
    "creatorToken": true,
    "participantSnapshot": true,
    "joinContract": true,
    "nativeClients": true,
    "wsToken": true
  }
}
```

## Create room

```http
POST /api/rooms
Content-Type: application/json
```

Request:

```json
{
  "name": "Mantenimiento zona norte",
  "ttlMinutes": 180
}
```

Response:

```json
{
  "roomId": "abc123",
  "name": "Mantenimiento zona norte",
  "url": "/room/abc123",
  "creatorToken": "creator-secret",
  "ttl": 10800
}
```

## Read room

```http
GET /api/rooms/{roomID}
```

Response is a public room state. It includes TTL, closure status and safety configuration.

## Join contract

Native clients should call this endpoint before opening the WebSocket.

```http
POST /api/rooms/{roomID}/join
Content-Type: application/json
```

Request:

```json
{
  "nickname": "Virginia",
  "pin": "1234",
  "avatar": "🦊",
  "clientId": "stable-client-id"
}
```

`clientId` is optional. If it is missing or invalid, the backend returns a valid generated client id.

Response:

```json
{
  "room": {
    "id": "abc123",
    "name": "Mantenimiento zona norte",
    "ttl": 10800,
    "expiresIn": 10420,
    "maxFree": 3,
    "closed": false,
    "safety": {}
  },
  "client": {
    "id": "stable-client-id",
    "nickname": "Virginia",
    "avatar": "🦊"
  },
  "wsUrl": "wss://example.com/ws/rooms/abc123?token=short-lived-token",
  "wsToken": "short-lived-token",
  "tokenExpiresIn": 119,
  "protocolVersion": "lastseen-v2",
  "features": {
    "backgroundNativeTracking": true,
    "foregroundPWA": true,
    "safetyEvents": true,
    "wsToken": true
  }
}
```

The join endpoint is a preflight contract. It validates the current room and nickname rules, then issues a short-lived single-use WebSocket token. The WebSocket join remains the final source of truth because another client could join between the preflight response and the socket connection.

Common error responses:

- `400 missing nickname`
- `400 invalid pin`
- `404 room not found`
- `409 nickname_taken`
- `410 room_closed`
- `429 room_full`

## WebSocket join

Recommended native-client connection:

```http
GET /ws/rooms/{roomID}?token={wsToken}
```

The token is short-lived, single-use, and scoped to the room. It carries the sanitized join identity prepared by `POST /api/rooms/{roomID}/join`.

Existing PWA-compatible connection remains supported during migration:

```http
GET /ws/rooms/{roomID}?nick={nickname}&pin={pin}&avatar={avatar}&id={clientId}
```

The backend sends a `snapshot` immediately after a successful join.

## WebSocket inbound messages

### Location

```json
{ "t": "loc", "lat": 37.2501, "lng": -6.9501, "bat": 0.82 }
```

### SOS

```json
{ "t": "sos", "lat": 37.2501, "lng": -6.9501, "bat": 0.02 }
```

### Meeting point

```json
{ "t": "meet", "lat": 37.2501, "lng": -6.9501 }
```

### Perimeter

```json
{ "t": "perimeter", "lat": 37.2501, "lng": -6.9501, "radius": 250 }
```

### Wake participant

```json
{ "t": "wake", "targetId": "client-id" }
```

### Panic event

```json
{ "t": "panic" }
```

### Self disconnect

```json
{ "t": "disconnect", "pin": "1234" }
```

## WebSocket outbound messages

The server can emit:

- `snapshot`
- `join`
- `leave`
- `loc`
- `sos`
- `meet`
- `perimeter`
- `wake`
- `panic`
- `room`
- `room-ended`
- `error`

## Android/Kotlin client expectations

A native client should:

1. Store a stable `clientId` per room/device.
2. Call `POST /api/rooms/{roomID}/join`.
3. Open the returned `wsUrl` with the short-lived `token`.
4. Start a foreground location service only after user consent.
5. Keep a persistent notification while sharing location.
6. Send `loc` messages from the service.
7. Reconnect WebSocket when coverage returns by requesting a fresh join token.
8. Re-send the latest known location after reconnect.
9. Stop tracking when the user leaves the room or the operation ends.

## Current security note

`lastseen-v2` supports token-based WebSocket joins for native clients and keeps the old query-parameter join path only for PWA compatibility during migration.

A production Android release should use only:

```http
POST /api/rooms/{roomID}/join
→ { "wsToken": "short-lived-token", "wsUrl": "wss://.../ws/rooms/{roomID}?token=..." }

GET /ws/rooms/{roomID}?token={wsToken}
```
