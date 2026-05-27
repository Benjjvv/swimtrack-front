// Acceso a la cámara del dispositivo vía getUserMedia.

export class CameraController {
  constructor() {
    /** @type {MediaStream|null} */
    this._stream = null;
  }

  /**
   * Pide permiso y enchufa el stream al elemento <video>.
   * @param {HTMLVideoElement} videoEl
   * @returns {Promise<MediaStream>}
   */
  async start(videoEl) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('getUserMedia no está disponible en este navegador.');
    }
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
    } catch (err) {
      if (err && err.name === 'NotAllowedError') {
        throw new Error('Permiso de cámara denegado.');
      }
      if (err && err.name === 'NotFoundError') {
        throw new Error('No se encontró ninguna cámara.');
      }
      throw new Error('No se pudo acceder a la cámara: ' + (err && err.message ? err.message : err));
    }
    videoEl.srcObject = this._stream;
    await videoEl.play();
    return this._stream;
  }

  /** Libera la cámara (apaga todos los tracks). */
  stop() {
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }
  }

  isActive() {
    return this._stream !== null;
  }
}
