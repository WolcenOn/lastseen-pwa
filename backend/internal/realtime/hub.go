package realtime

import (
	"context"
	"errors"
	"sync"
	"time"
)

var (
	ErrRoomNotFound = errors.New("room not found")
	ErrRoomFull     = errors.New("room is full for free tier")
)

type HubConfig struct {
	RoomTTL          time.Duration
	MaxFreeClients   int
	CleanupInterval  time.Duration
	ClientWriteWait  time.Duration
	ClientPongWait   time.Duration
	ClientPingPeriod time.Duration
}

type Hub struct {
	mu     sync.RWMutex
	rooms  map[string]*Room
	config HubConfig
}

func NewHub(config HubConfig) *Hub {
	if config.RoomTTL <= 0 {
		config.RoomTTL = 3 * time.Hour
	}
	if config.MaxFreeClients <= 0 {
		config.MaxFreeClients = 3
	}
	if config.CleanupInterval <= 0 {
		config.CleanupInterval = time.Minute
	}

	return &Hub{
		rooms:  make(map[string]*Room),
		config: config,
	}
}

func (h *Hub) Run(ctx context.Context) {
	ticker := time.NewTicker(h.config.CleanupInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.CleanupExpiredRooms()
		}
	}
}

func (h *Hub) CreateRoom(id string, name string) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()

	room := NewRoom(RoomConfig{
		ID:             id,
		Name:           name,
		TTL:            h.config.RoomTTL,
		MaxFreeClients: h.config.MaxFreeClients,
	})

	h.rooms[id] = room
	return room
}

func (h *Hub) GetRoom(id string) (*Room, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	room, ok := h.rooms[id]
	return room, ok
}

func (h *Hub) RoomInfo(id string) (PublicRoom, bool) {
	room, ok := h.GetRoom(id)
	if !ok {
		return PublicRoom{}, false
	}

	return room.Public(time.Now().UTC()), true
}

func (h *Hub) JoinRoom(roomID string, client *Client) error {
	room, ok := h.GetRoom(roomID)
	if !ok {
		return ErrRoomNotFound
	}

	if err := room.AddClient(client); err != nil {
		return err
	}

	room.SendSnapshot(client)
	room.Broadcast(OutboundMessage{
		Type: "join",
		Data: PublicClient{
			ID:        client.ID,
			Nickname:  client.Nickname,
			Avatar:    client.Avatar,
			Connected: true,
			LastSeen:  time.Now().UTC(),
		},
	})

	return nil
}

func (h *Hub) LeaveRoom(roomID string, clientID string) {
	room, ok := h.GetRoom(roomID)
	if !ok {
		return
	}

	client, existed := room.MarkDisconnected(clientID)
	if !existed {
		return
	}

	room.Broadcast(OutboundMessage{
		Type: "leave",
		Data: PublicClient{
			ID:           client.ID,
			Nickname:     client.Nickname,
			Avatar:       client.Avatar,
			Lat:          client.Lat,
			Lng:          client.Lng,
			BatteryLevel: client.BatteryLevel,
			Connected:    false,
			LastSeen:     client.LastSeen,
		},
	})
}

func (h *Hub) HandleClientMessage(roomID string, clientID string, msg InboundMessage) {
	room, ok := h.GetRoom(roomID)
	if !ok {
		return
	}

	switch msg.Type {
	case "loc":
		room.UpdateLocation(clientID, msg)
	case "panic":
		room.Broadcast(OutboundMessage{Type: "panic", Data: map[string]string{"from": clientID}})
	case "wake":
		room.SendToClient(msg.TargetID, OutboundMessage{Type: "wake", Data: map[string]string{"from": clientID}})
	case "sos":
		room.MarkSOS(clientID, msg)
	case "disconnect":
		if room.ForceSelfDisconnect(clientID, msg.PIN) {
			room.Broadcast(OutboundMessage{Type: "leave", Data: map[string]string{"id": clientID}})
		}
	}
}

func (h *Hub) CleanupExpiredRooms() {
	now := time.Now().UTC()

	h.mu.Lock()
	defer h.mu.Unlock()

	for roomID, room := range h.rooms {
		if room.IsExpired(now) {
			room.Close()
			delete(h.rooms, roomID)
		}
	}
}

func (h *Hub) CloseAll() {
	h.mu.Lock()
	defer h.mu.Unlock()

	for roomID, room := range h.rooms {
		room.Close()
		delete(h.rooms, roomID)
	}
}
