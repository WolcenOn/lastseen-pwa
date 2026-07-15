# Session persistence, local history and Railway cost controls

## Goals

This iteration keeps LastSeen privacy-first while fixing accidental refresh/reload behavior:

- Reuse the same local participant identity after refresh.
- Avoid duplicate map users when the same browser reconnects.
- Store recent room/member safety history only in the user's browser.
- Give the room creator limited ephemeral controls.
- Reduce WebSocket traffic sent to Railway.

## Local-only browser storage

Each room stores a local record under:

```txt
lastseen:<roomId>:state
```

The record may include:

- `roomId`
- `clientId`
- `nickname`
- `avatar`
- `pin`
- `isCreator`
- `creatorToken`
- `lastJoinedAt`
- `membersHistory`
- `safety`

This is intentionally stored in `localStorage`, not in the backend. The backend remains RAM-only and does not persist location history.

## Stable client IDs

On first join, the browser creates a stable `clientId` for that room. Future WebSocket joins include it as:

```txt
/ws/rooms/<roomId>?id=<clientId>&nick=...&pin=...&avatar=...
```

If the same `clientId` reconnects, the server replaces the previous connection instead of creating another participant. A separate server-side `sessionId` prevents an old WebSocket close event from marking the new session offline.

## Creator controls

When a room is created, the backend returns a `creatorToken`. Only the creator's browser stores it. The token enables:

- Updating room duration.
- Ending the room manually.

The token is not put in shared links.

## Cost controls

The frontend throttles location sends:

- Send immediately on join.
- Then send only if enough time has passed.
- Or if the device moved enough meters.

Current defaults:

```txt
MIN_LOCATION_INTERVAL_MS = 12000
MIN_LOCATION_DISTANCE_M = 10
```

This reduces Railway WebSocket traffic and CPU use while preserving useful live tracking for event coordination.

## Future premium path

This structure prepares:

- Longer room duration.
- Larger groups.
- Multiple perimeters.
- Automatic inactivity alerts.
- Creator/admin moderation.
- Exportable local safety report generated on-device.
