/*
  PURIAIR FRONTEND v20 — Allow Empty Classrooms
  -------------------------------------------------------------------
  v20 CHANGES
  - Removed the restriction preventing the removal of the last classroom.
  - The dashboard now gracefully handles 0 classrooms by showing empty states.
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

/* CHI thresholds — match the official PuriAir table exactly */
const CHI_THRESHOLDS = {
  co2:         { safe: 700,  moderate: 1000, poor: 1500 },
  pm25:        { safe: 12,   moderate: 35,   poor: 55   },
  temperature: { safeMin: 20,   safeMax: 24,
                 modMin: 24.1,  modMax: 27,
                 poorMin: 27.1, poorMax: 30 },
  humidity:    { safeMin: 30,   safeMax: 50,
                 modMin: 51,    modMax: 60,
                 poorMin: 61,   poorMax: 70 }
};

/* Points contributed per metric condition */
const CONDITION_POINTS = {
  safe: 100,
  moderate: 70,
  poor: 40,
  critical: 10
};

/* =========================================================
   2. STATE
   ========================================================= */
let classrooms     = [];
let selectedRoom   = '';
let selectedMetric = 'chi';
let currentRole    = 'student';
let rawFirebaseDevices = {};

let serverTimeOffset = 0;

let assignmentsCache = {};
let assignmentListenerAttached = false;
let classroomListenerAttached  = false;
let assignmentsLoadedFromFirebase = false;

const pendingWrites = {};
const PENDING_WRITE_GRACE_MS = 3000;

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
const statusLabel = s => (s || 'unknown').toUpperCase();

function now() {
  return Date.now() + serverTimeOffset;
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtOr(value, fn) {
  if (value === null || value === undefined) return 'No reading';
  return fn ? fn(value) : value;
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
   4. ASSIGNMENT PERSISTENCE (Firebase-backed)
   ========================================================= */
function loadAssignments() {
  if (Object.keys(assignmentsCache).length) return assignmentsCache;
  try { return JSON.parse(localStorage.getItem(ASSIGNMENTS_KEY) || '{}'); }
  catch { return {}; }
}

function saveAssignments(data) {
  assignmentsCache = data;
  try { localStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(data)); } catch {}

  if (!assignmentsLoadedFromFirebase) {
    console.warn('[PuriAir] saveAssignments blocked — Firebase snapshot not yet received.');
    return;
  }

  if (firebaseReady && db) {
    db.ref('assignments').set(data).catch(err => {
      console.error('[PuriAir] assignment save failed:', err);
      showToast('Sync failed', 'Assignments saved locally but not to Firebase.');
    });
  }
}

function attachAssignmentListener() {
  if (!firebaseReady || !db || assignmentListenerAttached) return;
  assignmentListenerAttached = true;

  db.ref('assignments').on('value', snap => {
    const val = snap.val() || {};
    assignmentsCache = val;
    assignmentsLoadedFromFirebase = true;
    try { localStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(val)); } catch {}
    buildClassroomsFromAssignments();
    renderAllViews();
  }, err => {
    console.warn('[PuriAir] assignments read failed:', err);
  });
}

function availableDeviceIds() {
  const assigned = new Set(Object.values(loadAssignments()).map(x => x.deviceId).filter(Boolean));
  return Object.keys(rawFirebaseDevices).filter(id => !assigned.has(id));
}

/* =========================================================
   5. FIREBASE INIT
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

    if (firebase.auth) {
      firebase.auth().onAuthStateChanged(user => {
        if (user) {
          console.log('[PuriAir] Firebase auth ready. UID:', user.uid);
          attachFirebaseListeners();
          attachAssignmentListener();
        } else {
          console.log('[PuriAir] No auth user — signing in anonymously…');
          firebase.auth().signInAnonymously()
            .then(cred => console.log('[PuriAir] Anonymous auth OK. UID:', cred.user.uid))
            .catch(err => console.warn('[PuriAir] Anonymous auth failed:', err.code, err.message));
        }
      });
    } else {
      console.warn('[PuriAir] firebase-auth-compat.js not loaded. Admin writes may fail.');
      attachFirebaseListeners();
      attachAssignmentListener();
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
    offline: 'Offline', connecting: 'Connecting',
    idle: 'Idle', stale: 'No recent data', live: 'Live'
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
function conditionCO2(v) {
  if (v === null) return 'unknown';
  if (v <= CHI_THRESHOLDS.co2.safe)      return 'safe';
  if (v <= CHI_THRESHOLDS.co2.moderate) return 'moderate';
  if (v <= CHI_THRESHOLDS.co2.poor)     return 'poor';
  return 'critical';
}
function conditionPM25(v) {
  if (v === null) return 'unknown';
  if (v <= CHI_THRESHOLDS.pm25.safe)      return 'safe';
  if (v <= CHI_THRESHOLDS.pm25.moderate) return 'moderate';
  if (v <= CHI_THRESHOLDS.pm25.poor)     return 'poor';
  return 'critical';
}
function conditionTemperature(v) {
  if (v === null) return 'unknown';
  if (v < CHI_THRESHOLDS.temperature.modMin) return 'safe';
  if (v < CHI_THRESHOLDS.temperature.poorMin) return 'moderate';
  if (v <= CHI_THRESHOLDS.temperature.poorMax) return 'poor';
  return 'critical';
}
function conditionHumidity(v) {
  if (v === null) return 'unknown';
  if (v < CHI_THRESHOLDS.humidity.modMin) return 'safe';
  if (v < CHI_THRESHOLDS.humidity.poorMin) return 'moderate';
  if (v <= CHI_THRESHOLDS.humidity.poorMax) return 'poor';
  return 'critical';
}
function conditionCHI(v) {
  if (v === null) return 'unknown';
  if (v >= 80) return 'safe';
  if (v >= 60) return 'moderate';
  if (v >= 40) return 'poor';
  return 'critical';
}

function roomStatusFromConditions(conds) {
  if (conds.every(c => c === 'unknown')) return 'unknown';
  if (conds.includes('critical')) return 'critical';
  if (conds.includes('poor'))     return 'poor';
  if (conds.includes('moderate')) return 'moderate';
  return 'safe';
}

function metricScore(type, value) {
  if (value === null) return null;

  const zone = metricCondition(type, value);

  const ZONES = {
    critical: { start: 0,  end: 25 },
    poor:     { start: 25, end: 50 },
    moderate: { start: 50, end: 75 },
    safe:     { start: 75, end: 100 }
  };

  const z = ZONES[zone];
  if (!z) return 50;

  let t = 0.5;

  if (type === 'co2') {
    const T = CHI_THRESHOLDS.co2;
    if (zone === 'safe')          t = Math.min(1, value / T.safe);
    else if (zone === 'moderate') t = (value - T.safe)     / (T.moderate - T.safe);
    else if (zone === 'poor')     t = (value - T.moderate) / (T.poor     - T.moderate);
    else                          t = Math.min(1, (value - T.poor) / 500);
  } else if (type === 'pm25') {
    const T = CHI_THRESHOLDS.pm25;
    if (zone === 'safe')          t = Math.min(1, value / T.safe);
    else if (zone === 'moderate') t = (value - T.safe)     / (T.moderate - T.safe);
    else if (zone === 'poor')     t = (value - T.moderate) / (T.poor     - T.moderate);
    else                          t = Math.min(1, (value - T.poor) / 45);
  } else if (type === 'temperature') {
    const T = CHI_THRESHOLDS.temperature;
    if (zone === 'safe')          t = 0.5 + (value - 22) / 4;
    else if (zone === 'moderate') t = (value - T.modMin)  / (T.modMax  - T.modMin);
    else if (zone === 'poor')     t = (value - T.poorMin) / (T.poorMax - T.poorMin);
    else                          t = value < 20
      ? Math.max(0, 1 - (18 - value) / 18)
      : Math.min(1, (value - 30) / 20);
  } else if (type === 'humidity') {
    const T = CHI_THRESHOLDS.humidity;
    if (zone === 'safe')          t = 0.5 + (value - 40) / 20;
    else if (zone === 'moderate') t = (value - T.modMin)  / (T.modMax  - T.modMin);
    else if (zone === 'poor')     t = (value - T.poorMin) / (T.poorMax - T.poorMin);
    else                          t = value < 30
      ? Math.max(0, 1 - (20 - value) / 20)
      : Math.min(1, (value - 70) / 20);
  } else if (type === 'chi') {
    if (zone === 'safe')          t = (value - 80) / 20;
    else if (zone === 'moderate') t = (value - 60) / 20;
    else if (zone === 'poor')     t = (value - 40) / 20;
    else                          t = value / 40;
  }

  t = Math.max(0, Math.min(1, t));
  return z.start + t * (z.end - z.start);
}

function computeCHI(co2, pm25, temp, humidity) {
  const conds = [
    conditionCO2(co2),
    conditionPM25(pm25),
    conditionTemperature(temp),
    conditionHumidity(humidity)
  ].filter(c => c !== 'unknown');

  if (!conds.length) return null;

  const total = conds.reduce((a, c) => a + CONDITION_POINTS[c], 0);
  return Math.round(total / conds.length);
}

function normalizeDeviceToRoom(devId, node, assignment, lastSyncedMs) {
  if (!node || typeof node !== 'object') return null;
  const latest  = (node.latest  && typeof node.latest  === 'object') ? node.latest  : null;
  const control = (node.control && typeof node.control === 'object') ? node.control : null;
  const status  = (node.status  && typeof node.status  === 'object') ? node.status  : null;

  const co2         = numOrNull(latest?.co2_ppm);
  const pm25        = numOrNull(latest?.pm25_ug_m3);
  const temperature = numOrNull(latest?.temperature_C);
  const humidity    = numOrNull(latest?.humidity_pct);
  const motionRaw   = latest?.motion;
  const occupancy   = motionRaw === true ? 1 : (motionRaw === false ? 0 : null);
  const purifier    = latest?.purifier === true;

  const conds = [
    conditionCO2(co2),
    conditionPM25(pm25),
    conditionTemperature(temperature),
    conditionHumidity(humidity)
  ];

  const chi = computeCHI(co2, pm25, temperature, humidity);
  const statusText = chi !== null ? conditionCHI(chi) : roomStatusFromConditions(conds);

  const tsMs = numOrNull(latest?.timestamp_ms) ?? 0;
  const hasTimestamp = tsMs > 0;
  const ageMs = hasTimestamp ? (now() - tsMs) : null;
  const fresh = hasTimestamp && ageMs !== null && ageMs < DEVICE_FRESH_MS;
  const online = latest?.clock_synced === true && fresh;

  let lastSynced = lastSyncedMs || 0;
  if (hasTimestamp && fresh && tsMs > lastSynced) lastSynced = tsMs;

  return {
    id: assignment.classroomId || devId,
    name: assignment.deviceName || `Classroom ${assignment.classroomId || devId}`,
    deviceId: devId,
    chi,
    co2, pm25, temperature, humidity,
    occupancy,
    purifier,
    status: statusText,
    conditions: {
      co2: conds[0], pm25: conds[1],
      temperature: conds[2], humidity: conds[3]
    },
    lastSynced,
    hasAnyReading: !(co2 === null && pm25 === null && temperature === null && humidity === null),
    device: {
      online,
      hasTimestamp,
      ageMs,
      last_seen: tsMs || 0,
      device_id: latest?.deviceId || devId,
      uptime_ms: numOrNull(latest?.device_uptime_ms) ?? 0,
      raw: { latest, control, status }
    }
  };
}

function buildClassroomsFromAssignments() {
  const assignments = loadAssignments();
  const built = [];
  let dirty = false;

  Object.entries(assignments).forEach(([classroomId, a]) => {
    const devId = a.deviceId;
    if (!devId) return;

    const node = rawFirebaseDevices[devId];
    if (!node || typeof node !== 'object') return;

    const r = normalizeDeviceToRoom(
      devId,
      node,
      { ...a, classroomId, deviceName: a.deviceName || `Classroom ${classroomId}` },
      a.lastSynced
    );
    if (!r) return;

    built.push(r);

    if (r.device.online && r.lastSynced > (a.lastSynced || 0)) {
      assignments[classroomId].lastSynced = r.lastSynced;
      dirty = true;
    }
  });

  if (dirty) saveAssignments(assignments);

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

  const anyFresh = Object.values(rawFirebaseDevices).some(node => {
    const ts = numOrNull(node?.latest?.timestamp_ms);
    return ts !== null && ts > 0 && (now() - ts) < DEVICE_FRESH_MS;
  });

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
    const ts = numOrNull(node?.latest?.timestamp_ms) ?? 0;
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
  if (!firebaseReady || !db || classroomListenerAttached) return;
  classroomListenerAttached = true;

  db.ref('.info/serverTimeOffset').on('value', snap => {
    serverTimeOffset = numOrNull(snap.val()) ?? 0;
    buildClassroomsFromAssignments();
    renderAllViews();
  });

  db.ref('.info/connected').on('value', snap => {
    const connected = snap.val() === true;
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
    buildClassroomsFromAssignments();

    const state = computeGlobalStatus();
    const labelMap = {
      idle: 'Connected · Idle', stale: 'No recent data',
      live: 'Firebase live',    offline: 'Disconnected'
    };
    setFirebaseUiStatus(state, labelMap[state]);
    renderAllViews();
    renderFreshnessBanner();

    const ls = $('#lastSync');
    if (ls) ls.textContent = state === 'live' ? 'just now'
      : (rawFirebaseDevices && Object.keys(rawFirebaseDevices).length ? 'no recent data' : 'waiting for devices');
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
  
  const activePage = $('.nav-item.active')?.dataset.page || 'puriair';
  if (!admin && ADMIN_ONLY_PAGES.includes(activePage)) navigate('overview');

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
  if (type === 'humidity')    return conditionHumidity(value);
  if (type === 'co2')         return conditionCO2(value);
  if (type === 'pm25')        return conditionPM25(value);
  if (type === 'temperature') return conditionTemperature(value);
  if (type === 'chi')         return conditionCHI(value);
  return 'unknown';
}
function metricLabel(type) {
  return ({
    humidity:'HUMIDITY', co2:'CO₂', pm25:'PM2.5',
    temperature:'TEMPERATURE', chi:'CHI'
  })[type] || 'METRIC';
}
function metricUnit(type) {
  return ({
    humidity:'%', co2:'ppm', pm25:'µg/m³',
    temperature:'°C', chi:'/ 100'
  })[type] || '';
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
    const chiText = r.chi === null ? '--' : r.chi;
    return `
    <tr class="condition-row ${r.status}">
      <td><span class="room-name">${r.id}</span>${offlineBadge}<small>${r.name}</small></td>
      <td><div class="chi-status-cell"><strong>${chiText}</strong><span class="status-chip ${r.status}">${statusLabel(r.status)}</span></div></td>
      <td class="${r.conditions.humidity}">${fmtOr(r.humidity, v => v + '%')}</td>
      <td class="${r.conditions.co2}">${fmtOr(r.co2, v => v + ' ppm')}</td>
      <td class="${r.conditions.pm25}">${fmtOr(r.pm25, v => v + ' µg/m³')}</td>
      <td class="${r.conditions.temperature}">${fmtOr(r.temperature, v => Number(v).toFixed(1) + ' °C')}</td>
      <td class="${r.status}">${r.purifier ? '<span class="value-good">ACTIVE</span>' : '<span>—</span>'}</td>
    </tr>`;
  }).join('');

  const safe     = classrooms.filter(r => r.status === 'safe').length;
  const occupied = classrooms.filter(r => r.occupancy === 1).length;
  const withCHI  = classrooms.filter(r => r.chi !== null);
  const overall  = withCHI.length
    ? Math.round(withCHI.reduce((a, r) => a + r.chi, 0) / withCHI.length)
    : null;

  const set = (sel, val) => { const el = $(sel); if (el) el.textContent = val; };
  set('#classroomCount', classrooms.length);
  set('#safeCount', safe);
  set('#occupiedCount', occupied);
  set('#alertCount', classrooms.filter(r => r.status === 'poor' || r.status === 'critical').length);
  set('#legendSafe', safe);
  set('#legendModerate', classrooms.filter(r => r.status === 'moderate').length);
  set('#legendPoor', classrooms.filter(r => r.status === 'poor').length);
  set('#legendCritical', classrooms.filter(r => r.status === 'critical').length);
  set('#overallCHI', overall === null ? '--' : overall);

  const gauge = $('#chiGauge');
  if (gauge) {
    if (overall === null) {
      gauge.style.background = 'conic-gradient(#eee 0deg 360deg)';
    } else {
      const gaugeColor = overall >= 80 ? 'safe' : overall >= 60 ? 'moderate' : overall >= 40 ? 'poor' : 'critical';
      gauge.style.background = `conic-gradient(var(--${gaugeColor}) 0deg ${overall * 3.6}deg,#eee ${overall * 3.6}deg 360deg)`;
    }
  }
}

function renderClassrooms() {
  const roomSel = $('#roomSelect');
  const cards = $('#classroomCards');

  if (!classrooms.length) {
    if (roomSel) roomSel.innerHTML = '<option>No classrooms assigned</option>';
    if (cards)   cards.innerHTML = '<div class="panel" style="padding:20px;color:#999;text-align:center">No PuriAir devices have been paired with a classroom yet, or assigned devices have never published to Firebase.</div>';
    
    // Clear the focused telemetry view
    const t = $('#detailRoomTitle'); if (t) t.textContent = 'No classroom assigned';
    const chi = $('#detailCHI'); if (chi) chi.textContent = '--';
    const grid = $('#detailTelemetry');
    if (grid) grid.innerHTML = '';
    const act = $('#studentPurifierActivity'); if (act) act.innerHTML = '<i></i> PURIFIER —';
    
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
        : (r.device.hasTimestamp ? `${Math.round(r.device.ageMs / 1000)}s ago` : 'never');
      const chiText = r.chi === null ? '--' : `CHI ${r.chi}`;
      return `
      <article class="room-card condition-box ${r.status} ${r.id === selectedRoom ? 'selected' : ''} ${r.device.online ? '' : 'device-offline'}" data-room="${r.id}">
        <div class="room-card-head">
          <h5>${r.id}</h5>
          <div class="card-status"><strong>${chiText}</strong><span class="status-chip ${r.status}">${statusLabel(r.status)}</span></div>
        </div>
        <div class="room-mini">
          <div><span>Humidity</span><strong>${fmtOr(r.humidity, v => v + '%')}</strong></div>
          <div><span>CO₂</span><strong>${fmtOr(r.co2, v => v + ' ppm')}</strong></div>
          <div><span>PM2.5</span><strong>${fmtOr(r.pm25, v => v + ' µg/m³')}</strong></div>
          <div><span>Temperature</span><strong>${fmtOr(r.temperature, v => Number(v).toFixed(1) + ' °C')}</strong></div>
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
  if ($('#detailCHI')) $('#detailCHI').textContent = r.chi === null ? '--' : r.chi;

  const telemetry = [
    ['humidity',    'Humidity',    r.humidity,                       '%'],
    ['co2',         'CO₂',         r.co2,                            'ppm'],
    ['pm25',        'PM2.5',       r.pm25,                           'µg/m³'],
    ['temperature', 'Temperature', r.temperature,                    '°C']
  ];

  const metricTiles = telemetry.map(x => {
    const status = r.conditions[x[0]]; 
    const display = x[2] === null ? 'No reading'
      : (x[0] === 'temperature' ? Number(x[2]).toFixed(1) : x[2]);
    return `<button type="button"
              class="telemetry metric-telemetry condition-box ${status} ${selectedMetric === x[0] ? 'active-metric' : ''}"
              data-metric="${x[0]}"
              aria-label="View ${x[1]} condition">
      <span>${x[1]}</span>
      <strong>${display}</strong>
      <em>${x[3]}</em>
      <small class="metric-condition-label">${statusLabel(status)}</small>
    </button>`;
  }).join('');

  const chiStatus  = r.chi === null ? 'unknown' : conditionCHI(r.chi);
  const chiDisplay = r.chi === null ? 'No reading' : r.chi;
  const chiTile = `<button type="button"
              class="telemetry metric-telemetry condition-box ${chiStatus} ${selectedMetric === 'chi' ? 'active-metric' : ''}"
              data-metric="chi"
              aria-label="View CHI condition">
      <span>CHI</span>
      <strong>${chiDisplay}</strong>
      <em>/ 100</em>
      <small class="metric-condition-label">${statusLabel(chiStatus)}</small>
    </button>`;

  const occupancyTile = `
    <div class="telemetry occupancy-tile ${r.occupancy === 1 ? 'occupied' : 'vacant'}">
      <span>Occupancy</span>
      <strong>${r.occupancy === null ? 'No reading' : (r.occupancy === 1 ? 'OCCUPIED' : 'VACANT')}</strong>
      <em>${r.occupancy === 1 ? 'Motion detected' : (r.occupancy === 0 ? 'No occupants detected' : 'No PIR data received')}</em>
    </div>`;

  const grid = $('#detailTelemetry');
  if (grid) {
    grid.innerHTML = metricTiles + chiTile + occupancyTile;
    $$('#detailTelemetry .metric-telemetry').forEach(el =>
      el.addEventListener('click', () => {
        selectedMetric = el.dataset.metric;
        renderRoomDetail();
      })
    );
  }

  let selected;
  if (selectedMetric === 'chi') {
    selected = ['chi', 'CHI', r.chi, '/ 100'];
  } else {
    selected = telemetry.find(x => x[0] === selectedMetric) || telemetry[0];
  }
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
  const status = value === null ? 'unknown' : metricCondition(type, value);
  const score  = metricScore(type, value);

  const valueText = value === null
    ? 'No reading'
    : `${type === 'temperature' ? Number(value).toFixed(1) : value} ${metricUnit(type)} · ${statusLabel(status)}`;

  if ($('#conditionMeterValue')) $('#conditionMeterValue').textContent = valueText;
  const arrow = $('#conditionMeterArrow');
  if (arrow) {
    if (score === null) {
      arrow.style.left = '50%';
      arrow.className  = 'condition-arrow unknown';
      arrow.textContent = '—';
    } else {
      arrow.style.left = `${Math.max(2, Math.min(98, Math.round(score)))}%`;
      arrow.className  = `condition-arrow ${status}`;
      arrow.textContent = '▼';
    }
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

/* =========================================================
   CHI MODAL
   ========================================================= */
function renderChiModal() {
  const body = $('#chiModalBody');
  if (!body) return;

  const r = room();
  if (!r) {
    body.innerHTML = '<p class="chi-explainer">No classroom is currently selected.</p>';
    return;
  }

  const overall = r.chi;
  const status = r.status;
  const conds = r.conditions || {};
  const statusLabelText = statusLabel(status);

  let scoreClass = 'unknown';
  if (overall !== null) {
    scoreClass = overall >= 80 ? 'safe'
               : overall >= 60 ? 'moderate'
               : overall >= 40 ? 'poor'
               : 'critical';
  }

  const rows = [
    { name: 'CO₂',         value: r.co2,         unit: 'ppm',   cond: conds.co2 },
    { name: 'PM2.5',       value: r.pm25,        unit: 'µg/m³', cond: conds.pm25 },
    { name: 'Temperature', value: r.temperature, unit: '°C',    cond: conds.temperature },
    { name: 'Humidity',    value: r.humidity,    unit: '%',     cond: conds.humidity }
  ];

  const rowsHtml = rows.map(row => {
    const cond = row.cond || 'unknown';
    const display = row.value === null || row.value === undefined
      ? 'No reading'
      : (row.name === 'Temperature' ? Number(row.value).toFixed(1) : row.value) + ' ' + row.unit;
    const points = CONDITION_POINTS[cond];
    const pointsText = points === undefined ? '—' : points;
    return `
      <tr>
        <td><strong>${row.name}</strong></td>
        <td>${display}</td>
        <td class="condition-cell ${cond}">${statusLabel(cond)}</td>
        <td><strong>${pointsText}</strong></td>
      </tr>`;
  }).join('');

  body.innerHTML = `
    <div class="chi-modal-section">
      <div class="chi-modal-score">
        <div class="chi-modal-score-num ${scoreClass}">
          ${overall === null ? '--' : overall}
        </div>
        <div class="chi-modal-score-meta">
          <strong>${statusLabelText}</strong>
          <small>
            ${overall === null
              ? 'No metric has reported a reading yet.'
              : `Average of the four individual metric conditions for ${r.id}.`}
          </small>
        </div>
      </div>

      <div class="chi-scale-bar">
        <div class="chi-scale-zone critical">CRITICAL<small>0 – 39</small></div>
        <div class="chi-scale-zone poor">POOR<small>40 – 59</small></div>
        <div class="chi-scale-zone moderate">MODERATE<small>60 – 79</small></div>
        <div class="chi-scale-zone safe">SAFE<small>80 – 100</small></div>
      </div>
    </div>

    <div class="chi-modal-section">
      <h5>This room's breakdown</h5>
      <table class="chi-breakdown-table">
        <thead>
          <tr>
            <th>Metric</th>
            <th>Reading</th>
            <th>Condition</th>
            <th>Points</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>

    <div class="chi-modal-section">
      <h5>How CHI is computed</h5>
      <p class="chi-explainer">
        Each metric is graded against the official PuriAir table:
        <br><br>
        <code>Safe = 100 pts · Moderate = 70 pts · Poor = 40 pts · Critical = 10 pts</code>
        <br><br>
        <strong>CHI = average of all reported metrics.</strong> Metrics with no reading are skipped.
        If a metric is <code>UNKNOWN</code>, it does not contribute to CHI.
        <br><br>
        Example: one safe, one moderate, one poor → <code>(100 + 70 + 40) / 3 = 70 → MODERATE</code>.
      </p>
    </div>
  `;
}

function openChiModal() {
  renderChiModal();
  $('#chiModal')?.classList.remove('hidden');
}
function closeChiModal() {
  $('#chiModal')?.classList.add('hidden');
}

/* =========================================================
   10. SENSOR STATUS PAGE
   ========================================================= */
function sensorStateFromValue(value) {
  if (value === null) return 'unknown';
  if (!Number.isFinite(Number(value))) return 'malfunctioning';
  return 'functioning';
}
function stateLabel(s) {
  if (s === 'functioning')    return 'FUNCTIONING';
  if (s === 'malfunctioning') return 'MALFUNCTIONING';
  return 'UNKNOWN';
}
function stateTone(s) {
  if (s === 'functioning')    return 'safe';
  if (s === 'malfunctioning') return 'critical';
  return 'moderate';
}

function formatDuration(ms){
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

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

  const tempState = sensorStateFromValue(r.temperature);
  const humState  = sensorStateFromValue(r.humidity);
  const co2State  = sensorStateFromValue(r.co2);
  const pmState   = sensorStateFromValue(r.pm25);
  const pirState  = r.occupancy === null ? 'unknown' : 'functioning';

  const lastSeenMs = r.device?.last_seen || 0;
  const secSince   = lastSeenMs ? Math.round((now() - lastSeenMs) / 1000) : null;
  const onlineOk   = r.device?.online === true;
  const espState   = r.device?.hasTimestamp === false ? 'unknown'
    : (onlineOk ? 'functioning' : 'malfunctioning');

  const dhtCombined =
    (tempState === 'functioning' || humState === 'functioning') ? 'functioning' :
    (tempState === 'malfunctioning' || humState === 'malfunctioning') ? 'malfunctioning' : 'unknown';

  const devices = [
    {
      name: 'ESP32 Controller',
      model: `Device ${r.device?.device_id || '—'} · uptime ${formatDuration(r.device?.uptime_ms || 0)}`,
      value: r.device?.hasTimestamp ? (onlineOk ? 'ONLINE' : 'STALE') : 'NEVER REPORTED',
      state: stateLabel(espState),
      tone: stateTone(espState),
      detail: secSince === null ? 'No timestamp received yet.' : `Last telemetry ${secSince}s ago`
    },
    {
      name: 'DHT22',
      model: 'Temperature and relative humidity',
      value: `Temp: ${fmtOr(r.temperature, v => Number(v).toFixed(1) + ' °C')} · RH: ${fmtOr(r.humidity, v => v + '%')}`,
      state: stateLabel(dhtCombined),
      tone: stateTone(dhtCombined),
      detail: (tempState === 'unknown' && humState === 'unknown')
        ? 'No temperature or humidity received.'
        : 'At least one DHT22 input present.'
    },
    {
      name: 'MH-Z19C',
      model: 'CO₂ concentration',
      value: fmtOr(r.co2, v => v + ' ppm'),
      state: stateLabel(co2State),
      tone: stateTone(co2State),
      detail: co2State === 'unknown' ? 'No CO₂ reading received.' : 'Numeric CO₂ reading present.'
    },
    {
      name: 'PMS5003',
      model: 'PM2.5 particulate matter',
      value: fmtOr(r.pm25, v => v + ' µg/m³'),
      state: stateLabel(pmState),
      tone: stateTone(pmState),
      detail: pmState === 'unknown' ? 'No PM2.5 reading received.' : 'Numeric PM2.5 reading present.'
    },
    {
      name: 'PIR Sensor HC-SR501',
      model: 'Motion / occupancy input',
      value: r.occupancy === null ? 'No reading' : (r.occupancy === 1 ? 'MOTION DETECTED' : 'NO MOTION'),
      state: stateLabel(pirState),
      tone: stateTone(pirState),
      detail: pirState === 'unknown' ? 'No motion telemetry received.' : 'Motion telemetry present.'
    }
  ];

  if ($('#sensorSummary')) $('#sensorSummary').innerHTML = devices.map(d => `
    <article class="panel sensor-card">
      <div class="sensor-card-top">
        <span class="sensor-device-icon">${d.name.startsWith('ESP32') ? '▦' : d.name === 'DHT22' ? '℃' : d.name === 'MH-Z19C' ? '◉' : d.name === 'PMS5003' ? '▤' : '⌁'}</span>
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

  if ($('#sensorCheckedAt')) $('#sensorCheckedAt').textContent =
    `Updated ${new Date().toLocaleTimeString('en-PH', {hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false})}`;
}

/* =========================================================
   11. PURIFIER PAGE
   ========================================================= */
function renderPurifier() {
  const select = $('#purifierRoomSelect');
  if (!select) return;

  if (!classrooms.length) {
    select.innerHTML = '';
    if ($('#purifierSummary')) $('#purifierSummary').innerHTML = '<article class="panel sensor-empty">No classrooms assigned yet.</article>';
    if ($('#filterForecast')) $('#filterForecast').innerHTML = '';
    if ($('#filterHistory')) $('#filterHistory').innerHTML = '';
    return;
  }

  if (!classrooms.some(r => r.id === selectedRoom)) selectedRoom = classrooms[0].id;
  select.innerHTML = classrooms.map(r => `<option value="${r.id}" ${r.id === selectedRoom ? 'selected' : ''}>${r.id} — ${r.name}</option>`).join('');

  const r = room(); if (!r) return;

  const status = r.device?.raw?.status || null;
  const control = r.device?.raw?.control || null;

  const cards = [
    {
      name: 'Purifier fan',
      model: 'Relay-controlled DC blower',
      value: status?.purifierFan === true ? 'ACTIVE'
           : status?.purifierFan === false ? 'OFF'
           : 'No status reported',
      tone: status?.purifierFan === true ? 'safe'
          : status?.purifierFan === false ? 'moderate'
          : 'moderate',
      note: status ? 'Reported by ESP32 /status node.' : 'ESP32 has never published /status.'
    },
    {
      name: 'Humidifier (atomizer)',
      model: 'Relay-controlled atomizer',
      value: status?.humidifier === true ? 'ACTIVE'
           : status?.humidifier === false ? 'OFF'
           : 'No status reported',
      tone: status?.humidifier === true ? 'safe'
          : status?.humidifier === false ? 'moderate'
          : 'moderate',
      note: status ? 'Reported by ESP32 /status node.' : 'ESP32 has never published /status.'
    },
    {
      name: 'Dehumidifier (Peltier)',
      model: 'TEC1-12706 with heatsink fan',
      value: status?.dehumidifier === true ? 'ACTIVE'
           : status?.dehumidifier === false ? 'OFF'
           : 'No status reported',
      tone: status?.dehumidifier === true ? 'safe'
          : status?.dehumidifier === false ? 'moderate'
          : 'moderate',
      note: status ? 'Reported by ESP32 /status node.' : 'ESP32 has never published /status.'
    },
    {
      name: 'Master power',
      model: 'Main system enable',
      value: status?.power === true ? 'ON'
           : status?.power === false ? 'OFF'
           : 'No status reported',
      tone: status?.power === true ? 'safe'
          : status?.power === false ? 'moderate'
          : 'moderate',
      note: status ? 'Reported by ESP32 /status node.' : 'ESP32 has never published /status.'
    },
    {
      name: 'Operating mode',
      model: 'Auto vs Manual',
      value: status?.mode ? String(status.mode).toUpperCase() : 'No status reported',
      tone: status?.mode ? 'safe' : 'moderate',
      note: status ? 'Reported by ESP32 /status node.' : 'ESP32 has never published /status.'
    },
    {
      name: 'Last command received',
      model: 'Latest /control write',
      value: control ? `Mode ${control.mode || '—'} · PWR ${control.power ? 'ON' : 'OFF'}` : 'No control node',
      tone: control ? 'safe' : 'moderate',
      note: control ? 'Reflects the last command stored in Firebase.' : 'No /control has ever been written.'
    }
  ];

  if ($('#purifierSummary')) {
    $('#purifierSummary').innerHTML = cards.map(c => `
      <article class="panel sensor-card">
        <div class="sensor-card-top">
          <span class="sensor-device-icon">◉</span>
          <span class="sensor-status-pill ${c.tone}">${c.tone === 'safe' ? 'REPORTED' : 'NO DATA'}</span>
        </div>
        <h4>${c.name}</h4>
        <p>${c.model}</p>
        <strong class="sensor-reading">${c.value}</strong>
        <small>${c.note}</small>
      </article>`).join('');
  }

  if ($('#filterForecast')) {
    $('#filterForecast').innerHTML = '<p class="management-note">Filter service intervals are not configured. Add records below and they will appear here.</p>';
  }

  const records = loadFilterRecords()[r.id] || {};
  const all = Object.entries(records).flatMap(([k, arr]) =>
    (arr || []).map(rec => ({ ...rec, type: k }))
  ).sort((a, b) => (b.created || 0) - (a.created || 0));

  if ($('#filterHistory')) {
    $('#filterHistory').innerHTML = all.length
      ? all.map(rec => `
        <div class="sensor-diagnostic-row">
          <div>
            <strong>${(rec.type || '').toUpperCase()} · ${rec.action || ''}</strong>
            <small>${rec.date || ''} · Condition: ${rec.condition || '—'} · ${rec.notes || 'No notes'}</small>
          </div>
          <span class="sensor-status-pill ${rec.condition === 'good' ? 'safe' : rec.condition === 'moderate' ? 'moderate' : 'critical'}">${(rec.condition || 'unknown').toUpperCase()}</span>
        </div>`).join('')
      : '<p class="management-note">No filter maintenance records yet.</p>';
  }
}

/* =========================================================
   12. DATABASE LOGS
   ========================================================= */
function fetchDailyTelemetry(deviceId, dateStr) {
  return new Promise((resolve, reject) => {
    if (!firebaseReady || !db) { reject(new Error('Firebase not connected')); return; }

    const path = `devices/${deviceId}/readings/${dateStr}`;
    db.ref(path).once('value')
      .then(snap => {
        const day = snap.val() || {};
        const rows = [];

        Object.entries(day).forEach(([timeKey, rec]) => {
          if (!rec || typeof rec !== 'object') return;

          const ts = numOrNull(rec.timestamp_ms);
          if (!ts || ts < 1700000000000) return;

          rows.push({
            timestamp:   new Date(ts).toISOString(),
            date:        rec.date || dateStr,
            time:        rec.time || timeKey.replace(/-/g, ':'),
            classroom:   deviceId,
            temperature_C: numOrNull(rec.temperature_C),
            humidity_pct:  numOrNull(rec.humidity_pct),
            pm25_ug_m3:    numOrNull(rec.pm25_ug_m3),
            co2_ppm:       numOrNull(rec.co2_ppm),
            motion:        rec.motion === true ? 1 : 0
          });
        });

        rows.sort((a, b) => a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0);
        resolve(rows);
      })
      .catch(reject);
  });
}

function rowsToExcelXml(rows, sheetName) {
  if (!rows.length) {
    return `<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="${escapeXml(sheetName)}"><Table><Row><Cell><Data ss:Type="String">No data</Data></Cell></Row></Table></Worksheet></Workbook>`;
  }
  const headers = Object.keys(rows[0]);
  const headerCells = headers.map(h => `<Cell ss:StyleID="hdr"><Data ss:Type="String">${escapeXml(h)}</Data></Cell>`).join('');
  const bodyRows = rows.map(r => {
    const cells = headers.map(h => {
      const v = r[h];
      if (v === null || v === undefined) {
        return `<Cell><Data ss:Type="String">No reading</Data></Cell>`;
      }
      const isNum = typeof v === 'number' && isFinite(v);
      const type = isNum ? 'Number' : 'String';
      return `<Cell><Data ss:Type="${type}">${escapeXml(v)}</Data></Cell>`;
    }).join('');
    return `<Row>${cells}</Row>`;
  }).join('');
  return `<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="hdr"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#7B1113" ss:Pattern="Solid"/></Style></Styles><Worksheet ss:Name="${escapeXml(sheetName)}"><Table><Row>${headerCells}</Row>${bodyRows}</Table></Worksheet></Workbook>`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
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
    if ($('#databaseBlockInfo')) $('#databaseBlockInfo').innerHTML = '';
    return;
  }

  if (!classrooms.some(r => r.id === selectedRoom)) selectedRoom = classrooms[0].id;
  roomSel.innerHTML = classrooms.map(r =>
    `<option value="${r.id}" ${r.id === selectedRoom ? 'selected' : ''}>${r.id} — ${r.name}</option>`
  ).join('');

  const dateInput = $('#databaseDate');
  if (dateInput) {
    const today = new Date();
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    const last  = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const toISO = d => d.toISOString().slice(0, 10);
    dateInput.min = toISO(first);
    dateInput.max = toISO(last);
    if (!dateInput.value) dateInput.value = toISO(today);
  }

  updateDatabaseBlockInfo();
}

function updateDatabaseBlockInfo() {
  const roomId  = $('#databaseRoomSelect')?.value;
  const dateVal = $('#databaseDate')?.value;
  const info = $('#databaseBlockInfo');
  if (!info) return;
  if (!roomId || !dateVal) { info.innerHTML = ''; return; }

  const r = classrooms.find(x => x.id === roomId);
  info.innerHTML = `
    Selected classroom: <strong>${escapeXml(roomId)}</strong><br>
    Assigned device: <strong>${escapeXml(r?.deviceId || '—')}</strong><br>
    Target date: <strong>${escapeXml(dateVal)}</strong><br>
    Source: <strong>Firebase /devices/&lt;deviceId&gt;/readings/${escapeXml(dateVal)}</strong>
  `;
}

async function handleDatabaseExport(e) {
  e.preventDefault();
  if (!isAdmin()) { showToast('Access denied', 'Only administrators can export database logs.'); return; }

  const classroomId = $('#databaseRoomSelect').value;
  const dateVal     = $('#databaseDate').value;
  if (!classroomId || !dateVal) { showToast('Missing parameters', 'Select a classroom and date.'); return; }

  const r = classrooms.find(x => x.id === classroomId);
  if (!r || !r.deviceId) { showToast('No device', `Classroom ${classroomId} has no device assigned.`); return; }

  const today = new Date();
  const yyyy = today.getFullYear();
  const mm   = String(today.getMonth() + 1).padStart(2, '0');
  if (!dateVal.startsWith(`${yyyy}-${mm}`)) {
    showToast('Out of range', 'Only the current month is downloadable.');
    return;
  }

  showToast('Fetching…', `Reading Firebase history for ${r.deviceId} on ${dateVal}…`);

  try {
    const rows = await fetchDailyTelemetry(r.deviceId, dateVal);
    if (!rows.length) {
      showToast('No data', `No history recorded for ${classroomId} on ${dateVal}.`);
      return;
    }
    downloadExcel(rows, `${classroomId}_telemetry_${dateVal}.xls`, `${classroomId} ${dateVal}`.slice(0, 28));
    showToast('Download ready', `${rows.length} rows for ${classroomId} on ${dateVal}.`);
  } catch (err) {
    console.error('[PuriAir] export failed:', err);
    showToast('Export failed', err.message || 'See console.');
  }
}

/* =========================================================
   13. NAVIGATION
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
   14. TOAST / CLOCK
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
   15. ADMIN PURIFIER CONTROL
   ========================================================= */
function pushControlUpdate(updates) {
  const r = room();
  if (!r) return Promise.reject(new Error('No classroom selected.'));

  const devId = r.deviceId;
  Object.keys(updates).forEach(k => { pendingWrites[k] = Date.now(); });

  if (!firebaseReady || !db) {
    Object.assign(purifierControlState, updates);
    applyControlToUi();
    showToast('Offline update', 'Firebase not connected — changed locally only.');
    return Promise.resolve();
  }

  return db.ref(`devices/${devId}/control`).update(updates)
    .then(() => { Object.assign(purifierControlState, updates); applyControlToUi(); })
    .catch(err => {
      console.error('[PuriAir] Control write failed:', err);
      showToast('Write failed', 'Could not send command to Firebase.');
    });
}

function toggleOperatingMode() {
  if (!isAdmin()) { showToast('Access denied', 'Only administrators can change mode.'); return; }
  const newMode = purifierControlState.mode === 'auto' ? 'manual' : 'auto';
  pushControlUpdate({ mode: newMode }).then(() => {
    showToast(newMode === 'auto' ? 'Automatic mode' : 'Manual mode',
              newMode === 'auto' ? 'The ESP32 now controls the purifier automatically.'
                                 : 'You now control the purifier switches.');
  });
}
function togglePower() {
  if (!isAdmin() || purifierControlState.mode !== 'manual') return;
  const s = !purifierControlState.power;
  pushControlUpdate({ power: s }).then(() => showToast('Power ' + (s ? 'ON' : 'OFF'), 'Master switch updated.'));
}
function toggleFan() {
  if (!isAdmin() || purifierControlState.mode !== 'manual') return;
  pushControlUpdate({ purifierFan: !purifierControlState.purifierFan });
}
function toggleHumidifier() {
  if (!isAdmin() || purifierControlState.mode !== 'manual') return;
  const s = !purifierControlState.humidifier;
  const updates = { humidifier: s };
  if (s && purifierControlState.dehumidifier) {
    updates.dehumidifier = false;
    showToast('Dehumidifier disabled', 'Humidifier and dehumidifier cannot run together.');
  }
  pushControlUpdate(updates);
}
function toggleDehumidifier() {
  if (!isAdmin() || purifierControlState.mode !== 'manual') return;
  const s = !purifierControlState.dehumidifier;
  const updates = { dehumidifier: s };
  if (s && purifierControlState.humidifier) {
    updates.humidifier = false;
    showToast('Humidifier disabled', 'Humidifier and dehumidifier cannot run together.');
  }
  pushControlUpdate(updates);
}

function applyControlToUi() {
  const isManual = purifierControlState.mode === 'manual' && isAdmin();

  const setToggle = (id, checked, disabled) => {
    const el = $(id); if (!el) return;
    el.checked = checked; el.disabled = disabled;
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
      ? 'Return to Automatic' : 'Enable Manual Mode';
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
        help.textContent = '✓ Device confirmed.';
        help.className = 'helper-text confirmed';
      }
    }
  }
}

function syncControlPanelFromDevice(r) {
  if (!r || !r.device) return;
  const ctrl = r.device.raw && r.device.raw.control;
  if (!ctrl) return;

  const t = Date.now();
  const fresh = (k) => !pendingWrites[k] || (t - pendingWrites[k]) > PENDING_WRITE_GRACE_MS;

  if (fresh('mode'))         purifierControlState.mode         = ctrl.mode === 'manual' ? 'manual' : 'auto';
  if (fresh('power'))        purifierControlState.power        = ctrl.power === true;
  if (fresh('purifierFan'))  purifierControlState.purifierFan  = ctrl.purifierFan === true;
  if (fresh('humidifier'))   purifierControlState.humidifier   = ctrl.humidifier === true;
  if (fresh('dehumidifier')) purifierControlState.dehumidifier = ctrl.dehumidifier === true;
}

/* =========================================================
   16. FILTER LOG
   ========================================================= */
function loadFilterRecords() {
  try { return JSON.parse(localStorage.getItem('puriair_filter_records') || '{}'); }
  catch { return {}; }
}
function saveFilterRecords(data) {
  localStorage.setItem('puriair_filter_records', JSON.stringify(data));
}

/* =========================================================
   17. EVENT LISTENERS
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

  $('#chiBubbleBtn')?.addEventListener('click', openChiModal);
  $('#closeChiModal')?.addEventListener('click', closeChiModal);
  $('#chiModal')?.addEventListener('click', e => {
    if (e.target.id === 'chiModal') closeChiModal();
  });

  const fsd = $('#filterServiceDate');
  if (fsd) fsd.value = new Date().toISOString().slice(0, 10);

  $('#filterLogForm')?.addEventListener('submit', e => {
    e.preventDefault();
    const key = selectedRoom;
    if (!key) { showToast('No classroom selected', 'Assign a classroom first.'); return; }
    const type = $('#filterType').value;
    const records = loadFilterRecords();
    records[key] = records[key] || {};
    records[key][type] = records[key][type] || [];
    records[key][type].push({
      date: $('#filterServiceDate').value,
      action: $('#filterAction').value,
      condition: $('#filterCondition').value,
      notes: $('#filterNotes').value.trim(),
      created: Date.now()
    });
    saveFilterRecords(records);
    $('#filterNotes').value = '';
    renderPurifier();
    showToast('Maintenance saved', `Record saved for ${key}.`);
  });

  $('#databaseExportForm')?.addEventListener('submit', handleDatabaseExport);
  $('#databaseRoomSelect')?.addEventListener('change', () => {
    selectedRoom = $('#databaseRoomSelect').value;
    updateDatabaseBlockInfo();
  });
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
   18. CLASSROOM MANAGEMENT
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

  assignments[id] = { deviceId: devId, deviceName: `Classroom ${id}`, lastSynced: 0, updatedAt: Date.now() };
  saveAssignments(assignments);
  closeClassroomModal();
  showToast('Classroom added', `${id} paired with ${devId}.`);

  buildClassroomsFromAssignments();
  applyRole();
  renderAllViews();
}
function confirmRemoveClassroom() {
  if (!isAdmin()) return;
  
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
   19. INITIALIZATION
   ========================================================= */
window.addEventListener('error', (e) => {
  console.error('[PuriAir global]', e.error || e.message);
  try { showToast('Runtime error', (e.error && e.error.message) || e.message || 'Unknown error'); } catch {}
});

function init() {
  try {
    try {
      const cached = JSON.parse(localStorage.getItem(ASSIGNMENTS_KEY) || '{}');
      if (cached && typeof cached === 'object') assignmentsCache = cached;
    } catch {}

    initFirebase();
    applyRole();
    wireListeners();
    navigate('puriair');

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
