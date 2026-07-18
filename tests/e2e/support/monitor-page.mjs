const SELECTORS = {
  video: '#cameraVideo',
  canvas: '#cameraCanvas',
  fileInput: '#videoFileInput',
  loading: '#detectionLoading',
};

export class MonitorPage {
  constructor(page) {
    this.page = page;
    this.video = page.locator(SELECTORS.video);
    this.canvas = page.locator(SELECTORS.canvas);
    this.fileInput = page.locator(SELECTORS.fileInput);
    this.loading = page.locator(SELECTORS.loading);
  }

  async goto() {
    // './' mantiene el URL_PREFIX tanto en local como al apuntar al Apache desplegado.
    await this.page.goto('./');
    await this.fileInput.waitFor({ state: 'attached' });
  }

  async uploadVideo(videoPath) {
    await this.fileInput.setInputFiles(videoPath);
  }

  async waitForPlayback() {
    await this.page.waitForFunction(({ videoSelector, canvasSelector }) => {
      const video = document.querySelector(videoSelector);
      const canvas = document.querySelector(canvasSelector);
      return video && canvas && !video.paused && video.currentTime > 0.05 && canvas.width > 0;
    }, { videoSelector: SELECTORS.video, canvasSelector: SELECTORS.canvas });

    await this.page.waitForFunction(({ canvasSelector }) => {
      const canvas = document.querySelector(canvasSelector);
      if (!canvas?.width || !canvas?.height) return false;
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let count = 0;
      for (let index = 0; index < data.length; index += 16) {
        if (data[index] < 100 && data[index + 1] > 140 && data[index + 2] < 150) count += 1;
      }
      return count >= 8;
    }, { canvasSelector: SELECTORS.canvas });
  }

  /** Mide el canvas en cada frame de composición hasta completar los loops solicitados. */
  async observeOverlayThroughLoops({ loops = 2, timeoutMs = 10_000, minimumGreenPixels = 8 } = {}) {
    return this.page.evaluate(({ videoSelector, canvasSelector, loopsToObserve, timeout, minimumPixels }) => {
      const video = document.querySelector(videoSelector);
      const canvas = document.querySelector(canvasSelector);
      if (!video || !canvas) throw new Error('No se encontró el stage de video para observar el overlay.');

      const countGreenPixels = () => {
        if (!canvas.width || !canvas.height) return 0;
        const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        let count = 0;
        for (let index = 0; index < data.length; index += 16) {
          if (data[index] < 100 && data[index + 1] > 140 && data[index + 2] < 150) count += 1;
        }
        return count;
      };

      return new Promise((resolve, reject) => {
        const startedAt = performance.now();
        let previousTime = video.currentTime;
        let observedLoops = 0;
        let samples = 0;
        let blankFrames = 0;
        let maxConsecutiveBlankFrames = 0;

        const sample = () => {
          const currentTime = video.currentTime;
          if (currentTime + 0.2 < previousTime) observedLoops += 1;
          previousTime = currentTime;

          const greenPixels = countGreenPixels();
          samples += 1;
          if (greenPixels < minimumPixels) {
            blankFrames += 1;
            maxConsecutiveBlankFrames = Math.max(maxConsecutiveBlankFrames, blankFrames);
          } else {
            blankFrames = 0;
          }

          if (observedLoops >= loopsToObserve) {
            resolve({ observedLoops, samples, maxConsecutiveBlankFrames });
            return;
          }
          if (performance.now() - startedAt >= timeout) {
            reject(new Error(`El video no completó ${loopsToObserve} loops; observados: ${observedLoops}.`));
            return;
          }
          requestAnimationFrame(sample);
        };

        requestAnimationFrame(sample);
      });
    }, {
      videoSelector: SELECTORS.video,
      canvasSelector: SELECTORS.canvas,
      loopsToObserve: loops,
      timeout: timeoutMs,
      minimumPixels: minimumGreenPixels,
    });
  }
}
