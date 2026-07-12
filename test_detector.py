#!/usr/bin/env python3
"""Prueba una clase de detección (stub o real) contra un video, sin Flask.

Verifica que stream() emita frames con el formato del contrato (ver CLAUDE.md /
INTEGRACION_IA.md). Usa la clase real `detector.SwimmerDetector` si el módulo
existe; si no, cae al stub. Así el test sirve hoy (stub) y el día que llegue la
clase real, sin cambiarle nada.

Uso:
    python test_detector.py [ruta_video] [ruta_pesos.pt]

Ejemplos:
    python test_detector.py                        # stub (ignora el video)
    python test_detector.py pileta.mp4 best.pt     # clase real + pesos
"""
import sys

try:
    from detector import SwimmerDetector           # clase real (cuando exista)
    SOURCE = "detector (clase real)"
except ImportError:
    from detector_stub import SwimmerDetector       # hoy: stub
    SOURCE = "detector_stub (detecciones falsas)"

REQUIRED = {"time", "width", "height", "boxes"}     # count NO: lo agrega el back
BOX_KEYS = {"id", "x1", "y1", "x2", "y2", "conf"}


def main(video, weights):
    print(f"Probando {SOURCE} contra: {video}\n")
    det = SwimmerDetector(weights=weights)

    n = 0
    last_t = -1.0
    ids = set()
    for f in det.stream(video):
        n += 1
        missing = REQUIRED - set(f)
        assert not missing, f"frame {n}: faltan claves {missing}"
        assert isinstance(f["time"], (int, float)), f"frame {n}: time no es número"
        assert f["time"] >= last_t, f"frame {n}: time bajó ({f['time']} < {last_t})"
        last_t = f["time"]
        for b in f["boxes"]:
            bad = BOX_KEYS - set(b)
            assert not bad, f"frame {n}: caja sin claves {bad}"
            assert isinstance(b["id"], int), f"frame {n}: id no es int (¿track persist?)"
            assert 0 <= b["x1"] < b["x2"] <= f["width"], f"frame {n}: x fuera de rango"
            assert 0 <= b["y1"] < b["y2"] <= f["height"], f"frame {n}: y fuera de rango"
            ids.add(b["id"])
        if n <= 3:
            print(f"  frame {n}: {f}")

    assert n > 0, "stream() no emitió ningún frame"
    print(f"\nOK: {n} frames con formato correcto. IDs estables vistos: {sorted(ids)}")


if __name__ == "__main__":
    video = sys.argv[1] if len(sys.argv) > 1 else "test.mp4"
    weights = sys.argv[2] if len(sys.argv) > 2 else None
    main(video, weights)
