package realtime

import (
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const sendBufferSize = 16

type ClientConfig struct {
	ID       string
	Nickname string
	PIN      string
	Avatar   string
	Conn     *websocket.Conn
}

type Client struct {
	ID       string
	Nickname string
	PIN      string
	Avatar   string

	Conn *websocket.Conn
	send chan OutboundMessage
	once sync.Once

	Lat          float64
	Lng          float64
	BatteryLevel float64

	Connected     bool
	GeofenceAlert bool
	SOS           bool
	LastSeen      time.Time
}

func NewClient(config ClientConfig) *Client {
	return &Client{
		ID:        config.ID,
		Nickname:  config.Nickname,
		PIN:       config.PIN,
		Avatar:    config.Avatar,
		Conn:      config.Conn,
		send:      make(chan OutboundMessage, sendBufferSize),
		Connected: true,
		LastSeen:  time.Now().UTC(),
	}
}

func (c *Client) ReadPump(hub *Hub, roomID string) {
	defer func() {
		hub.LeaveRoom(roomID, c.ID)
		_ = c.Conn.Close()
	}()

	c.Conn.SetReadLimit(512)

	pongWait := hub.config.ClientPongWait
	if pongWait <= 0 {
		pongWait = 60 * time.Second
	}

	_ = c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	c.Conn.SetPongHandler(func(string) error {
		return c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		var msg InboundMessage
		if err := c.Conn.ReadJSON(&msg); err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("websocket read error client=%s err=%v", c.ID, err)
			}
			return
		}

		if !msg.Valid() {
			continue
		}

		hub.HandleClientMessage(roomID, c.ID, msg)
	}
}

func (c *Client) WritePump(hub *Hub) {
	pingPeriod := hub.config.ClientPingPeriod
	if pingPeriod <= 0 {
		pingPeriod = 45 * time.Second
	}

	writeWait := hub.config.ClientWriteWait
	if writeWait <= 0 {
		writeWait = 8 * time.Second
	}

	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		_ = c.Conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.send:
			_ = c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.Conn.WriteJSON(msg); err != nil {
				return
			}

		case <-ticker.C:
			_ = c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) Send(msg OutboundMessage) {
	defer func() {
		_ = recover()
	}()

	select {
	case c.send <- msg:
	default:
		c.CloseSend()
	}
}

func (c *Client) CloseSend() {
	c.once.Do(func() {
		close(c.send)
	})
}

func (c *Client) Close() {
	c.CloseSend()
	_ = c.Conn.Close()
}

func (c *Client) Clone() *Client {
	copy := *c
	copy.Conn = nil
	copy.send = nil
	copy.PIN = ""
	return &copy
}
