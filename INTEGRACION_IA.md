# Integración de la IA de detección — SwimTrack

Hola 👋 Esto es todo lo que necesitás para enchufar tu clase de detección real.
El back y el front **ya están hechos y andando** contra un stub que imita tu
clase. Si tu clase respeta el contrato de abajo, integrarte es **cambiar un
import**. Nada más.

---

## 1. Qué reemplazás

Hoy existe `detector_stub.py`: una clase `SwimmerDetector` que genera detecciones
**falsas** (2 nadadores inventados que se mueven) respetando el contrato de datos.
Todo el sistema —endpoint, streaming SSE, y el front que dibuja las cajas y las
sincroniza con el video— está construido y probado contra ese stub.

**Tu clase real (YOLO) sustituye al stub.** Punto.

---

## 2. La interfaz que tu clase DEBE cumplir

Mismo nombre y misma firma que el stub:

```python
class SwimmerDetector:
    def __init__(self, weights=None):
        # Cargás YOLO acá, UNA sola vez. `weights` = ruta al .pt.
        ...

    def stream(self, video_path):
        # GENERADOR: un `yield` por frame procesado.
        for ...:
            yield {
                "time": 3.0,        # segundos desde el inicio del video (float, no decreciente)
                "width": 1280,      # ancho del video ORIGINAL, en px
                "height": 720,      # alto del video ORIGINAL, en px
                "boxes": [
                    {"id": 1, "x1": 100, "y1": 50, "x2": 180, "y2": 250, "conf": 0.91},
                    # ...una por nadador detectado en ese frame
                ],
            }
```

Cada caja (coords en **píxeles del video original**):

- `id` — entero **estable entre frames** (de YOLO `track(persist=True)`). El mismo
  nadador tiene el mismo `id` frame a frame. Esto es clave: el front y el conteo
  dependen de que los ids no salten.
- `x1, y1, x2, y2` — esquinas de la caja, en px del video original.
- `conf` — confianza, 0..1.

Reglas:

- `boxes` puede ir **vacío** (`[]`) si en ese frame no hay nadadores.
- **NO mandes `count`.** Lo calcula el back (acumula los ids únicos que va viendo).
  Si lo incluís, se ignora.
- Emití **solo nadadores** (ver punto 3).

> Si tu `stream()` emite exactamente esto, la integración es el punto 4 y **nada
> más**. No tenés que saber nada del front, del SSE ni de Flask.

---

## 3. Qué entregás vos

1. **El módulo** con la clase, ej. `detector.py`, que exponga `SwimmerDetector`
   con la interfaz de arriba.
2. **Los pesos `.pt`** (ej. `best.pt`) y desde dónde cargarlos.
3. **`requirements.txt`** con tus dependencias (ultralytics / torch / etc.) para
   mergear con el nuestro. Aclará versión de torch y de CUDA si importa.
4. **El índice de la clase "nadador"** en tu modelo (qué class id devuelve YOLO
   para un nadador), así confirmamos que filtrás bien. Tu `stream()` ya debería
   emitir solo esa clase.
5. **La resolución de procesamiento**: a qué tamaño corrés la inferencia, y
   confirmá que las cajas salen en **px del video original** (`width`/`height` del
   frame = dims del video original). Si downscaleás para inferir, acordate de
   mapear las coords de vuelta al original.

---

## 4. El único punto de integración

En `app.py`, líneas **19–20**, está el TODO:

```python
# TODO: cambiar a la clase real cuando esté lista (from detector import SwimmerDetector)
from detector_stub import SwimmerDetector
```

Se cambia por:

```python
from detector import SwimmerDetector
```

Y si tus pesos necesitan una ruta, se ajusta la instancia (línea **24**):

```python
_detector = SwimmerDetector(weights="best.pt")   # hoy está en weights=None
```

Eso es todo. El detector se instancia **una vez** al arrancar y se reutiliza.

---

## 5. Cómo probar tu clase ANTES de integrar

En el repo hay un **`test_detector.py`** que corre la clase contra un video, sin
levantar Flask, y valida el formato del contrato. Detecta solo tu clase real si
existe `detector.py`; si no, prueba el stub (así ya funciona hoy). Cuando tengas
tu módulo y tus pesos:

```bash
python test_detector.py pileta.mp4 best.pt     # ruta al video y a tus pesos .pt
```

Tenés que ver:

- Los primeros frames impresos con la forma del contrato.
- `id` que se **repiten** entre frames para el mismo nadador (no que cambien en
  cada frame — si saltan, `track(persist=True)` no está bien configurado).
- `time` creciente.
- `OK: N frames con formato correcto`, sin ningún assert que reviente.

Si eso pasa, cambiás el import (punto 4) y ya está integrado.

---

## 6. Qué NO tenés que tocar

Todo esto ya está hecho y probado contra el contrato — no lo toques:

- **El front** (`static/js/…`): reproduce el video, dibuja las cajas escaladas y
  sincronizadas por `time`, y cuenta.
- **El endpoint** `POST /api/detect`: recibe el video, valida que sea video, lo
  guarda en un temporal y lo borra al terminar (nada queda en disco).
- **El streaming SSE**: arma el `count`, formatea los eventos, y maneja errores y
  desconexiones.
- **El contrato de datos**: no lo cambies sin avisar — lo consumen back y front.

Vos ponés la clase que emite los frames; el resto ya los recibe y los dibuja.
Cualquier duda, escribime. 🏊
