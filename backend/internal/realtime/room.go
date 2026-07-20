package realtime

import (
	"sort"
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

func (r *Room) CanJoin(clientID string, nickname string) error {
	r.mu.RLock()
	defer r.mu.RUnlock()

	if r.Closed || r.remainingLocked(time.Now().UTC()) <= 0 {
		return ErrRoomClosed
	}

	_, reconnecting := r.clients[clientID]
	if !reconnecting && r.nicknameTakenLocked(clientID, nickname) {
		return ErrNicknameTaken
	}

	activeCount := 0
	for id, client := range r.clients {
		if id == clientID {
			continue
		}
		if client.Connected {
			activeCount++
		}
	}

	if !reconnecting && activeCount >= r.MaxFreeClients {
		return ErrRoomFull
	}

	return nil
}

func (r *Room) AddClient(client *Client) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.Closed || r.remainingLocked(time.Now().UTC()) <= 0 {
		return ErrRoomClosed
	}

	previous, reconnecting := r.clients[client.ID]
	if reconnecting && previous.Nickname != "" {
		client.Nickname = previous.Nickname
	}

	if r.nicknameTakenLocked(client.ID, client.Nickname) {
		return ErrNicknameTaken
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

	if !reconnecting && activeCount >= r.MaxFreeClients {
		return ErrRoomFull
	}

	if reconnecting {
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

func (r *Room) ClientRole(clientID string) string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	client, ok := r.clients[clientID]
	if !ok || client.Role == "" {
		return ClientRoleParticipant
	}
	return client.Role
}

func (r *Room) CanManageSafety(clientID string) bool {
	return r.ClientRole(clientID) == ClientRoleCreator
}

func (r *Room) nicknameTakenLocked(clientID string, nickname string) bool {
	key := normalizeNickname(nickname)
	if key == "" {
		return false
	}

	for id, client := range r.clients {
		if id == clientID {
			continue
		}
		if normalizeNickname(client.Nickname) == key {
			return true
		}
	}
	return false
}

func normalizeNickname(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
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
		Clients: r.publicClientsLocked(),
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

func (r *Room) publicClientsLocked() []PublicClient {
	clients := make([]PublicClient, 0, len(r.clients))
	for _, client := range r.clients {
		clients = append(clients, client.toPublicLocked())
	}

	sort.SliceStable(clients, func(i int, j int) bool {
		leftNick := normalizeNickname(clients[i].Nickname)
		rightNick := normalizeNickname(clients[j].Nickname)
		if leftNick != rightNick {
			return leftNick < rightNick
		}
		return clients[i].ID < clients[j].ID
	})

	return clients
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
