/* =========================================================================
   Tail Control — Web Bluetooth app for ClawGear, Ear Gear 2, FlutterWings,
   Mitail, and MiTail Mini.

   All five products share one GATT service. Adjust the UUIDs below if a
   product ever diverges.
   ========================================================================= */

const SERVICE_UUID = '19f8ade2-d0c6-4c0a-912a-30601d9b3060';
const RX_UUID      = '5e4d86ac-ef2f-466f-a857-8776d45ffbc2'; // notify: device -> app
const TX_UUID      = '567a99d6-a442-4ac0-b676-4993bf95f805'; // write:  app -> device
const BATT_UUID    = 'e818bda3-88a7-43c0-8509-6e0bbb6f55d9'; // battery voltage (custom, per spec doc)

// A live GATT inspection of an actual mitail unit found a *different* set of
// UUIDs than the ones in the spec doc above — the doc may be stale, or this
// firmware revision may have moved on. We try the documented UUIDs first,
// then fall back to these, so the app still works whichever a given device
// actually implements. Run a BLE inspector against your other four products
// to see which set (if either) they match.
const DISCOVERED_SERVICE_UUID = '3af2108b-d066-42da-a7d4-55648fa0a9b6';
const DISCOVERED_RX_UUID      = 'c6612b64-0087-4974-939e-68968ef294b0'; // readable, saw "mitail ready"
const DISCOVERED_TX_UUID      = '5bfd6484-ddee-4723-bfe6-b653372bbfd6'; // "Read Not Permitted" = write-only

// Standard Bluetooth SIG Battery Service — the mitail unit exposes battery
// level here, standard-issue, alongside two custom characteristics
// (voltage, charging state) grouped into the same service.
const BATTERY_SERVICE_UUID       = '0000180f-0000-1000-8000-00805f9b34fb';
const BATTERY_LEVEL_UUID         = '00002a19-0000-1000-8000-00805f9b34fb'; // standard, single byte 0-100
const BATTERY_VOLTAGE_CUSTOM_UUID   = 'b08fed02-0584-40ef-b006-aff7e0d24e13'; // format unconfirmed
const CHARGING_STATE_CUSTOM_UUID    = '5073792e-4fc0-45a0-b0a5-78b6c1756c91'; // format unconfirmed

const PROTOCOL_CANDIDATES = [
  { service: SERVICE_UUID, tx: TX_UUID, rx: RX_UUID, label: 'documented' },
  { service: DISCOVERED_SERVICE_UUID, tx: DISCOVERED_TX_UUID, rx: DISCOVERED_RX_UUID, label: 'discovered' },
];

// Product name matching, used to label a device once we know its BLE name.
const PRODUCTS = [
  { key: 'clawgear', label: 'ClawGear',      match: /claw/i },
  { key: 'eg2',       label: 'Ear Gear 2',    match: /\bear\b|eg2/i },
  { key: 'flutter',   label: 'FlutterWings',  match: /flutter|wing/i },
  { key: 'minitail',  label: 'MiTail Mini',   match: /mini/i },
  { key: 'mitail',    label: 'Mitail',        match: /mitail|tail/i },
];

const MOVES = [
  ['TAILHM', 'Home'],
  ['TAILS1', 'Slow wag 1'],
  ['TAILS2', 'Slow wag 2'],
  ['TAILS3', 'Slow wag 3'],
  ['TAILFA', 'Fast wag'],
  ['TAILSH', 'Short wag'],
  ['TAILHA', 'Happy wag'],
  ['TAILER', 'Erect / lift'],
  ['TAILEP', 'Erect pulse'],
  ['TAILT1', 'Tremble 1'],
  ['TAILT2', 'Tremble 2'],
  ['TAILET', 'Erect tremble'],
];

const CONF_FIELDS = [
  'ver', 'minsToSleep', 'minsToNPM', 'minNPMPauseSec', 'maxNPMPauseSec',
  'groupsNPM', 'servo1home', 'servo2home', 'listenModeNPMEnabled',
  'listenModeResponseOnly', 'groupsLM', 'tiltModeNPMEnabled',
  'tiltModeResponseOnly', 'disconnectedCountdownEnabled', 'homeOnAppPoweroff',
  'conferenceModeEnabled', 'securityPasskey', 'numRGBLEDs', 'nomRGBVolt',
  'maxRGBmAmp',
];

/* ---------------------------------------------------------------------- */
/* State                                                                  */
/* ---------------------------------------------------------------------- */

const state = {
  devices: new Map(), // id -> deviceRecord
  activeDeviceId: null,
};

function guessProduct(name) {
  if (!name) return 'Unknown device';
  const hit = PRODUCTS.find(p => p.match.test(name));
  return hit ? hit.label : name;
}

function log(deviceId, dir, text) {
  const el = document.getElementById('console');
  if (!el) return;
  const line = document.createElement('div');
  line.className = 'console-line';
  const ts = new Date().toLocaleTimeString();
  const dirClass = dir === 'tx' ? 'dir-tx' : dir === 'rx' ? 'dir-rx' : 'dir-sys';
  const dirLabel = dir === 'tx' ? '→ tx' : dir === 'rx' ? '← rx' : '·';
  line.innerHTML = `<span class="ts">${ts}</span><span class="${dirClass}">${dirLabel}</span><span>${escapeHtml(text)}</span>`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function toast(msg, type = '') {
  const host = document.getElementById('toast-host');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

/* ---------------------------------------------------------------------- */
/* Bluetooth                                                              */
/* ---------------------------------------------------------------------- */

async function scanAndConnect(mode = 'filtered') {
  if (!navigator.bluetooth) {
    document.getElementById('ble-support-warning').classList.remove('hidden');
    document.getElementById('ble-support-warning').textContent =
      "This browser doesn't support Web Bluetooth. Use Chrome or Edge on desktop or Android (iOS isn't supported by any browser — try the Bluefy app on iPhone).";
    return;
  }

  try {
    // "filtered" only lists devices that advertise SERVICE_UUID directly in
    // their advertising packet — fast and clean, but some peripherals only
    // expose their services after connection and simply won't show up here.
    // "all" (acceptAllDevices) lists every nearby BLE device by name instead,
    // as a fallback for that case. optionalServices is what actually grants
    // GATT access to SERVICE_UUID once connected, in either mode.
    const requestOptions = mode === 'all'
      ? { acceptAllDevices: true, optionalServices: [SERVICE_UUID, DISCOVERED_SERVICE_UUID, BATTERY_SERVICE_UUID] }
      : { filters: [{ services: [SERVICE_UUID] }, { services: [DISCOVERED_SERVICE_UUID] }], optionalServices: [SERVICE_UUID, DISCOVERED_SERVICE_UUID, BATTERY_SERVICE_UUID] };

    const btDevice = await navigator.bluetooth.requestDevice(requestOptions);

    const id = btDevice.id;
    log(id, 'sys', `Connecting to ${btDevice.name || id}…`);

    const server = await btDevice.gatt.connect();

    // Try each known protocol layout until one actually has the service.
    let service = null, txChar = null, rxChar = null, matchedProtocol = null;
    for (const candidate of PROTOCOL_CANDIDATES) {
      try {
        service = await server.getPrimaryService(candidate.service);
        txChar = await service.getCharacteristic(candidate.tx);
        rxChar = await service.getCharacteristic(candidate.rx);
        matchedProtocol = candidate.label;
        break;
      } catch (e) { /* try the next candidate */ }
    }
    if (!service) {
      server.disconnect();
      toast(`${btDevice.name || 'That device'} doesn't match any known protocol layout`, 'error');
      log(id, 'sys', `No known service found on ${btDevice.name || id}. Disconnected.`);
      return;
    }
    log(id, 'sys', `Matched ${matchedProtocol} protocol layout.`);

    // Enumerate every service/characteristic the device actually exposes,
    // for the Raw GATT explorer — this is what lets you test writes against
    // characteristics we didn't guess correctly.
    const allChars = await discoverAllCharacteristics(server);
    log(id, 'sys', `Discovered ${allChars.length} characteristic(s) across all services.`);

    let battChar = null;
    try {
      const battService = await server.getPrimaryService(BATTERY_SERVICE_UUID);
      battChar = await battService.getCharacteristic(BATTERY_LEVEL_UUID);
    } catch (e) { /* optional, or documented custom BATT_UUID may live directly on the main service */
      try { battChar = await service.getCharacteristic(BATT_UUID); } catch (e2) { /* not present */ }
    }

    const record = {
      id,
      btDevice,
      server,
      txChar,
      rxChar,
      battChar,
      protocol: matchedProtocol,
      allChars,
      gattSubscriptions: new Map(), // charKey -> listener fn, for the explorer's Subscribe toggle
      name: btDevice.name || 'Unnamed device',
      product: guessProduct(btDevice.name),
      connected: true,
      battery: null,
    };

    state.devices.set(id, record);
    state.activeDeviceId = id;

    // Read whatever's already sitting in RX before subscribing — some
    // firmware exposes a readable status string (e.g. "mitail ready") here.
    try {
      const initial = await rxChar.readValue();
      const text = decodeValue(initial);
      if (text) log(id, 'rx', text);
    } catch (e) { /* not readable, notify-only — fine */ }

    await rxChar.startNotifications();
    rxChar.addEventListener('characteristicvaluechanged', (ev) => {
      const text = decodeValue(ev.target.value);
      log(id, 'rx', text);
      maybeParseConfig(id, text);
    });

    if (battChar) {
      try {
        const initialBatt = await battChar.readValue();
        record.battery = decodeBattery(initialBatt);
      } catch (e) { /* not readable up front, fine */ }
      try {
        await battChar.startNotifications();
        battChar.addEventListener('characteristicvaluechanged', (ev) => {
          record.battery = decodeBattery(ev.target.value);
          renderAll();
        });
      } catch (e) { /* device may not support notify on this char */ }
    }

    btDevice.addEventListener('gattserverdisconnected', () => {
      record.connected = false;
      log(id, 'sys', `${record.name} disconnected.`);
      toast(`${record.name} disconnected`, 'error');
      renderAll();
    });

    log(id, 'sys', `Connected to ${record.name} (${record.product}).`);
    toast(`Connected to ${record.name}`, 'success');
    renderAll();
  } catch (err) {
    if (err.name === 'NotFoundError') return; // user cancelled the chooser
    console.error(err);
    toast(`Connection failed: ${err.message}`, 'error');
  }
}

// Walk every primary service on the device and every characteristic on
// each, so the Raw GATT explorer can offer literally everything the device
// exposes rather than just the UUIDs we guessed correctly.
async function discoverAllCharacteristics(server) {
  const results = [];
  try {
    const services = await server.getPrimaryServices();
    for (const service of services) {
      try {
        const chars = await service.getCharacteristics();
        for (const char of chars) {
          results.push({
            key: `${service.uuid}::${char.uuid}`,
            serviceUuid: service.uuid,
            charUuid: char.uuid,
            char,
            properties: char.properties,
          });
        }
      } catch (e) { /* some services may refuse enumeration */ }
    }
  } catch (e) {
    // getPrimaryServices() with no filter requires the site to have
    // "generic access" to enumerate everything; if that's blocked, fall
    // back to nothing — the explorer will just be empty for this device.
  }
  return results;
}

function shortUuid(uuid) {
  const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.exec(uuid);
  if (m) return `0x${m[1].toUpperCase()}`;
  return uuid.split('-')[0];
}

function propsBadges(props) {
  if (!props) return '';
  const flags = [];
  if (props.read) flags.push('R');
  if (props.write) flags.push('W');
  if (props.writeWithoutResponse) flags.push('WNR');
  if (props.notify) flags.push('N');
  if (props.indicate) flags.push('I');
  return flags.join(' ');
}

function decodeValue(dataView) {
  try {
    return new TextDecoder().decode(dataView);
  } catch (e) {
    return Array.from(new Uint8Array(dataView.buffer)).map(b => b.toString(16).padStart(2, '0')).join(' ');
  }
}

// Standard Bluetooth Battery Level characteristic (0x2A19) is a single byte,
// 0-100, meaning percent — that's what a mitail unit actually exposes. Falls
// back to a text or little-endian millivolt guess for the custom BATT_UUID
// fallback path, in case a different product in the line uses that instead.
function decodeBattery(dataView) {
  if (dataView.byteLength === 1) {
    const pct = dataView.getUint8(0);
    if (pct <= 100) return `${pct}%`;
  }
  try {
    const text = new TextDecoder().decode(dataView).trim();
    if (/^[\x20-\x7e]+$/.test(text) && text.length) return text;
  } catch (e) { /* fall through */ }
  if (dataView.byteLength >= 2) {
    const mv = dataView.getUint16(0, true);
    return `${(mv / 1000).toFixed(2)} V`;
  }
  return null;
}

async function sendCommand(deviceId, command) {
  const record = state.devices.get(deviceId);
  if (!record || !record.connected) {
    toast('No connected device selected', 'error');
    return;
  }
  try {
    const bytes = new TextEncoder().encode(command);
    if (record.txChar.writeValueWithoutResponse) {
      await record.txChar.writeValueWithoutResponse(bytes);
    } else {
      await record.txChar.writeValue(bytes);
    }
    log(deviceId, 'tx', command);
  } catch (err) {
    console.error(err);
    log(deviceId, 'sys', `Send failed: ${err.message}`);
    toast(`Send failed: ${err.message}`, 'error');
  }
}

function sendToActive(command) {
  if (!state.activeDeviceId) {
    toast('Select a connected device first', 'error');
    return;
  }
  sendCommand(state.activeDeviceId, command);
}

function disconnectDevice(deviceId) {
  const record = state.devices.get(deviceId);
  if (record && record.btDevice.gatt.connected) {
    record.btDevice.gatt.disconnect();
  }
}

function forgetDevice(deviceId) {
  disconnectDevice(deviceId);
  state.devices.delete(deviceId);
  if (state.activeDeviceId === deviceId) {
    const next = state.devices.keys().next();
    state.activeDeviceId = next.done ? null : next.value;
  }
  renderAll();
}

/* ---------------------------------------------------------------------- */
/* Config (READCONF / WRITECONF)                                          */
/* ---------------------------------------------------------------------- */

let pendingConfRead = false;

function maybeParseConfig(deviceId, text) {
  const trimmed = text.trim();
  const parts = trimmed.replace(/^READCONF\s*/i, '').split(/\s+/);
  if (!pendingConfRead) return;
  if (parts.length < CONF_FIELDS.length) return;
  pendingConfRead = false;
  CONF_FIELDS.forEach((field, i) => {
    const input = document.getElementById(`conf-${field}`);
    if (input) input.value = parts[i];
  });
  toast('Configuration loaded from device', 'success');
}

function readConf() {
  pendingConfRead = true;
  sendToActive('READCONF');
}

function writeConf() {
  const values = CONF_FIELDS.map(field => {
    const input = document.getElementById(`conf-${field}`);
    return input ? input.value : '0';
  });
  if (values.some(v => v === '' || v == null)) {
    toast('Fill in every configuration field before writing', 'error');
    return;
  }
  sendToActive(`WRITECONF ${values.join(' ')}`);
}

/* ---------------------------------------------------------------------- */
/* Autonomous mode command builder                                       */
/* ---------------------------------------------------------------------- */

function buildAutomodeCommand() {
  const groups = Array.from(document.querySelectorAll('.mood-check:checked')).map(c => c.value);
  const min = document.getElementById('t-min').value.trim();
  const max = document.getElementById('t-max').value.trim();

  if (!groups.length) return null;
  if (!min) return null;

  let timing = `T${min}`;
  if (max && max !== min) timing += `T${max}`;

  return `AUTOMODE ${groups.join('')} ${timing}`;
}

function updateAutomodePreview() {
  const cmd = buildAutomodeCommand();
  document.getElementById('automode-preview').textContent = cmd || 'Select at least one mood group';
}

/* ---------------------------------------------------------------------- */
/* Rendering                                                              */
/* ---------------------------------------------------------------------- */

const DEVICE_SELECTS = [
  'controls-device-select', 'settings-device-select', 'manual-device-select',
  'auto-device-select', 'console-device-select',
];

function renderAll() {
  renderDeviceSelects();
  renderConnectionList();
  renderWelcomeList();
  renderActivePill();
  renderGattExplorer();
}

function renderDeviceSelects() {
  DEVICE_SELECTS.forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prevValue = sel.value;
    sel.innerHTML = '';
    if (!state.devices.size) {
      const opt = document.createElement('option');
      opt.textContent = 'No devices connected';
      opt.value = '';
      sel.appendChild(opt);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    state.devices.forEach(rec => {
      const opt = document.createElement('option');
      opt.value = rec.id;
      opt.textContent = `${rec.name} — ${rec.product}${rec.connected ? '' : ' (disconnected)'}`;
      sel.appendChild(opt);
    });
    sel.value = state.devices.has(prevValue) ? prevValue : (state.activeDeviceId || sel.options[0].value);
  });
}

function renderActivePill() {
  const pill = document.getElementById('active-device-pill');
  const rec = state.devices.get(state.activeDeviceId);
  if (!rec) {
    pill.textContent = 'No device selected';
    pill.classList.remove('online');
    return;
  }
  pill.textContent = `${rec.connected ? '●' : '○'} ${rec.name}`;
  pill.classList.toggle('online', rec.connected);
}

function deviceRowHTML(rec) {
  const battText = rec.battery ? ` · ${rec.battery}` : '';
  return `
    <div class="device-row" data-id="${rec.id}">
      <div class="device-info">
        <div class="device-dot ${rec.connected ? 'on' : ''}"></div>
        <div>
          <div class="device-name">${escapeHtml(rec.name)}</div>
          <div class="device-meta">${escapeHtml(rec.product)}${battText}</div>
        </div>
      </div>
      <div class="device-actions">
        <button class="btn btn-ghost" data-action="select" data-id="${rec.id}">${rec.id === state.activeDeviceId ? 'Active' : 'Use'}</button>
        ${rec.connected
          ? `<button class="btn btn-ghost" data-action="disconnect" data-id="${rec.id}">Disconnect</button>`
          : `<button class="btn btn-ghost" data-action="forget" data-id="${rec.id}">Remove</button>`}
      </div>
    </div>`;
}

function renderConnectionList() {
  const el = document.getElementById('connection-device-list');
  if (!state.devices.size) {
    el.className = 'device-list empty-state';
    el.textContent = 'No devices yet.';
    return;
  }
  el.className = 'device-list';
  el.innerHTML = Array.from(state.devices.values()).map(deviceRowHTML).join('');
}

function renderWelcomeList() {
  const el = document.getElementById('welcome-device-list');
  if (!state.devices.size) {
    el.className = 'device-grid empty-state';
    el.textContent = 'No devices connected yet. Head to the Connection tab to scan.';
    return;
  }
  el.className = 'device-grid';
  el.innerHTML = Array.from(state.devices.values()).map(deviceRowHTML).join('');
}

function renderMoves() {
  const grid = document.getElementById('moves-grid');
  grid.innerHTML = MOVES.map(([code, label]) =>
    `<button class="btn btn-ghost" data-cmd="${code}" title="${code}">${label}</button>`
  ).join('');
}

function renderConfFields() {
  const grid = document.getElementById('conf-grid');
  grid.innerHTML = CONF_FIELDS.map(field => `
    <div class="conf-field">
      <label for="conf-${field}">${field}</label>
      <input type="text" id="conf-${field}" class="text-input" placeholder="—">
    </div>
  `).join('');
}

function renderGattExplorer() {
  const sel = document.getElementById('gatt-char-select');
  const badges = document.getElementById('gatt-badges');
  const rec = state.devices.get(state.activeDeviceId);
  sel.innerHTML = '';

  if (!rec || !rec.allChars || !rec.allChars.length) {
    const opt = document.createElement('option');
    opt.textContent = rec ? 'No characteristics discovered on this device' : 'No device connected';
    opt.value = '';
    sel.appendChild(opt);
    sel.disabled = true;
    badges.textContent = '';
    return;
  }

  sel.disabled = false;
  rec.allChars.forEach(entry => {
    const opt = document.createElement('option');
    opt.value = entry.key;
    opt.textContent = `${shortUuid(entry.serviceUuid)} / ${entry.charUuid} [${propsBadges(entry.properties)}]`;
    sel.appendChild(opt);
  });
  updateGattBadges();
}

function updateGattBadges() {
  const sel = document.getElementById('gatt-char-select');
  const badges = document.getElementById('gatt-badges');
  const rec = state.devices.get(state.activeDeviceId);
  if (!rec || !sel.value) { badges.textContent = ''; return; }
  const entry = rec.allChars.find(e => e.key === sel.value);
  if (!entry) { badges.textContent = ''; return; }
  badges.textContent = `Properties: ${propsBadges(entry.properties) || 'none'}`;
  document.getElementById('gatt-subscribe-btn').textContent =
    rec.gattSubscriptions.has(entry.key) ? 'Unsubscribe' : 'Subscribe';
}

/* ---------------------------------------------------------------------- */
/* Wallpaper                                                              */
/* ---------------------------------------------------------------------- */

function applyWallpaper(dataUrl) {
  const layer = document.getElementById('wallpaper-layer');
  if (dataUrl) {
    layer.style.backgroundImage = `url(${dataUrl})`;
    layer.classList.add('active');
  } else {
    layer.style.backgroundImage = 'none';
    layer.classList.remove('active');
  }
}

function loadWallpaper() {
  try {
    const saved = localStorage.getItem('tailcontrol-wallpaper');
    if (saved) applyWallpaper(saved);
  } catch (e) { /* localStorage unavailable */ }
}

function saveWallpaper(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      localStorage.setItem('tailcontrol-wallpaper', reader.result);
    } catch (e) {
      toast("Image too large to save — try a smaller file", 'error');
      return;
    }
    applyWallpaper(reader.result);
    toast('Wallpaper saved', 'success');
  };
  reader.readAsDataURL(file);
}

function clearWallpaper() {
  try { localStorage.removeItem('tailcontrol-wallpaper'); } catch (e) { /* noop */ }
  applyWallpaper(null);
  document.getElementById('wallpaper-input').value = '';
}

/* ---------------------------------------------------------------------- */
/* Wiring                                                                 */
/* ---------------------------------------------------------------------- */

function switchTab(name) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === `tab-${name}`));
}

function wireNav() {
  document.getElementById('nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item');
    if (btn) switchTab(btn.dataset.tab);
  });
  document.querySelectorAll('[data-goto]').forEach(el => {
    el.addEventListener('click', () => switchTab(el.dataset.goto));
  });
}

function wireDeviceSelects() {
  DEVICE_SELECTS.forEach(id => {
    const sel = document.getElementById(id);
    sel.addEventListener('change', () => {
      state.activeDeviceId = sel.value;
      renderAll();
    });
  });
}

function wireDeviceListClicks() {
  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;
    if (action === 'select') { state.activeDeviceId = id; renderAll(); }
    if (action === 'disconnect') disconnectDevice(id);
    if (action === 'forget') forgetDevice(id);
  });
}

function wireCommandButtons() {
  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cmd]');
    if (btn) sendToActive(btn.dataset.cmd);
  });
}

function wireConnection() {
  document.getElementById('btn-scan').addEventListener('click', () => scanAndConnect('filtered'));
  document.getElementById('btn-scan-all').addEventListener('click', () => scanAndConnect('all'));
}

function wireSettings() {
  document.getElementById('btn-set-disconnect-timer').addEventListener('click', () => {
    const val = document.getElementById('disconnect-timer-input').value;
    if (val === '') { toast('Enter a number of minutes (0 to disable)', 'error'); return; }
    sendToActive(`SETDISCONNECTEDCOUNT ${val}`);
  });
  document.getElementById('btn-readconf').addEventListener('click', readConf);
  document.getElementById('btn-writeconf').addEventListener('click', writeConf);

  document.getElementById('wallpaper-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) saveWallpaper(file);
  });
  document.getElementById('btn-clear-wallpaper').addEventListener('click', clearWallpaper);
}

function wireAuto() {
  document.querySelectorAll('.mood-check').forEach(c => c.addEventListener('change', updateAutomodePreview));
  document.getElementById('t-min').addEventListener('input', updateAutomodePreview);
  document.getElementById('t-max').addEventListener('input', updateAutomodePreview);

  document.getElementById('btn-automode-play').addEventListener('click', () => {
    const cmd = buildAutomodeCommand();
    if (!cmd) { toast('Select at least one mood group and a minimum time', 'error'); return; }
    sendToActive(cmd);
  });
  document.getElementById('btn-stopnpm').addEventListener('click', () => sendToActive('STOPNPM'));
  document.getElementById('btn-stopauto').addEventListener('click', () => sendToActive('STOPAUTO'));
}

function wireLog() {
  document.getElementById('btn-clear-log').addEventListener('click', () => {
    document.getElementById('console').innerHTML = '';
  });
  document.getElementById('btn-console-send').addEventListener('click', sendConsoleCommand);
  document.getElementById('console-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendConsoleCommand();
  });
}

// Parses the raw-write input: "0x..." is read as hex bytes, anything else
// is sent as UTF-8 text — lets you test both framings against a
// characteristic without guessing which one the firmware wants.
function parseRawInput(value) {
  const trimmed = value.trim();
  if (/^0x[0-9a-f]+$/i.test(trimmed)) {
    const hex = trimmed.slice(2);
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
  }
  return new TextEncoder().encode(trimmed);
}

function getSelectedGattEntry() {
  const rec = state.devices.get(state.activeDeviceId);
  const sel = document.getElementById('gatt-char-select');
  if (!rec || !sel.value) return null;
  return rec.allChars.find(e => e.key === sel.value) || null;
}

function wireGattExplorer() {
  document.getElementById('gatt-char-select').addEventListener('change', updateGattBadges);

  document.getElementById('gatt-write-btn').addEventListener('click', async () => {
    const entry = getSelectedGattEntry();
    const input = document.getElementById('gatt-write-input');
    if (!entry) { toast('Select a characteristic first', 'error'); return; }
    const bytes = parseRawInput(input.value);
    if (!bytes.length) { toast('Enter something to write', 'error'); return; }
    try {
      if (entry.properties.writeWithoutResponse) {
        await entry.char.writeValueWithoutResponse(bytes);
      } else {
        await entry.char.writeValue(bytes);
      }
      log(state.activeDeviceId, 'tx', `[${shortUuid(entry.serviceUuid)}/${entry.charUuid.slice(0, 8)}] ${input.value}`);
    } catch (err) {
      log(state.activeDeviceId, 'sys', `GATT write failed: ${err.message}`);
      toast(`Write failed: ${err.message}`, 'error');
    }
  });

  document.getElementById('gatt-read-btn').addEventListener('click', async () => {
    const entry = getSelectedGattEntry();
    if (!entry) { toast('Select a characteristic first', 'error'); return; }
    try {
      const value = await entry.char.readValue();
      const text = decodeValue(value);
      log(state.activeDeviceId, 'rx', `[${shortUuid(entry.serviceUuid)}/${entry.charUuid.slice(0, 8)}] ${text}`);
    } catch (err) {
      log(state.activeDeviceId, 'sys', `GATT read failed: ${err.message}`);
      toast(`Read failed: ${err.message}`, 'error');
    }
  });

  document.getElementById('gatt-subscribe-btn').addEventListener('click', async () => {
    const entry = getSelectedGattEntry();
    const rec = state.devices.get(state.activeDeviceId);
    if (!entry || !rec) { toast('Select a characteristic first', 'error'); return; }
    const btn = document.getElementById('gatt-subscribe-btn');

    if (rec.gattSubscriptions.has(entry.key)) {
      try {
        entry.char.removeEventListener('characteristicvaluechanged', rec.gattSubscriptions.get(entry.key));
        await entry.char.stopNotifications();
      } catch (e) { /* best effort */ }
      rec.gattSubscriptions.delete(entry.key);
      btn.textContent = 'Subscribe';
      log(state.activeDeviceId, 'sys', `Unsubscribed from ${entry.charUuid.slice(0, 8)}`);
      return;
    }

    try {
      const listener = (ev) => {
        const text = decodeValue(ev.target.value);
        log(state.activeDeviceId, 'rx', `[${shortUuid(entry.serviceUuid)}/${entry.charUuid.slice(0, 8)}] ${text}`);
      };
      await entry.char.startNotifications();
      entry.char.addEventListener('characteristicvaluechanged', listener);
      rec.gattSubscriptions.set(entry.key, listener);
      btn.textContent = 'Unsubscribe';
      log(state.activeDeviceId, 'sys', `Subscribed to ${entry.charUuid.slice(0, 8)}`);
    } catch (err) {
      log(state.activeDeviceId, 'sys', `Subscribe failed: ${err.message}`);
      toast(`Subscribe failed (characteristic may not support notify): ${err.message}`, 'error');
    }
  });
}

function sendConsoleCommand() {
  const input = document.getElementById('console-input');
  const sel = document.getElementById('console-device-select');
  const cmd = input.value.trim();
  if (!cmd) return;
  sendCommand(sel.value || state.activeDeviceId, cmd);
  input.value = '';
}

/* ---------------------------------------------------------------------- */
/* Init                                                                   */
/* ---------------------------------------------------------------------- */

function init() {
  renderMoves();
  renderConfFields();
  loadWallpaper();
  wireNav();
  wireDeviceSelects();
  wireDeviceListClicks();
  wireCommandButtons();
  wireConnection();
  wireSettings();
  wireAuto();
  wireLog();
  wireGattExplorer();
  updateAutomodePreview();
  renderAll();

  if (!navigator.bluetooth) {
    const w = document.getElementById('ble-support-warning');
    w.classList.remove('hidden');
    w.textContent = "This browser doesn't support Web Bluetooth. Use Chrome or Edge on desktop or Android — it isn't supported on iOS by any browser (the Bluefy app is a workaround). The page also needs to be served over HTTPS, which GitHub Pages does automatically.";
  }
}

document.addEventListener('DOMContentLoaded', init);
