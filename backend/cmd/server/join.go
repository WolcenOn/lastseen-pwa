package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/WolcenOn/lastseen-pwa/backend/internal/realtime"
	"github.com/gorilla/websocket"
)

const joinTokenTTL = 2 * time.Minute

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		return origin == "" || isAllowedOrigin(origin)
	},
}

type joinRoomRequest struct {
	Nickname     string `json:"nickname"`
	PIN          string `json:"pin"`
	Avatar       string `json:"avatar"`
	ClientID     string `json:"clientId"`
	CreatorToken string `json:"creatorToken"`
}

type joinRoomResponse struct {
	Room            realtime.PublicRoom `json:"room"`
	Client          joinClientResponse  `json:"client"`
	WebSocketURL    string              `json:"wsUrl"`
	WebSocketToken  string              `json:"wsToken"`
	TokenExpiresIn  int64               `json:"tokenExpiresIn"`
	ProtocolVersion string              `json:"protocolVersion"`
	Role            string              `json:"role"`
	Capabilities    joinCapabilities    `json:"capabilities"`
	Features        map[string]bool     `json:"features"`
}

type joinClientResponse struct {
	ID       string `json:"id"`
	Nickname string `json:"nickname"`
	Avatar   string `json:"avatar"`
}

type joinCapabilities struct {
	CanViewRoom         bool `json:"canViewRoom"`
	CanShareLocation    bool `json:"canShareLocation"`
	CanSendSOS          bool `json:"canSendSOS"`
	CanSendPanic        bool `json:"canSendPanic"`
	CanWakeParticipants bool `json:"canWakeParticipants"`
	CanSetMeetingPoint  bool `json:"canSetMeetingPoint"`
	CanSetPerimeter     bool `json:"canSetPerimeter"`
	CanUpdateTTL        bool `json:"canUpdateTTL"`
	CanEndRoom          bool `json:"canEndRoom"`
}

type websocketJoinClaims struct {
	RoomID    string
	ClientID  string
	Nickname  string
	PIN       string
	Avatar    string
	ExpiresAt time.Time
}

type websocketTokenStore struct {
	mu     sync.Mutex
	ttl    time.Duration
	tokens map[string]websocketJoinClaims
}

func newWebSocketTokenStore(ttl time.Duration) *websocketTokenStore {
	if ttl <= 0 {
		ttl = joinTokenTTL
	}
	return &websocketTokenStore{ttl: ttl, tokens: make(map[string]websocketJoinClaims)}
}

func (s *websocketTokenStore) Issue(claims websocketJoinClaims) (string, websocketJoinClaims, error) {
	token, err := randomURLSafe(24)
	if err != nil {
		return "", websocketJoinClaims{}, err
	}

	claims.ExpiresAt = time.Now().UTC().Add(s.ttl)

	s.mu.Lock()
	s.cleanupLocked(time.Now().UTC())
	s.tokens[token] = claims
	s.mu.Unlock()

	return token, claims, nil
}

func (s *websocketTokenStore) Consume(token string, roomID string) (websocketJoinClaims, bool) {
	token = strings.TrimSpace(token)
	if token == "" {
		return websocketJoinClaims{}, false
	}

	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()

	s.cleanupLocked(now)
	claims, ok := s.tokens[token]
	if !ok || claims.RoomID != roomID || !claims.ExpiresAt.After(now) {
		delete(s.tokens, token)
		return websocketJoinClaims{}, false
	}

	delete(s.tokens, token)
	return claims, true
}

func (s *websocketTokenStore) cleanupLocked(now time.Time) {
	for token, claims := range s.tokens {
		if !claims.ExpiresAt.After(now) {
			delete(s.tokens, token)
		}
	}
}

func joinRoomHandler(hub *realtime.Hub, tokens *websocketTokenStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		roomID := r.PathValue("roomID")
		if roomID == "" {
			http.Error(w, "missing room id", http.StatusBadRequest)
			return
		}

		var payload joinRoomRequest
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&payload)
		}

		nickname := sanitizeNickname(payload.Nickname)
		pin := strings.TrimSpace(payload.PIN)
		avatar := sanitizeAvatar(payload.Avatar)
		clientID := sanitizeClientID(payload.ClientID)
		creatorToken := strings.TrimSpace(payload.CreatorToken)
		if creatorToken == "" {
			creatorToken = strings.TrimSpace(r.Header.Get("X-Creator-Token"))
		}

		if nickname == "" {
			http.Error(w, "missing nickname", http.StatusBadRequest)
			return
		}
		if !pinPattern.MatchString(pin) {
			http.Error(w, "invalid pin", http.StatusBadRequest)
			return
		}
		if avatar == "" {
			avatar = avatarSet[0]
		}
		if clientID == "" {
			var err error
			clientID, err = randomURLSafe(9)
			if err != nil {
				http.Error(w, "failed to create client", http.StatusInternalServerError)
				return
			}
		}

		room, err := hub.PrepareJoin(roomID, clientID, nickname)
		if err != nil {
			writeJoinHTTPError(w, err)
			return
		}

		role, err := hub.ClientRole(roomID, creatorToken)
		if err != nil {
			writeJoinHTTPError(w, err)
			return
		}

		claims := websocketJoinClaims{
			RoomID:   roomID,
			ClientID: clientID,
			Nickname: nickname,
			PIN:      pin,
			Avatar:   avatar,
		}
		wsToken, claims, err := tokens.Issue(claims)
		if err != nil {
			http.Error(w, "failed to issue websocket token", http.StatusInternalServerError)
			return
		}

		writeJSON(w, http.StatusOK, joinRoomResponse{
			Room: room,
			Client: joinClientResponse{
				ID:       clientID,
				Nickname: nickname,
				Avatar:   avatar,
			},
			WebSocketURL:    websocketTokenURL(r, roomID, wsToken),
			WebSocketToken:  wsToken,
			TokenExpiresIn:  int64(time.Until(claims.ExpiresAt).Seconds()),
			ProtocolVersion: protocolVersion,
			Role:            role,
			Capabilities:    capabilitiesForRole(role),
			Features: map[string]bool{
				"backgroundNativeTracking": true,
				"foregroundPWA":            true,
				"roles":                    true,
				"safetyEvents":             true,
				"wsToken":                  true,
			},
		})
	}
}

func capabilitiesForRole(role string) joinCapabilities {
	capabilities := joinCapabilities{
		CanViewRoom:         true,
		CanShareLocation:    true,
		CanSendSOS:          true,
		CanSendPanic:        true,
		CanWakeParticipants: true,
	}

	if role == realtime.ClientRoleCreator {
		capabilities.CanSetMeetingPoint = true
		capabilities.CanSetPerimeter = true
		capabilities.CanUpdateTTL = true
		capabilities.CanEndRoom = true
	}

	return capabilities
}

func websocketHandler(hub *realtime.Hub, tokens *websocketTokenStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		roomID := r.PathValue("roomID")
		if roomID == "" {
			http.Error(w, "missing room id", http.StatusBadRequest)
			return
		}

		nickname, pin, avatar, clientID, ok := websocketJoinIdentity(r, tokens, roomID)
		if !ok {
			http.Error(w, "invalid websocket token or join parameters", http.StatusUnauthorized)
			return
		}

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("websocket upgrade error: %v", err)
			return
		}

		sessionID, err := randomURLSafe(9)
		if err != nil {
			_ = conn.Close()
			return
		}

		client := realtime.NewClient(realtime.ClientConfig{
			ID:        clientID,
			SessionID: sessionID,
			Nickname:  nickname,
			PIN:       pin,
			Avatar:    avatar,
			Conn:      conn,
		})
		if err := hub.JoinRoom(roomID, client); err != nil {
			_ = conn.WriteJSON(joinErrorMessage(err))
			_ = conn.Close()
			return
		}

		go client.WritePump(hub)
		go client.ReadPump(hub, roomID)
	}
}

func websocketJoinIdentity(r *http.Request, tokens *websocketTokenStore, roomID string) (string, string, string, string, bool) {
	if token := strings.TrimSpace(r.URL.Query().Get("token")); token != "" {
		claims, ok := tokens.Consume(token, roomID)
		if !ok {
			return "", "", "", "", false
		}
		return claims.Nickname, claims.PIN, claims.Avatar, claims.ClientID, true
	}

	nickname := sanitizeNickname(r.URL.Query().Get("nick"))
	pin := strings.TrimSpace(r.URL.Query().Get("pin"))
	avatar := sanitizeAvatar(r.URL.Query().Get("avatar"))
	clientID := sanitizeClientID(r.URL.Query().Get("id"))

	if nickname == "" || !pinPattern.MatchString(pin) {
		return "", "", "", "", false
	}
	if avatar == "" {
		avatar = avatarSet[0]
	}
	if clientID == "" {
		var err error
		clientID, err = randomURLSafe(9)
		if err != nil {
			return "", "", "", "", false
		}
	}

	return nickname, pin, avatar, clientID, true
}

func joinErrorMessage(err error) realtime.OutboundMessage {
	if errors.Is(err, realtime.ErrNicknameTaken) {
		return realtime.OutboundMessage{
			Type: "error",
			Data: map[string]string{
				"code":    "nickname_taken",
				"message": "Ese mote ya está en uso en esta sala. Elige otro.",
			},
		}
	}
	return realtime.OutboundMessage{
		Type: "error",
		Data: map[string]string{
			"code":    "join_failed",
			"message": err.Error(),
		},
	}
}

func writeJoinHTTPError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, realtime.ErrRoomNotFound):
		http.Error(w, "room not found", http.StatusNotFound)
	case errors.Is(err, realtime.ErrNicknameTaken):
		http.Error(w, "nickname_taken", http.StatusConflict)
	case errors.Is(err, realtime.ErrRoomFull):
		http.Error(w, "room_full", http.StatusTooManyRequests)
	case errors.Is(err, realtime.ErrRoomClosed):
		http.Error(w, "room_closed", http.StatusGone)
	default:
		http.Error(w, "join_failed", http.StatusInternalServerError)
	}
}

func websocketTokenURL(r *http.Request, roomID string, token string) string {
	values := url.Values{}
	values.Set("token", token)
	return websocketURL(r, roomID, values)
}

func websocketURL(r *http.Request, roomID string, values url.Values) string {
	scheme := "ws"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "wss"
	}

	host := r.Host
	if forwardedHost := strings.TrimSpace(r.Header.Get("X-Forwarded-Host")); forwardedHost != "" {
		host = forwardedHost
	}

	return (&url.URL{
		Scheme:   scheme,
		Host:     host,
		Path:     "/ws/rooms/" + roomID,
		RawQuery: values.Encode(),
	}).String()
}
