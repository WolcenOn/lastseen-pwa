const DEFAULT_PERIMETER_RADIUS = 250;

export function attachMapZoneDrawer(map, Leaflet = globalThis.L) {
  if (!map || !Leaflet) throw new Error("map and Leaflet are required");

  let meetingMarker = null;
  let perimeterCircle = null;
  let perimeterCenterMarker = null;

  function drawMeetingPoint(point) {
    const coords = normalizeLatLng(point);
    if (!coords) return false;

    const icon = Leaflet.divIcon({
      className: "",
      html: '<div class="meeting-marker zone-marker">📍</div>',
      iconSize: [44, 44],
      iconAnchor: [22, 38],
      popupAnchor: [0, -34]
    });

    if (meetingMarker) {
      meetingMarker.setLatLng(coords);
      meetingMarker.setIcon(icon);
    } else {
      meetingMarker = Leaflet.marker(coords, { icon, zIndexOffset: 900 }).addTo(map);
    }

    meetingMarker.bindPopup("Punto de encuentro");
    bringToFront(meetingMarker);
    refreshMap(map);
    return true;
  }

  function drawPerimeter(perimeter) {
    const coords = normalizeLatLng(perimeter);
    if (!coords) return false;

    const radius = normalizeRadius(perimeter?.radius ?? perimeter?.radiusMeters);
    const circleOptions = {
      radius,
      weight: 4,
      opacity: 0.95,
      fillOpacity: 0.18,
      interactive: true,
      className: "lastseen-perimeter-zone"
    };

    if (perimeterCircle) {
      perimeterCircle.setLatLng(coords);
      perimeterCircle.setRadius(radius);
      perimeterCircle.setStyle(circleOptions);
    } else {
      perimeterCircle = Leaflet.circle(coords, circleOptions).addTo(map);
    }

    const centerIcon = Leaflet.divIcon({
      className: "",
      html: `<div class="perimeter-center-marker zone-marker">◎<span>${radius} m</span></div>`,
      iconSize: [72, 34],
      iconAnchor: [36, 17],
      popupAnchor: [0, -18]
    });

    if (perimeterCenterMarker) {
      perimeterCenterMarker.setLatLng(coords);
      perimeterCenterMarker.setIcon(centerIcon);
    } else {
      perimeterCenterMarker = Leaflet.marker(coords, { icon: centerIcon, zIndexOffset: 950 }).addTo(map);
    }

    perimeterCircle.bindPopup(`Perímetro: ${radius} m`);
    perimeterCenterMarker.bindPopup(`Centro del perímetro · ${radius} m`);
    bringToFront(perimeterCircle);
    bringToFront(perimeterCenterMarker);
    refreshMap(map);
    return true;
  }

  function clearMeetingPoint() {
    if (meetingMarker) meetingMarker.remove();
    meetingMarker = null;
  }

  function clearPerimeter() {
    if (perimeterCircle) perimeterCircle.remove();
    if (perimeterCenterMarker) perimeterCenterMarker.remove();
    perimeterCircle = null;
    perimeterCenterMarker = null;
  }

  return {
    drawMeetingPoint,
    drawPerimeter,
    clearMeetingPoint,
    clearPerimeter
  };
}

export function normalizeLatLng(value) {
  const lat = Number(value?.lat);
  const lng = Number(value?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return [roundCoord(lat), roundCoord(lng)];
}

export function normalizeRadius(value) {
  const radius = Number(value || DEFAULT_PERIMETER_RADIUS);
  if (!Number.isFinite(radius)) return DEFAULT_PERIMETER_RADIUS;
  return Math.max(50, Math.min(5000, Math.round(radius)));
}

function bringToFront(layer) {
  try {
    layer?.bringToFront?.();
  } catch {
    // Some Leaflet layer types/plugins may not support bringToFront.
  }
}

function refreshMap(map) {
  [0, 80, 250].forEach(delay => setTimeout(() => map.invalidateSize?.(), delay));
}

function roundCoord(value) {
  return Math.round(Number(value) * 1000000) / 1000000;
}
