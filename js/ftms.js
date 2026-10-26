// Pilote FTMS (Fitness Machine Service) : le protocole Bluetooth standard annoncé par l'EL520B.
// Référence : Bluetooth SIG, Fitness Machine Service 1.0.
import { GattQueue, bytesOf, hex, listen } from './util.js';

export const FTMS = {
  service: 0x1826,
  feature: 0x2acc,
  crossTrainerData: 0x2ace,
  indoorBikeData: 0x2ad2,
  resistanceRange: 0x2ad6,
  controlPoint: 0x2ad9,
  machineStatus: 0x2ada,
};

const OP = { requestControl: 0x00, setResistance: 0x04, start: 0x07, stopOrPause: 0x08, response: 0x80 };
const OP_NAMES = { 0x00: 'prise de contrôle', 0x01: 'reset', 0x04: 'résistance cible', 0x05: 'puissance cible', 0x07: 'démarrage', 0x08: 'arrêt' };
const RESULTS = { 0x01: 'OK', 0x02: 'non supporté', 0x03: 'paramètre invalide', 0x04: 'échec', 0x05: 'contrôle refusé' };
const STATUS = { 0x01: 'reset', 0x02: 'arrêt/pause', 0x03: 'arrêt sécurité', 0x04: 'démarrage', 0x07: 'résistance cible modifiée', 0x08: 'puissance cible modifiée', 0xff: 'contrôle perdu' };
const MACHINE_FEATURES = ['vitesse moyenne', 'cadence', 'distance', 'inclinaison', 'dénivelé', 'allure', 'pas', 'résistance', 'foulées', 'énergie', 'cardio', 'MET', 'temps écoulé', 'temps restant', 'puissance', 'force/puissance', 'mémoire utilisateur'];
const TARGET_FEATURES = ['vitesse', 'inclinaison', 'résistance', 'puissance (ERG)', 'cardio', 'énergie', 'pas', 'foulées', 'distance', 'durée', 'zones x2', 'zones x3', 'zones x5', 'simulation', 'circonférence', 'spin down', 'cadence'];

// Champs dans l'ordre de la norme : [bit du drapeau, nom, type, échelle].
// Le bit 0 (« More Data ») est inversé : la vitesse instantanée est présente quand il vaut 0.
const CROSS_TRAINER = [
  [0, 'speed', 'u16', 0.01],
  [1, 'avgSpeed', 'u16', 0.01],
  [2, 'distance', 'u24', 1],
  [3, 'stepRate', 'u16', 1],
  [3, 'avgStepRate', 'u16', 1],
  [4, 'strideCount', 'u16', 0.1],
  [5, 'elevationUp', 'u16', 1],
  [5, 'elevationDown', 'u16', 1],
  [6, 'incline', 's16', 0.1],
  [6, 'rampAngle', 's16', 0.1],
  [7, 'resistance', 's16', 1],
  [8, 'power', 's16', 1],
  [9, 'avgPower', 's16', 1],
  [10, 'kcal', 'u16', 1],
  [10, 'kcalPerHour', 'u16', 1],
  [10, 'kcalPerMin', 'u8', 1],
  [11, 'hr', 'u8', 1],
  [12, 'met', 'u8', 0.1],
  [13, 'elapsed', 'u16', 1],
  [14, 'remaining', 'u16', 1],
];

const INDOOR_BIKE = [
  [0, 'speed', 'u16', 0.01],
  [1, 'avgSpeed', 'u16', 0.01],
  [2, 'cadence', 'u16', 0.5],
  [3, 'avgCadence', 'u16', 0.5],
  [4, 'distance', 'u24', 1],
  [5, 'resistance', 's16', 1],
  [6, 'power', 's16', 1],
  [7, 'avgPower', 's16', 1],
  [8, 'kcal', 'u16', 1],
  [8, 'kcalPerHour', 'u16', 1],
  [8, 'kcalPerMin', 'u8', 1],
  [9, 'hr', 'u8', 1],
  [10, 'met', 'u8', 0.1],
  [11, 'elapsed', 'u16', 1],
  [12, 'remaining', 'u16', 1],
];

const SIZE = { u8: 1, u16: 2, s16: 2, u24: 3 };

function readField(dv, i, type) {
  switch (type) {
    case 'u8': return dv.getUint8(i);
    case 'u16': return dv.getUint16(i, true);
    case 's16': return dv.getInt16(i, true);
    case 'u24': return dv.getUint16(i, true) | (dv.getUint8(i + 2) << 16);
  }
}

export const parseCrossTrainerData = dv => parseFtmsData(dv, CROSS_TRAINER, 3);
export const parseIndoorBikeData = dv => parseFtmsData(dv, INDOOR_BIKE, 2);

function parseFtmsData(dv, fields, flagBytes) {
  let flags = 0;
  for (let b = 0; b < flagBytes; b++) flags |= dv.getUint8(b) << (8 * b);
  const out = {};
  let i = flagBytes;
  for (const [bit, name, type, scale] of fields) {
    const set = (flags >> bit) & 1;
    if (bit === 0 ? set : !set) continue;
    if (i + SIZE[type] > dv.byteLength) break; // trame tronquée : on garde ce qui a été lu
    out[name] = readField(dv, i, type) * scale;
    i += SIZE[type];
  }
  return out;
}

export class FtmsDriver {
  protocol = 'FTMS';
  canControl = false;
  maxLevel = 15;
  #queue = new GattQueue();
  #unlisten = [];
  #controlPoint = null;
  #pending = null;

  constructor(server, { onData, onLog, onRaw, resistanceFactor = 10 }) {
    Object.assign(this, { server, onData, onLog, onRaw, resistanceFactor });
  }

  async init() {
    const service = await this.server.getPrimaryService(FTMS.service);
    await this.#readFeatures(service);
    await this.#readResistanceRange(service);

    let source = null;
    if (await this.#subscribe(service, FTMS.crossTrainerData, dv => this.#onData('2ACE', dv, parseCrossTrainerData(dv)))) {
      source = 'elliptique (2ACE)';
    } else if (await this.#subscribe(service, FTMS.indoorBikeData, dv => this.#onData('2AD2', dv, parseIndoorBikeData(dv)))) {
      source = 'vélo (2AD2)';
    }
    if (!source) throw new Error('aucune caractéristique de données FTMS (2ACE / 2AD2)');
    this.onLog(`Données reçues via le profil ${source}`);

    await this.#subscribe(service, FTMS.machineStatus, dv => this.#onStatus(dv));

    try {
      this.#controlPoint = await service.getCharacteristic(FTMS.controlPoint);
      this.#unlisten.push(listen(this.#controlPoint, dv => this.#onControlResponse(dv)));
      await this.#controlPoint.startNotifications();
      const code = await this.#command([OP.requestControl]);
      this.canControl = ![0x02, 0x04, 0x05].includes(code);
    } catch (e) {
      this.onLog(`Point de contrôle FTMS indisponible : ${e.message}`);
    }
  }

  // La norme exprime la résistance cible au 1/10 (niveau 8 → 80) ; QZ fait de même pour les Domyos.
  setResistance(level) {
    return this.#command([OP.setResistance, Math.round(level * this.resistanceFactor) & 0xff]);
  }

  start() {
    return this.#command([OP.start]);
  }

  stop() {
    return this.#command([OP.stopOrPause, 0x01]);
  }

  dispose() {
    this.#unlisten.forEach(off => off());
    this.#unlisten = [];
    this.#pending?.resolve(null);
  }

  async #subscribe(service, uuid, handler) {
    try {
      const characteristic = await service.getCharacteristic(uuid);
      this.#unlisten.push(listen(characteristic, handler));
      await characteristic.startNotifications();
      return true;
    } catch {
      return false;
    }
  }

  async #readFeatures(service) {
    try {
      const dv = await (await service.getCharacteristic(FTMS.feature)).readValue();
      const names = (mask, list) => list.filter((_, bit) => mask & (1 << bit)).join(', ') || 'aucune';
      this.onLog(`Mesures annoncées : ${names(dv.getUint32(0, true), MACHINE_FEATURES)}`);
      this.onLog(`Consignes acceptées : ${names(dv.getUint32(4, true), TARGET_FEATURES)}`);
    } catch (e) {
      this.onLog(`Fonctions FTMS illisibles : ${e.message}`);
    }
  }

  async #readResistanceRange(service) {
    try {
      const dv = await (await service.getCharacteristic(FTMS.resistanceRange)).readValue();
      const [min, max, step] = [dv.getInt16(0, true), dv.getInt16(2, true), dv.getUint16(4, true)];
      this.onLog(`Plage de résistance brute : ${min} → ${max} (pas ${step})`);
      // Au 1/10 selon la norme : 10 → 150 signifie niveaux 1 à 15.
      this.maxLevel = Math.round(max > 30 ? max / 10 : max) || 15;
    } catch (e) {
      this.onLog(`Plage de résistance non lue : ${e.message}`);
    }
  }

  #onData(label, dv, d) {
    this.onRaw(label, hex(dv), d);
    const out = {};
    if (d.speed != null) out.speed = d.speed;
    // Sur les elliptiques Domyos, « pas/min » vaut le double de la cadence en tr/min (constat de QZ).
    if (d.stepRate != null) out.cadence = d.stepRate / 2;
    if (d.cadence != null) out.cadence = d.cadence;
    if (d.resistance != null) out.resistance = d.resistance > this.maxLevel ? d.resistance / 10 : d.resistance;
    if (d.power != null) out.power = Math.max(0, d.power);
    if (d.kcal != null && d.kcal !== 0xffff) out.kcal = d.kcal;
    if (d.hr) out.hr = d.hr;
    this.onData(out);
  }

  #onStatus(dv) {
    const b = bytesOf(dv);
    this.onLog(`État machine : ${STATUS[b[0]] ?? `code ${b[0]}`} [${hex(dv)}]`);
  }

  #command(bytes) {
    if (!this.#controlPoint) return Promise.reject(new Error('pas de point de contrôle FTMS'));
    return this.#queue.run(async () => {
      const op = bytes[0];
      const reply = new Promise(resolve => {
        this.#pending = { op, resolve };
        setTimeout(() => resolve(null), 3000);
      });
      this.onLog(`→ Contrôle : ${OP_NAMES[op] ?? op} [${hex(bytes)}]`);
      await this.#controlPoint.writeValueWithResponse(Uint8Array.from(bytes));
      const code = await reply;
      this.#pending = null;
      this.onLog(`← Contrôle : ${OP_NAMES[op] ?? op} → ${code == null ? 'pas de réponse' : RESULTS[code] ?? `code ${code}`}`);
      return code;
    });
  }

  #onControlResponse(dv) {
    const b = bytesOf(dv);
    this.onRaw('2AD9', hex(dv));
    if (b[0] === OP.response && this.#pending?.op === b[1]) this.#pending.resolve(b[2]);
  }
}
