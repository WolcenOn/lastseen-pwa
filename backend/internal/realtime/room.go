package realtime

import (
	"sync"
	"time"
)

type RoomConfig struct {
	ID             string
	Name           string
	TTL            time.Duration
	MaxFreeClients int
}

type Room struct {
	mu sync.RWMutex

	ID             string
	Name           string
	TTL            time.Duration
	MaxFreeClients int

	CreatedAt      time.Time
	LastActivityAt time.Time

	clients map[string]*Client
	safety  PublicSafety
}

func NewRoom(config RoomConfig) *Room {
	now := time.Now().UTC()

	return &Room{
		ID:             config.ID,
		Name:           config.Name,
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

	remaining := r.TTL - now.Sub(r.LastActivityAt)
	if remaining < 0 {
		remaining = 0
	}

	return PublicRoom{
		ID:        r.ID,
		Name:      r.Name,
		CreatedAt: r.CreatedAt,
		ExpiresIn: int64(remaining.Seconds()),
		MaxFree:   r.MaxFreeClients,
		Safety:    cloneSafety(r.safety),
	}
}

func (r *Room) AddClient(client *Client) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	activeCount := 0
	for _, c := range r.clients {
		if c.Connected {
			activeCount++
		}
	}

	if activeCount >= r.MaxFreeClients {
		return ErrRoomFull
	}

	client.Connected = true
	client.LastSeen = time.Now().UTC()

	r.clients[client.ID] = client
	r.touchLocked()

	return nil
}

func (r *Room) MarkDisconnected(clientID string) (*Client, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	client, ok := r.clients[clientID]
	if !ok {
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
	if !ok {
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
	if !ok {
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
	r.touchLocked()

	return perimeter
}

func (r *Room) SendSnapshot(client *Client) {
	client.Send(OutboundMessage{Type: "snapshot", Data: r.Snapshot()})
}

func (r *Room) Snapshot() RoomSnapshot {
	r.mu.RLock()
	defer r.mu.RUnlock()

	clients := make([]PublicClient, 0, len(r.clients))
	for _, client := range r.clients {
		clients = append(clients, client.toPublicLocked())
	}

	remaining := r.TTL - time.Since(r.LastActivityAt)
	if remaining < 0 {
		remaining = 0
	}

	safety := cloneSafety(r.safety)

	return RoomSnapshot{
		Room: PublicRoom{
			ID:        r.ID,
			Name:      r.Name,
			CreatedAt: r.CreatedAt,
			ExpiresIn: int64(remaining.Seconds()),
			MaxFree:   r.MaxFreeClients,
			Safety:    safety,
		},
		Clients: clients,
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

	for _, client := range r.clients {
		if client.Connected {
			return false
		}
	}

	return now.Sub(r.LastActivityAt) > r.TTL
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
