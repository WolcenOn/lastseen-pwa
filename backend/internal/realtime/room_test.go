package realtime

import (
	"testing"
	"time"
)

func TestAddClientReconnectsSameClientIDWithoutDuplicate(t *testing.T) {
	room := NewRoom(RoomConfig{
		ID:             "room-a",
		Name:           "Room A",
		CreatorToken:   "creator-token",
		TTL:            time.Hour,
		MaxFreeClients: 3,
	})

	first := NewClient(ClientConfig{
		ID:        "client-1",
		SessionID: "session-old",
		Nickname:  "Pedro",
		PIN:       "1234",
		Avatar:    "🐼",
	})
	first.Lat = 37.1
	first.Lng = -7.1
	first.BatteryLevel = 0.53

	if err := room.AddClient(first); err != nil {
		t.Fatalf("first add failed: %v", err)
	}

	second := NewClient(ClientConfig{
		ID:        "client-1",
		SessionID: "session-new",
		Nickname:  "Pedro",
		PIN:       "1234",
		Avatar:    "🐼",
	})

	if err := room.AddClient(second); err != nil {
		t.Fatalf("reconnect failed: %v", err)
	}

	snapshot := room.Snapshot()
	if got := len(snapshot.Clients); got != 1 {
		t.Fatalf("expected one participant after reconnect, got %d", got)
	}

	client := snapshot.Clients[0]
	if client.ID != "client-1" || !client.Connected {
		t.Fatalf("unexpected public client: %+v", client)
	}
	if client.Lat != 37.1 || client.Lng != -7.1 || client.BatteryLevel != 0.53 {
		t.Fatalf("expected last location to be preserved, got %+v", client)
	}
}

func TestOldSessionDisconnectDoesNotMarkNewSessionOffline(t *testing.T) {
	room := NewRoom(RoomConfig{
		ID:             "room-b",
		Name:           "Room B",
		CreatorToken:   "creator-token",
		TTL:            time.Hour,
		MaxFreeClients: 3,
	})

	first := NewClient(ClientConfig{ID: "client-1", SessionID: "old", Nickname: "Pedro", PIN: "1234", Avatar: "🐼"})
	if err := room.AddClient(first); err != nil {
		t.Fatalf("first add failed: %v", err)
	}

	second := NewClient(ClientConfig{ID: "client-1", SessionID: "new", Nickname: "Pedro", PIN: "1234", Avatar: "🐼"})
	if err := room.AddClient(second); err != nil {
		t.Fatalf("reconnect failed: %v", err)
	}

	if _, ok := room.MarkDisconnected("client-1", "old"); ok {
		t.Fatal("old session should not disconnect the new active session")
	}

	snapshot := room.Snapshot()
	if got := len(snapshot.Clients); got != 1 {
		t.Fatalf("expected one participant, got %d", got)
	}
	if !snapshot.Clients[0].Connected {
		t.Fatalf("new session should remain online: %+v", snapshot.Clients[0])
	}
}

func TestSnapshotCanonicalizesDuplicateLogicalUsers(t *testing.T) {
	room := NewRoom(RoomConfig{
		ID:             "room-c",
		Name:           "Room C",
		CreatorToken:   "creator-token",
		TTL:            time.Hour,
		MaxFreeClients: 10,
	})

	offline := NewClient(ClientConfig{ID: "old-client", SessionID: "old", Nickname: "Pedro", PIN: "1111", Avatar: "🐼"})
	offline.Connected = false
	offline.Lat = 37.1
	offline.Lng = -7.1
	offline.LastSeen = time.Now().UTC().Add(-10 * time.Minute)
	room.clients[offline.ID] = offline

	online := NewClient(ClientConfig{ID: "new-client", SessionID: "new", Nickname: "Pedro", PIN: "2222", Avatar: "🐼"})
	online.Lat = 37.2
	online.Lng = -7.2
	if err := room.AddClient(online); err != nil {
		t.Fatalf("online add failed: %v", err)
	}

	snapshot := room.Snapshot()
	if got := len(snapshot.Clients); got != 1 {
		t.Fatalf("expected one canonical logical participant, got %d: %+v", got, snapshot.Clients)
	}
	client := snapshot.Clients[0]
	if client.ID != "new-client" || !client.Connected {
		t.Fatalf("expected online duplicate to win, got %+v", client)
	}
}

func TestCreatorTokenAuthorizesRoomManagement(t *testing.T) {
	hub := NewHub(HubConfig{RoomTTL: time.Hour, MaxFreeClients: 3})
	hub.CreateRoom("room-d", "Room D", "creator-token", time.Hour)

	if _, err := hub.UpdateRoomTTL("room-d", "wrong-token", 2*time.Hour); err != ErrForbidden {
		t.Fatalf("expected ErrForbidden for wrong token, got %v", err)
	}

	public, err := hub.UpdateRoomTTL("room-d", "creator-token", 2*time.Hour)
	if err != nil {
		t.Fatalf("expected valid creator token to update TTL, got %v", err)
	}
	if public.TTL != int64((2 * time.Hour).Seconds()) {
		t.Fatalf("expected TTL to update, got %d", public.TTL)
	}
}
