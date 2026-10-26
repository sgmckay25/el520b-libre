// Pilote du protocole propriétaire Domyos : liaison série sur BLE (puce Microchip « ISSC »).
// Trames et format repris du projet libre QZ (qdomyos-zwift, src/devices/domyoselliptical).
import { GattQueue, bytesOf, fromHex, hex, listen, sleep } from './util.js';

export const DOMYOS = {
  service: '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  write: '49535343-8841-43f4-a8d4-ecbe34729bb3',
  notify: '49535343-1e4d-4bd9-ba61-23c647249616',
};

// Chaque trame se termine par la somme de ses octets (mod 256) ; au-delà de 20 octets elle part en deux morceaux.
const INIT = [
  'f0 c8 01 b9',
  'f0 c9 b9',
  'f0 a3 93',
  'f0 a4 94',
  'f0 a5 95',
  'f0 ab 9b',
  'f0 c4 03 b7',
  'f0 ad ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff 01 ff', 'ff ff 8b',
  'f0 cb 02 00 08 ff ff ff ff ff ff ff ff ff ff ff ff ff 01 00', '00 01 ff ff ff ff b6',
  'f0 ad ff ff 00 05 ff ff ff ff ff ff ff 00 00 ff ff ff 01 ff',
].map(fromHex);
const START = [
  'ff ff 94',
  'f0 cb ff ff ff ff ff ff ff ff ff ff ff ff 01 00 14 01 ff ff', 'ff ff ff ff ff ff bd',
].map(fromHex);
const STOP = [fromHex('f0 c8 00 b8')];
const POLL = [fromHex('f0 ac 9c')];
const POLL_MS = 300;

export class DomyosDriver {
  protocol = 'Domyos propriétaire';
  canControl = true;
  maxLevel = 15;
  #queue = new GattQueue();
  #unlisten = [];
  #tx = null;
  #timer = null;
  #partial = null;

  constructor(server, { onData, onLog, onRaw }) {
    Object.assign(this, { server, onData, onLog, onRaw });
  }

  async init() {
    const service = await this.server.getPrimaryService(DOMYOS.service);
    this.#tx = await service.getCharacteristic(DOMYOS.write);
    const rx = await service.getCharacteristic(DOMYOS.notify);
    this.#unlisten.push(listen(rx, dv => this.#onNotify(dv)));
    await rx.startNotifications();
    await this.#send(INIT, 'initialisation');
    // La console ne répond que lorsqu'on l'interroge.
    this.#timer = setInterval(() => {
      if (this.#queue.pending === 0) this.#send(POLL).catch(() => {});
    }, POLL_MS);
  }

  setResistance(level) {
    const frame = [0xf0, 0xad, ...Array(8).fill(0xff), level, ...Array(6).fill(0xff), 0x00, 0x01, 0xff, 0xff, 0xff];
    frame.push(frame.reduce((sum, b) => sum + b, 0) & 0xff);
    return this.#send([Uint8Array.from(frame.slice(0, 20)), Uint8Array.from(frame.slice(20))], `résistance ${level}`);
  }

  start() {
    return this.#send([...INIT, ...START], 'démarrage');
  }

  stop() {
    return this.#send(STOP, 'arrêt');
  }

  dispose() {
    clearInterval(this.#timer);
    this.#unlisten.forEach(off => off());
    this.#unlisten = [];
  }

  // Les morceaux d'une trame partent d'un seul bloc pour que l'interrogation périodique ne s'intercale pas.
  #send(chunks, label) {
    return this.#queue.run(async () => {
      if (label) this.onLog(`→ ${label} : ${chunks.map(hex).join(' | ')}`);
      for (const chunk of chunks) {
        if (this.#tx.properties.write) await this.#tx.writeValueWithResponse(chunk);
        else await this.#tx.writeValueWithoutResponse(chunk);
        // Après une trame complète, on laisse à la console le temps de répondre (comme QZ).
        if (chunk.length < 20) await sleep(60);
      }
    });
  }

  #onNotify(dv) {
    let frame = bytesOf(dv).slice();
    if (this.#partial) {
      frame = Uint8Array.from([...this.#partial, ...frame]);
      this.#partial = null;
    }
    if (frame.length === 20 && frame[0] === 0xf0) {
      this.#partial = frame; // première moitié, la suite arrive dans la notification suivante
      return;
    }
    if (frame.length !== 26) {
      this.onRaw('Domyos', hex(frame));
      return;
    }
    const u16 = i => (frame[i] << 8) | frame[i + 1];
    const data = {
      speed: u16(6) / 10,
      cadence: frame[9],
      kcal: u16(10),
      resistance: Math.max(1, frame[14]),
      hr: frame[18] || undefined,
    };
    this.onRaw('Domyos', hex(frame), { ...data, distanceKm: u16(12) / 10, incline: frame[21], button: frame[22] });
    this.onData(data);
  }
}
