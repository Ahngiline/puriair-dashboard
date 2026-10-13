/*
  PURIAIR FRONTEND v11 — Firebase Realtime Database integration + Admin Manual Control
  -------------------------------------------------------------------
  Schema read from Firebase:
    devices/<device_id>/latest/<field>
    devices/<device_id>/control/<field>    (read + write by admin)
    devices/<device_id>/status/<field>     (read-only, from ESP32)
  Field names (from ESP32 firmware):
    latest:  clock_synced, co2_ppm, date, deviceId, device_uptime_ms,
             humidity_pct, motion, pm25_ug_m3, temperature_C, time,
             timestamp_ms, timezone
    control: mode, power, purifierFan, humidifier, dehumidifier
    status:  mode, power, purifierFan, humidifier, dehumidifier
  -------------------------------------------------------------------
  Public view opens as Student (read-only) by default.
  Admin logs in via modal: Username "Admin", Password "123admin".
  Firebase URL: https://puriair-databasse-default-rtdb.firebaseio.com/
  If Firebase is unreachable, the app falls back to a local demo simulation.

  v11 CHANGES
  - Added Anonymous Auth so the dashboard satisfies "auth != null" rules.
  - Added full Firebase config (apiKey, authDomain, etc.) to fix auth/invalid-api-key.
  - Replaced purifier command UI with four manual toggles:
    Power, Purifier Fan, Humidifier, Dehumidifier.
  - Humidifier and dehumidifier mutually exclude in the UI: turning one ON
    automatically turns the other OFF, matching the ESP32's own safety logic.
  - Command state and applied state (from /status) are tracked separately
    so the dashboard can show "waiting for device confirmation".
*/

/* =========================================================
   1. CONFIG & CONSTANTS
   ========================================================= */
const ADMIN_CREDENTIALS = { username: 'Admin', password: '123admin' };

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCWGuiR0hJlZ4OW03k1orR11Jo-6Kko3hM",
  authDomain: "puriair-databasse.firebaseapp.com",
  databaseURL: "https://puriair-databasse-default-rtdb.firebaseio.com",
  projectId: "puriair-databasse",
  storageBucket: "puriair-databasse.firebasestorage.app",
  messagingSenderId: "360587468296",
  appId: "1:360587468296:web:abb33b939f371d042dbbbd"
};

let db = null;
let firebaseReady = false;
let firebaseAuthReady = false;

const DEVICE_FRESH_MS = 120000;
const STALE_WARN_MS   = 5 * 60 * 1000;

const ASSIGNMENTS_KEY        = 'puriair_device_assignments_v1';
const AVAILABLE_DEVICES_KEY  = 'puriair_available_devices_v1';

const PAGE_TITLES = {
  puriair: 'PuriAir Project',
  overview: 'Environmental Overview',
  classrooms: 'Classroom Monitoring',
  settings: 'Admin Settings',
  sensors: 'Sensor Status',
  purifier: 'Purifier & Filter Maintenance',
  database: 'Database Logs',
  about: 'About PuriAir'
};

const ADMIN_ONLY_PAGES = ['settings', 'sensors', 'purifier', 'database'];

/* =========================================================
   2. STATE
   ========================================================= */
let classrooms     = [];
let selectedRoom   = '';
let selectedMetric = 'humidity';
let esp32Temperature = 43.6;
let currentRole    = 'student';
let lastFirebaseSnapshot = 0;
let rawFirebaseDevices = {};

let serverTimeOffset = 0;

/* Local mirror of the last control state we wrote to Firebase. */
let purifierControlState = {
  mode: 'auto',
  power: false,
  purifierFan: false,
  humidifier: false,
  dehumidifier: false
};

/* =========================================================
   3. UTILITIES
   ========================================================= */
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const room    = () => classrooms.find(r => r.id === selectedRoom) || classrooms[0] || null;
const isAdmin = () => currentRole === 'admin';
const statusLabel = s => (s || '').toUpperCase();
const currentPage = () => $('.nav-item.active')?.dataset.page || 'puriair';

function now() {
  return Date.now() + serverTimeOffset;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function valueClass(type, value) {
  if (type === 'co2')  return value > 1500 ? 'value-danger' : value > 1000 ? 'value-warn' : 'value-good';
  if (type === 'pm25') return value > 35   ? 'value-danger' : value > 15   ? 'value-warn' : 'value-good';
  return '';
}
function fmtDateTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString('en-PH', {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
}

/* =========================================================
   4. DEVICE ASSIGNMENT PERSISTENCE
   ========================================================= */
function loadAssignments() {
  try { return JSON.parse(localStorage.getItem(ASSIGNMENTS_KEY) || '{}'); }
  catch { return {}; }
}
function saveAssignments(data) {
  try { localStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(data)); } catch {}
}
function saveAvailableDevicesCache(list) {
  try { localStorage.setItem(AVAILABLE_DEVICES_KEY, JSON.stringify(list)); } catch {}
}
function assignedDeviceIds() {
  return Object.values(loadAssignments()).map(x => x.deviceId).filter(Boolean);
}
function availableDeviceIds() {
  const assigned = new Set(assignedDeviceIds());
  return Object.keys(rawFirebaseDevices).filter(id => !assigned.has(id));
}

/* =========================================================
   5. FIREBASE INIT (with Anonymous Auth)
   ========================================================= */
function initFirebase() {
  try {
    if (typeof firebase === 'undefined') {
      console.warn('[PuriAir] Firebase SDK not loaded — offline mode.');
      setFirebaseUiStatus('offline', 'Firebase SDK not loaded');
      return;
    }
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.database();
    firebaseReady = true;

    /* ---- Anonymous authentication ---- */
    if (firebase.auth) {
      firebase.auth().onAuthStateChanged(user => {
        if (user) {
          console.log('[PuriAir] Firebase auth ready. UID:', user.uid);
          firebaseAuthReady = true;
        } else {
          console.log('[PuriAir] No auth user — signing in anonymously…');
          firebase.auth().signInAnonymously()
            .then(cred => console.log('[PuriAir] Anonymous auth OK. UID:', cred.user.uid))
            .catch(err => console.warn('[PuriAir] Anonymous auth failed:', err.code, err.message));
        }
      });
    } else {
      console.warn('[PuriAir] firebase-auth-compat.js not loaded. Admin writes may fail.');
    }

    console.log('[PuriAir] Firebase initialized:', FIREBASE_CONFIG.databaseURL);
    setFirebaseUiStatus('connecting', 'Connecting…');
  } catch (err) {
    console.error('[PuriAir] Firebase init failed:', err);
    firebaseReady = false;
    setFirebaseUiStatus('offline', 'Init failed');
  }
}

function setFirebaseUiStatus(state, label) {
  const dot = $('#connectionDot');
  const lbl = $('#connectionLabel');
  const chip = $('#firebaseStatusChip');
  const healthDot = $('#systemHealthDot');
  const healthText = $('#systemHealthText');
  const healthSub = $('#systemHealthSub');
  const tel = $('#fbTelemetryStatus');
  const cmd = $('#fbCommandsStatus');

  const COLOR = {
    offline:    { dot: '#c93b3b', chip: 'critical', text: 'System Offline',  sub: label || 'Firebase unreachable' },
    connecting: { dot: '#d29a28', chip: 'moderate', text: 'Connecting…',      sub: label || 'Establishing connection' },
    idle:       { dot: '#8a8582', chip: 'moderate', text: 'Connected · Idle', sub: label || 'No devices publishing yet' },
    stale:      { dot: '#d29a28', chip: 'moderate', text: 'No Recent Data',   sub: label || 'Devices not reporting' },
    live:       { dot: '#36a96f', chip: 'safe',     text: 'System Online',    sub: label || 'Firebase sync ready' }
  };
  const c = COLOR[state] || COLOR.offline;

  const pillLabels = {
    offline: 'Offline',
    connecting: 'Connecting',
    idle: 'Idle',
    stale: 'No recent data',
    live: 'Live'
  };

  if (dot) dot.style.background = c.dot;
  if (lbl) lbl.textContent = label || pillLabels[state] || 'Unknown';
  if (chip) {
    chip.className = 'status-chip ' + c.chip;
    chip.textContent = state === 'live' ? 'READY' : (state === 'offline' ? 'OFFLINE' : state.toUpperCase());
  }
  if (healthDot) healthDot.style.background = c.dot;
  if (healthText) healthText.textContent = c.text;
  if (healthSub) healthSub.textContent = c.sub;
  if (tel) tel.textContent = state === 'live' ? 'Live stream' : (state === 'idle' ? 'Waiting for devices' : (state === 'stale' ? 'Stale' : 'Unavailable'));
  if (cmd) cmd.textContent = state === 'live' ? 'Live stream' : (state === 'idle' ? 'Waiting for devices' : (state === 'stale' ? 'Stale' : 'Unavailable'));
}

/* =========================================================
   6. FIREBASE → CLASSROOMS SYNC
   ========================================================= */
function normalizeDeviceToRoom(devId, node, assignment, lastSyncedMs) {
  const latest  = (node && node.latest) || {};
  const control = (node && node.control) || {};
  const status  = (node && node.status) || {};
  const classroomId = assignment.classroomId || devId;

  const co2         = num(latest.co2_ppm, 0);
  const pm25        = num(latest.pm25_ug_m3, 0);
  const temperature = num(latest.temperature_C, 0);
  const humidity    = num(latest.humidity_pct, 0);
  const motion      = latest.motion === true;
  const occupancy   = motion ? 1 : 0;

  const purifier = latest.purifier === true || (co2 > 1000 || pm25 > 20);

  const penalty =
    Math.max(0, (co2 - 500) / 35) +
    Math.max(0, (pm25 - 8) * 1.2) +
    Math.max(0, (humidity - 65) * 0.7);
  const chi = Math.max(20, Math.min(98, Math.round(96 - penalty - occupancy * 0.05)));

  const statusText =
    co2 > 1700 || pm25 > 35 ? 'critical' :
    co2 > 1250 || pm25 > 25 ? 'poor' :
    co2 > 950  || pm25 > 15 ? 'moderate' :
    'safe';

  const tsMs = num(latest.timestamp_ms, 0);
  const hasTimestamp = tsMs > 0;
  const ageMs = hasTimestamp ? (now() - tsMs) : Infinity;
  const fresh = hasTimestamp && ageMs < DEVICE_FRESH_MS;
  const online = latest.clock_synced === true && fresh;

  let lastSynced = lastSyncedMs || 0;
  if (hasTimestamp && tsMs > lastSynced && fresh) lastSynced = tsMs;

  return {
    id: classroomId,
    name: assignment.deviceName || `Classroom ${classroomId}`,
    deviceId: devId,
    chi, co2, pm25, temperature, humidity, occupancy, purifier,
    status: statusText,
    lastSynced,
    device: {
      esp32_temperature: num(latest.temperature_C, 0),
      online,
      hasTimestamp,
      ageMs: hasTimestamp ? ageMs : null,
      last_seen: tsMs || 0,
      device_id: latest.deviceId || devId,
      uptime_ms: num(latest.device_uptime_ms, 0),
      raw: { latest, control, status }
    },
    control: {
      mode: control.mode || 'auto',
      power: control.power === true,
      purifierFan: control.purifierFan === true,
      humidifier: control.humidifier === true,
      dehumidifier: control.dehumidifier === true
    }
  };
}

function buildClassroomsFromAssignments() {
  const assignments = loadAssignments();
  const built = [];
  Object.entries(assignments).forEach(([classroomId, a]) => {
    const devId = a.deviceId;
    const node  = rawFirebaseDevices[devId] || { latest: {}, control: {}, status: {} };
    const r = normalizeDeviceToRoom(devId, node, { ...a, classroomId, deviceName: a.deviceName || `Classroom ${classroomId}` }, a.lastSynced);
    built.push(r);

    if (r.device.online && r.lastSynced > (a.lastSynced || 0)) {
      assignments[classroomId].lastSynced = r.lastSynced;
    }
  });
  saveAssignments(assignments);
  classrooms = built;

  if (classrooms.length && !classrooms.some(r => r.id === selectedRoom)) {
    selectedRoom = classrooms[0].id;
  }
  if (!classrooms.length) selectedRoom = '';
}

function computeGlobalStatus() {
  if (!firebaseReady) return 'offline';
  const ids = Object.keys(rawFirebaseDevices);
  if (!ids.length) return 'idle';
  const anyFresh = classrooms.some(r => r.device.online);
  return anyFresh ? 'live' : 'stale';
}

function renderFreshnessBanner() {
  const banner = $('#staleBanner');
  if (!banner) return;

  const ids = Object.keys(rawFirebaseDevices);
  if (!firebaseReady) {
    banner.classList.remove('hidden');
    banner.textContent = '⚠ Firebase is unreachable. Data shown is from the last successful sync.';
    banner.classList.add('stale');
    return;
  }
  if (!ids.length) {
    banner.classList.remove('hidden');
    banner.textContent = '⚠ Firebase is connected, but no PuriAir device has ever published.';
    banner.classList.add('stale');
    return;
  }
  const anyFresh = classrooms.some(r => r.device.online);
  if (anyFresh) {
    banner.classList.add('hidden');
    banner.classList.remove('stale');
    return;
  }

  let newest = 0;
  Object.values(rawFirebaseDevices).forEach(node => {
    const ts = num(node?.latest?.timestamp_ms, 0);
    if (ts > newest) newest = ts;
  });

  banner.classList.remove('hidden');
  banner.classList.add('stale');
  if (newest > 0) {
    banner.textContent = `⚠ No PuriAir device has reported in the last ${Math.round(STALE_WARN_MS/60000)} minutes. Most recent telemetry was ${fmtDateTime(newest)}.`;
  } else {
    banner.textContent = `⚠ Devices exist but none have published a timestamp. They may be misconfigured.`;
  }
}

function attachFirebaseListeners() {
  if (!firebaseReady || !db) return;

  db.ref('.info/serverTimeOffset').on('value', snap => {
    serverTimeOffset = num(snap.val(), 0);
    buildClassroomsFromAssignments();
    renderAllViews();
  });

  db.ref('.info/connected').on('value', snap => {
    const connected = snap.val() === true;
    firebaseAuthReady = connected;
    if (!connected) {
      setFirebaseUiStatus('offline', 'Disconnected');
      renderFreshnessBanner();
    } else {
      const state = computeGlobalStatus();
      setFirebaseUiStatus(state === 'offline' ? 'connecting' : state);
      renderFreshnessBanner();
    }
  });

  db.ref('devices').on('value', snap => {
    rawFirebaseDevices = snap.val() || {};
    saveAvailableDevicesCache(Object.keys(rawFirebaseDevices));
    buildClassroomsFromAssignments();
    lastFirebaseSnapshot = now();

    const state = computeGlobalStatus();
    const labelMap = {
      idle: 'Connected · Idle',
      stale: 'No recent data',
      live: 'Firebase live',
      offline: 'Disconnected'
    };
    setFirebaseUiStatus(state, labelMap[state]);
    renderAllViews();
    renderFreshnessBanner();

    const ls = $('#lastSync');
    if (ls) ls.textContent = state === 'live' ? 'just now' : (rawFirebaseDevices && Object.keys(rawFirebaseDevices).length ? 'no recent data' : 'waiting for devices');
  }, err => {
    console.error('[PuriAir] Firebase read error:', err);
    setFirebaseUiStatus('offline', 'Read error');
    showToast('Firebase offline', 'Showing last known values.');
    renderFreshnessBanner();
  });
}

/* =========================================================
   7. ROLE HANDLING
   ========================================================= */
function applyRole() {
  const admin = isAdmin();
  $$('.admin-only').forEach(el => el.classList.toggle('role-hidden', !admin));
  $$('.student-only').forEach(el => el.classList.toggle('role-hidden', admin));
  document.body.classList.toggle('student-role', !admin);

  const loginBtn = $('#loginButton');
  if (loginBtn) {
    loginBtn.textContent = admin ? 'Logout' : 'Login';
    loginBtn.classList.toggle('logged-in', admin);
  }
  if (!admin && ADMIN_ONLY_PAGES.includes(currentPage())) navigate('overview');

  applyControlToUi();
}

function openLoginModal() {
  const m = $('#loginModal'); if (!m) return;
  m.classList.remove('hidden');
  if ($('#loginUsername')) $('#loginUsername').value = '';
  if ($('#loginPassword')) $('#loginPassword').value = '';
  if ($('#loginError')) $('#loginError').classList.add('hidden');
  setTimeout(() => $('#loginUsername')?.focus(), 50);
}
function closeLoginModal() { $('#loginModal')?.classList.add('hidden'); }
function submitLogin(e) {
  e.preventDefault();
  const user = $('#loginUsername').value.trim();
  const pass = $('#loginPassword').value;
  if (user === ADMIN_CREDENTIALS.username && pass === ADMIN_CREDENTIALS.password) {
    currentRole = 'admin';
    closeLoginModal();
    applyRole();
    navigate('overview');
    showToast('Admin access granted', 'Full dashboard controls enabled.');
  } else {
    $('#loginError').classList.remove('hidden');
    $('#loginPassword').value = '';
    $('#loginPassword').focus();
  }
}
function handleLoginButton() {
  if (isAdmin()) {
    currentRole = 'student';
    applyRole();
    navigate('puriair');
    showToast('Signed out', 'You are viewing as a student.');
  } else {
    openLoginModal();
  }
}

/* =========================================================
   8. METRIC HELPERS
   ========================================================= */
function metricCondition(type, value) {
  const v = Number(value);
  if (type === 'humidity')    return v >= 40 && v <= 60 ? 'safe' : (v >= 30 && v <= 70 ? 'moderate' : (v >= 20 && v <= 80 ? 'poor' : 'critical'));
  if (type === 'co2')         return v <= 800 ? 'safe' : (v <= 1000 ? 'moderate' : (v <= 1500 ? 'poor' : 'critical'));
  if (type === 'pm25')        return v <= 15  ? 'safe' : (v <= 25   ? 'moderate' : (v <= 35   ? 'poor' : 'critical'));
  if (type === 'temperature') return v >= 23 && v <= 27 ? 'safe' : ((v >= 21 && v < 23) || (v > 27 && v <= 29) ? 'moderate' : ((v >= 18 && v < 21) || (v > 29 && v <= 32) ? 'poor' : 'critical'));
  return 'safe';
}
function metricLabel(type) {
  return ({ humidity:'HUMIDITY', co2:'CO₂', pm25:'PM2.5', temperature:'TEMPERATURE' })[type] || 'METRIC';
}
function metricScore(type, value) {
  const v = Number(value);
  if (type === 'co2')         return Math.max(0, Math.min(100, 100 - ((v - 400) / (2000 - 400)) * 100));
  if (type === 'pm25')        return Math.max(0, Math.min(100, 100 - (v / 55) * 100));
  if (type === 'humidity')    return Math.max(0, Math.min(100, 100 - Math.abs(v - 50) * 2.5));
  if (type === 'temperature') return Math.max(0, Math.min(100, 100 - Math.abs(v - 25) * 12));
  return 0;
}

/* =========================================================
   9. RENDERERS
   ========================================================= */
function renderAllViews() {
  try { renderOverview(); } catch (e) { console.error('renderOverview', e); }
  try { renderClassrooms(); } catch (e) { console.error('renderClassrooms', e); }
  try { if (!$('#page-sensors')?.classList.contains('hidden'))  renderSensors(); } catch (e) { console.error('renderSensors', e); }
  try { if (!$('#page-purifier')?.classList.contains('hidden')) renderPurifier(); } catch (e) { console.error('renderPurifier', e); }
  try { if (!$('#page-database')?.classList.contains('hidden')) renderDatabase(); } catch (e) { console.error('renderDatabase', e); }
  try { renderFreshnessBanner(); } catch (e) { console.error('renderFreshnessBanner', e); }
}

function renderOverview() {
  const tbody = $('#overviewTable');
  if (!tbody) return;

  if (!classrooms.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999;padding:20px">No classrooms assigned yet. Ask an administrator to pair a PuriAir device.</td></tr>';
    ['#classroomCount','#safeCount','#occupiedCount','#alertCount','#legendSafe','#legendModerate','#legendPoor','#legendCritical']
      .forEach(sel => { const el = $(sel); if (el) el.textContent = '0'; });
    const chi = $('#overallCHI'); if (chi) chi.textContent = '--';
    const g = $('#chiGauge'); if (g) g.style.background = 'conic-gradient(#eee 0deg 360deg)';
    return;
  }

  tbody.innerHTML = classrooms.map(r => {
    const offlineBadge = r.device.online ? '' : ' <span class="offline-inline" title="Device offline">●</span>';
    return `
    <tr class="condition-row ${r.status}">
      <td><span class="room-name">${r.id}</span>${offlineBadge}<small>${r.name}</small></td>
      <td><div class="chi-status-cell"><strong>${r.chi}</strong><span class="status-chip ${r.status}">${statusLabel(r.status)}</span></div></td>
      <td class="${r.status}">${r.humidity}%</td>
      <td class="${valueClass('co2',r.co2)} ${r.status}">${r.co2} ppm</td>
      <td class="${valueClass('pm25',r.pm25)} ${r.status}">${r.pm25} µg/m³</td>
      <td class="${r.status}">${Number(r.temperature).toFixed(1)} °C</td>
      <td class="${r.status}">${r.purifier ? '<span class="value-good">ACTIVE</span>' : '<span>OFF</span>'}</td>
    </tr>`;
  }).join('');

  const safe     = classrooms.filter(r => r.status === 'safe').length;
  const occupied = classrooms.filter(r => r.occupancy > 0).length;
  const overall  = Math.round(classrooms.reduce((a, r) => a + r.chi, 0) / classrooms.length);

  const set = (sel, val) => { const el = $(sel); if (el) el.textContent = val; };
  set('#classroomCount', classrooms.length);
  set('#safeCount', safe);
  set('#occupiedCount', occupied);
  set('#alertCount', classrooms.filter(r => r.status === 'poor' || r.status === 'critical').length);
  set('#legendSafe', safe);
  set('#legendModerate', classrooms.filter(r => r.status === 'moderate').length);
  set('#legendPoor', classrooms.filter(r => r.status === 'poor').length);
  set('#legendCritical', classrooms.filter(r => r.status === 'critical').length);
  set('#overallCHI', overall);

  const gauge = $('#chiGauge');
  if (gauge) {
    const gaugeColor = overall >= 80 ? 'safe' : overall >= 60 ? 'moderate' : overall >= 40 ? 'poor' : 'critical';
    gauge.style.background = `conic-gradient(var(--${gaugeColor}) 0deg ${overall * 3.6}deg,#eee ${overall * 3.6}deg 360deg)`;
  }
}

function renderClassrooms() {
  const roomSel = $('#roomSelect');
  const cards = $('#classroomCards');

  if (!classrooms.length) {
    if (roomSel) roomSel.innerHTML = '<option>No classrooms assigned</option>';
    if (cards)   cards.innerHTML = '<div class="panel" style="padding:20px;color:#999;text-align:center">No PuriAir devices have been paired with a classroom yet. An administrator must assign a device in the Classroom Management panel.</div>';
    return;
  }

  if (roomSel) {
    roomSel.innerHTML = classrooms.map(r =>
      `<option value="${r.id}" ${r.id === selectedRoom ? 'selected' : ''}>${r.id} — ${r.name}</option>`
    ).join('');
  }

  if (cards) {
    cards.innerHTML = classrooms.map(r => {
      const ageTxt = r.device.online
        ? 'just now'
        : (r.device.hasTimestamp ? `${Math.round(r.device.ageMs / 1000)}s ago` : 'no timestamp');
      return `
      <article class="room-card condition-box ${r.status} ${r.id === selectedRoom ? 'selected' : ''} ${r.device.online ? '' : 'device-offline'}" data-room="${r.id}">
        <div class="room-card-head">
          <h5>${r.id}</h5>
          <div class="card-status"><strong>CHI ${r.chi}</strong><span class="status-chip ${r.status}">${statusLabel(r.status)}</span></div>
        </div>
        <div class="room-mini">
          <div><span>Humidity</span><strong>${r.humidity}%</strong></div>
          <div><span>CO₂</span><strong>${r.co2} ppm</strong></div>
          <div><span>PM2.5</span><strong>${r.pm25} µg/m³</strong></div>
          <div><span>Temperature</span><strong>${Number(r.temperature).toFixed(1)} °C</strong></div>
        </div>
        <div class="room-card-foot">
          <span class="room-device-tag ${r.device.online ? 'online' : 'offline'}">
            ${r.device.online ? '● ONLINE' : '○ OFFLINE'} · ${r.deviceId}
          </span>
          <small class="room-last-synced" title="Last synchronized">
            ${r.device.online ? `Live · updated ${ageTxt}` : `Last sync: ${fmtDateTime(r.lastSynced)}`}
          </small>
        </div>
      </article>`;
    }).join('');

    $$('.room-card').forEach(card =>
      card.addEventListener('click', () => {
        selectedRoom = card.dataset.room;
        renderClassrooms();
        renderRoomDetail();
      })
    );
  }

  renderRoomDetail();
}

function renderRoomDetail() {
  const r = room();
  if (!r) {
    const t = $('#detailRoomTitle'); if (t) t.textContent = 'No classroom assigned';
    const chi = $('#detailCHI'); if (chi) chi.textContent = '--';
    const grid = $('#detailTelemetry');
    if (grid) grid.innerHTML = '<div class="panel" style="grid-column:1/-1;padding:20px;color:#999;text-align:center">No telemetry available yet.</div>';
    const act = $('#studentPurifierActivity'); if (act) act.innerHTML = '<i></i> PURIFIER —';
    return;
  }

  if ($('#roomSelect')) $('#roomSelect').value = r.id;
  if ($('#detailRoomTitle')) $('#detailRoomTitle').textContent = `${r.id} · ${r.name}`;
  if ($('#detailStatus')) {
    $('#detailStatus').className = `status-chip ${r.status}`;
    $('#detailStatus').textContent = statusLabel(r.status);
  }
  if ($('#detailCHI')) $('#detailCHI').textContent = r.chi;

  const telemetry = [
    ['humidity',    'Humidity',    r.humidity,                       '%'],
    ['co2',         'CO₂',         r.co2,                            'ppm'],
    ['pm25',        'PM2.5',       r.pm25,                           'µg/m³'],
    ['temperature', 'Temperature', Number(r.temperature).toFixed(1), '°C']
  ];

  const metricTiles = telemetry.map(x => {
    const status = metricCondition(x[0], x[2]);
    return `<button type="button"
              class="telemetry metric-telemetry condition-box ${status} ${selectedMetric === x[0] ? 'active-metric' : ''}"
              data-metric="${x[0]}"
              aria-label="View ${x[1]} condition">
      <span>${x[1]}</span>
      <strong>${x[2]}</strong>
      <em>${x[3]}</em>
      <small class="metric-condition-label">${statusLabel(status)}</small>
    </button>`;
  }).join('');

  const occupancyTile = `
    <div class="telemetry occupancy-tile ${r.occupancy > 0 ? 'occupied' : 'vacant'}">
      <span>Occupancy</span>
      <strong>${r.occupancy > 0 ? 'OCCUPIED' : 'VACANT'}</strong>
      <em>${r.occupancy > 0 ? 'Motion detected' : 'No occupants detected'}</em>
    </div>`;

  const grid = $('#detailTelemetry');
  if (grid) {
    grid.innerHTML = metricTiles + occupancyTile;
    $$('#detailTelemetry .metric-telemetry').forEach(el =>
      el.addEventListener('click', () => {
        selectedMetric = el.dataset.metric;
        renderRoomDetail();
      })
    );
  }

  const selected = telemetry.find(x => x[0] === selectedMetric) || telemetry[0];
  renderMetricCondition(selected[0], selected[2]);

  if ($('#fanStatus')) $('#fanStatus').textContent = r.purifier ? 'ACTIVE' : 'INACTIVE';
  const activity = $('#studentPurifierActivity');
  if (activity) {
    activity.innerHTML = `<i></i> PURIFIER ${r.purifier ? 'ACTIVE' : 'INACTIVE'}`;
    activity.classList.toggle('inactive', !r.purifier);
  }
  if ($('#fanRing')) {
    $('#fanRing').classList.toggle('off', !r.purifier);
    $('#fanRing').style.animation = r.purifier ? 'spin 1.2s linear infinite' : 'none';
  }

  syncControlPanelFromDevice(r);
  applyControlToUi();
}

function renderMetricCondition(type, value) {
  const status = metricCondition(type, value);
  const score  = Math.round(metricScore(type, value));

  if ($('#conditionMeterValue')) $('#conditionMeterValue').textContent = `${value} · ${statusLabel(status)}`;
  const arrow = $('#conditionMeterArrow');
  if (arrow) {
    arrow.style.left = `${Math.max(2, Math.min(98, score))}%`;
    arrow.className  = `condition-arrow ${status}`;
    arrow.textContent = '▼';
  }
  if ($('#conditionMeterCaption')) $('#conditionMeterCaption').textContent = `${metricLabel(type)} CONDITION · ${statusLabel(status)}`;
  if ($('#conditionMeter')) $('#conditionMeter').className = `condition-meter ${status}`;
  if ($('#detailMetricName')) $('#detailMetricName').textContent = metricLabel(type);
  if ($('#detailMetricNameMirror')) $('#detailMetricNameMirror').textContent = metricLabel(type);
  const badge = $('#detailMetricStatus');
  if (badge) {
    badge.className = `status-chip ${status}`;
    badge.textContent = statusLabel(status);
  }
}

function inputAvailable(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}
function sensorState(ok, goodLabel = 'Functioning', badLabel = 'Malfunctioning') {
  return ok ? { label: goodLabel, tone: 'safe' } : { label: badLabel, tone: 'critical' };
}
function formatDuration(ms){ const total=Math.max(0,Math.floor(ms/1000)); const d=Math.floor(total/86400), h=Math.floor((total%86400)/3600), m=Math.floor((total%3600)/60); return `${d}d ${h}h ${m}m`; }

function renderSensors() {
  const select = $('#sensorRoomSelect');
  if (!select) return;

  if (!classrooms.length) {
    select.innerHTML = '';
    if ($('#sensorSummary')) $('#sensorSummary').innerHTML = '<div class="panel sensor-empty">No classrooms assigned yet.</div>';
    if ($('#sensorDiagnostics')) $('#sensorDiagnostics').innerHTML = '';
    return;
  }
  if (!classrooms.some(r => r.id === selectedRoom)) selectedRoom = classrooms[0].id;
  select.innerHTML = classrooms.map(r => `<option value="${r.id}" ${r.id === selectedRoom ? 'selected' : ''}>${r.id} — ${r.name}</option>`).join('');

  const r = room(); if (!r) return;
  const tempOk     = inputAvailable(r.temperature);
  const humidityOk = inputAvailable(r.humidity);
  const co2Ok      = inputAvailable(r.co2);
  const pmOk       = inputAvailable(r.pm25);
  const pirOk      = inputAvailable(r.occupancy);

  const lastSeenMs = r.device?.last_seen || 0;
  const secSince   = lastSeenMs ? Math.round((now() - lastSeenMs) / 1000) : null;
  const onlineOk   = r.device?.online === true;

  const devices = [
    { name:'ESP32 Controller', model:`Device ${r.device?.device_id || '—'} · uptime ${formatDuration(r.device?.uptime_ms || 0)}`,
      value: onlineOk ? 'ONLINE' : 'OFFLINE',
      state: onlineOk ? 'ONLINE' : 'OFFLINE',
      tone: onlineOk ? 'safe' : 'critical',
      detail: secSince === null ? 'No timestamp received yet.' : `Last telemetry ${secSince}s ago` },
    { name:'DHT22', model:'Temperature and relative humidity',
      value:`Temp: ${tempOk ? Number(r.temperature).toFixed(1)+' °C' : 'No input'} · RH: ${humidityOk ? Number(r.humidity)+'%' : 'No input'}`,
      state: sensorState(tempOk && humidityOk).label,
      tone: tempOk && humidityOk ? 'safe' : 'critical',
      detail: tempOk && humidityOk ? 'Both inputs present.' : 'One or both inputs missing.' },
    { name:'MH-Z19C', model:'CO₂ concentration',
      value: co2Ok ? `${r.co2} ppm` : 'No CO₂ input',
      state: sensorState(co2Ok).label, tone: co2Ok ? 'safe' : 'critical',
      detail: co2Ok ? 'Numeric CO₂ reading present.' : 'CO₂ reading missing.' },
    { name:'PMS5003', model:'PM2.5 particulate matter',
      value: pmOk ? `${r.pm25} µg/m³` : 'No PM2.5 input',
      state: sensorState(pmOk).label, tone: pmOk ? 'safe' : 'critical',
      detail: pmOk ? 'Numeric PM2.5 reading present.' : 'PM2.5 reading missing.' },
    { name:'PIR Sensor HC-SR501', model:'Motion / occupancy input',
      value: pirOk ? (r.occupancy > 0 ? 'MOTION DETECTED' : 'NO MOTION') : 'No occupancy input',
      state: sensorState(pirOk).label, tone: pirOk ? 'safe' : 'critical',
      detail: pirOk ? 'Motion telemetry present.' : 'Occupancy input missing.' }
  ];

  if ($('#sensorSummary')) $('#sensorSummary').innerHTML = devices.map(d => `
    <article class="panel sensor-card">
      <div class="sensor-card-top">
        <span class="sensor-device-icon">${d.name.startsWith('ESP32')?'▦':d.name==='DHT22'?'℃':d.name==='MH-Z19C'?'◉':d.name==='PMS5003'?'▤':'⌁'}</span>
        <span class="sensor-status-pill ${d.tone}">${d.state}</span>
      </div>
      <h4>${d.name}</h4>
      <p>${d.model}</p>
      <strong class="sensor-reading">${d.value}</strong>
      <small>${d.detail}</small>
    </article>`).join('');

  if ($('#sensorDiagnostics')) $('#sensorDiagnostics').innerHTML = devices.map(d => `
    <div class="sensor-diagnostic-row">
      <div><strong>${d.name}</strong><small>${d.detail}</small></div>
      <span class="sensor-status-pill ${d.tone}">${d.state}</span>
    </div>`).join('');

  updateSensorUptime(r.id, devices);
  renderSensorUptime(r.id, devices);
  if ($('#sensorCheckedAt')) $('#sensorCheckedAt').textContent = `Updated ${new Date().toLocaleTimeString('en-PH', {hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false})}`;
}

const SENSOR_UPTIME_KEY = 'puriair_sensor_uptime_v1';
function loadSensorUptime(){ try { return JSON.parse(localStorage.getItem(SENSOR_UPTIME_KEY)||'{}'); } catch { return {}; } }
function saveSensorUptime(data){ localStorage.setItem(SENSOR_UPTIME_KEY, JSON.stringify(data)); }
function updateSensorUptime(roomId, devices){
 const all=loadSensorUptime(), t=now(); all[roomId]=all[roomId]||{};
 devices.forEach(d=>{
   const key=d.name; const up=d.tone!=='critical'; let rec=all[roomId][key];
   if(!rec){ rec={status:up?'up':'down', since:t, firstSeen:t, upMs:0, downMs:0, events:[{at:t,status:up?'UP':'DOWN',note:'First observed by dashboard'}]}; }
   else if((rec.status==='up')!==up){ const elapsed=Math.max(0,t-rec.since); if(rec.status==='up') rec.upMs+=elapsed; else rec.downMs+=elapsed; rec.status=up?'up':'down'; rec.since=t; rec.events=rec.events||[]; rec.events.unshift({at:t,status:up?'UP':'DOWN',note:`Status changed to ${up?'available':'unavailable'}`}); rec.events=rec.events.slice(0,30); }
   rec.lastSeen=t; rec.currentUp=up; all[roomId][key]=rec;
 }); saveSensorUptime(all);
}
function renderSensorUptime(roomId, devices){
 const sum = $('#sensorUptimeSummary'); const hist = $('#sensorUptimeHistory');
 if (!sum || !hist) return;
 const all=loadSensorUptime(), data=all[roomId]||{}, t=now();
 sum.innerHTML=devices.map(d=>{const rec=data[d.name];if(!rec)return '';const up=rec.status==='up';const elapsed=Math.max(0,t-rec.since);const upMs=rec.upMs+(up?elapsed:0),downMs=rec.downMs+(!up?elapsed:0),total=upMs+downMs,pct=total?Math.round(upMs/total*100):100;return `<article class="panel sensor-card"><div class="sensor-card-top"><h4>${d.name}</h4><span class="sensor-status-pill ${up?'safe':'critical'}">${up?'UP':'DOWN'}</span></div><strong class="sensor-reading">${pct}% observed uptime</strong><small>Up: ${formatDuration(upMs)} · Down: ${formatDuration(downMs)}</small><small>First observed: ${new Date(rec.firstSeen).toLocaleString()}</small></article>`}).join('');
 const events=devices.flatMap(d=>(data[d.name]?.events||[]).map(e=>({...e,device:d.name}))).sort((a,b)=>b.at-a.at).slice(0,25);
 hist.innerHTML=events.length?events.map(e=>`<div class="sensor-diagnostic-row"><div><strong>${e.device} · ${e.status}</strong><small>${new Date(e.at).toLocaleString()} · ${e.note}</small></div><span class="sensor-status-pill ${e.status==='UP'?'safe':'critical'}">${e.status}</span></div>`).join(''):'<p class="management-note">Uptime events will appear after sensors are first observed.</p>';
}

const FILTER_RULES = {
  pre:    { name:'Pre-filter',   min:1, max:3,  unit:'month', action:'Clean every 1–3 months' },
  hepa:   { name:'HEPA filter',  min:6, max:12, unit:'month', action:'Replace every 6–12 months' },
  carbon: { name:'Carbon filter',min:3, max:6,  unit:'month', action:'Replace every 3–6 months' }
};
function loadFilterRecords(){ try { return JSON.parse(localStorage.getItem('puriair_filter_records')||'{}'); } catch { return {}; } }
function saveFilterRecords(data){ localStorage.setItem('puriair_filter_records', JSON.stringify(data)); }
function addMonths(dateString, months){ const d=new Date(dateString+'T12:00:00'); d.setMonth(d.getMonth()+months); return d; }
function fmtDate(d){ return d.toLocaleDateString('en-PH',{year:'numeric',month:'short',day:'numeric'}); }

function renderPurifier(){
  const select=$('#purifierRoomSelect'); if(!select) return;
  if(!classrooms.length){select.innerHTML='';if($('#purifierSummary'))$('#purifierSummary').innerHTML='<article class="panel sensor-empty">No classrooms assigned yet.</article>';if($('#filterForecast'))$('#filterForecast').innerHTML='';if($('#filterHistory'))$('#filterHistory').innerHTML='';return;}
  if(!classrooms.some(r=>r.id===selectedRoom)) selectedRoom=classrooms[0].id;
  select.innerHTML=classrooms.map(r=>`<option value="${r.id}" ${r.id===selectedRoom?'selected':''}>${r.id} — ${r.name}</option>`).join('');
  const r=room(); if(!r) return;
  const data=loadFilterRecords(); const roomData=data[r.id]||{};

  const cards=[
    ['Purifier fan','Fan speed',`${r.purifier?'Active':'Standby'}`,r.purifier?'safe':'moderate','Live state derived from air quality and ESP32 purifier flag.'],
    ['Humidification','Atomizer module',`Status: ${r.humidity<45?'Active':'Standby'}`,r.humidity<45?'safe':'moderate','Atomizer activity is inferred from humidity.'],
    ['Humidification tank','Water level',`Level: not connected`, 'moderate','Tank level requires a float switch or manual update.'],
    ['Dehumidification','TEC1-12706 Peltier', 'Status: Not verified', 'moderate','Requires electrical/current or controller feedback to confirm operation.'],
    ['Thermal management','Heatsink & cooling fan','Temperature: not connected','moderate','Overheating cannot be detected without a temperature probe on/near the assembly.'],
    ['Collected water','Dehumidification reservoir','Level: not connected','moderate','Add a float/level sensor or update manually; empty before overflow.']
  ];
  if($('#purifierSummary')) $('#purifierSummary').innerHTML=cards.map(c=>`<article class="panel sensor-card"><div class="sensor-card-top"><span class="sensor-device-icon">◉</span><span class="sensor-status-pill ${c[3]}">${c[3]==='safe'?'ACTIVE / OK':'DEMO / CHECK'}</span></div><h4>${c[0]}</h4><p>${c[1]}</p><strong class="sensor-reading">${c[2]}</strong><small>${c[4]}</small></article>`).join('');

  const forecasts=Object.keys(FILTER_RULES).map(k=>{
    const rule=FILTER_RULES[k], rec=(roomData[k]||[]).slice(-1)[0];
    if(!rec) return {k,rule,rec:null,earliest:null,latest:null,due:null};
    const earliest=addMonths(rec.date,rule.min),latest=addMonths(rec.date,rule.max);
    let due=latest;
    if(rec.condition==='moderate') due=earliest;
    if(rec.condition==='critical'||rec.condition==='damaged') due=new Date();
    return {k,rule,rec,earliest,latest,due};
  });
  if($('#filterForecast')) $('#filterForecast').innerHTML=forecasts.map(f=>{
    let status='No service record yet';let tone='moderate';let forecast='Log the last cleaning/replacement date and condition to calculate an exact suggested date.';
    if(f.rec){
      const t=new Date();
      status=f.rec.condition.toUpperCase();
      tone=f.rec.condition==='good'?'safe':f.rec.condition==='moderate'?'moderate':'critical';
      const dueDate=f.due;
      const dueText=(f.rec.condition==='critical'||f.rec.condition==='damaged')?'Immediate service recommended — '+fmtDate(dueDate):`Suggested service date: ${fmtDate(dueDate)}`;
      forecast=`${dueText}. Routine service window: ${fmtDate(f.earliest)} – ${fmtDate(f.latest)}.`;
      if(t>f.latest && f.rec.condition!=='critical'&&f.rec.condition!=='damaged') forecast+=' Routine interval has passed; service is due now.';
      if(f.rec.condition==='moderate')forecast+=' Moderate condition uses the earliest routine date.';
      if(f.rec.condition==='good')forecast+=' Good condition uses the latest routine date.';
    }
    return `<article class="panel filter-forecast-card"><div class="sensor-card-top"><h4>${f.rule.name}</h4><span class="sensor-status-pill ${tone}">${status}</span></div><p>${f.rule.action}</p><strong>${f.rec?'Last action: '+f.rec.action+' · '+fmtDate(new Date(f.rec.date+'T12:00:00')):'No date recorded'}</strong><strong class="filter-due-date">${f.rec?'Next recommended date: '+fmtDate(f.due):'Next recommended date: not available'}</strong><small>${forecast}</small></article>`;
  }).join('');

  const records=Object.entries(roomData).flatMap(([k,arr])=>arr.map(rec=>({...rec,type:k}))).sort((a,b)=>b.created-a.created);
  if($('#filterHistory')) $('#filterHistory').innerHTML=records.length?records.map(rec=>`<div class="sensor-diagnostic-row"><div><strong>${FILTER_RULES[rec.type].name} · ${rec.action}</strong><small>${fmtDate(new Date(rec.date+'T12:00:00'))} · Condition: ${rec.condition} · ${rec.notes||'No notes'}</small></div><span class="sensor-status-pill ${rec.condition==='good'?'safe':rec.condition==='moderate'?'moderate':'critical'}">${rec.condition.toUpperCase()}</span></div>`).join(''):'<p class="management-note">No filter maintenance records yet.</p>';
}

/* =========================================================
   10. DATABASE EXPORT
   ========================================================= */
const BLOCK_DAYS = 10;
const DB_STORAGE_KEY = 'puriair_db_blocks_v1';
function blockIndexFromDate(date) { const ms = new Date(date).setHours(0,0,0,0); const epoch = new Date(1970,0,1).getTime(); return Math.floor((ms - epoch) / (BLOCK_DAYS * 86400000)); }
function blockRangeFromIndex(index) { const epoch = new Date(1970,0,1).getTime(); const start = new Date(epoch + index * BLOCK_DAYS * 86400000); const end = new Date(start.getTime() + (BLOCK_DAYS - 1) * 86400000); return { start, end }; }
function blockId(classroomId, blockIndex) { return `${classroomId}__block_${String(blockIndex).padStart(4, '0')}`; }
function fmtBlockRange(index) { const { start, end } = blockRangeFromIndex(index); const opts = { year: 'numeric', month: 'short', day: 'numeric' }; return `${start.toLocaleDateString('en-PH', opts)} – ${end.toLocaleDateString('en-PH', opts)}`; }
function loadDbBlocks() { try { return JSON.parse(localStorage.getItem(DB_STORAGE_KEY) || '{}'); } catch { return {}; } }
function saveDbBlocks(data) { try { localStorage.setItem(DB_STORAGE_KEY, JSON.stringify(data)); } catch {} }
function seededRandom(seedStr) { let h = 2166136261; for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619); } return function () { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function generateTelemetryBlock(classroomId, blockIndex) {
  const key = blockId(classroomId, blockIndex) + '__telemetry';
  const stored = loadDbBlocks()[key];
  if (stored) return stored;
  const rnd = seededRandom(key);
  const { start } = blockRangeFromIndex(blockIndex);
  const rows = [];
  const base = classrooms.find(c => c.id === classroomId) || { co2: 700, pm25: 10, humidity: 52, temperature: 25.5, occupancy: 15 };
  const hours = BLOCK_DAYS * 24;
  for (let h = 0; h < hours; h++) {
    const ts = new Date(start.getTime() + h * 3600000);
    const hourOfDay = ts.getHours();
    const dayFactor = Math.sin(((hourOfDay - 6) / 24) * Math.PI * 2) * 0.5 + 0.5;
    const weekend = [0, 6].includes(ts.getDay());
    const occBase = weekend ? 2 : 20;
    const occupancy = Math.max(0, Math.round(occBase * dayFactor + (rnd() - 0.5) * 6));
    const co2 = Math.round(420 + occupancy * 28 + rnd() * 120);
    const pm25 = Math.round((base.pm25 * 0.4 + occupancy * 0.5 + rnd() * 6) * 10) / 10;
    const humidity = Math.round(base.humidity + (rnd() - 0.5) * 14);
    const temperature = Math.round((base.temperature + dayFactor * 2 + (rnd() - 0.5) * 1.5) * 10) / 10;
    const penalty = Math.max(0, (co2 - 500) / 35) + Math.max(0, (pm25 - 8) * 1.2) + Math.max(0, (humidity - 65) * 0.7);
    const chi = Math.max(20, Math.min(98, Math.round(96 - penalty - occupancy * 0.05)));
    rows.push({ timestamp: ts.toISOString(), classroom: classroomId, chi,
      status: chi >= 80 ? 'safe' : chi >= 60 ? 'moderate' : chi >= 40 ? 'poor' : 'critical',
      co2, pm25, temperature, humidity, occupancy, purifier: (co2 > 1000 || pm25 > 20) ? 'ON' : 'OFF' });
  }
  const all = loadDbBlocks(); all[key] = rows; saveDbBlocks(all); return rows;
}
function escapeXml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;'); }
function rowsToExcelXml(rows, sheetName) {
  if (!rows.length) return `<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="${escapeXml(sheetName)}"><Table><Row><Cell><Data ss:Type="String">No data</Data></Cell></Row></Table></Worksheet></Workbook>`;
  const headers = Object.keys(rows[0]);
  const headerCells = headers.map(h => `<Cell ss:StyleID="hdr"><Data ss:Type="String">${escapeXml(h)}</Data></Cell>`).join('');
  const bodyRows = rows.map(r => { const cells = headers.map(h => { const v = r[h]; const isNum = typeof v === 'number' && isFinite(v); const type = isNum ? 'Number' : 'String'; return `<Cell><Data ss:Type="${type}">${escapeXml(v)}</Data></Cell>`; }).join(''); return `<Row>${cells}</Row>`; }).join('');
  return `<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="hdr"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#7B1113" ss:Pattern="Solid"/></Style></Styles><Worksheet ss:Name="${escapeXml(sheetName)}"><Table><Row>${headerCells}</Row>${bodyRows}</Table></Worksheet></Workbook>`;
}
function downloadExcel(rows, filename, sheetName) {
  const xml = rowsToExcelXml(rows, sheetName || 'Logs');
  const blob = new Blob([xml], { type: 'application/vnd.ms-excel' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.xls') || filename.endsWith('.xlsx') ? filename : filename + '.xls';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function renderDatabase() {
  const roomSel = $('#databaseRoomSelect');
  if (!roomSel) return;
  if (!classrooms.length) {
    roomSel.innerHTML = '';
    if ($('#databaseBlockList')) $('#databaseBlockList').innerHTML = '<p class="management-note">No classrooms assigned yet.</p>';
    if ($('#databaseBlockInfo')) $('#databaseBlockInfo').innerHTML = '';
    if ($('#databaseBlockCount')) $('#databaseBlockCount').textContent = '0 blocks';
    return;
  }
  if (!classrooms.some(r => r.id === selectedRoom)) selectedRoom = classrooms[0].id;
  roomSel.innerHTML = classrooms.map(r => `<option value="${r.id}" ${r.id === selectedRoom ? 'selected' : ''}>${r.id} — ${r.name}</option>`).join('');
  const dateInput = $('#databaseDate');
  if (dateInput && !dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);
  updateDatabaseBlockInfo();
  renderDatabaseBlockList();
}
function updateDatabaseBlockInfo() {
  const roomId = $('#databaseRoomSelect')?.value;
  const dateVal = $('#databaseDate')?.value;
  const info = $('#databaseBlockInfo'); if (!info) return;
  if (!roomId || !dateVal) { info.innerHTML = ''; return; }
  const idx = blockIndexFromDate(dateVal);
  const key = blockId(roomId, idx) + '__telemetry';
  const exists = !!loadDbBlocks()[key];
  info.innerHTML = `Selected classroom: <strong>${escapeXml(roomId)}</strong><br>Target 10-day block: <strong>Block #${idx}</strong> · ${fmtBlockRange(idx)}<br>Log type: <strong>Environmental Telemetry</strong> · Status: <strong>${exists ? 'Stored locally' : 'Will be generated on download'}</strong>`;
}
function renderDatabaseBlockList() {
  const roomId = $('#databaseRoomSelect')?.value;
  const list = $('#databaseBlockList'); const countEl = $('#databaseBlockCount');
  if (!list) return;
  if (!roomId) { list.innerHTML = ''; if (countEl) countEl.textContent = '0 blocks'; return; }
  const blocks = loadDbBlocks();
  const prefix = roomId + '__block_';
  const relevant = Object.keys(blocks).filter(k => k.startsWith(prefix) && k.endsWith('__telemetry'))
    .map(k => { const m = k.match(/__block_(\d+)__/); return { key: k, idx: m ? Number(m[1]) : 0, rows: blocks[k].length }; })
    .sort((a, b) => b.idx - a.idx).slice(0, 12);
  if (countEl) countEl.textContent = `${relevant.length} block${relevant.length === 1 ? '' : 's'}`;
  if (!relevant.length) { list.innerHTML = `<p class="management-note">No telemetry blocks stored for ${roomId} yet. Download one to generate it.</p>`; return; }
  list.innerHTML = relevant.map(b => `<div class="database-block-row"><div><strong>Block #${b.idx} · ${fmtBlockRange(b.idx)}</strong><small>${b.rows} rows · ${b.key}</small></div><span class="database-block-tag">STORED</span></div>`).join('');
}
function handleDatabaseExport(e) {
  e.preventDefault();
  if (!isAdmin()) { showToast('Access denied', 'Only administrators can export database logs.'); return; }
  const roomId = $('#databaseRoomSelect').value;
  const dateVal = $('#databaseDate').value;
  if (!roomId || !dateVal) { showToast('Missing parameters', 'Select a classroom and date.'); return; }
  const idx = blockIndexFromDate(dateVal);
  const rows = generateTelemetryBlock(roomId, idx);
  const { start, end } = blockRangeFromIndex(idx);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);
  downloadExcel(rows, `${roomId}_telemetry_block${idx}_${startStr}_to_${endStr}.xls`, `${roomId} telemetry`.slice(0, 28));
  showToast('Download ready', `${rows.length} telemetry rows for ${roomId} · Block #${idx}.`);
  updateDatabaseBlockInfo();
  renderDatabaseBlockList();
}

/* =========================================================
   11. NAVIGATION
   ========================================================= */
function navigate(page) {
  if (!isAdmin() && ADMIN_ONLY_PAGES.includes(page)) {
    showToast('Student access', 'This section is available to administrators only.');
    return;
  }
  $$('.content').forEach(el => el.classList.add('hidden'));
  const target = $(`#page-${page}`);
  if (!target) return;
  target.classList.remove('hidden');
  $$('.nav-item[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  if ($('#pageTitle')) $('#pageTitle').textContent = PAGE_TITLES[page] || 'PuriAir';
  try {
    if (page === 'classrooms') renderClassrooms();
    if (page === 'sensors') renderSensors();
    if (page === 'purifier') renderPurifier();
    if (page === 'database') renderDatabase();
  } catch (e) { console.error('navigate render', e); }
  $('#sidebar')?.classList.remove('open');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* =========================================================
   12. TOAST / CLOCK
   ========================================================= */
function showToast(title, message) {
  const t = $('#toast'); if (!t) { console.log('[toast]', title, message); return; }
  if ($('#toastTitle')) $('#toastTitle').textContent = title;
  if ($('#toastMessage')) $('#toastMessage').textContent = message;
  t.classList.add('show');
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}
function updateClock() {
  const c = $('#clock'); if (!c) return;
  c.textContent = new Date().toLocaleTimeString('en-PH', { hour12: false });
}

/* =========================================================
   13. ADMIN PURIFIER CONTROL — v2
   =========================================================

   Field contract with the ESP32 firmware (/control node):
     mode          : "auto" | "manual"
     power         : boolean   (master on/off)
     purifierFan   : boolean
     humidifier    : boolean
     dehumidifier  : boolean

   Mutual exclusion rule (enforced here AND in firmware):
     - Humidifier and dehumidifier must NEVER be true at the same time.
     - Turning one ON automatically turns the other OFF.
   ========================================================= */

function pushControlUpdate(updates) {
  const r = room();
  if (!r) return Promise.reject(new Error('No classroom selected.'));

  const devId = r.deviceId;

  if (!firebaseReady || !db) {
    Object.assign(purifierControlState, updates);
    applyControlToUi();
    showToast('Offline update', 'Firebase not connected — changed locally only.');
    return Promise.resolve();
  }

  return db.ref(`devices/${devId}/control`).update(updates)
    .then(() => {
      Object.assign(purifierControlState, updates);
      applyControlToUi();
    })
    .catch(err => {
      console.error('[PuriAir] Control write failed:', err);
      showToast('Write failed', 'Could not send command to Firebase.');
    });
}

function toggleOperatingMode() {
  if (!isAdmin()) {
    showToast('Access denied', 'Only administrators can change purifier operating mode.');
    return;
  }

  const newMode = purifierControlState.mode === 'auto' ? 'manual' : 'auto';

  if (newMode === 'auto') {
    pushControlUpdate({ mode: 'auto' }).then(() => {
      showToast('Automatic mode', 'The ESP32 now controls the purifier automatically.');
    });
  } else {
    pushControlUpdate({ mode: 'manual' }).then(() => {
      showToast('Manual mode', 'You now control the purifier switches.');
    });
  }
}

function togglePower() {
  if (!isAdmin() || purifierControlState.mode !== 'manual') return;
  const newState = !purifierControlState.power;
  pushControlUpdate({ power: newState }).then(() => {
    showToast('Power ' + (newState ? 'ON' : 'OFF'), 'Master switch updated.');
  });
}

function toggleFan() {
  if (!isAdmin() || purifierControlState.mode !== 'manual') return;
  const newState = !purifierControlState.purifierFan;
  pushControlUpdate({ purifierFan: newState });
}

function toggleHumidifier() {
  if (!isAdmin() || purifierControlState.mode !== 'manual') return;

  const newState = !purifierControlState.humidifier;
  const updates = { humidifier: newState };

  if (newState && purifierControlState.dehumidifier) {
    updates.dehumidifier = false;
    showToast('Dehumidifier disabled', 'Humidifier and dehumidifier cannot run together.');
  }

  pushControlUpdate(updates);
}

function toggleDehumidifier() {
  if (!isAdmin() || purifierControlState.mode !== 'manual') return;

  const newState = !purifierControlState.dehumidifier;
  const updates = { dehumidifier: newState };

  if (newState && purifierControlState.humidifier) {
    updates.humidifier = false;
    showToast('Humidifier disabled', 'Humidifier and dehumidifier cannot run together.');
  }

  pushControlUpdate(updates);
}

function applyControlToUi() {
  const isManual = purifierControlState.mode === 'manual' && isAdmin();

  const setToggle = (id, checked, disabled) => {
    const el = $(id);
    if (!el) return;
    el.checked = checked;
    el.disabled = disabled;
  };

  setToggle('#switchPower',        purifierControlState.power,          !isManual);
  setToggle('#switchFan',          purifierControlState.purifierFan,    !isManual);
  setToggle('#switchHumidifier',   purifierControlState.humidifier,     !isManual);
  setToggle('#switchDehumidifier', purifierControlState.dehumidifier,   !isManual);

  const conflict = purifierControlState.humidifier && purifierControlState.dehumidifier;
  $('#switchHumidifier')?.closest('.switch-row')?.classList.toggle('conflict', conflict);
  $('#switchDehumidifier')?.closest('.switch-row')?.classList.toggle('conflict', conflict);

  const modeBadge = $('#controlMode');
  if (modeBadge) modeBadge.textContent = purifierControlState.mode.toUpperCase();

  const override = $('#overrideButton');
  if (override) {
    override.textContent = purifierControlState.mode === 'manual'
      ? 'Return to Automatic'
      : 'Enable Manual Mode';
    override.setAttribute('aria-pressed', String(purifierControlState.mode === 'manual'));
    override.disabled = !isAdmin();
  }

  const cmd = $('#fanCommand');
  if (cmd) {
    if (purifierControlState.mode === 'auto') {
      cmd.textContent = 'AUTO · ' + (purifierControlState.power ? 'ACTIVE' : 'STANDBY');
    } else {
      cmd.textContent = 'MANUAL · ' + (purifierControlState.power ? 'ON' : 'OFF');
    }
  }

  const help = $('#purifierModeHelp');
  if (help) {
    if (!isAdmin()) {
      help.textContent = 'Administrator access is required for manual control.';
      help.className = 'helper-text';
    } else if (purifierControlState.mode === 'auto') {
      help.textContent = 'Automatic mode selected. Manual switches are disabled.';
      help.className = 'helper-text';
    } else {
      const r = room();
      const applied = r?.device?.raw?.status || {};
      const pending =
        purifierControlState.power        !== (applied.power === true) ||
        purifierControlState.purifierFan  !== (applied.purifierFan === true) ||
        purifierControlState.humidifier   !== (applied.humidifier === true) ||
        purifierControlState.dehumidifier !== (applied.dehumidifier === true);

      if (pending) {
        help.textContent = '⏳ Waiting for device to confirm…';
        help.className = 'helper-text pending';
      } else {
        help.textContent = '✓ Device confirmed. Humidifier and dehumidifier cannot both run.';
        help.className = 'helper-text confirmed';
      }
    }
  }
}

function syncControlPanelFromDevice(r) {
  if (!r || !r.device) return;

  const ctrl = r.device.raw && r.device.raw.control;
  if (ctrl) {
    purifierControlState.mode = ctrl.mode === 'manual' ? 'manual' : 'auto';
    if (typeof purifierControlState.power === 'boolean') {
      purifierControlState.power         = ctrl.power === true;
      purifierControlState.purifierFan   = ctrl.purifierFan === true;
      purifierControlState.humidifier    = ctrl.humidifier === true;
      purifierControlState.dehumidifier  = ctrl.dehumidifier === true;
    }
  }
}

/* =========================================================
   14. EVENT LISTENERS
   ========================================================= */
function wireListeners() {
  $$('.nav-item[data-page]').forEach(btn => btn.addEventListener('click', () => navigate(btn.dataset.page)));
  $$('.text-button').forEach(btn => btn.addEventListener('click', () => navigate(btn.dataset.pageTarget)));

  $('#roomSelect')?.addEventListener('change', e => { selectedRoom = e.target.value; renderClassrooms(); });
  $('#sensorRoomSelect')?.addEventListener('change', e => { selectedRoom = e.target.value; renderSensors(); });
  $('#purifierRoomSelect')?.addEventListener('change', e => { selectedRoom = e.target.value; renderPurifier(); });

  $('#overrideButton')?.addEventListener('click', toggleOperatingMode);
  $('#switchPower')?.addEventListener('change', togglePower);
  $('#switchFan')?.addEventListener('change', toggleFan);
  $('#switchHumidifier')?.addEventListener('change', toggleHumidifier);
  $('#switchDehumidifier')?.addEventListener('change', toggleDehumidifier);

  const fsd = $('#filterServiceDate');
  if (fsd) fsd.value = new Date().toISOString().slice(0,10);

  $('#filterLogForm')?.addEventListener('submit', e => {
    e.preventDefault();
    const key = selectedRoom; const type = $('#filterType').value;
    if (!key) { showToast('No classroom selected', 'Assign a classroom first.'); return; }
    const records = loadFilterRecords();
    records[key] = records[key] || {};
    records[key][type] = records[key][type] || [];
    records[key][type].push({ date: $('#filterServiceDate').value, action: $('#filterAction').value, condition: $('#filterCondition').value, notes: $('#filterNotes').value.trim(), created: Date.now() });
    saveFilterRecords(records);
    $('#filterNotes').value = '';
    renderPurifier();
    showToast('Maintenance saved', `${FILTER_RULES[type].name} record saved for ${key}.`);
  });

  $('#databaseExportForm')?.addEventListener('submit', handleDatabaseExport);
  $('#databaseRoomSelect')?.addEventListener('change', () => { selectedRoom = $('#databaseRoomSelect').value; updateDatabaseBlockInfo(); renderDatabaseBlockList(); });
  $('#databaseDate')?.addEventListener('change', updateDatabaseBlockInfo);

  $('#addClassroomButton')?.addEventListener('click', () => openClassroomModal('add'));
  $('#removeClassroomButton')?.addEventListener('click', () => openClassroomModal('remove'));
  $('#confirmAddClassroom')?.addEventListener('click', confirmAddClassroom);
  $('#confirmRemoveClassroom')?.addEventListener('click', confirmRemoveClassroom);
  $('#closeClassroomModal')?.addEventListener('click', closeClassroomModal);
  $('#cancelClassroomModal')?.addEventListener('click', closeClassroomModal);
  $('#cancelRemoveClassroom')?.addEventListener('click', closeClassroomModal);
  $('#classroomModal')?.addEventListener('click', e => { if (e.target.id === 'classroomModal') closeClassroomModal(); });
  $('#newClassroomCode')?.addEventListener('keydown', e => { if (e.key === 'Enter') confirmAddClassroom(); });

  $('#mobileMenu')?.addEventListener('click', () => $('#sidebar')?.classList.toggle('open'));

  $('#loginButton')?.addEventListener('click', handleLoginButton);
  $('#closeLoginModal')?.addEventListener('click', closeLoginModal);
  $('#cancelLogin')?.addEventListener('click', closeLoginModal);
  $('#loginForm')?.addEventListener('submit', submitLogin);
  $('#loginModal')?.addEventListener('click', e => { if (e.target.id === 'loginModal') closeLoginModal(); });
}

/* =========================================================
   15. CLASSROOM MANAGEMENT
   ========================================================= */
function openClassroomModal(mode) {
  if (!isAdmin()) return;
  $('#classroomModal')?.classList.remove('hidden');
  const add = mode === 'add';
  $('#addClassroomForm')?.classList.toggle('hidden', !add);
  $('#removeClassroomForm')?.classList.toggle('hidden', add);
  if ($('#classroomModalTitle')) $('#classroomModalTitle').textContent = add ? 'Add Classroom' : 'Remove Classroom';

  if (add) {
    if ($('#newClassroomCode')) $('#newClassroomCode').value = '';
    const sel = $('#newClassroomDevice');
    if (sel) {
      const avail = availableDeviceIds();
      if (!avail.length) {
        sel.innerHTML = '<option value="">— No available PuriAir devices —</option>';
        sel.disabled = true;
        if ($('#addClassroomHint')) $('#addClassroomHint').textContent = 'No PuriAir devices are currently available. All detected devices are already paired, or no devices have published to Firebase yet.';
      } else {
        sel.disabled = false;
        sel.innerHTML = '<option value="">Select a device…</option>' + avail.map(id => `<option value="${id}">${id}</option>`).join('');
        if ($('#addClassroomHint')) $('#addClassroomHint').textContent = 'Select an available PuriAir device from Firebase to pair with this classroom.';
      }
    }
    setTimeout(() => $('#newClassroomCode')?.focus(), 50);
  } else {
    const sel = $('#removeClassroomSelect');
    if (sel) {
      sel.innerHTML = classrooms.map(r => `<option value="${r.id}">${r.id} — ${r.name} (${r.deviceId})</option>`).join('');
      if (classrooms.length) sel.value = selectedRoom;
    }
  }
}
function closeClassroomModal() { $('#classroomModal')?.classList.add('hidden'); }

function confirmAddClassroom() {
  if (!isAdmin()) return;
  const raw = $('#newClassroomCode').value.trim().toUpperCase();
  const id  = raw.replace(/\s+/g, '');
  const devId = $('#newClassroomDevice').value;

  if (!id) { showToast('Classroom code required', 'Enter a classroom code.'); return; }
  if (!/^[A-Z0-9][A-Z0-9_-]{2,19}$/.test(id)) { showToast('Invalid classroom code', 'Use a code like CPE-307.'); return; }
  if (classrooms.some(r => r.id === id)) { showToast('Already active', `${id} is already monitored.`); return; }
  if (!devId) { showToast('Device required', 'Select an available PuriAir device.'); return; }
  const assignments = loadAssignments();
  if (Object.values(assignments).some(a => a.deviceId === devId)) { showToast('Device already paired', `${devId} is assigned elsewhere.`); return; }
  assignments[id] = { deviceId: devId, deviceName: `Classroom ${id}`, lastSynced: 0 };
  saveAssignments(assignments);
  closeClassroomModal();
  showToast('Classroom added', `${id} paired with ${devId}.`);
  buildClassroomsFromAssignments();
  applyRole();
  renderAllViews();
}
function confirmRemoveClassroom() {
  if (!isAdmin()) return;
  if (classrooms.length <= 1) { showToast('Cannot remove', 'At least one classroom must remain.'); return; }
  const id = $('#removeClassroomSelect').value;
  const assignments = loadAssignments();
  if (!assignments[id]) { showToast('Not found', 'Classroom not assigned.'); return; }
  const devId = assignments[id].deviceId;
  delete assignments[id];
  saveAssignments(assignments);
  closeClassroomModal();
  showToast('Classroom removed', `${id} removed. Device ${devId} is available again.`);
  if (selectedRoom === id) selectedRoom = '';
  buildClassroomsFromAssignments();
  applyRole();
  renderAllViews();
}

/* =========================================================
   16. INITIALIZATION
   ========================================================= */
window.addEventListener('error', (e) => {
  console.error('[PuriAir global]', e.error || e.message);
  try { showToast('Runtime error', (e.error && e.error.message) || e.message || 'Unknown error'); } catch {}
});

function init() {
  try {
    initFirebase();
    applyRole();
    wireListeners();
    navigate('puriair');
    if (firebaseReady) {
      attachFirebaseListeners();
    }
    buildClassroomsFromAssignments();
    renderAllViews();
    updateClock();
    setInterval(updateClock, 1000);

    setInterval(() => {
      buildClassroomsFromAssignments();
      renderFreshnessBanner();
      const state = computeGlobalStatus();
      if (firebaseReady) {
        const labelMap = { idle: 'Connected · Idle', stale: 'No recent data', live: 'Firebase live', offline: 'Disconnected' };
        setFirebaseUiStatus(state, labelMap[state]);
      }
      if (!$('#page-classrooms')?.classList.contains('hidden')) renderClassrooms();
    }, 10000);
  } catch (err) {
    console.error('[PuriAir] init failed:', err);
    try { showToast('Init failed', err.message || 'See console.'); } catch {}
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}