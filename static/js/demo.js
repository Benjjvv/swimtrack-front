// Página Demo — sesión simulada de 10 largos que se revelan progresivamente + análisis IA.

import { formatTime } from './lib/format.js';
import { computeSessionMetrics } from './lib/metrics.js';
import { analyze } from './lib/ai-coach.js';

// Tiempos hardcodeados (ms): ritmo que se degrada (fatiga) hacia el final.
const DEMO_LAP_TIMES = [31200, 31800, 32100, 32500, 32400, 33000, 33500, 34100, 34800, 35500];
const TOTAL = DEMO_LAP_TIMES.length;
const STEP_MS = 1500;

const startBtn = document.getElementById('startDemoBtn');
const lapBadge = document.getElementById('lapBadge');
const lapGrid = document.getElementById('lapGrid');
const aiCard = document.getElementById('aiCard');
const aiOutput = document.getElementById('demoAiOutput');

let timerId = null;

/** Dibuja las 10 celdas (vacías o con tiempo) según cuántos largos van revelados. */
function renderGrid(revealed) {
  let html = '';
  for (let i = 0; i < TOTAL; i++) {
    const done = i < revealed;
    html += `
      <div class="col">
        <div class="border rounded text-center py-2 ${done ? '' : 'text-muted'}">
          <div class="small text-muted">Largo ${i + 1}</div>
          <div class="font-monospace fw-semibold">${done ? formatTime(DEMO_LAP_TIMES[i]) : '—'}</div>
        </div>
      </div>`;
  }
  lapGrid.innerHTML = html;
}

function setBadge(n) {
  lapBadge.textContent = `Largo ${n} / ${TOTAL}`;
}

async function finish() {
  aiCard.classList.remove('d-none');
  aiOutput.classList.remove('text-danger');
  aiOutput.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Analizando…';

  const session = {
    id: 'demo',
    date: new Date().toISOString(),
    swimmerName: 'Nadador Demo',
    laps: TOTAL,
    lapTimes: DEMO_LAP_TIMES.map((t, i) => ({ lapNumber: i + 1, time: t, timestamp: '' })),
    totalTime: DEMO_LAP_TIMES.reduce((s, t) => s + t, 0),
  };
  const m = computeSessionMetrics(session);
  const result = await analyze({
    mode: 'summary',
    swimmerName: session.swimmerName,
    metrics: {
      totalLaps: m.totalLaps,
      avgLap: m.avgLap,
      consistencyScore: m.consistencyScore,
      fatigueDelta: m.fatigueDelta,
    },
  });

  if (result.ok) {
    aiOutput.textContent = result.analysis;
  } else {
    aiOutput.classList.add('text-danger');
    aiOutput.textContent = 'Error: ' + result.error;
  }
  startBtn.disabled = false;
  startBtn.innerHTML = '<i class="bi bi-arrow-repeat"></i> Reiniciar demo';
}

function startDemo() {
  if (timerId) clearInterval(timerId);
  startBtn.disabled = true;
  aiCard.classList.add('d-none');
  let current = 0;
  setBadge(0);
  renderGrid(0);

  timerId = setInterval(() => {
    current += 1;
    setBadge(current);
    renderGrid(current);
    if (current >= TOTAL) {
      clearInterval(timerId);
      timerId = null;
      finish();
    }
  }, STEP_MS);
}

startBtn.addEventListener('click', startDemo);
renderGrid(0);
