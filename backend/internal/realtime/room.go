package realtime

import (
	"strings"
	"sync"
	"time"
)

const (
	MinRoomTTL = 15 * time.Minute
	MaxRoomTTL = 24 * time.Hour
)

type RoomConfig struct {
	ID             string
	Name           string
	CreatorToken   string
	TTL            time.Duration
	MaxFreeClients int
}

type Room struct {
	mu sync.RWMutex

	ID             string
	Name           string
	CreatorToken   string
	TTL            time.Duration
	MaxFreeClients int
	Closed         bool

	CreatedAt      time.Time
	LastActivityAt time.Time

	clients map[string]*Client
	safety  PublicSafety
}

func NewRoom(config RoomConfig) *Room {
	now := time.Now().UTC()

	if config.TTL < MinRoomTTL {
		config.TTL = MinRoomTTL
	}
	if config.TTL > MaxRoomTTL {
		config.TTL = MaxRoomTTL
	}

	return &Room{
		ID:             config.ID,
		Name:           config.Name,
		CreatorToken:   config.CreatorToken,
		TTL:            config.TTL,
		MaxFreeClients: config.MaxFreeClients,
		CreatedAt:      now,
		LastActivityAt: now,
		clients:        make(map[string]*Client),
	}
}

func (r *Room) Public(now time.Time) PublicRoom {
	r.mu.RLock()
	defer r.mu.RUnlock()

	remaining := r.remainingLocked(now)

	return PublicRoom{
		ID:        r.ID,
		Name:      r.Name,
		CreatedAt: r.CreatedAt,
		ExpiresIn: int64(remaining.Seconds()),
		TTL:       int64(r.TTL.Seconds()),
		MaxFree:   r.MaxFreeClients,
		Closed:    r.Closed,
		Safety:    cloneSafety(r.safety),
	}
}

func (r *Room) AddClient(client *Client) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.Closed || r.remainingLocked(time.Now().UTC()) <= 0 {
		return ErrRoomClosed
	}

	activeCount := 0
	for id, c := range r.clients {
		if id == client.ID {
			continue
		}
		if c.Connected {
			activeCount++
		}
	}

	if _, reconnecting := r.clients[client.ID]; !reconnecting && activeCount >= r.MaxFreeClients {
		return ErrRoomFull
	}

	if previous, ok := r.clients[client.ID]; ok {
		client.Lat = previous.Lat
		client.Lng = previous.Lng
		client.BatteryLevel = previous.BatteryLevel
		client.GeofenceAlert = previous.GeofenceAlert
		client.SOS = previous.SOS
		if !previous.LastSeen.IsZero() {
			client.LastSeen = previous.LastSeen
		}
		previous.Close()
	}

	client.Connected = true
	client.LastSeen = time.Now().UTC()
	r.clients[client.ID] = client
	r.touchLocked()

	return nil
}

func (r *Room) MarkDisconnected(clientID string, sessionID string) (*Client, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	client, ok := r.clients[clientID]
	if !ok || client.SessionID != sessionID {
		return nil, false
	}

	client.Connected = false
	client.LastSeen = time.Now().UTC()
	client.CloseSend()
	r.touchLocked()

	return client.Clone(), true
}

func (r *Room) ForceSelfDisconnect(clientID string, pin string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	client, ok := r.clients[clientID]
	if !ok || client.PIN == "" || client.PIN != pin {
		return false
	}

	client.Connected = false
	client.LastSeen = time.Now().UTC()
	client.CloseSend()
	r.touchLocked()

	return true
}

func (r *Room) UpdateLocation(clientID string, msg InboundMessage) {
	r.mu.Lock()

	client, ok := r.clients[clientID]
	if !ok || r.Closed {
		r.mu.Unlock()
		return
	}

	client.Lat = msg.Lat
	client.Lng = msg.Lng
	client.BatteryLevel = msg.BatteryLevel
	client.GeofenceAlert = r.isOutsidePerimeterLocked(msg.Lat, msg.Lng)
	client.LastSeen = time.Now().UTC()
	client.Connected = true

	public := client.toPublicLocked()
	r.touchLocked()
	r.mu.Unlock()

	r.Broadcast(OutboundMessage{Type: "loc", Data: public})
}

func (r *Room) MarkSOS(clientID string, msg InboundMessage) {
	r.mu.Lock()

	client, ok := r.clients[clientID]
	if !ok || r.Closed {
		r.mu.Unlock()
		return
	}

	client.Lat = msg.Lat
	client.Lng = msg.Lng
	client.BatteryLevel = msg.BatteryLevel
	client.GeofenceAlert = r.isOutsidePerimeterLocked(msg.Lat, msg.Lng)
	client.SOS = true
	client.LastSeen = time.Now().UTC()

	public := client.toPublicLocked()
	r.touchLocked()
	r.mu.Unlock()

	r.Broadcast(OutboundMessage{Type: "sos", Data: public})
}

func (r *Room) SetMeetingPoint(clientID string, msg InboundMessage) PublicMeetingPoint {
	r.mu.Lock()
	defer r.mu.Unlock()

	point := PublicMeetingPoint{
		Lat:       msg.Lat,
		Lng:       msg.Lng,
		SetBy:     clientID,
		UpdatedAt: time.Now().UTC(),
	}

	r.safety.MeetingPoint = &point
	r.touchLocked()

	return point
}

func (r *Room) SetPerimeter(clientID string, msg InboundMessage) PublicPerimeter {
	r.mu.Lock()
	defer r.mu.Unlock()

	perimeter := PublicPerimeter{
		Lat:          msg.Lat,
		Lng:          msg.Lng,
		RadiusMeters: msg.RadiusMeters,
		SetBy:        clientID,
		UpdatedAt:    time.Now().UTC(),
	}

	r.safety.Perimeter = &perimeter
	for _, client := range r.clients {
		if validLatLng(client.Lat, client.Lng) {
			client.GeofenceAlert = r.isOutsidePerimeterLocked(client.Lat, client.Lng)
		}
	}
	r.touchLocked()

	return perimeter
}

func (r *Room) UpdateTTL(ttl time.Duration) (PublicRoom, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if ttl < MinRoomTTL || ttl > MaxRoomTTL || r.Closed {
		return PublicRoom{}, false
	}

	r.TTL = ttl
	r.touchLocked()
	return r.publicLocked(time.Now().UTC()), true
}

func (r *Room) End() PublicRoom {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.Closed = true
	r.touchLocked()
	for _, client := range r.clients {
		client.Connected = false
		client.LastSeen = time.Now().UTC()
		client.CloseSend()
	}

	return r.publicLocked(time.Now().UTC())
}

func (r *Room) SendSnapshot(client *Client) {
	client.Send(OutboundMessage{Type: "snapshot", Data: r.Snapshot()})
}

func (r *Room) Snapshot() RoomSnapshot {
	r.mu.RLock()
	defer r.mu.RUnlock()

	safety := cloneSafety(r.safety)

	return RoomSnapshot{
		Room:    r.publicLocked(time.Now().UTC()),
		Clients: r.canonicalClientsLocked(),
		Safety:  safety,
	}
}

func (r *Room) Broadcast(msg OutboundMessage) {
	r.mu.RLock()
	clients := make([]*Client, 0, len(r.clients))
	for _, client := range r.clients {
		if client.Connected {
			clients = append(clients, client)
		}
	}
	r.mu.RUnlock()

	for _, client := range clients {
		client.Send(msg)
	}
}

func (r *Room) SendToClient(clientID string, msg OutboundMessage) {
	r.mu.RLock()
	client, ok := r.clients[clientID]
	r.mu.RUnlock()

	if !ok || !client.Connected {
		return
	}

	client.Send(msg)
}

func (r *Room) IsExpired(now time.Time) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()

	return r.Closed || r.remainingLocked(now) <= 0
}

func (r *Room) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()

	for _, client := range r.clients {
		client.Close()
	}

	r.clients = make(map[string]*Client)
}

func (r *Room) touchLocked() {
	r.LastActivityAt = time.Now().UTC()
}

func (r *Room) remainingLocked(now time.Time) time.Duration {
	remaining := r.TTL - now.Sub(r.CreatedAt)
	if remaining < 0 {
		return 0
	}
	return remaining
}

func (r *Room) publicLocked(now time.Time) PublicRoom {
	remaining := r.remainingLocked(now)
	return PublicRoom{
		ID:        r.ID,
		Name:      r.Name,
		CreatedAt: r.CreatedAt,
		ExpiresIn: int64(remaining.Seconds()),
		TTL:       int64(r.TTL.Seconds()),
		MaxFree:   r.MaxFreeClients,
		Closed:    r.Closed,
		Safety:    cloneSafety(r.safety),
	}
}

func (r *Room) canonicalClientsLocked() []PublicClient {
	byLogicalUser := make(map[string]PublicClient, len(r.clients))
	for _, client := range r.clients {
		public := client.toPublicLocked()
		key := public.logicalUserKey()
		if previous, ok := byLogicalUser[key]; !ok || preferPublicClient(public, previous) {
			byLogicalUser[key] = public
		}
	}

	clients := make([]PublicClient, 0, len(byLogicalUser))
	for _, client := range byLogicalUser {
		clients = append(clients, client)
	}
	return clients
}

func preferPublicClient(next PublicClient, current PublicClient) bool {
	if next.Connected != current.Connected {
		return next.Connected
	}
	if !next.LastSeen.Equal(current.LastSeen) {
		return next.LastSeen.After(current.LastSeen)
	}
	return next.ID > current.ID
}

func (p PublicClient) logicalUserKey() string {
	nick := strings.ToLower(strings.TrimSpace(p.Nickname))
	avatar := strings.TrimSpace(p.Avatar)
	if nick != "" || avatar != "" {
		return nick + "|" + avatar
	}
	return p.ID
}

func (r *Room) isOutsidePerimeterLocked(lat float64, lng float64) bool {
	if r.safety.Perimeter == nil {
		return false
	}

	distance := haversineMeters(lat, lng, r.safety.Perimeter.Lat, r.safety.Perimeter.Lng)
	return distance > float64(r.safety.Perimeter.RadiusMeters)
}

func cloneSafety(value PublicSafety) PublicSafety {
	var safety PublicSafety

	if value.MeetingPoint != nil {
		meeting := *value.MeetingPoint
		safety.MeetingPoint = &meeting
	}

	if value.Perimeter != nil {
		perimeter := *value.Perimeter
		safety.Perimeter = &perimeter
	}

	return safety
}

func (c *Client) toPublicLocked() PublicClient {
	return PublicClient{
		ID:            c.ID,
		Nickname:      c.Nickname,
		Avatar:        c.Avatar,
		Lat:           c.Lat,
		Lng:           c.Lng,
		BatteryLevel:  c.BatteryLevel,
		Connected:     c.Connected,
		GeofenceAlert: c.GeofenceAlert,
		SOS:           c.SOS,
		LastSeen:      c.LastSeen,
	}
}
