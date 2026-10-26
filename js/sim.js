// Simulateur : imite la console pour essayer l'interface sans le vélo.

export class SimDriver {
  protocol = 'Simulation';
  canControl = true;
  maxLevel = 15;
  #level = 5;
  #t = 0;
  #timer = null;

  constructor({ onData, onLog }) {
    Object.assign(this, { onData, onLog });
  }

  async init() {
    this.onLog('Simulation démarrée');
    this.#timer = setInterval(() => this.#tick(), 500);
  }

  #tick() {
    this.#t += 0.5;
    const pedaling = this.#t % 120 < 105; // petite pause toutes les deux minutes
    const cadence = pedaling ? 58 + 8 * Math.sin(this.#t / 20) + Math.random() * 3 : 0;
    this.onData({
      speed: cadence * 0.2,
      cadence,
      resistance: this.#level,
      hr: Math.round(92 + this.#level * 3 + cadence / 2),
    });
  }

  async setResistance(level) {
    this.onLog(`Simulation : résistance ${level}`);
    setTimeout(() => { this.#level = level; }, 400); // la vraie console met un instant à réagir
    return 0x01;
  }

  async start() {}

  async stop() {}

  dispose() {
    clearInterval(this.#timer);
  }
}
