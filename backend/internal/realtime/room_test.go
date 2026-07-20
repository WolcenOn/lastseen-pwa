package realtime

import (
	"errors"
	"testing"
	"time"
)

func newTestRoom() *Room {
	return NewRoom(RoomConfig{
		ID:             "room-test",
		Name:           "Room Test",
		CreatorToken:   "creator-token",
		TTL:            time.Hour,
		MaxFreeClients: 10,
	})
}

func TestCanJoinPreflightRejectsDuplicateNickname(t *testing.T) {
	room := newTestRoom()

	if err := room.AddClient(NewClient(ClientConfig{ID: "client-1", SessionID: "a", Nickname: "Pedro", PIN: "1111", Avatar: "🐼"})); err != nil {
		t.Fatalf("first add failed: %v", err)
	}

	err := room.CanJoin("client-2", "pedro")
	if !errors.Is(err, ErrNicknameTaken) {
		t.Fatalf("expected ErrNicknameTaken in preflight, got %v", err)
	}
}

func TestCanJoinPreflightAllowsSameClientReconnect(t *testing.T) {
	room := newTestRoom()

	if err := room.AddClient(NewClient(ClientConfig{ID: "client-1", SessionID: "a", Nickname: "Pedro", PIN: "1111", Avatar: "🐼"})); err != nil {
		t.Fatalf("first add failed: %v", err)
	}

	if err := room.CanJoin("client-1", "Otro mote"); err != nil {
		t.Fatalf("same client should be allowed to preflight reconnect, got %v", err)
	}
}

func TestAddClientReconnectsSameClientIDWithoutDuplicate(t *testing.T) {
	room := newTestRoom()

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
		Avatar:    "🦊",
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
	if client.Nickname != "Pedro" {
		t.Fatalf("expected reconnect to preserve original nickname, got %q", client.Nickname)
	}
	if client.Lat != 37.1 || client.Lng != -7.1 || client.BatteryLevel != 0.53 {
		t.Fatalf("expected last location to be preserved, got %+v", client)
	}
}

func TestAddClientRejectsDuplicateNicknameForDifferentClient(t *testing.T) {
	room := newTestRoom()

	if err := room.AddClient(NewClient(ClientConfig{ID: "client-1", SessionID: "a", Nickname: "Pedro", PIN: "1111", Avatar: "🐼"})); err != nil {
		t.Fatalf("first add failed: %v", err)
	}

	err := room.AddClient(NewClient(ClientConfig{ID: "client-2", SessionID: "b", Nickname: "Pedro", PIN: "2222", Avatar: "🦊"}))
	if !errors.Is(err, ErrNicknameTaken) {
		t.Fatalf("expected ErrNicknameTaken, got %v", err)
	}
}

func TestAddClientRejectsDuplicateNicknameCaseInsensitive(t *testing.T) {
	room := newTestRoom()

	if err := room.AddClient(NewClient(ClientConfig{ID: "client-1", SessionID: "a", Nickname: "Pedro", PIN: "1111", Avatar: "🐼"})); err != nil {
		t.Fatalf("first add failed: %v", err)
	}

	err := room.AddClient(NewClient(ClientConfig{ID: "client-2", SessionID: "b", Nickname: "pedro", PIN: "2222", Avatar: "🦊"}))
	if !errors.Is(err, ErrNicknameTaken) {
		t.Fatalf("expected ErrNicknameTaken for case-insensitive duplicate, got %v", err)
	}
}

func TestAddClientRejectsDuplicateNicknameWithOuterSpaces(t *testing.T) {
	room := newTestRoom()

	if err := room.AddClient(NewClient(ClientConfig{ID: "client-1", SessionID: "a", Nickname: "Pedro", PIN: "1111", Avatar: "🐼"})); err != nil {
		t.Fatalf("first add failed: %v", err)
	}

	err := room.AddClient(NewClient(ClientConfig{ID: "client-2", SessionID: "b", Nickname: "  Pedro  ", PIN: "2222", Avatar: "🦊"}))
	if !errors.Is(err, ErrNicknameTaken) {
		t.Fatalf("expected ErrNicknameTaken for trimmed duplicate, got %v", err)
	}
}

func TestAddClientAllowsSameAvatarWithDifferentNickname(t *testing.T) {
	room := newTestRoom()

	if err := room.AddClient(NewClient(ClientConfig{ID: "client-1", SessionID: "a", Nickname: "Pedro", PIN: "1111", Avatar: "🐼"})); err != nil {
		t.Fatalf("first add failed: %v", err)
	}
	if err := room.AddClient(NewClient(ClientConfig{ID: "client-2", SessionID: "b", Nickname: "Lucia", PIN: "2222", Avatar: "🐼"})); err != nil {
		t.Fatalf("same avatar with different nickname should be allowed, got %v", err)
	}
}

func TestDisconnectedNicknameRemainsReserved(t *testing.T) {
	room := newTestRoom()

	first := NewClient(ClientConfig{ID: "client-1", SessionID: "old", Nickname: "Pedro", PIN: "1111", Avatar: "🐼"})
	if err := room.AddClient(first); err != nil {
		t.Fatalf("first add failed: %v", err)
	}
	if _, ok := room.MarkDisconnected("client-1", "old"); !ok {
		t.Fatal("expected disconnect to be recorded")
	}

	err := room.AddClient(NewClient(ClientConfig{ID: "client-2", SessionID: "new", Nickname: "Pedro", PIN: "2222", Avatar: "🦊"}))
	if !errors.Is(err, ErrNicknameTaken) {
		t.Fatalf("expected disconnected nickname to remain reserved, got %v", err)
	}
}

func TestOldSessionDisconnectDoesNotMarkNewSessionOffline(t *testing.T) {
	room := newTestRoom()

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

func TestSetPerimeterRecalculatesGeofenceAlerts(t *testing.T) {
	room := newTestRoom()

	inside := NewClient(ClientConfig{ID: "client-in", SessionID: "in", Nickname: "Dentro", PIN: "1111", Avatar: "🐼"})
	inside.Lat = 37.25
	inside.Lng = -6.95
	outside := NewClient(ClientConfig{ID: "client-out", SessionID: "out", Nickname: "Fuera", PIN: "2222", Avatar: "🦊"})
	outside.Lat = 37.28
	outside.Lng = -6.95

	if err := room.AddClient(inside); err != nil {
		t.Fatalf("inside add failed: %v", err)
	}
	if err := room.AddClient(outside); err != nil {
		t.Fatalf("outside add failed: %v", err)
	}

	room.SetPerimeter("client-in", InboundMessage{Lat: 37.25, Lng: -6.95, RadiusMeters: 250})

	clients := map[string]PublicClient{}
	for _, client := range room.Snapshot().Clients {
		clients[client.ID] = client
	}

	if clients["client-in"].GeofenceAlert {
		t.Fatalf("inside client should remain inside perimeter: %+v", clients["client-in"])
	}
	if !clients["client-out"].GeofenceAlert {
		t.Fatalf("outside client should be marked outside perimeter: %+v", clients["client-out"])
	}
}

func TestSnapshotOrderingIsDeterministic(t *testing.T) {
	room := newTestRoom()

	clients := []*Client{
		NewClient(ClientConfig{ID: "client-c", SessionID: "c", Nickname: "Zoe", PIN: "3333", Avatar: "🐼"}),
		NewClient(ClientConfig{ID: "client-a", SessionID: "a", Nickname: "Ana", PIN: "1111", Avatar: "🦊"}),
		NewClient(ClientConfig{ID: "client-b", SessionID: "b", Nickname: "Luis", PIN: "2222", Avatar: "🐼"}),
	}
	for _, client := range clients {
		if err := room.AddClient(client); err != nil {
			t.Fatalf("add failed: %v", err)
		}
	}

	snapshot := room.Snapshot()
	got := []string{snapshot.Clients[0].Nickname, snapshot.Clients[1].Nickname, snapshot.Clients[2].Nickname}
	want := []string{"Ana", "Luis", "Zoe"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("snapshot order = %v, want %v", got, want)
		}
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
