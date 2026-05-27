// Página Análisis IA — métricas en cliente + integración con /api/ai/analyze.

import { getItem, KEYS } from './lib/storage.js';
import { formatTime, formatDate } from './lib/format.js';
import { computeSessionMetrics } from './lib/metrics.js';
import { analyze } from './lib/ai-coach.js';

const swimmers = getItem(KEYS.SWIMMERS, []);
const sessions = getItem(KEYS.SESSIONS, []);

let selectedSwimmer = 'all';
let selectedSessionId = null;
/** @type {{role:string,content:string}[]} */
const chatHistory = [];

// --- DOM ---
const $ = (id) => document.getElementById(id);
const els = {
  empty: $('analysisEmpty'),
  main: $('analysisMain'),
  swimmerSelect: $('swimmerSelect'),
  sessionSelect: $('sessionSelect'),
  laps: $('mLaps'),
  avg: $('mAvg'),
  consistency: $('mConsistency'),
  fatigue: $('mFatigue'),
  summaryBtn: $('summaryBtn'),
  diagnosisBtn: $('diagnosisBtn'),
  aiOutput: $('aiOutput'),
  chatLog: $('chatLog'),
  chatForm: $('chatForm'),
  chatInput: $('chatInput'),
  chatSend: $('chatSend'),
};

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

// --- Datos derivados ---
function sessionsForSwimmer() {
  const list =
    selectedSwimmer === 'all'
      ? sessions
      : sessions.filter((s) => s.swimmerId === selectedSwimmer);
  return list.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
}

function currentSession() {
  return sessions.find((s) => s.id === selectedSessionId) || null;
}

// --- Render: selectores ---
function renderSwimmerOptions() {
  const opts = ['<option value="all">Todos</option>'];
  for (const sw of swimmers) {
    opts.push(`<option value="${escapeHtml(sw.id)}">${escapeHtml(sw.name)}</option>`);
  }
  els.swimmerSelect.innerHTML = opts.join('');
  els.swimmerSelect.value = selectedSwimmer;
}

function renderSessionOptions() {
  const list = sessionsForSwimmer();
  els.sessionSelect.innerHTML = list
    .map(
      (s) =>
        `<option value="${escapeHtml(s.id)}">${escapeHtml(formatDate(s.date))} · ${escapeHtml(s.swimmerName)} (${s.laps} largos)</option>`
    )
    .join('');
  // Mantener selección si sigue disponible; si no, la primera.
  if (!list.some((s) => s.id === selectedSessionId)) {
    selectedSessionId = list.length ? list[0].id : null;
  }
  if (selectedSessionId) els.sessionSelect.value = selectedSessionId;
}

// --- Render: métricas ---
function renderMetrics() {
  const session = currentSession();
  const m = computeSessionMetrics(session);
  els.laps.textContent = m.totalLaps || '—';
  els.avg.textContent = m.totalLaps ? formatTime(m.avgLap) : '—';
  els.consistency.textContent = m.totalLaps ? `${m.consistencyScore.toFixed(0)}%` : '—';

  if (!m.totalLaps) {
    els.fatigue.textContent = '—';
    els.fatigue.classList.remove('text-danger');
  } else {
    const sign = m.fatigueDelta >= 0 ? '+' : '−';
    els.fatigue.textContent = `${sign}${formatTime(Math.abs(m.fatigueDelta))}`;
    els.fatigue.classList.toggle('text-danger', m.fatigueDelta > 1500);
  }

  const hasSession = !!session;
  els.summaryBtn.disabled = !hasSession;
  els.diagnosisBtn.disabled = !hasSession;
}

function render() {
  renderSwimmerOptions();
  renderSessionOptions();
  renderMetrics();
}

// --- IA ---
function buildContext() {
  const session = currentSession();
  const m = computeSessionMetrics(session);
  return {
    swimmerName: session ? session.swimmerName : null,
    sessionDate: session ? session.date : null,
    metrics: {
      totalLaps: m.totalLaps,
      avgLap: m.avgLap,
      consistencyScore: m.consistencyScore,
      fatigueDelta: m.fatigueDelta,
    },
  };
}

async function runAnalysis(mode) {
  if (!currentSession()) return;
  els.summaryBtn.disabled = true;
  els.diagnosisBtn.disabled = true;
  els.aiOutput.classList.remove('text-danger');
  els.aiOutput.innerHTML =
    '<span class="spinner-border spinner-border-sm me-2"></span>Analizando…';

  const result = await analyze({ mode, ...buildContext() });
  if (result.ok) {
    els.aiOutput.textContent = result.analysis;
  } else {
    els.aiOutput.classList.add('text-danger');
    els.aiOutput.textContent = 'Error: ' + result.error;
  }
  els.summaryBtn.disabled = false;
  els.diagnosisBtn.disabled = false;
}

// --- Chat ---
function appendChat(role, content) {
  const wrap = document.createElement('div');
  const mine = role === 'user';
  wrap.className = `d-flex ${mine ? 'justify-content-end' : 'justify-content-start'}`;
  const bubble = document.createElement('div');
  bubble.className = `p-2 px-3 rounded ${mine ? 'text-bg-primary' : 'text-bg-secondary'}`;
  bubble.style.maxWidth = '85%';
  bubble.textContent = content;
  wrap.appendChild(bubble);
  els.chatLog.appendChild(wrap);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

async function sendChat(e) {
  e.preventDefault();
  const text = els.chatInput.value.trim();
  if (!text) return;
  els.chatInput.value = '';
  chatHistory.push({ role: 'user', content: text });
  appendChat('user', text);

  els.chatSend.disabled = true;
  const result = await analyze({ mode: 'chat', messages: chatHistory, ...buildContext() });
  const reply = result.ok ? result.analysis : 'Error: ' + result.error;
  chatHistory.push({ role: 'assistant', content: reply });
  appendChat('assistant', reply);
  els.chatSend.disabled = false;
}

// --- Init ---
function init() {
  if (sessions.length === 0) {
    els.empty.classList.remove('d-none');
    return;
  }
  els.main.classList.remove('d-none');

  els.swimmerSelect.addEventListener('change', () => {
    selectedSwimmer = els.swimmerSelect.value;
    selectedSessionId = null;
    render();
  });
  els.sessionSelect.addEventListener('change', () => {
    selectedSessionId = els.sessionSelect.value;
    renderMetrics();
  });
  els.summaryBtn.addEventListener('click', () => runAnalysis('summary'));
  els.diagnosisBtn.addEventListener('click', () => runAnalysis('diagnosis'));
  els.chatForm.addEventListener('submit', sendChat);

  render();
}

init();
