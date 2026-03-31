/* ============================================================
   DISASTERWATCH · app.js
   Real-time disaster tracker using USGS + GDACS data
   ============================================================ */

/* ============================================================
   CONFIG
   ============================================================ */
const CONFIG = {
  map: {
    center: [15, 15],
    zoom: 2,
    minZoom: 2,
    maxZoom: 10,
  },
  apis: {
    // USGS: all M4.5+ earthquakes from the past 7 days (no API key needed)
    usgs: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson',
    // GDACS: global disaster alerts (cyclones + floods). We route through
    // allorigins.win to bypass browser CORS restrictions.
    gdacs: 'https://api.allorigins.win/raw?url=' +
           encodeURIComponent('https://www.gdacs.org/xml/rss.xml'),
  },
  colors: {
    earthquake: '#ff6230',
    cyclone:    '#818cf8',
    flood:      '#38bdf8',
  },
  refreshMs: 5 * 60 * 1000, // auto-refresh every 5 minutes
};

/* ============================================================
   STATE
   ============================================================ */
const STATE = {
  map:          null,
  layers:       [],   // { marker, layer, event }
  events:       [],   // all loaded events
  activeFilter: 'all',
  loading:      false,
};

/* ============================================================
   MAP INIT
   ============================================================ */
function initMap() {
  STATE.map = L.map('map', {
    center:     CONFIG.map.center,
    zoom:       CONFIG.map.zoom,
    minZoom:    CONFIG.map.minZoom,
    maxZoom:    CONFIG.map.maxZoom,
    zoomControl: false,
  });

  // Dark CartoDB basemap (no API key required)
  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
    {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' +
        ' &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 20,
    }
  ).addTo(STATE.map);

  // Place zoom control bottom-right
  L.control.zoom({ position: 'bottomright' }).addTo(STATE.map);

  // Show lat/lon on mousemove
  STATE.map.on('mousemove', (e) => {
    const lat = e.latlng.lat.toFixed(3);
    const lon = e.latlng.lng.toFixed(3);
    const coordEl = document.getElementById('coordText');
    if (coordEl) {
      coordEl.textContent =
        `LAT ${lat >= 0 ? '+' : ''}${lat}  ·  LON ${lon >= 0 ? '+' : ''}${lon}`;
    }
  });
}

/* ============================================================
   DATA: USGS EARTHQUAKES
   ============================================================ */
async function fetchEarthquakes() {
  const res = await fetch(CONFIG.apis.usgs);
  if (!res.ok) throw new Error('USGS fetch failed');
  const data = await res.json();

  return data.features.map((f) => ({
    id:        f.id,
    type:      'earthquake',
    title:     f.properties.title,
    place:     f.properties.place || 'Unknown location',
    magnitude: f.properties.mag,
    depth:     f.geometry.coordinates[2],
    lat:       f.geometry.coordinates[1],
    lon:       f.geometry.coordinates[0],
    time:      new Date(f.properties.time),
    url:       f.properties.url || '',
    severity:  magToSeverity(f.properties.mag),
  }));
}

function magToSeverity(m) {
  if (m >= 7.0) return 'critical';
  if (m >= 6.0) return 'high';
  if (m >= 5.0) return 'medium';
  return 'low';
}

/* ============================================================
   DATA: GDACS (CYCLONES + FLOODS via RSS)
   ============================================================ */
async function fetchGDACS() {
  const res = await fetch(CONFIG.apis.gdacs);
  if (!res.ok) throw new Error('GDACS fetch failed');
  const xmlText = await res.text();

  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, 'text/xml');
  const items = xml.querySelectorAll('item');

  const events = [];

  items.forEach((item, idx) => {
    // --- Event type ---
    const evtType = getXmlText(item, 'gdacs:eventtype') ||
                    getXmlText(item, 'eventtype') || '';

    // We only care about TC (Tropical Cyclone) and FL (Flood)
    const typeMap = { TC: 'cyclone', FL: 'flood' };
    const type = typeMap[evtType.trim().toUpperCase()];
    if (!type) return;

    // --- Coordinates ---
    const latRaw = getXmlText(item, 'geo:lat') ||
                   getXmlText(item, 'lat') || '0';
    const lonRaw = getXmlText(item, 'geo:long') ||
                   getXmlText(item, 'long') || '0';
    const lat = parseFloat(latRaw);
    const lon = parseFloat(lonRaw);
    if (!lat && !lon) return; // skip zero-zero

    // --- Other fields ---
    const titleRaw = item.querySelector('title')?.textContent?.trim() || 'Unknown event';
    const country  = getXmlText(item, 'gdacs:country') || 'Unknown location';
    const pubDate  = item.querySelector('pubDate')?.textContent || '';
    const link     = item.querySelector('link')?.textContent?.trim() || '';
    const alertLvl = getXmlText(item, 'gdacs:alertlevel') || '';
    const guid     = item.querySelector('guid')?.textContent?.trim() || `gdacs-${idx}`;

    events.push({
      id:        guid,
      type,
      title:     titleRaw,
      place:     country,
      magnitude: null,
      depth:     null,
      lat,
      lon,
      time:      pubDate ? new Date(pubDate) : new Date(),
      url:       link,
      severity:  alertToSeverity(alertLvl),
    });
  });

  return events;
}

/**
 * Helper: get text content of a namespaced XML element.
 * Tries various strategies because browser XML parsers handle namespaces
 * inconsistently.
 */
function getXmlText(parent, tagName) {
  // Strategy 1: direct querySelector
  try {
    const el = parent.querySelector(tagName);
    if (el) return el.textContent.trim();
  } catch (_) {}

  // Strategy 2: getElementsByTagName (strips namespace prefix automatically
  // in some browsers)
  const localName = tagName.includes(':') ? tagName.split(':')[1] : tagName;
  const byTag = parent.getElementsByTagName(tagName);
  if (byTag.length) return byTag[0].textContent.trim();

  // Strategy 3: iterate all descendants and match localName
  const all = parent.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === localName) return all[i].textContent.trim();
  }

  return '';
}

function alertToSeverity(level) {
  const l = level.toLowerCase();
  if (l === 'red')    return 'critical';
  if (l === 'orange') return 'high';
  if (l === 'green')  return 'medium';
  return 'low';
}

/* ============================================================
   MARKERS
   ============================================================ */
function clearMarkers() {
  STATE.layers.forEach(({ marker }) => {
    if (marker) STATE.map.removeLayer(marker);
  });
  STATE.layers = [];
}

function addMarkersForEvents(events) {
  events.forEach((ev) => {
    if (!ev.lat || !ev.lon) return;
    const marker = createMarker(ev);
    if (marker) {
      marker.addTo(STATE.map);
      STATE.layers.push({ marker, event: ev });
    }
  });
}

function createMarker(ev) {
  const color   = CONFIG.colors[ev.type];
  const size    = getMarkerSize(ev);
  const htmlStr = buildMarkerHTML(ev.type, color, size);

  const icon = L.divIcon({
    html:       htmlStr,
    className:  '',              // no default Leaflet class
    iconSize:   [size * 4, size * 4],
    iconAnchor: [size * 2, size * 2],
    popupAnchor:[0, -size * 2],
  });

  const marker = L.marker([ev.lat, ev.lon], { icon });

  // Popup
  marker.bindPopup(buildPopupHTML(ev), {
    className:    'custom-popup',
    maxWidth:     280,
    closeButton:  true,
    autoPan:      true,
  });

  // Open popup on hover (desktop) + click (all)
  marker.on('mouseover', () => marker.openPopup());

  return marker;
}

function getMarkerSize(ev) {
  if (ev.type === 'earthquake') {
    const mag = ev.magnitude || 4.5;
    return Math.max(5, Math.round((mag - 4) * 4.5 + 5));
  }
  const sevMap = { critical: 14, high: 11, medium: 8, low: 6 };
  return sevMap[ev.severity] || 7;
}

function buildMarkerHTML(type, color, size) {
  const half  = size * 2;   // icon total half-width
  const core  = size;       // actual dot radius

  if (type === 'earthquake') {
    return `
      <div class="dw-marker" style="width:${half*2}px;height:${half*2}px;">
        <div class="dw-pulse"   style="width:${core*2}px;height:${core*2}px;background:${color};"></div>
        <div class="dw-pulse-2" style="width:${core*2}px;height:${core*2}px;background:${color};"></div>
        <div class="dw-core"    style="width:${core}px;height:${core}px;background:${color};box-shadow:0 0 ${core*2}px ${color};"></div>
      </div>`;
  }

  if (type === 'cyclone') {
    return `
      <div class="dw-marker" style="width:${half*2}px;height:${half*2}px;">
        <div class="dw-spin"  style="width:${core*2+6}px;height:${core*2+6}px;border-top:2px solid ${color};border-right:2px solid transparent;"></div>
        <div class="dw-pulse" style="width:${core*2}px;height:${core*2}px;background:${color};"></div>
        <div class="dw-core"  style="width:${core}px;height:${core}px;background:${color};box-shadow:0 0 ${core*2}px ${color};"></div>
      </div>`;
  }

  if (type === 'flood') {
    return `
      <div class="dw-marker" style="width:${half*2}px;height:${half*2}px;">
        <div class="dw-ripple"   style="width:${core*2}px;height:${core*2}px;border-color:${color};"></div>
        <div class="dw-ripple dw-ripple-2" style="width:${core*2}px;height:${core*2}px;border-color:${color};"></div>
        <div class="dw-ripple dw-ripple-3" style="width:${core*2}px;height:${core*2}px;border-color:${color};"></div>
        <div class="dw-core" style="width:${core}px;height:${core}px;background:${color};box-shadow:0 0 ${core*2}px ${color};"></div>
      </div>`;
  }

  return '';
}

/* ============================================================
   POPUP HTML
   ============================================================ */
function buildPopupHTML(ev) {
  const typeLabels = {
    earthquake: 'SEISMIC EVENT',
    cyclone:    'TROPICAL CYCLONE / STORM',
    flood:      'FLOOD ALERT',
  };
  const typeClass = `${ev.type}-popup`;
  const timeStr   = ev.time.toUTCString().replace(' GMT', ' UTC');

  const magBlock = (ev.type === 'earthquake' && ev.magnitude != null) ? `
    <div style="margin-bottom:10px;">
      <div class="popup-mag-big">${ev.magnitude.toFixed(1)}</div>
      <span class="popup-mag-label">RICHTER MAGNITUDE</span>
    </div>` : '';

  const depthBlock = (ev.depth != null) ? `
    <div class="popup-row">
      <span class="popup-icon">▾</span>
      <span>Depth: <strong>${Math.round(ev.depth)} km</strong></span>
    </div>` : '';

  const linkBlock = ev.url ? `
    <a href="${ev.url}" target="_blank" rel="noopener noreferrer" class="popup-link">
      VIEW FULL REPORT →
    </a>` : '';

  return `
    <div class="popup-wrap">
      <div class="popup-top ${typeClass}">
        <div class="popup-type">${typeLabels[ev.type] || ev.type.toUpperCase()}</div>
        <div class="popup-sev ${ev.severity}">${ev.severity.toUpperCase()}</div>
      </div>
      <div class="popup-body">
        <div class="popup-title">${ev.title}</div>
        ${magBlock}
        ${depthBlock}
        <div class="popup-row">
          <span class="popup-icon">◎</span>
          <span>${ev.place}</span>
        </div>
        <div class="popup-row">
          <span class="popup-icon">◷</span>
          <span style="font-family:'Fira Code',monospace;font-size:10px;">${timeStr}</span>
        </div>
        ${linkBlock}
      </div>
    </div>`;
}

/* ============================================================
   SIDEBAR
   ============================================================ */
function renderSidebar(filter = 'all') {
  const listEl   = document.getElementById('disasterList');
  const countEl  = document.getElementById('eventCount');
  const filtered = filter === 'all'
    ? STATE.events
    : STATE.events.filter((e) => e.type === filter);

  countEl.textContent = `${filtered.length} EVENT${filtered.length !== 1 ? 'S' : ''}`;

  if (!filtered.length) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div>NO ${filter === 'all' ? '' : filter.toUpperCase() + ' '}EVENTS FOUND</div>
        <div style="font-size:10px;margin-top:6px;">
          Data may be loading or unavailable
        </div>
      </div>`;
    return;
  }

  // Sort: most recent first
  const sorted = [...filtered].sort((a, b) => b.time - a.time);

  listEl.innerHTML = sorted.map((ev) => buildCardHTML(ev)).join('');

  // Click → fly to marker and open popup
  listEl.querySelectorAll('.event-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id    = card.dataset.id;
      const ev    = STATE.events.find((e) => e.id === id);
      if (!ev) return;
      STATE.map.flyTo([ev.lat, ev.lon], 6, { duration: 1.2, easeLinearity: 0.4 });
      const layerData = STATE.layers.find((l) => l.event.id === id);
      if (layerData?.marker) {
        setTimeout(() => layerData.marker.openPopup(), 1300);
      }
    });
  });
}

function buildCardHTML(ev) {
  const typeIcons = { earthquake: '⚡', cyclone: '🌀', flood: '🌊' };
  const magBadge  = (ev.type === 'earthquake' && ev.magnitude != null)
    ? `<span class="card-mag">M${ev.magnitude.toFixed(1)}</span>` : '';
  const typeLabel = ev.type.toUpperCase();

  return `
    <div class="event-card ${ev.type}-card" data-id="${ev.id}">
      <div class="card-strip"></div>
      <div class="card-inner">
        <div class="card-icon-box">${typeIcons[ev.type] || '●'}</div>
        <div class="card-text">
          <div class="card-row1">
            <span class="card-type-tag">${typeLabel}</span>
            ${magBadge}
            <span class="card-sev-dot ${ev.severity}"></span>
          </div>
          <div class="card-place">${truncate(ev.place, 38)}</div>
          <div class="card-time">${timeAgo(ev.time)}</div>
        </div>
      </div>
    </div>`;
}

/* ============================================================
   STATS
   ============================================================ */
function updateStats() {
  const eqs   = STATE.events.filter((e) => e.type === 'earthquake');
  const tcs   = STATE.events.filter((e) => e.type === 'cyclone');
  const fls   = STATE.events.filter((e) => e.type === 'flood');
  const maxMg = eqs.length
    ? Math.max(...eqs.map((e) => e.magnitude || 0))
    : 0;

  countUp('eqCount', eqs.length);
  countUp('tcCount', tcs.length);
  countUp('flCount', fls.length);

  document.getElementById('maxMag').textContent = maxMg
    ? maxMg.toFixed(1) : '—';

  // Global threat level
  const total   = eqs.length + tcs.length + fls.length;
  const hasCrit = STATE.events.some((e) => e.severity === 'critical');
  const hasHigh = STATE.events.some((e) => e.severity === 'high');
  const threatEl = document.getElementById('globalThreat');
  if (threatEl) {
    if (hasCrit) {
      threatEl.textContent = 'CRITICAL';
      threatEl.style.color = 'var(--critical)';
    } else if (hasHigh) {
      threatEl.textContent = 'ELEVATED';
      threatEl.style.color = 'var(--high)';
    } else if (total > 0) {
      threatEl.textContent = 'MODERATE';
      threatEl.style.color = 'var(--medium)';
    } else {
      threatEl.textContent = 'NOMINAL';
      threatEl.style.color = 'var(--low)';
    }
  }
}

function countUp(id, target) {
  const el    = document.getElementById(id);
  if (!el) return;
  const start = parseInt(el.textContent) || 0;
  if (start === target) return;
  const dur   = 700;
  const fps   = 60;
  const steps = Math.round(dur / (1000 / fps));
  let cur     = start;
  let step    = 0;

  const timer = setInterval(() => {
    step++;
    cur = Math.round(start + (target - start) * easeOut(step / steps));
    el.textContent = cur;
    if (step >= steps) {
      el.textContent = target;
      clearInterval(timer);
    }
  }, 1000 / fps);
}

function easeOut(t) {
  return 1 - Math.pow(1 - t, 3);
}

/* ============================================================
   MAIN DATA LOAD
   ============================================================ */
async function loadData() {
  if (STATE.loading) return;
  STATE.loading = true;

  // Show loading state in sidebar
  const listEl = document.getElementById('disasterList');
  listEl.innerHTML = `
    <div class="loading-state">
      <div class="radar-spinner">
        <div class="radar-sweep"></div>
        <div class="radar-ring r1"></div>
        <div class="radar-ring r2"></div>
        <div class="radar-ring r3"></div>
      </div>
      <div class="loading-text fira">SCANNING GLOBAL FEEDS...</div>
    </div>`;

  try {
    // Fetch both in parallel; use allSettled so one failure doesn't
    // block the other
    const [eqResult, gdacsResult] = await Promise.allSettled([
      fetchEarthquakes(),
      fetchGDACS(),
    ]);

    let allEvents = [];

    if (eqResult.status === 'fulfilled') {
      allEvents = allEvents.concat(eqResult.value);
    } else {
      console.warn('[DisasterWatch] USGS fetch failed:', eqResult.reason);
    }

    if (gdacsResult.status === 'fulfilled') {
      allEvents = allEvents.concat(gdacsResult.value);
    } else {
      console.warn('[DisasterWatch] GDACS fetch failed:', gdacsResult.reason);
    }

    STATE.events = allEvents;

    // Re-render map markers
    clearMarkers();
    addMarkersForEvents(allEvents);

    // Update UI
    updateStats();
    renderSidebar(STATE.activeFilter);

    // Timestamp
    const now = new Date();
    const utcStr = now.toUTCString().split(' ').slice(4, 5).join(' ') + ' UTC';
    const lastEl = document.getElementById('lastUpdated');
    if (lastEl) lastEl.textContent = utcStr;

    if (allEvents.length === 0) {
      listEl.innerHTML = `
        <div class="error-state">
          <div>⚠ NO DATA RECEIVED</div>
          <div style="margin-top:8px;font-size:10px;">
            API sources may be unavailable.<br/>Try refreshing.
          </div>
        </div>`;
    }
  } catch (err) {
    console.error('[DisasterWatch] Unexpected error:', err);
    listEl.innerHTML = `
      <div class="error-state">
        <div>⚠ FEED ERROR</div>
        <div style="margin-top:8px;font-size:10px;">
          Could not retrieve data.<br/>
          Check your connection and refresh.
        </div>
      </div>`;
  }

  STATE.loading = false;
}

/* ============================================================
   FILTER TABS
   ============================================================ */
function initFilterTabs() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) =>
        b.classList.remove('active'));
      btn.classList.add('active');
      STATE.activeFilter = btn.dataset.filter;
      renderSidebar(STATE.activeFilter);
    });
  });
}

/* ============================================================
   REFRESH BUTTON
   ============================================================ */
function initRefreshBtn() {
  const btn = document.getElementById('refreshBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    btn.style.opacity = '0.5';
    btn.style.pointerEvents = 'none';
    loadData().finally(() => {
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
    });
  });
}

/* ============================================================
   UTILITIES
   ============================================================ */
function timeAgo(date) {
  const sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 60)   return 'JUST NOW';
  const min = Math.floor(sec / 60);
  if (min < 60)   return `${min}M AGO`;
  const hr  = Math.floor(min / 60);
  if (hr < 24)    return `${hr}H AGO`;
  const day = Math.floor(hr / 24);
  return `${day}D AGO`;
}

function truncate(str, n) {
  if (!str) return '';
  return str.length > n ? str.slice(0, n) + '…' : str;
}

/* ============================================================
   BOOT
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initFilterTabs();
  initRefreshBtn();
  loadData();

  // Auto-refresh
  setInterval(loadData, CONFIG.refreshMs);
});
