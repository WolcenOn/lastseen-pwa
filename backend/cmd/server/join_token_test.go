package main

import (
	"testing"
	"time"
)

func TestWebSocketTokenStoreConsumesTokenOnce(t *testing.T) {
	store := newWebSocketTokenStore(time.Minute)
	token, _, err := store.Issue(websocketJoinClaims{
		RoomID:   "room-1",
		ClientID: "client-1",
		Nickname: "Ana",
		PIN:      "1234",
		Avatar:   "🦊",
	})
	if err != nil {
		t.Fatalf("issue token failed: %v", err)
	}

	claims, ok := store.Consume(token, "room-1")
	if !ok {
		t.Fatal("expected token to be accepted")
	}
	if claims.ClientID != "client-1" || claims.Nickname != "Ana" || claims.PIN != "1234" || claims.Avatar != "🦊" {
		t.Fatalf("unexpected claims: %+v", claims)
	}

	if _, ok := store.Consume(token, "room-1"); ok {
		t.Fatal("token should be single-use")
	}
}

func TestWebSocketTokenStoreRejectsWrongRoom(t *testing.T) {
	store := newWebSocketTokenStore(time.Minute)
	token, _, err := store.Issue(websocketJoinClaims{RoomID: "room-1", ClientID: "client-1", Nickname: "Ana", PIN: "1234", Avatar: "🦊"})
	if err != nil {
		t.Fatalf("issue token failed: %v", err)
	}

	if _, ok := store.Consume(token, "room-2"); ok {
		t.Fatal("token should not be valid for a different room")
	}
}

func TestWebSocketTokenStoreRejectsExpiredToken(t *testing.T) {
	store := newWebSocketTokenStore(time.Nanosecond)
	token, _, err := store.Issue(websocketJoinClaims{RoomID: "room-1", ClientID: "client-1", Nickname: "Ana", PIN: "1234", Avatar: "🦊"})
	if err != nil {
		t.Fatalf("issue token failed: %v", err)
	}

	time.Sleep(time.Millisecond)
	if _, ok := store.Consume(token, "room-1"); ok {
		t.Fatal("expired token should be rejected")
	}
}
