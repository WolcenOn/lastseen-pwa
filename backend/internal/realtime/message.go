package realtime

import "time"

const (
	MinPerimeterRadiusMeters = 50
	MaxPerimeterRadiusMeters = 5000
)

// InboundMessage is intentionally compact to reduce payload size on saturated mobile networks.
type InboundMessage struct {
	Type string `json:"t"`

	Lat float64 `json:"lat,omitempty"`
	Lng float64 `json:"lng,omitempty"`

	BatteryLevel float64 `json:"bat,omitempty"`
	TargetID     string  `json:"target,omitempty"`
	PIN          string  `json:"pin,omitempty"`
	RadiusMeters int     `json:"radius,omitempty"`
}

func (m InboundMessage) Valid() bool {
	switch m.Type {
	case "loc":
		return validLatLng(m.Lat, m.Lng) && validBatteryLevel(m.BatteryLevel)
	case "panic":
		return true
	case "wake":
		return m.TargetID != ""
	case "sos":
		return validLatLng(m.Lat, m.Lng) && validBatteryLevel(m.BatteryLevel)
	case "disconnect":
		return m.PIN != ""
	case "meet":
		return validLatLng(m.Lat, m.Lng)
	case "perimeter":
		return validLatLng(m.Lat, m.Lng) && m.RadiusMeters >= MinPerimeterRadiusMeters && m.RadiusMeters <= MaxPerimeterRadiusMeters
	default:
		return false
	}
}

type OutboundMessage struct {
	Type string `json:"t"`
	Data any    `json:"d,omitempty"`
}

type PublicRoom struct {
	ID        string       `json:"id"`
	Name      string       `json:"name"`
	CreatedAt time.Time    `json:"createdAt"`
	ExpiresIn int64        `json:"expiresIn"`
	TTL       int64        `json:"ttl"`
	MaxFree   int          `json:"maxFree"`
	Closed    bool         `json:"closed"`
	Safety    PublicSafety `json:"safety"`
}

type PublicSafety struct {
	MeetingPoint *PublicMeetingPoint `json:"meetingPoint,omitempty"`
	Perimeter    *PublicPerimeter    `json:"perimeter,omitempty"`
}

type PublicMeetingPoint struct {
	Lat       float64   `json:"lat"`
	Lng       float64   `json:"lng"`
	SetBy     string    `json:"setBy,omitempty"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type PublicPerimeter struct {
	Lat          float64   `json:"lat"`
	Lng          float64   `json:"lng"`
	RadiusMeters int       `json:"radius"`
	SetBy        string    `json:"setBy,omitempty"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

type RoomSnapshot struct {
	Room    PublicRoom     `json:"room"`
	Clients []PublicClient `json:"clients"`
	Safety  PublicSafety   `json:"safety"`
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

func validBatteryLevel(value float64) bool {
	return value >= 0 && value <= 1
}
