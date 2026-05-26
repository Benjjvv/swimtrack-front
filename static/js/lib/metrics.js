// Cálculo de métricas de una sesión de natación.
// Mismas fórmulas que el mockup (src/lib/metrics.ts).

/**
 * @typedef {Object} LapTime
 * @property {number} lapNumber
 * @property {number} time      Tiempo del largo en ms.
 * @property {string} timestamp ISO.
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} date
 * @property {string} swimmerId
 * @property {string} swimmerName
 * @property {number} laps
 * @property {LapTime[]} lapTimes
 * @property {number} totalTime
 */

/**
 * @typedef {Object} SessionMetrics
 * @property {number} totalLaps
 * @property {number} totalTime         ms
 * @property {number} avgLap            ms
 * @property {number} bestLap           ms (mejor = menor tiempo)
 * @property {number} worstLap          ms
 * @property {number} stdDev            ms
 * @property {number} consistencyScore  0-100
 * @property {number} fatigueDelta      ms (positivo = fatiga; segunda mitad más lenta)
 */

const EMPTY = Object.freeze({
  totalLaps: 0,
  totalTime: 0,
  avgLap: 0,
  bestLap: 0,
  worstLap: 0,
  stdDev: 0,
  consistencyScore: 0,
  fatigueDelta: 0,
});

/**
 * Calcula las métricas de una sesión.
 * @param {Session|null|undefined} session
 * @returns {SessionMetrics}
 */
export function computeSessionMetrics(session) {
  const lapTimes = (session && Array.isArray(session.lapTimes) ? session.lapTimes : [])
    .map(l => (l && Number.isFinite(l.time) && l.time >= 0 ? l.time : null))
    .filter(t => t !== null);

  const totalLaps = lapTimes.length;
  if (totalLaps === 0) return { ...EMPTY };

  const totalTime = lapTimes.reduce((sum, t) => sum + t, 0);
  const avgLap = totalTime / totalLaps;
  const bestLap = Math.min(...lapTimes);
  const worstLap = Math.max(...lapTimes);

  const variance =
    lapTimes.reduce((sum, t) => sum + Math.pow(t - avgLap, 2), 0) / totalLaps;
  const stdDev = Math.sqrt(variance);

  // Consistencia: 100 - coef. de variación (%). Clamp 0-100.
  const consistencyScore = avgLap > 0
    ? Math.max(0, Math.min(100, 100 - (stdDev / avgLap) * 100))
    : 0;

  // Fatiga: promedio segunda mitad − promedio primera mitad.
  let fatigueDelta = 0;
  if (totalLaps >= 2) {
    const half = Math.floor(totalLaps / 2);
    const firstHalf = lapTimes.slice(0, half);
    const secondHalf = lapTimes.slice(-half);
    const firstAvg = firstHalf.reduce((s, t) => s + t, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((s, t) => s + t, 0) / secondHalf.length;
    fatigueDelta = secondAvg - firstAvg;
  }

  return {
    totalLaps,
    totalTime,
    avgLap,
    bestLap,
    worstLap,
    stdDev,
    consistencyScore,
    fatigueDelta,
  };
}
