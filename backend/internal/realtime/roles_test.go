package realtime

import (
	"errors"
	"testing"
	"time"
)

func TestClientRoleReturnsCreatorForValidCreatorToken(t *testing.T) {
	hub := NewHub(HubConfig{RoomTTL: time.Hour, MaxFreeClients: 3})
	hub.CreateRoom("room-role", "Role Room", "creator-token", time.Hour)

	role, err := hub.ClientRole("room-role", "creator-token")
	if err != nil {
		t.Fatalf("expected role resolution to succeed: %v", err)
	}
	if role != ClientRoleCreator {
		t.Fatalf("expected creator role, got %q", role)
	}
}

func TestClientRoleReturnsParticipantWithoutCreatorToken(t *testing.T) {
	hub := NewHub(HubConfig{RoomTTL: time.Hour, MaxFreeClients: 3})
	hub.CreateRoom("room-role", "Role Room", "creator-token", time.Hour)

	role, err := hub.ClientRole("room-role", "")
	if err != nil {
		t.Fatalf("expected role resolution to succeed: %v", err)
	}
	if role != ClientRoleParticipant {
		t.Fatalf("expected participant role, got %q", role)
	}
}

func TestClientRoleReturnsParticipantForInvalidCreatorToken(t *testing.T) {
	hub := NewHub(HubConfig{RoomTTL: time.Hour, MaxFreeClients: 3})
	hub.CreateRoom("room-role", "Role Room", "creator-token", time.Hour)

	role, err := hub.ClientRole("room-role", "wrong-token")
	if err != nil {
		t.Fatalf("expected invalid creator token to resolve as participant: %v", err)
	}
	if role != ClientRoleParticipant {
		t.Fatalf("expected participant role, got %q", role)
	}
}

func TestClientRoleReturnsRoomNotFound(t *testing.T) {
	hub := NewHub(HubConfig{RoomTTL: time.Hour, MaxFreeClients: 3})

	_, err := hub.ClientRole("missing-room", "creator-token")
	if !errors.Is(err, ErrRoomNotFound) {
		t.Fatalf("expected ErrRoomNotFound, got %v", err)
	}
}

func TestNewClientDefaultsToParticipantRole(t *testing.T) {
	client := NewClient(ClientConfig{ID: "client-1", SessionID: "session-1", Nickname: "Ana", PIN: "1234"})

	if client.Role != ClientRoleParticipant {
		t.Fatalf("expected default participant role, got %q", client.Role)
	}
}

func TestRoomSafetyCapabilitiesRequireCreatorRole(t *testing.T) {
	room := newTestRoom()

	creator := NewClient(ClientConfig{ID: "creator", SessionID: "creator-session", Nickname: "Ana", PIN: "1234", Role: ClientRoleCreator})
	participant := NewClient(ClientConfig{ID: "participant", SessionID: "participant-session", Nickname: "Luis", PIN: "5678", Role: ClientRoleParticipant})

	if err := room.AddClient(creator); err != nil {
		t.Fatalf("creator add failed: %v", err)
	}
	if err := room.AddClient(participant); err != nil {
		t.Fatalf("participant add failed: %v", err)
	}

	if !room.CanManageSafety("creator") {
		t.Fatal("creator should be able to manage safety")
	}
	if room.CanManageSafety("participant") {
		t.Fatal("participant should not be able to manage safety")
	}
	if room.CanManageSafety("missing") {
		t.Fatal("missing client should not be able to manage safety")
	}
}
