const DEFAULT_FPS = 30;
const DEFAULT_DURATION_SECONDS = 2;

/** Construye eventos SSE deterministas que siguen el contrato público del Front. */
export function buildDetectionFrames({
  fps = DEFAULT_FPS,
  durationSeconds = DEFAULT_DURATION_SECONDS,
  width = 320,
  height = 320,
} = {}) {
  const frameCount = Math.round(fps * durationSeconds);
  return Array.from({ length: frameCount }, (_unused, frameIndex) => {
    const progress = frameIndex / Math.max(1, frameCount - 1);
    const x1 = Math.round(32 + progress * 120);
    return {
      time: Number((frameIndex / fps).toFixed(6)),
      width,
      height,
      count: 1,
      boxes: [{
        id: 1,
        x1,
        y1: 72,
        x2: x1 + 88,
        y2: 244,
        conf: 0.93,
      }],
    };
  });
}

/** Intercepta sólo el upload de detecciones, sin sustituir rutas ni assets de la app. */
export async function installDetectionStreamMock(page, options) {
  const body = buildDetectionFrames(options)
    .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
    .join('');

  await page.route('**/api/detect', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream; charset=utf-8',
      body,
    });
  });
}
