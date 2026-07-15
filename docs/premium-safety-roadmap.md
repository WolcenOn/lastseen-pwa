# Premium safety roadmap

This document captures the safety features introduced by the map MVP and the natural premium path.

## Included in the MVP

- Live Leaflet map in the room screen.
- Member markers using each user's temporary avatar.
- Shared meeting point, broadcast through WebSocket and included in room snapshots.
- Shared perimeter with radius in meters, stored only in RAM.
- Server-side geofence check on each location update.
- Local inactivity review based on each member's last signal timestamp.

## Premium-ready features

These are intentionally prepared as product hooks but not monetized yet.

### Safety perimeter

Free tier can expose a simple shared perimeter for testing. Premium can later unlock:

- Multiple named perimeters.
- Larger radius values.
- Per-user perimeter history during the room lifetime.
- Admin-only perimeter changes through a creator token.

### Inactivity alerts

Current MVP performs local manual inactivity checks in the browser. Premium can later unlock:

- Automatic alerts.
- Configurable thresholds.
- Escalation to wake/panic flows.
- Creator/admin summary panel.

### Meeting point and rescue mode

Current MVP shares one meeting point. Premium can later unlock:

- Multiple meeting points.
- Compass-to-meeting-point.
- Last known path snippets.
- Emergency contact handoff.

## Privacy boundary

All safety state remains ephemeral and room-scoped. No user accounts, no long-lived location database, and no persistent tracking should be introduced without an explicit product/security review.
