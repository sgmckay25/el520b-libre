// Utilitaires partagés : octets, file GATT, noms d'UUID, estimation de puissance.

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function bytesOf(value) {
  if (value instanceof DataView) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return Uint8Array.from(value);
}

export const hex = value => Array.from(bytesOf(value), b => b.toString(16).padStart(2, '0')).join(' ');

export const fromHex = text => Uint8Array.from(text.trim().split(/\s+/), h => parseInt(h, 16));

// Web Bluetooth refuse deux opérations GATT en parallèle : tout passe par cette file.
export class GattQueue {
  #tail = Promise.resolve();
  pending = 0;

  run(task) {
    this.pending++;
    const result = this.#tail.then(task).finally(() => this.pending--);
    this.#tail = result.catch(() => {});
    return result;
  }
}

// Abonne un gestionnaire aux notifications d'une caractéristique et renvoie de quoi le retirer.
export function listen(characteristic, handler) {
  const onChange = event => handler(event.target.value);
  characteristic.addEventListener('characteristicvaluechanged', onChange);
  return () => characteristic.removeEventListener('characteristicvaluechanged', onChange);
}

const SIG_BASE = '-0000-1000-8000-00805f9b34fb';
const UUID_NAMES = {
  '1800': 'Accès générique',
  '1801': 'Attributs génériques',
  '180a': 'Informations appareil',
  '180d': 'Fréquence cardiaque',
  '180f': 'Batterie',
  '1816': 'Vitesse et cadence',
  '1818': 'Puissance vélo',
  '1826': 'Fitness Machine (FTMS)',
  '2a24': 'Modèle',
  '2a25': 'N° de série',
  '2a26': 'Firmware',
  '2a27': 'Matériel',
  '2a28': 'Logiciel',
  '2a29': 'Fabricant',
  '2a37': 'Mesure cardio',
  '2acc': 'Fonctions FTMS',
  '2ace': 'Données elliptique',
  '2ad2': 'Données vélo',
  '2ad3': 'État entraînement',
  '2ad6': 'Plage de résistance',
  '2ad8': 'Plage de puissance',
  '2ad9': 'Point de contrôle FTMS',
  '2ada': 'État machine',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455': 'Domyos propriétaire (UART ISSC)',
  '49535343-8841-43f4-a8d4-ecbe34729bb3': 'Domyos écriture',
  '49535343-1e4d-4bd9-ba61-23c647249616': 'Domyos notifications',
};

export function uuidLabel(uuid) {
  const short = uuid.startsWith('0000') && uuid.endsWith(SIG_BASE) ? uuid.slice(4, 8) : uuid;
  return UUID_NAMES[short] ? `${short} · ${UUID_NAMES[short]}` : short;
}

// Formule reprise de QZ pour les elliptiques Domyos qui n'envoient pas de puissance.
export function estimatePower(resistance, cadence) {
  if (!cadence || !resistance) return 0;
  return Math.round((10.39 + 1.45 * (resistance - 1)) * Math.exp(0.028 * cadence));
}
