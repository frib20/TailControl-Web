/* =========================================================================
   Tail Control — Web Bluetooth app for ClawGear, Ear Gear 2, FlutterWings,
   Mitail, and MiTail Mini.

   All five products share one GATT service. Adjust the UUIDs below if a
   product ever diverges.
   ========================================================================= */

const SERVICE_UUID = '19f8ade2-d0c6-4c0a-912a-30601d9b3060';
const RX_UUID      = '5e4d86ac-ef2f-466f-a857-8776d45ffbc2'; // notify: device -> app
const TX_UUID      = '567a99d6-a442-4ac0-b676-4993bf95f805'; // write:  app -> device
const BATT_UUID    = 'e818bda3-88a7-43c0-8509-6e0bbb6f55d9'; // battery voltage

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

async function scanAndConnect() {
  if (!navigator.bluetooth) {
    document.getElementById('ble-support-warning').classList.remove('hidden');
    document.getElementById('ble-support-warning').textContent =
      "This browser doesn't support Web Bluetooth. Use Chrome or Edge on desktop or Android (iOS isn't supported by any browser — try the Bluefy app on iPhone).";
    return;
  }

  try {
    const btDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
      optionalServices: [SERVICE_UUID],
    });

    const id = btDevice.id;
    log(id, 'sys', `Connecting to ${btDevice.name || id}…`);

    const server = await btDevice.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    const txChar = await service.getCharacteristic(TX_UUID);
    const rxChar = await service.getCharacteristic(RX_UUID);
    let battChar = null;
    try { battChar = await service.getCharacteristic(BATT_UUID); } catch (e) { /* optional */ }

    const record = {
      id,
      btDevice,
      server,
      txChar,
      rxChar,
      battChar,
      name: btDevice.name || 'Unnamed device',
      product: guessProduct(btDevice.name),
      connected: true,
      battery: null,
    };

    state.devices.set(id, record);
    state.activeDeviceId = id;

    await rxChar.startNotifications();
    rxChar.addEventListener('characteristicvaluechanged', (ev) => {
      const text = decodeValue(ev.target.value);
      log(id, 'rx', text);
      maybeParseConfig(id, text);
    });

    if (battChar) {
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

function decodeValue(dataView) {
  try {
    return new TextDecoder().decode(dataView);
  } catch (e) {
    return Array.from(new Uint8Array(dataView.buffer)).map(b => b.toString(16).padStart(2, '0')).join(' ');
  }
}

// Best-effort battery parse: tries text first (e.g. "BATT 3.98"), then
// falls back to a little-endian uint16 millivolt reading. Adjust this if
// your firmware's encoding differs.
function decodeBattery(dataView) {
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
  document.getElementById('btn-scan').addEventListener('click', scanAndConnect);
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
  updateAutomodePreview();
  renderAll();

  if (!navigator.bluetooth) {
    const w = document.getElementById('ble-support-warning');
    w.classList.remove('hidden');
    w.textContent = "This browser doesn't support Web Bluetooth. Use Chrome or Edge on desktop or Android — it isn't supported on iOS by any browser (the Bluefy app is a workaround). The page also needs to be served over HTTPS, which GitHub Pages does automatically.";
  }
}

document.addEventListener('DOMContentLoaded', init);
