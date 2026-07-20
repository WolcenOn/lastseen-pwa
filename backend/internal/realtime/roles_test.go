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
