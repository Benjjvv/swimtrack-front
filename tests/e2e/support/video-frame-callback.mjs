/**
 * Simula el fallo observado: el primer callback posterior al loop no invoca a
 * la aplicación, por lo que la cadena de requestVideoFrameCallback se corta.
 * Los eventos nativos de seek/timeupdate siguen ocurriendo y deben recuperar
 * el overlay sin que las cajas parpadeen.
 */
export async function stopVideoFrameCallbacksAfterFirstLoop(page) {
  await page.addInitScript(() => {
    const nativeRequest = HTMLVideoElement.prototype.requestVideoFrameCallback;
    if (typeof nativeRequest !== 'function') return;

    const lastMediaTimes = new WeakMap();
    HTMLVideoElement.prototype.requestVideoFrameCallback = function requestVideoFrameCallback(callback) {
      return nativeRequest.call(this, (now, metadata) => {
        const mediaTime = Number.isFinite(metadata?.mediaTime) ? metadata.mediaTime : this.currentTime;
        const previous = lastMediaTimes.get(this);
        if (Number.isFinite(previous) && mediaTime + 0.2 < previous) return;
        lastMediaTimes.set(this, mediaTime);
        callback(now, metadata);
      });
    };
  });
}
