// GUION DE PRESENTACIÓN — NO es detección real.
//
// Para videos puntuales (identificados por el nombre de archivo) sabemos de
// antemano en qué SEGUNDOS del video cada nadador completa un largo. Al
// reproducir ESE video se le suman los largos al nadador registrado en el modal
// (por ORDEN de registro) y se siembra la sesión en Historial. Atado a videos
// concretos; el día que la IA detecte largos de verdad, este archivo se borra.

import { getItem, setItem, KEYS } from './storage.js';

// Config por video: substring del nombre de archivo -> lista ORDENADA (1 entrada
// por nadador, por orden de registro) con los segundos de cada largo.
const DEMO_VIDEOS = {
  'video-presentacion-final': [
    { laps: [25, 56] }, // 1er nadador registrado
  ],
};

/**
 * Si el archivo es un video de demo conocido, devuelve su schedule
 * (array de {laps:number[]}); si no, null.
 * @param {File} file
 * @returns {{laps:number[]}[]|null}
 */
export function demoVideoSchedule(file) {
  if (!file || !file.name) return null;
  const name = file.name.toLowerCase();
  const key = Object.keys(DEMO_VIDEOS).find((k) => name.includes(k));
  return key ? DEMO_VIDEOS[key] : null;
}

/**
 * Convierte segundos ABSOLUTOS de largo ([25,56]) en lapTimes con tiempos
 * RELATIVOS (cada largo = diferencia con el anterior), en ms. Puro.
 * @param {number[]} lapSeconds
 * @param {string} nowIso
 * @returns {{lapNumber:number,time:number,timestamp:string}[]}
 */
export function lapTimesFromSeconds(lapSeconds, nowIso) {
  let prev = 0;
  return lapSeconds.map((sec, i) => {
    const time = Math.max(0, Math.round((sec - prev) * 1000));
    prev = sec;
    return { lapNumber: i + 1, time, timestamp: nowIso };
  });
}

/**
 * Construye una Session (shape de Historial) para un nadador y sus largos. Id
 * determinista por nadador -> idempotente al re-subir el mismo video. Puro.
 * @param {{id:string,name:string}} swimmer
 * @param {number[]} lapSeconds
 * @param {string} nowIso
 */
export function buildDemoSession(swimmer, lapSeconds, nowIso) {
  const lapTimes = lapTimesFromSeconds(lapSeconds, nowIso);
  return {
    id: `demo-session-${swimmer.id}`,
    date: nowIso,
    swimmerId: swimmer.id,
    swimmerName: swimmer.name,
    laps: lapTimes.length,
    lapTimes,
    totalTime: lapTimes.reduce((sum, l) => sum + l.time, 0),
  };
}

/**
 * Siembra en Historial una sesión por cada par (nadador, segundos de largo).
 * Idempotente: no duplica la sesión demo de un nadador ya sembrado.
 * @param {{swimmer:{id:string,name:string}, laps:number[]}[]} pairs
 */
export function seedDemoSessions(pairs) {
  const sessions = getItem(KEYS.SESSIONS, []);
  const now = new Date().toISOString();
  let changed = false;
  for (const { swimmer, laps } of pairs) {
    if (!swimmer) continue;
    const session = buildDemoSession(swimmer, laps, now);
    if (!sessions.some((s) => s.id === session.id)) {
      sessions.push(session);
      changed = true;
    }
  }
  if (changed) setItem(KEYS.SESSIONS, sessions);
}

/**
 * Engancha al <video> el conteo de largos por tiempo: cuando currentTime cruza
 * cada segundo del plan, llama onLap(swimmerId) UNA vez. Sincronizado al tiempo
 * del video (no setTimeout) y a prueba de loop.
 * @param {HTMLVideoElement} video
 * @param {{swimmerId:string, laps:number[]}[]} plan
 * @param {(swimmerId:string, lapNumber:number)=>void} onLap
 * @returns {() => void} cleanup: quita el listener de timeupdate
 */
export function runVideoLapScript(video, plan, onLap) {
  const fired = plan.map(() => new Set());
  const handler = () => {
    plan.forEach((p, i) => {
      p.laps.forEach((sec, j) => {
        if (!fired[i].has(j) && video.currentTime >= sec) {
          fired[i].add(j);
          onLap(p.swimmerId, j + 1);
        }
      });
    });
  };
  video.addEventListener('timeupdate', handler);
  return () => video.removeEventListener('timeupdate', handler);
}
