"""SwimTrack — STUB del detector de nadadores.

===========================================================================
  ⚠️  ESTO ES UN STUB REEMPLAZABLE — NO ES LA IA REAL  ⚠️
===========================================================================
  La clase real `SwimmerDetector` (YOLO en GPU) la entrega un compañero más
  adelante. Este archivo imita EXACTAMENTE su interfaz pública para poder
  construir el back y el front contra el contrato, sin depender de la IA.

  El día que llegue la clase real, se cambia SOLO el import:
      from detector_stub import SwimmerDetector   ->   from detector import SwimmerDetector
  Nada más. Después este archivo se borra.

  Regla: NO poner acá lógica de negocio. Solo genera detecciones FALSAS que
  respetan el contrato de datos definido en CLAUDE.md.
===========================================================================

Interfaz compartida con la clase real (ver CLAUDE.md):

    detector = SwimmerDetector(weights=...)      # se instancia una vez
    for frame in detector.stream(video_path):    # generador, un dict por frame
        ...

Contrato de cada frame (coords en píxeles del video ORIGINAL):

    { "time": 3.0, "width": 1280, "height": 720,
      "boxes": [{"id": 1, "x1": 100, "y1": 50, "x2": 180, "y2": 250, "conf": 0.91}] }

Sobre `count`: según CLAUDE.md, el nº de IDs únicos vistos hasta el momento lo
calcula el BACKEND (acumula los ids que va viendo), NO el detector. Por eso ni
este stub ni la clase real lo emiten aquí: el endpoint /api/detect lo agrega
antes de mandar el evento SSE.
"""

import math
import random
import time

# ── Parámetros del stub (fáciles de tocar; nada de esto existe en la clase real) ──
FRAME_WIDTH = 1280       # px del video "original" simulado (fijo)
FRAME_HEIGHT = 720       # (fijo)
N_FRAMES = 30            # ~30 frames de detecciones falsas
TIME_STEP_S = 0.2        # "time" incremental entre frames -> 0.0 .. 5.8 s
_STREAM_DELAY_S = 0.08   # pausa entre frames SOLO en el stub, para que el stream
                         # SSE se sienta real. La clase real va al ritmo de la GPU.
                         # Poné 0 para drenar el generador sin esperar (tests).

# Caja aproximada de un nadador (ancho x alto en px). Fija: el stub no estima tamaño.
_BOX_W = 90
_BOX_H = 210


class SwimmerDetector:
    """STUB de la clase real. Misma interfaz, detecciones inventadas.

    La clase real correría YOLO (track persist=True) sobre el video. Este stub
    ignora por completo el contenido del video: solo acepta la ruta para
    respetar la firma, y genera 2 nadadores con IDs estables que se mueven de a
    poco por la imagen.
    """

    def __init__(self, weights=None):
        # La clase real cargaría los pesos de YOLO acá. El stub solo los guarda:
        # no toca la GPU, no importa torch, no lee ningún archivo.
        self.weights = weights

    def stream(self, video_path):
        """Generador: ~30 frames de detecciones falsas (un dict por frame).

        Ignora el contenido de `video_path` (el detector real lo procesaría);
        acá solo se mantiene la firma del contrato.

        Los nadadores APARECEN escalonados (la pileta arranca vacía) para imitar
        una detección real: así el `count` que calcula el back sube 0 -> 1 -> 2.
        El nadador 1 sale de cuadro cerca del final: las cajas visibles bajan a 1
        pero el `count` acumulado se queda en 2.
        """
        # Ventanas de aparición (índice de frame).
        s1_in, s1_out = 2, 27   # nadador 1 presente en los frames 2..26
        s2_in = 10              # nadador 2 aparece más tarde y sigue hasta el final

        for i in range(N_FRAMES):
            boxes = []

            # Nadador 1 (id=1): carril superior, avanza hacia la DERECHA con un
            # leve vaivén vertical. Entra en s1_in y sale en s1_out.
            if s1_in <= i < s1_out:
                boxes.append(self._box(1, 90 + i * 28, int(150 + 12 * math.sin(i * 0.6))))

            # Nadador 2 (id=2): carril inferior, avanza hacia la IZQUIERDA
            # (sentido opuesto, vaivén desfasado). Aparece más tarde.
            if i >= s2_in:
                boxes.append(self._box(2, 1100 - i * 26, int(430 + 12 * math.sin(i * 0.6 + 1.5))))

            yield {
                "time": round(i * TIME_STEP_S, 2),
                "width": FRAME_WIDTH,
                "height": FRAME_HEIGHT,
                "boxes": boxes,
            }

            if _STREAM_DELAY_S:
                time.sleep(_STREAM_DELAY_S)

    @staticmethod
    def _box(swimmer_id, x1, y1):
        """Arma una caja del contrato con conf realista (~0.85-0.95)."""
        return {
            "id": swimmer_id,
            "x1": int(x1),
            "y1": int(y1),
            "x2": int(x1 + _BOX_W),
            "y2": int(y1 + _BOX_H),
            "conf": round(random.uniform(0.85, 0.95), 2),
        }


# Prueba rápida a mano:  python detector_stub.py
if __name__ == "__main__":
    det = SwimmerDetector(weights=None)
    for _frame in det.stream("cualquier_video.mp4"):
        print(_frame)
