// Cliente del endpoint /api/ai/analyze (proxy de Flask hacia el módulo de IA).

/**
 * @typedef {Object} AnalyzeResult
 * @property {boolean} ok
 * @property {string} [analysis] - Texto devuelto por la IA (o el mock).
 * @property {boolean} [mock]    - true si vino del mock del servidor.
 * @property {string} [error]    - Mensaje de error si ok=false.
 */

/** URL del endpoint, leída del <meta> que pone base.html con url_for (soporta subpath). */
function analyzeUrl() {
  const meta = document.querySelector('meta[name="st-analyze-url"]');
  return meta && meta.content ? meta.content : '/api/ai/analyze';
}

/**
 * Pide un análisis a la IA.
 * @param {{mode:'summary'|'diagnosis'|'chat', swimmerName?:string, sessionDate?:string,
 *          metrics?:Object, messages?:{role:string,content:string}[]}} payload
 * @returns {Promise<AnalyzeResult>}
 */
export async function analyze(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(analyzeUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: `El servidor respondió ${res.status}.` };
    const data = await res.json();
    return { ok: true, analysis: data.analysis || '', mock: !!data.mock };
  } catch (err) {
    const msg =
      err && err.name === 'AbortError'
        ? 'La IA tardó demasiado en responder.'
        : 'No se pudo contactar al servidor.';
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
