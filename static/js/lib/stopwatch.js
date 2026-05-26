// Cronómetro con soporte de pausa, reset, y registro de largos.

/**
 * @typedef {Object} StopwatchLap
 * @property {number} lapNumber  1-indexed
 * @property {number} time       ms del largo
 * @property {string} timestamp  ISO del momento en que se registró
 */

/**
 * @typedef {Object} StopwatchOptions
 * @property {(elapsed: number) => void} [onTick]    Callback ejecutado en cada tick (ms acumulados).
 * @property {number} [tickInterval]                 Cada cuántos ms dispara onTick (default 50).
 */

export class Stopwatch {
  /** @param {StopwatchOptions} [options] */
  constructor(options = {}) {
    this.onTick = typeof options.onTick === 'function' ? options.onTick : null;
    this.tickInterval = Number.isFinite(options.tickInterval) ? options.tickInterval : 50;

    this._startedAt = 0;
    this._accumulated = 0;
    this._running = false;
    this._timerId = null;
    /** @type {StopwatchLap[]} */
    this._laps = [];
  }

  start() {
    if (this._running) return;
    this._startedAt = Date.now();
    this._running = true;
    if (this.onTick) {
      this._timerId = setInterval(() => {
        this.onTick(this.getElapsed());
      }, this.tickInterval);
    }
  }

  pause() {
    if (!this._running) return;
    this._accumulated += Date.now() - this._startedAt;
    this._running = false;
    if (this._timerId !== null) {
      clearInterval(this._timerId);
      this._timerId = null;
    }
  }

  stop() {
    this.pause();
  }

  reset() {
    this.pause();
    this._accumulated = 0;
    this._startedAt = 0;
    this._laps = [];
    if (this.onTick) this.onTick(0);
  }

  /** @returns {number} ms transcurridos totales. */
  getElapsed() {
    if (this._running) {
      return this._accumulated + (Date.now() - this._startedAt);
    }
    return this._accumulated;
  }

  /**
   * Registra un nuevo largo. El tiempo es la diferencia entre el
   * elapsed actual y la suma de los largos ya registrados.
   * @returns {StopwatchLap}
   */
  addLap() {
    const elapsed = this.getElapsed();
    const previousTotal = this._laps.reduce((s, l) => s + l.time, 0);
    const lapTime = Math.max(0, elapsed - previousTotal);
    /** @type {StopwatchLap} */
    const lap = {
      lapNumber: this._laps.length + 1,
      time: lapTime,
      timestamp: new Date().toISOString(),
    };
    this._laps.push(lap);
    return lap;
  }

  /** @returns {StopwatchLap|null} El largo eliminado, o null si no había. */
  removeLap() {
    return this._laps.pop() ?? null;
  }

  /** @returns {StopwatchLap[]} Copia de los largos. */
  getLapTimes() {
    return this._laps.slice();
  }

  /** @returns {boolean} */
  isRunning() {
    return this._running;
  }
}
