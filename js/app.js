// Interface : connexion Bluetooth, affichage en direct, séance, historique et diagnostic.
import { FtmsDriver, FTMS } from './ftms.js';
import { DomyosDriver, DOMYOS } from './domyos.js';
import { SimDriver } from './sim.js';
import { estimatePower, sleep, uuidLabel } from './util.js';
import { loadSessions, storeSessions, summarize, toTcx, toCsv, download, formatDuration, fileStamp } from './session.js';

const $ = id => document.getElementById(id);

// Web Bluetooth ne donne accès qu'aux services déclarés ici.
const OPTIONAL_SERVICES = [
  FTMS.service,
  DOMYOS.service,
  0x180a, 0x180d, 0x1816, 0x1818, 0xfff0, 0xffe0,
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // UART Nordic, au cas où
];
const DEVICE_INFO = { 0x2a29: 'Fabricant', 0x2a24: 'Modèle', 0x2a26: 'Firmware', 0x2a27: 'Matériel', 0x2a28: 'Logiciel' };
const STALE_MS = 3000;
const EMPTY_LIVE = { speed: null, cadence: null, resistance: null, power: null, powerAt: -Infinity, powerEstimated: false, hr: null, kcal: null, at: -Infinity };

const live = { ...EMPTY_LIVE };
const session = { state: 'idle', startedAt: 0, elapsed: 0, distance: 0, kcal: 0, lastKcal: null, samples: [], lastTick: performance.now() };
let device = null;
let driver = null;
let wantConnected = false;
let connecting = false;
let target = null; // résistance demandée, en attente de confirmation : { level, at }
let wakeLock = null;

const nf = digits => new Intl.NumberFormat('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const NF = [nf(0), nf(1), nf(2)];
const dateFormat = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// ---------- Journal ----------

const logLines = [];
let logQueued = false;

function log(message) {
  const now = new Date();
  logLines.push(`${now.toLocaleTimeString('fr-FR')}.${String(now.getMilliseconds()).padStart(3, '0')}  ${message}`);
  if (logLines.length > 3000) logLines.splice(0, logLines.length - 3000);
  if (!logQueued) {
    logQueued = true;
    requestAnimationFrame(renderLog);
  }
}

function renderLog() {
  logQueued = false;
  const el = $('log');
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
  el.textContent = logLines.slice(-400).join('\n');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function onRaw(label, bytes, parsed) {
  if (!$('opt-raw').checked) return;
  const fields = parsed
    ? Object.entries(parsed)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : v}`)
      .join(' ')
    : '';
  log(`← ${label}  ${bytes}${fields ? `  | ${fields}` : ''}`);
}

const diagnosticText = () => `${$('gatt').textContent}\n\n${logLines.join('\n')}`;

// ---------- Connexion ----------

function setStatus(state, text) {
  $('status').dataset.state = state;
  $('status-text').textContent = text ?? { off: 'Déconnecté', connecting: 'Connexion…', on: 'Connecté' }[state];
  $('btn-connect').textContent = state === 'off' ? 'Connecter le vélo' : 'Déconnecter';
  $('btn-sim').disabled = state !== 'off';
  renderResistance();
}

function pickDevice() {
  if ($('opt-all').checked) {
    return navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: OPTIONAL_SERVICES });
  }
  return navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: 'Domyos' }, { namePrefix: 'DOMYOS' }, { namePrefix: 'EL' }, { services: [FTMS.service] }],
    optionalServices: OPTIONAL_SERVICES,
  });
}

async function describeGatt(server, services) {
  const lines = [`Appareil : ${device.name ?? '(sans nom)'}`];
  const decoder = new TextDecoder();
  if (services.some(s => s.uuid === BluetoothUUID.getService(0x180a))) {
    const info = await server.getPrimaryService(0x180a);
    for (const [uuid, name] of Object.entries(DEVICE_INFO)) {
      try {
        const value = await (await info.getCharacteristic(Number(uuid))).readValue();
        lines.push(`${name} : ${decoder.decode(value).replace(/\0+$/, '')}`);
      } catch {
        // caractéristique absente ou interdite par Chrome : rien à afficher
      }
    }
  }
  const PROPS = { read: 'lecture', write: 'écriture', writeWithoutResponse: 'écriture sans réponse', notify: 'notification', indicate: 'indication' };
  for (const service of services) {
    lines.push('', `Service ${uuidLabel(service.uuid)}`);
    try {
      for (const c of await service.getCharacteristics()) {
        const props = Object.keys(PROPS).filter(p => c.properties[p]).map(p => PROPS[p]).join(', ');
        lines.push(`  └ ${uuidLabel(c.uuid)}  (${props})`);
      }
    } catch (e) {
      lines.push(`  (caractéristiques illisibles : ${e.message})`);
    }
  }
  return lines.join('\n');
}

function chooseProtocol(uuids) {
  const forced = $('opt-proto').value;
  if (forced !== 'auto') return forced;
  if (uuids.includes(BluetoothUUID.getService(FTMS.service))) return 'ftms';
  if (uuids.includes(DOMYOS.service)) return 'domyos';
  throw Object.assign(new Error('ni FTMS ni protocole Domyos trouvés : envoie le diagnostic'), { permanent: true });
}

function ensureWanted() {
  if (!wantConnected) throw Object.assign(new Error('connexion annulée'), { permanent: true });
}

async function connect() {
  setStatus('connecting', `Connexion à ${device.name ?? 'l’appareil'}…`);
  const server = await device.gatt.connect();
  ensureWanted();
  log(`Connecté à « ${device.name ?? '?'} »`);
  const services = await server.getPrimaryServices();
  $('gatt').textContent = await describeGatt(server, services);
  const protocol = chooseProtocol(services.map(s => s.uuid));
  log(`Protocole utilisé : ${protocol}`);
  const callbacks = { onData, onLog: log, onRaw, resistanceFactor: Number($('opt-factor').value) };
  driver = protocol === 'ftms' ? new FtmsDriver(server, callbacks) : new DomyosDriver(server, callbacks);
  await driver.init();
  ensureWanted();
  setStatus('on', `${device.name ?? 'Vélo'} · ${driver.protocol}`);
}

// La console auto-alimentée s'éteint quand on arrête de pédaler : on retente tant que l'utilisateur le souhaite.
async function connectLoop() {
  if (connecting) return;
  connecting = true;
  try {
    for (let attempt = 1; wantConnected; attempt++) {
      try {
        await connect();
        return;
      } catch (e) {
        teardown();
        if (device?.gatt.connected) device.gatt.disconnect();
        log(`Échec de connexion (essai ${attempt}) : ${e.message}`);
        if (e.permanent || attempt >= 40) break;
        setStatus('connecting', 'Nouvel essai… pédale pour réveiller la console');
        await sleep(attempt < 5 ? 2000 : 5000);
      }
    }
    wantConnected = false;
    setStatus('off');
  } finally {
    connecting = false;
  }
}

function onDisconnected() {
  if (connecting) return;
  log('Console déconnectée');
  teardown();
  if (wantConnected) connectLoop();
  else setStatus('off');
}

function teardown() {
  driver?.dispose();
  driver = null;
  target = null;
  Object.assign(live, EMPTY_LIVE);
  renderLive();
}

function disconnect() {
  wantConnected = false;
  teardown();
  if (device?.gatt.connected) device.gatt.disconnect();
  setStatus('off');
}

async function onConnectClick() {
  if ($('status').dataset.state !== 'off') {
    disconnect();
    return;
  }
  let picked;
  try {
    picked = await pickDevice();
  } catch (e) {
    if (e.name !== 'NotFoundError') log(`Bluetooth : ${e.message}`);
    return;
  }
  device?.removeEventListener('gattserverdisconnected', onDisconnected);
  device = picked;
  device.addEventListener('gattserverdisconnected', onDisconnected);
  wantConnected = true;
  connectLoop();
}

async function onSimClick() {
  driver = new SimDriver({ onData, onLog: log });
  await driver.init();
  $('gatt').textContent = 'Simulation : aucune connexion Bluetooth.';
  setStatus('on', 'Simulation');
}

// ---------- Données en direct ----------

function onData(data) {
  const now = performance.now();
  Object.assign(live, data, { at: now });
  if (data.power != null) live.powerAt = now;
  live.powerEstimated = now - live.powerAt > STALE_MS;
  if (live.powerEstimated) live.power = estimatePower(live.resistance ?? target?.level, live.cadence);
  if (target && live.resistance === target.level) target = null;
  renderLive();
}

function setMetric(id, value, digits) {
  $(id).textContent = value == null ? '–' : NF[digits].format(value);
}

function renderLive() {
  const fresh = performance.now() - live.at < STALE_MS;
  setMetric('m-speed', fresh ? live.speed : null, 1);
  setMetric('m-cadence', fresh ? live.cadence : null, 0);
  setMetric('m-power', fresh ? live.power : null, 0);
  setMetric('m-hr', fresh && live.hr ? live.hr : null, 0);
  $('u-power').textContent = live.powerEstimated && fresh ? 'W · estimée' : 'W';
  renderResistance();
}

function renderResistance() {
  const canControl = Boolean(driver?.canControl);
  $('res-down').disabled = !canControl;
  $('res-up').disabled = !canControl;
  $('m-res-max').textContent = `/ ${driver?.maxLevel ?? 15}`;
  if (target && performance.now() - target.at > 5000) target = null;
  const shown = live.resistance ?? target?.level;
  $('m-res').textContent = shown == null ? '–' : Math.round(shown);
  $('m-res-target').textContent = target && target.level !== live.resistance ? `→ ${target.level}` : '';
}

async function changeResistance(delta) {
  if (!driver?.canControl) return;
  const from = target?.level ?? Math.round(live.resistance ?? 1);
  const level = Math.min(driver.maxLevel ?? 15, Math.max(1, from + delta));
  target = { level, at: performance.now() };
  renderResistance();
  try {
    const code = await driver.setResistance(level);
    if (code != null && code !== 0x01) log(`Résistance ${level} refusée par la console (code ${code})`);
  } catch (e) {
    log(`Résistance : ${e.message}`);
  }
}

// ---------- Séance ----------

function startOrPause() {
  if (session.state === 'running') {
    session.state = 'paused';
    releaseWakeLock();
  } else {
    if (session.state === 'idle') {
      Object.assign(session, { startedAt: Date.now(), elapsed: 0, distance: 0, kcal: 0, lastKcal: null, samples: [] });
      Promise.resolve(driver?.start()).catch(e => log(`Démarrage console : ${e.message}`));
      log('Séance démarrée');
    }
    session.state = 'running';
    session.lastTick = performance.now();
    acquireWakeLock();
  }
  renderSession();
}

function finish() {
  if (session.state === 'idle') return;
  session.state = 'idle';
  releaseWakeLock();
  Promise.resolve(driver?.stop()).catch(e => log(`Arrêt console : ${e.message}`));
  const record = summarize(session);
  if (record.duration < 30) {
    log('Séance de moins de 30 s : non enregistrée');
  } else {
    const list = loadSessions();
    list.unshift(record);
    if (storeSessions(list)) log(`Séance enregistrée (${formatDuration(record.duration)})`);
    else log('Stockage du navigateur plein : exporte puis supprime d’anciennes séances');
    renderHistory();
  }
  renderSession();
}

function tick() {
  const now = performance.now();
  const dt = Math.max(0, (now - session.lastTick) / 1000);
  session.lastTick = now;
  if (session.state === 'running') {
    const fresh = now - live.at < STALE_MS;
    const speed = fresh ? live.speed ?? 0 : 0;
    const cadence = fresh ? live.cadence ?? 0 : 0;
    const power = fresh ? live.power ?? 0 : 0;
    session.elapsed += dt;
    session.distance += (speed / 3.6) * dt;
    if (fresh && live.kcal != null) {
      // Compteur de la console : on additionne ses hausses (il repart de zéro si elle se rallume).
      if (session.lastKcal != null && live.kcal >= session.lastKcal) session.kcal += live.kcal - session.lastKcal;
      session.lastKcal = live.kcal;
    } else if (live.kcal == null) {
      session.kcal += (power * dt) / 1000; // ≈ 1 kcal dépensée par kJ produit (rendement musculaire ~24 %)
    }
    session.samples.push([
      Math.round(session.elapsed),
      Math.round(speed * 10),
      Math.round(cadence),
      Math.round(live.resistance ?? 0),
      Math.round(power),
      fresh ? Math.round(live.hr ?? 0) : 0,
      Math.round(session.distance),
    ]);
    renderSession();
  }
  renderLive();
}

function renderSession() {
  $('m-time').textContent = formatDuration(session.elapsed);
  $('m-distance').textContent = NF[2].format(session.distance / 1000);
  $('m-kcal').textContent = NF[0].format(session.kcal);
  $('m-state').textContent = {
    idle: session.samples.length ? 'Terminée' : 'Prête',
    running: 'En cours',
    paused: 'En pause',
  }[session.state];
  $('btn-start').textContent = { idle: 'Démarrer', running: 'Pause', paused: 'Reprendre' }[session.state];
  $('btn-stop').disabled = session.state === 'idle';
}

async function acquireWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// ---------- Historique ----------

function renderHistory() {
  const list = loadSessions();
  $('history-empty').hidden = list.length > 0;
  $('history').replaceChildren(...list.map(s => {
    const item = document.createElement('li');
    const when = Object.assign(document.createElement('div'), { className: 'when', textContent: dateFormat.format(new Date(s.startedAt)) });
    const stats = Object.assign(document.createElement('div'), { className: 'stats' });
    const parts = [
      formatDuration(s.duration),
      `${NF[2].format(s.distance / 1000)} km`,
      `${s.kcal} kcal`,
      `${s.avgPower} W moy.`,
      `${s.avgCadence} tr/min`,
      s.avgHr ? `${s.avgHr} bpm` : null,
    ];
    stats.append(...parts.filter(Boolean).map(text => Object.assign(document.createElement('span'), { textContent: text })));
    const actions = Object.assign(document.createElement('div'), { className: 'actions compact' });
    for (const [action, label] of [['tcx', 'Export TCX'], ['csv', 'CSV'], ['delete', 'Supprimer']]) {
      const button = Object.assign(document.createElement('button'), {
        className: action === 'delete' ? 'btn danger' : 'btn',
        textContent: label,
      });
      Object.assign(button.dataset, { action, id: s.id });
      actions.append(button);
    }
    item.append(when, stats, actions);
    return item;
  }));
}

function onHistoryClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const list = loadSessions();
  const s = list.find(x => x.id === button.dataset.id);
  if (!s) return;
  const name = `elliptique_${fileStamp(s.startedAt)}`;
  if (button.dataset.action === 'tcx') download(`${name}.tcx`, toTcx(s), 'application/vnd.garmin.tcx+xml');
  if (button.dataset.action === 'csv') download(`${name}.csv`, toCsv(s), 'text/csv');
  if (button.dataset.action === 'delete' && confirm('Supprimer cette séance ?')) {
    storeSessions(list.filter(x => x !== s));
    renderHistory();
  }
}

// ---------- Démarrage ----------

function checkSupport() {
  let problem = null;
  if (!window.isSecureContext) problem = 'Le Bluetooth web exige une page en HTTPS (ou ouverte via localhost).';
  else if (!navigator.bluetooth) problem = 'Ce navigateur ne gère pas le Bluetooth web : utilise Chrome ou Edge (Android, Windows, macOS). Sur iPhone, l’app « Bluefy ».';
  if (problem) {
    $('compat').textContent = problem;
    $('compat').hidden = false;
    $('btn-connect').disabled = true;
    return;
  }
  navigator.bluetooth.getAvailability?.().then(available => {
    if (available) return;
    $('compat').textContent = 'Bluetooth indisponible : active-le sur cet appareil.';
    $('compat').hidden = false;
  });
}

// Les options de connexion sont mémorisées d'une visite à l'autre.
function persistOptions() {
  for (const id of ['opt-all', 'opt-proto', 'opt-factor', 'opt-raw']) {
    const el = $(id);
    const key = `el520b.${id}`;
    try {
      const saved = localStorage.getItem(key);
      if (saved != null) {
        if (el.type === 'checkbox') el.checked = saved === '1';
        else el.value = saved;
      }
    } catch {
      // stockage indisponible (navigation privée) : valeurs par défaut
    }
    el.addEventListener('change', () => {
      try {
        localStorage.setItem(key, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value);
      } catch {
        // idem
      }
    });
  }
}

$('btn-connect').addEventListener('click', onConnectClick);
$('btn-sim').addEventListener('click', onSimClick);
$('res-down').addEventListener('click', () => changeResistance(-1));
$('res-up').addEventListener('click', () => changeResistance(+1));
$('btn-start').addEventListener('click', startOrPause);
$('btn-stop').addEventListener('click', finish);
$('history').addEventListener('click', onHistoryClick);
$('btn-copy-log').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(diagnosticText());
    log('Diagnostic copié dans le presse-papiers');
  } catch {
    log('Copie impossible : utilise « Télécharger »');
  }
});
$('btn-save-log').addEventListener('click', () => download(`diagnostic_el520b_${fileStamp(Date.now())}.txt`, diagnosticText(), 'text/plain'));
$('btn-clear-log').addEventListener('click', () => {
  logLines.length = 0;
  renderLog();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && session.state === 'running') acquireWakeLock();
});
window.addEventListener('beforeunload', event => {
  if (session.state !== 'idle') event.preventDefault();
});

persistOptions();
checkSupport();
renderSession();
renderLive();
renderHistory();
setInterval(tick, 1000);
log('Application prête');
