# LastSeen Android/Kotlin client plan

This document defines the coordinated plan for adding an Android/Kotlin client to LastSeen while keeping the Go backend as the source of truth and the current PWA stable.

## Product split

LastSeen should evolve as a multi-client system:

```text
Go backend
  ├── PWA client
  └── Android/Kotlin client
```

### Backend responsibilities

The backend owns product rules and shared state:

- room lifecycle
- stable `clientId` identity
- nickname uniqueness
- short-lived WebSocket join tokens
- roles and capabilities
- room safety state
- meeting point
- perimeter/geofence state
- real-time participant snapshot
- authorization for sensitive actions

### PWA responsibilities

The PWA remains the lightweight coordination client:

- create rooms
- join by link
- share links
- view the live map
- draw meeting points and perimeters when authorized
- show participant status
- show geofence alerts
- manage room duration/end as creator

The PWA should not be expected to provide reliable location while closed or deeply backgrounded.

### Android responsibilities

The Android client should solve the native problem the PWA cannot solve reliably:

- foreground service for continuous location sharing
- persistent notification while sharing
- reconnection after coverage loss
- fresh `POST /join` on reconnect to obtain a new `wsToken`
- re-send the latest known location after reconnect
- stop sharing when the user leaves the room or the room ends

The first Android MVP should not duplicate the full PWA map experience.

## Android MVP scope

The first Android version should be an emitter client, not a full command dashboard.

### In scope

- enter backend URL or use the production default
- paste room URL or enter room ID
- enter nickname
- enter PIN
- choose a basic avatar or use a default
- call `POST /api/rooms/{roomID}/join`
- read `role` and `capabilities`
- open returned `wsUrl`
- request foreground and background-capable location permissions as required by Android
- start a foreground service
- send `loc` messages through WebSocket
- display connected/disconnected state
- display current room role
- display whether the room ended
- allow manual stop/leave

### Out of scope for first MVP

- full map rendering
- room creation
- room TTL management
- drawing perimeters
- drawing meeting points
- account system
- payments
- organization/team management
- historical reports
- offline persistence beyond latest known location

## Backend contract used by Android

Android must use the backend contract documented in `docs/backend-contract.md`.

### Join flow

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
  "clientId": "stable-device-room-id"
}
```

Response fields Android must read:

```json
{
  "client": {
    "id": "stable-device-room-id",
    "nickname": "Virginia",
    "avatar": "🦊"
  },
  "wsUrl": "wss://example.com/ws/rooms/abc123?token=short-lived-token",
  "wsToken": "short-lived-token",
  "tokenExpiresIn": 119,
  "protocolVersion": "lastseen-v2",
  "role": "participant",
  "capabilities": {
    "canShareLocation": true,
    "canSendSOS": true,
    "canSendPanic": true,
    "canWakeParticipants": true,
    "canSetMeetingPoint": false,
    "canSetPerimeter": false,
    "canUpdateTTL": false,
    "canEndRoom": false
  }
}
```

Android must open exactly the returned `wsUrl`. Tokens are short-lived and single-use.

### Location message

```json
{ "t": "loc", "lat": 37.2501, "lng": -6.9501, "bat": 0.82 }
```

Rules:

- `lat` and `lng` must be valid coordinates.
- `bat` must be between `0` and `1`.
- Android should send a location immediately after WebSocket open if it already has a recent fix.
- Android should throttle updates to avoid battery drain.

Recommended first defaults:

```text
Minimum interval: 10-15 seconds
Minimum distance: 10 meters
High accuracy: enabled while actively sharing
```

### Stop/leave message

```json
{ "t": "disconnect", "pin": "1234" }
```

Android should send this before stopping the service when the user explicitly leaves.

### Server messages Android should handle

Minimum required:

- `snapshot`
- `loc`
- `leave`
- `room-ended`
- `error`

Useful later:

- `meet`
- `perimeter`
- `wake`
- `panic`
- `sos`
- `room`

For the MVP, Android only needs enough handling to keep its connection state correct and stop when the room ends.

## Native Android permissions

The exact Android permission handling should be implemented carefully and tested on recent Android versions.

Expected permissions:

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

Implementation notes:

- Request foreground location first.
- Explain clearly why location sharing is needed.
- Start continuous sharing only after explicit user action.
- Keep a persistent notification while sharing.
- Do not track outside an active room session.
- Stop the foreground service when the user leaves or the room ends.

## Foreground service model

Recommended components:

```text
MainActivity
  - join form
  - permission flow
  - status display
  - start/stop buttons

LastSeenForegroundService
  - owns active tracking session
  - owns FusedLocationProviderClient
  - owns WebSocket connection
  - owns reconnect loop
  - owns persistent notification

LastSeenApiClient
  - POST /join
  - error parsing

LastSeenWebSocketClient
  - open wsUrl
  - send loc/disconnect
  - handle room-ended/error

LastSeenSessionStore
  - roomId
  - clientId per room
  - nickname
  - pin only while active if possible
  - backend URL
```

## Reconnection strategy

Android must not reuse old WebSocket tokens.

On disconnect:

1. Keep foreground service alive if the user has not stopped sharing.
2. Wait using exponential backoff.
3. Call `POST /join` again.
4. Open the new `wsUrl`.
5. Send the latest known location immediately after open.

Recommended MVP backoff:

```text
1s, 2s, 5s, 10s, 20s, max 30s
```

The service should show the current connection state in the notification:

- sharing location
- reconnecting
- stopped
- room ended
- permission required

## Privacy and consent

Android must make the tracking state obvious.

Requirements:

- no hidden tracking
- explicit start button
- explicit stop button
- persistent notification during sharing
- clear wording that location is shared only inside the active room
- no account required for MVP
- no server-side historical storage in the current backend model
- no tracking after room end

Suggested user-facing wording:

```text
LastSeen está compartiendo tu ubicación con esta sala.
Toca para volver o detener el seguimiento.
```

## Suggested repository structure

The first implementation can live in the same repository:

```text
android/
  settings.gradle.kts
  build.gradle.kts
  app/
    build.gradle.kts
    src/main/AndroidManifest.xml
    src/main/java/com/lastseen/tracker/MainActivity.kt
    src/main/java/com/lastseen/tracker/LastSeenForegroundService.kt
    src/main/java/com/lastseen/tracker/LastSeenApiClient.kt
    src/main/java/com/lastseen/tracker/LastSeenWebSocketClient.kt
    src/main/java/com/lastseen/tracker/LastSeenSessionStore.kt
```

Keeping Android in the same repo helps coordinate backend contract changes during the MVP phase. The Android app can be split into a separate repository later if needed.

## Implementation phases

### Phase 0: Backend and PWA readiness

Current status:

- `lastseen-v2` join contract exists.
- `wsToken` exists.
- roles and capabilities exist.
- backend enforces safety permissions.
- PWA reads capabilities visually.
- geofence alerts update in real time.

### Phase 1: Android skeleton

Create Gradle project under `android/` with:

- minimal app module
- MainActivity
- manifest permissions
- basic UI
- no background tracking yet

### Phase 2: Join contract client

Implement:

- room URL parsing
- stable `clientId` per room
- `POST /join`
- response parsing
- role/capability display

### Phase 3: WebSocket foreground session

Implement:

- open returned `wsUrl`
- send first `loc`
- keep connection alive
- handle `room-ended`
- send `disconnect` on stop

### Phase 4: Foreground location service

Implement:

- FusedLocationProviderClient
- foreground service notification
- throttled location updates
- reconnect after network loss

### Phase 5: Field testing

Test scenarios:

- screen on
- screen locked
- app backgrounded
- Wi-Fi to mobile data handoff
- no coverage then restored coverage
- room ended from PWA
- participant outside perimeter
- battery drain over 30-60 minutes

### Phase 6: Optional Android viewer features

Only after the emitter is stable:

- simple participant list
- current room safety summary
- current perimeter status
- SOS button
- panic button
- basic map view

## Kotlin start criteria

Start implementing `android/` when the following are true:

- backend CI passes
- PWA join still works for creator and participant
- creator can draw perimeter/meeting point
- participant can see but not modify safety controls
- room-ended still closes clients correctly
- `docs/backend-contract.md` and this document agree on the join contract

At that point, Android development should begin with Phase 1 and avoid adding product features not listed in the MVP scope.