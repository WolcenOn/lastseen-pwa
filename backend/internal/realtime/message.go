package realtime

import "time"

// InboundMessage is intentionally compact to reduce payload size on saturated mobile networks.
type InboundMessage struct {
	Type string `json:"t"`

	Lat float64 `json:"lat,omitempty"`
	Lng float64 `json:"lng,omitempty"`

	BatteryLevel float64 `json:"bat,omitempty"`
	TargetID     string  `json:"target,omitempty"`
	PIN          string  `json:"pin,omitempty"`
}

func (m InboundMessage) Valid() bool {
	switch m.Type {
	case "loc":
		return validLatLng(m.Lat, m.Lng)
	case "panic":
		return true
	case "wake":
		return m.TargetID != ""
	case "sos":
		return validLatLng(m.Lat, m.Lng)
	case "disconnect":
		return m.PIN != ""
	default:
		return false
	}
}

type OutboundMessage struct {
	Type string `json:"t"`
	Data any    `json:"d,omitempty"`
}

type PublicRoom struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresIn int64     `json:"expiresIn"`
	MaxFree   int       `json:"maxFree"`
}

type RoomSnapshot struct {
	Room    PublicRoom     `json:"room"`
	Clients []PublicClient `json:"clients"`
}

type PublicClient struct {
	ID       string `json:"id"`
	Nickname string `json:"nick"`
	Avatar   string `json:"avatar"`

	Lat float64 `json:"lat,omitempty"`
	Lng float64 `json:"lng,omitempty"`

	BatteryLevel float64 `json:"bat,omitempty"`

	Connected     bool      `json:"on"`
	GeofenceAlert bool      `json:"geo,omitempty"`
	SOS           bool      `json:"sos,omitempty"`
	LastSeen      time.Time `json:"seen"`
}

func validLatLng(lat, lng float64) bool {
	return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat == 0 && lng == 0)
}
