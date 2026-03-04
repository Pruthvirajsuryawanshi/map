const map = L.map('map').setView([37.7749, -122.4194], 13);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const settings = {
  averageSpeedKmh: 35,
  signalProximityMeters: 45,
  cycle: {
    GREEN: 18,
    YELLOW: 4,
    RED: 20
  }
};

const signals = [
  { id: 'SIG-101', lat: 37.7793, lng: -122.4192, roadName: 'Van Ness Ave' },
  { id: 'SIG-102', lat: 37.7765, lng: -122.4252, roadName: 'Fell St' },
  { id: 'SIG-103', lat: 37.7711, lng: -122.4218, roadName: 'Market St' },
  { id: 'SIG-104', lat: 37.7684, lng: -122.4148, roadName: 'Mission St' },
  { id: 'SIG-105', lat: 37.7821, lng: -122.4118, roadName: 'Bush St' }
];

const signalRuntime = new Map();
const signalLayers = new Map();
let activeRoute = null;

function createSignalIcon(state, onRoute = false) {
  const stateClass = `signal-${state.toLowerCase()}`;
  const routeClass = onRoute ? 'signal-on-route' : '';
  return L.divIcon({
    className: '',
    html: `<div class="signal-marker ${stateClass} ${routeClass}"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });
}

function totalCycleDuration() {
  return settings.cycle.GREEN + settings.cycle.YELLOW + settings.cycle.RED;
}

function stateByElapsed(elapsed) {
  const cycleLength = totalCycleDuration();
  const t = ((elapsed % cycleLength) + cycleLength) % cycleLength;

  if (t < settings.cycle.GREEN) {
    return { state: 'GREEN', stateElapsed: t, remaining: settings.cycle.GREEN - t };
  }

  if (t < settings.cycle.GREEN + settings.cycle.YELLOW) {
    const stateElapsed = t - settings.cycle.GREEN;
    return { state: 'YELLOW', stateElapsed, remaining: settings.cycle.YELLOW - stateElapsed };
  }

  const stateElapsed = t - settings.cycle.GREEN - settings.cycle.YELLOW;
  return { state: 'RED', stateElapsed, remaining: settings.cycle.RED - stateElapsed };
}

function waitingTimeAtArrival(signalInfo, arrivalSec) {
  const cycleLength = totalCycleDuration();
  const arrivalOffset = (signalInfo.elapsed + arrivalSec) % cycleLength;
  const stateAtArrival = stateByElapsed(arrivalOffset);
  return stateAtArrival.state === 'RED' ? stateAtArrival.remaining : 0;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (deg) => deg * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function closestDistanceToRoute(signal, routeCoordinates) {
  let best = Number.POSITIVE_INFINITY;

  for (let i = 0; i < routeCoordinates.length; i += 1) {
    const p = routeCoordinates[i];
    const d = haversineMeters(signal, { lat: p.lat, lng: p.lng });
    if (d < best) best = d;
  }

  return best;
}

function cumulativeDistanceToClosestPoint(signal, routeCoordinates) {
  let bestDist = Number.POSITIVE_INFINITY;
  let bestIndex = 0;

  for (let i = 0; i < routeCoordinates.length; i += 1) {
    const p = routeCoordinates[i];
    const d = haversineMeters(signal, { lat: p.lat, lng: p.lng });
    if (d < bestDist) {
      bestDist = d;
      bestIndex = i;
    }
  }

  let cumulative = 0;
  for (let i = 1; i <= bestIndex; i += 1) {
    cumulative += haversineMeters(
      { lat: routeCoordinates[i - 1].lat, lng: routeCoordinates[i - 1].lng },
      { lat: routeCoordinates[i].lat, lng: routeCoordinates[i].lng }
    );
  }

  return cumulative;
}

function renderPrediction(info) {
  const fields = {
    id: document.getElementById('pred-id'),
    road: document.getElementById('pred-road'),
    distance: document.getElementById('pred-distance'),
    state: document.getElementById('pred-state'),
    arrival: document.getElementById('pred-arrival'),
    wait: document.getElementById('pred-wait')
  };

  if (!info) {
    fields.id.textContent = 'No signal on route';
    fields.road.textContent = '—';
    fields.distance.textContent = '—';
    fields.state.textContent = '—';
    fields.arrival.textContent = '—';
    fields.wait.textContent = '—';
    return;
  }

  fields.id.textContent = info.id;
  fields.road.textContent = info.roadName;
  fields.distance.textContent = `${info.distanceMeters.toFixed(0)} m`;
  fields.state.textContent = info.state;
  fields.arrival.textContent = `${info.arrivalSec.toFixed(1)} s`;
  fields.wait.textContent = `${info.waitSec.toFixed(1)} s`;
}

function updateSignalMarkers(routeSignals = new Set()) {
  signals.forEach((signal) => {
    const runtime = signalRuntime.get(signal.id);
    const stateInfo = stateByElapsed(runtime.elapsed);
    runtime.state = stateInfo.state;

    const marker = signalLayers.get(signal.id);
    marker.setIcon(createSignalIcon(runtime.state, routeSignals.has(signal.id)));
    marker.getPopup().setContent(
      `<b>${signal.id}</b><br/>${signal.roadName}<br/>State: ${runtime.state}`
    );
  });
}

function analyzeRoute(routeCoordinates) {
  const inRangeSignals = [];

  signals.forEach((signal) => {
    const distanceToRoute = closestDistanceToRoute(signal, routeCoordinates);

    if (distanceToRoute <= settings.signalProximityMeters) {
      const distanceFromStart = cumulativeDistanceToClosestPoint(signal, routeCoordinates);
      const runtime = signalRuntime.get(signal.id);
      const stateInfo = stateByElapsed(runtime.elapsed);
      const speedMps = (settings.averageSpeedKmh * 1000) / 3600;
      const arrivalSec = distanceFromStart / speedMps;
      const waitSec = waitingTimeAtArrival(runtime, arrivalSec);

      inRangeSignals.push({
        ...signal,
        distanceToRoute,
        distanceMeters: distanceFromStart,
        state: stateInfo.state,
        arrivalSec,
        waitSec
      });
    }
  });

  inRangeSignals.sort((a, b) => a.distanceMeters - b.distanceMeters);
  const nextSignal = inRangeSignals[0] || null;
  const routeSignalIds = new Set(inRangeSignals.map((signal) => signal.id));

  updateSignalMarkers(routeSignalIds);
  renderPrediction(nextSignal);
}

function initSignals() {
  signals.forEach((signal, idx) => {
    const offset = idx * 5;
    const initState = stateByElapsed(offset);

    signalRuntime.set(signal.id, {
      elapsed: offset,
      state: initState.state
    });

    const marker = L.marker([signal.lat, signal.lng], {
      icon: createSignalIcon(initState.state)
    }).addTo(map);

    marker.bindPopup(`<b>${signal.id}</b><br/>${signal.roadName}<br/>State: ${initState.state}`);
    signalLayers.set(signal.id, marker);
  });
}

function tickSignals() {
  signalRuntime.forEach((runtime) => {
    runtime.elapsed += 1;
  });

  if (activeRoute) {
    analyzeRoute(activeRoute);
  } else {
    updateSignalMarkers();
  }
}

function initRouting() {
  const routingControl = L.Routing.control({
    waypoints: [
      L.latLng(37.7836, -122.4089),
      L.latLng(37.7676, -122.4281)
    ],
    routeWhileDragging: true,
    addWaypoints: true,
    draggableWaypoints: true,
    showAlternatives: false,
    fitSelectedRoutes: true,
    lineOptions: {
      styles: [{ color: '#38bdf8', opacity: 0.9, weight: 6 }]
    },
    createMarker(i, waypoint, n) {
      return L.marker(waypoint.latLng, {
        draggable: true,
        title: i === 0 ? 'Start' : i === n - 1 ? 'Destination' : `Waypoint ${i + 1}`
      });
    }
  }).addTo(map);

  routingControl.on('routesfound', (event) => {
    const route = event.routes[0];
    activeRoute = route.coordinates;
    analyzeRoute(activeRoute);
  });
}

function initCoordDebugger() {
  const debug = document.getElementById('debug-coords');
  map.on('click', (event) => {
    const { lat, lng } = event.latlng;
    debug.textContent = `Lat: ${lat.toFixed(6)}, Lng: ${lng.toFixed(6)}`;

    L.popup()
      .setLatLng(event.latlng)
      .setContent(`Lat: ${lat.toFixed(6)}<br/>Lng: ${lng.toFixed(6)}`)
      .openOn(map);
  });
}

function initControls() {
  const speedInput = document.getElementById('speed-input');
  const recalcButton = document.getElementById('recalculate-btn');

  speedInput.addEventListener('input', () => {
    settings.averageSpeedKmh = Math.max(5, Number(speedInput.value) || 35);
  });

  recalcButton.addEventListener('click', () => {
    if (activeRoute) {
      analyzeRoute(activeRoute);
    }
  });
}

initSignals();
initRouting();
initCoordDebugger();
initControls();
setInterval(tickSignals, 1000);
