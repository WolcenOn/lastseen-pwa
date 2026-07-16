package realtime

import "testing"

func TestInboundLocationMessageValidation(t *testing.T) {
	valid := InboundMessage{Type: "loc", Lat: 40.4168, Lng: -3.7038, BatteryLevel: 0.75}
	if !valid.Valid() {
		t.Fatal("expected valid location message")
	}

	cases := []InboundMessage{
		{Type: "loc", Lat: 0, Lng: 0, BatteryLevel: 0.5},
		{Type: "loc", Lat: 91, Lng: 0, BatteryLevel: 0.5},
		{Type: "loc", Lat: -91, Lng: 0, BatteryLevel: 0.5},
		{Type: "loc", Lat: 40, Lng: 181, BatteryLevel: 0.5},
		{Type: "loc", Lat: 40, Lng: -181, BatteryLevel: 0.5},
		{Type: "loc", Lat: 40, Lng: -3, BatteryLevel: -0.01},
		{Type: "loc", Lat: 40, Lng: -3, BatteryLevel: 1.01},
	}

	for _, msg := range cases {
		if msg.Valid() {
			t.Fatalf("expected invalid location message: %+v", msg)
		}
	}
}

func TestInboundPerimeterMessageValidation(t *testing.T) {
	valid := InboundMessage{Type: "perimeter", Lat: 40.4168, Lng: -3.7038, RadiusMeters: 250}
	if !valid.Valid() {
		t.Fatal("expected valid perimeter message")
	}

	cases := []InboundMessage{
		{Type: "perimeter", Lat: 40, Lng: -3, RadiusMeters: MinPerimeterRadiusMeters - 1},
		{Type: "perimeter", Lat: 40, Lng: -3, RadiusMeters: MaxPerimeterRadiusMeters + 1},
		{Type: "perimeter", Lat: 0, Lng: 0, RadiusMeters: 250},
		{Type: "perimeter", Lat: 95, Lng: -3, RadiusMeters: 250},
	}

	for _, msg := range cases {
		if msg.Valid() {
			t.Fatalf("expected invalid perimeter message: %+v", msg)
		}
	}
}

func TestInboundControlMessageValidation(t *testing.T) {
	if !((InboundMessage{Type: "disconnect", PIN: "1234"}).Valid()) {
		t.Fatal("expected valid disconnect with PIN")
	}
	if (InboundMessage{Type: "disconnect"}).Valid() {
		t.Fatal("expected disconnect without PIN to be invalid")
	}
	if !((InboundMessage{Type: "wake", TargetID: "client-1"}).Valid()) {
		t.Fatal("expected wake with target to be valid")
	}
	if (InboundMessage{Type: "wake"}).Valid() {
		t.Fatal("expected wake without target to be invalid")
	}
	if (InboundMessage{Type: "unknown"}).Valid() {
		t.Fatal("expected unknown message type to be invalid")
	}
}
