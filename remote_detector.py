"""Adaptador del front Flask hacia el servicio remoto de visión.

El navegador continúa subiendo un video completo a ``POST /api/detect``. Este
módulo lo decodifica, comprime frames 640x640 en JPEG y los envía en batches
secuenciales a una sesión remota. El contrato público de ``stream()`` sigue
siendo el que consume el generador SSE del front.
"""

from __future__ import annotations

import json
import math
import time
import uuid
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass
from typing import Any, Literal

import cv2
import httpx


_RETRYABLE_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}


class RemoteDetectorError(RuntimeError):
    """Error legible producido al decodificar o al llamar al servicio IA."""


@dataclass(frozen=True)
class _EncodedFrame:
    frame_index: int
    time_ms: float
    original_width: int
    original_height: int
    jpeg: bytes

    def metadata(self) -> dict[str, int | float]:
        return {
            "frame_index": self.frame_index,
            "time_ms": self.time_ms,
            "original_width": self.original_width,
            "original_height": self.original_height,
        }


class RemoteSwimmerDetector:
    """Implementa ``stream(video_path)`` usando RT-DETRv2 + ByteTrack remotos.

    Cada llamada crea una sesión de tracking independiente. Los batches de una
    sesión se mandan en orden y nunca en paralelo, ya que ByteTrack conserva
    estado entre ellos. Un retry reutiliza exactamente ``batch_id``, secuencia,
    metadata y bytes, por lo que el servicio puede responder idempotentemente.
    """

    def __init__(
        self,
        *,
        base_url: str,
        auth_token: str,
        lap_calibration_id: str | None = None,
        tracking_diagnostics: Literal["none", "counts", "boxes"] = "none",
        batch_size: int = 8,
        inference_size: int = 640,
        jpeg_quality: int = 85,
        connect_timeout: float = 5.0,
        read_timeout: float = 120.0,
        write_timeout: float = 30.0,
        pool_timeout: float = 5.0,
        cleanup_timeout: float = 5.0,
        max_retries: int = 2,
        retry_backoff_seconds: float = 0.5,
        fallback_fps: float = 30.0,
        client_factory: Callable[..., httpx.Client] | None = None,
        sleep: Callable[[float], None] = time.sleep,
        uuid_factory: Callable[[], uuid.UUID] = uuid.uuid4,
    ) -> None:
        if not base_url.strip():
            raise ValueError("VISION_BASE_URL no puede estar vacío.")
        if batch_size < 1:
            raise ValueError("VISION_BATCH_SIZE debe ser al menos 1.")
        if inference_size < 1:
            raise ValueError("VISION_INFERENCE_SIZE debe ser al menos 1.")
        if not 1 <= jpeg_quality <= 100:
            raise ValueError("VISION_JPEG_QUALITY debe estar entre 1 y 100.")
        if max_retries < 0:
            raise ValueError("VISION_MAX_RETRIES no puede ser negativo.")
        if cleanup_timeout <= 0:
            raise ValueError("VISION_CLEANUP_TIMEOUT debe ser mayor que cero.")
        if fallback_fps <= 0:
            raise ValueError("VISION_FALLBACK_FPS debe ser mayor que cero.")
        if not isinstance(tracking_diagnostics, str):
            raise ValueError(
                "VISION_TRACKING_DIAGNOSTICS debe ser none, counts o boxes."
            )
        tracking_diagnostics = tracking_diagnostics.strip().lower()
        if tracking_diagnostics not in {"none", "counts", "boxes"}:
            raise ValueError(
                "VISION_TRACKING_DIAGNOSTICS debe ser none, counts o boxes."
            )

        self.base_url = base_url.rstrip("/")
        self.auth_token = auth_token
        self.lap_calibration_id = (
            lap_calibration_id.strip() if lap_calibration_id else None
        )
        self.tracking_diagnostics = tracking_diagnostics
        self.batch_size = batch_size
        self.inference_size = inference_size
        self.jpeg_quality = jpeg_quality
        self.max_retries = max_retries
        self.retry_backoff_seconds = retry_backoff_seconds
        self.fallback_fps = fallback_fps
        self.cleanup_timeout = cleanup_timeout
        self._client_factory = client_factory or httpx.Client
        self._sleep = sleep
        self._uuid_factory = uuid_factory
        self._timeout = httpx.Timeout(
            read_timeout,
            connect=connect_timeout,
            read=read_timeout,
            write=write_timeout,
            pool=pool_timeout,
        )

    @classmethod
    def from_flask_config(cls, config: dict[str, Any]) -> "RemoteSwimmerDetector":
        """Construye el adaptador desde ``app.config``."""
        return cls(
            base_url=config["VISION_BASE_URL"],
            auth_token=config.get("VISION_AUTH_TOKEN", ""),
            lap_calibration_id=config.get("VISION_LAP_CALIBRATION_ID"),
            tracking_diagnostics=config.get("VISION_TRACKING_DIAGNOSTICS", "none"),
            batch_size=int(config["VISION_BATCH_SIZE"]),
            inference_size=int(config["VISION_INFERENCE_SIZE"]),
            jpeg_quality=int(config["VISION_JPEG_QUALITY"]),
            connect_timeout=float(config["VISION_CONNECT_TIMEOUT"]),
            read_timeout=float(config["VISION_READ_TIMEOUT"]),
            write_timeout=float(config["VISION_WRITE_TIMEOUT"]),
            pool_timeout=float(config["VISION_POOL_TIMEOUT"]),
            cleanup_timeout=float(config["VISION_CLEANUP_TIMEOUT"]),
            max_retries=int(config["VISION_MAX_RETRIES"]),
            retry_backoff_seconds=float(config["VISION_RETRY_BACKOFF_SECONDS"]),
            fallback_fps=float(config["VISION_FALLBACK_FPS"]),
        )

    def stream(self, video_path: str) -> Iterator[dict[str, Any]]:
        """Decodifica ``video_path`` y emite un resultado SSE-ready por frame."""
        capture = cv2.VideoCapture(video_path)
        if not capture.isOpened():
            capture.release()
            raise RemoteDetectorError("No se pudo abrir el video subido.")

        fps = float(capture.get(cv2.CAP_PROP_FPS))
        if not math.isfinite(fps) or fps <= 0:
            fps = self.fallback_fps

        client: httpx.Client | None = None
        session_id: str | None = None
        sequence = 0
        pending: list[_EncodedFrame] = []
        frame_index = 0

        try:
            client = self._client_factory(
                headers={"X-Swimtrack-Auth": self.auth_token},
                timeout=self._timeout,
            )
            session_id = self._create_session(client, fps)

            while True:
                ok, frame = capture.read()
                if not ok:
                    break

                pending.append(self._encode_frame(frame, frame_index, fps))
                frame_index += 1

                if len(pending) == self.batch_size:
                    results, sequence = self._send_batch(
                        client, session_id, sequence, pending
                    )
                    yield from results
                    pending = []

            if pending:
                results, sequence = self._send_batch(
                    client, session_id, sequence, pending
                )
                yield from results

            if frame_index == 0:
                raise RemoteDetectorError(
                    "El video subido no contiene frames decodificables."
                )
        finally:
            capture.release()
            if client is not None and session_id is not None:
                self._close_session(client, session_id)
            if client is not None:
                client.close()

    def _encode_frame(self, frame: Any, frame_index: int, fps: float) -> _EncodedFrame:
        height, width = frame.shape[:2]
        resized = cv2.resize(
            frame,
            (self.inference_size, self.inference_size),
            interpolation=cv2.INTER_LINEAR,
        )
        ok, encoded = cv2.imencode(
            ".jpg",
            resized,
            [cv2.IMWRITE_JPEG_QUALITY, self.jpeg_quality],
        )
        if not ok:
            raise RemoteDetectorError(f"No se pudo codificar el frame {frame_index}.")
        return _EncodedFrame(
            frame_index=frame_index,
            time_ms=frame_index * 1000.0 / fps,
            original_width=int(width),
            original_height=int(height),
            jpeg=encoded.tobytes(),
        )

    def _create_session(self, client: httpx.Client, fps: float) -> str:
        payload: dict[str, float | str] = {"fps": fps}
        if self.lap_calibration_id is not None:
            payload["lap_calibration_id"] = self.lap_calibration_id
        if self.tracking_diagnostics != "none":
            payload["diagnostics"] = self.tracking_diagnostics
        try:
            response = client.post(
                f"{self.base_url}/v1/tracking-sessions",
                json=payload,
            )
        except httpx.HTTPError as exc:
            raise RemoteDetectorError(
                "No se pudo conectar con el servicio de detección."
            ) from exc

        self._ensure_success(response, expected_status=201)
        payload = self._response_json(response)
        session_id = payload.get("session_id")
        if not isinstance(session_id, str) or not session_id:
            raise RemoteDetectorError("El servicio IA devolvió una sesión inválida.")
        if payload.get("next_sequence", 0) != 0:
            raise RemoteDetectorError("La sesión IA no comenzó en la secuencia cero.")
        return session_id

    def _send_batch(
        self,
        client: httpx.Client,
        session_id: str,
        sequence: int,
        frames: Sequence[_EncodedFrame],
    ) -> tuple[list[dict[str, Any]], int]:
        batch_id = str(self._uuid_factory())
        metadata = {
            "batch_id": batch_id,
            "sequence": sequence,
            "frames": [frame.metadata() for frame in frames],
        }
        metadata_json = json.dumps(metadata, separators=(",", ":"))
        files = [
            (
                "frames",
                (f"frame-{frame.frame_index:08d}.jpg", frame.jpeg, "image/jpeg"),
            )
            for frame in frames
        ]

        response: httpx.Response | None = None
        last_transport_error: httpx.HTTPError | None = None
        for attempt in range(self.max_retries + 1):
            try:
                response = client.post(
                    f"{self.base_url}/v1/tracking-sessions/{session_id}/batches",
                    data={"metadata": metadata_json},
                    files=files,
                )
                last_transport_error = None
            except httpx.HTTPError as exc:
                last_transport_error = exc
                if attempt == self.max_retries:
                    break
                self._wait_before_retry(attempt)
                continue

            if (
                response.status_code in _RETRYABLE_STATUS_CODES
                and attempt < self.max_retries
            ):
                self._wait_before_retry(attempt)
                continue
            break

        if last_transport_error is not None:
            raise RemoteDetectorError(
                f"Falló el envío del batch {batch_id} al servicio IA."
            ) from last_transport_error
        if response is None:  # defensa; el loop siempre asigna respuesta o error
            raise RemoteDetectorError(f"El batch {batch_id} no obtuvo respuesta.")

        self._ensure_success(response, expected_status=200)
        payload = self._response_json(response)
        results = self._validate_batch_response(
            payload,
            session_id=session_id,
            batch_id=batch_id,
            sequence=sequence,
            frames=frames,
        )
        return results, sequence + 1

    def _validate_batch_response(
        self,
        payload: dict[str, Any],
        *,
        session_id: str,
        batch_id: str,
        sequence: int,
        frames: Sequence[_EncodedFrame],
    ) -> list[dict[str, Any]]:
        if payload.get("session_id") != session_id:
            raise RemoteDetectorError("La respuesta IA pertenece a otra sesión.")
        if payload.get("batch_id") != batch_id or payload.get("sequence") != sequence:
            raise RemoteDetectorError(
                "La respuesta IA no corresponde al batch enviado."
            )
        if payload.get("next_sequence") != sequence + 1:
            raise RemoteDetectorError(
                "La respuesta IA contiene una secuencia inválida."
            )

        response_frames = payload.get("frames")
        if not isinstance(response_frames, list) or len(response_frames) != len(frames):
            raise RemoteDetectorError("La respuesta IA no contiene todos los frames.")

        normalized: list[dict[str, Any]] = []
        for expected, result in zip(frames, response_frames, strict=True):
            if (
                not isinstance(result, dict)
                or result.get("frame_index") != expected.frame_index
            ):
                raise RemoteDetectorError(
                    "La respuesta IA alteró el orden de los frames."
                )
            if (
                result.get("width") != expected.original_width
                or result.get("height") != expected.original_height
            ):
                raise RemoteDetectorError(
                    "La respuesta IA devolvió dimensiones incorrectas."
                )
            boxes = result.get("boxes")
            if not isinstance(boxes, list):
                raise RemoteDetectorError("La respuesta IA contiene boxes inválidas.")

            normalized_frame = {
                "time": float(result.get("time_ms", expected.time_ms)) / 1000.0,
                "width": expected.original_width,
                "height": expected.original_height,
                "boxes": [self._normalize_box(box) for box in boxes],
            }
            lap_scores = result.get("lap_scores")
            if lap_scores is not None:
                if not isinstance(lap_scores, list):
                    raise RemoteDetectorError(
                        "La respuesta IA contiene lap_scores inválidos."
                    )
                normalized_frame["lap_scores"] = [
                    self._normalize_lap_score(score) for score in lap_scores
                ]
            tracking_diagnostics = result.get("tracking_diagnostics")
            if tracking_diagnostics is not None:
                normalized_frame["tracking_diagnostics"] = (
                    self._normalize_tracking_diagnostics(tracking_diagnostics)
                )
            normalized.append(normalized_frame)
        return normalized

    @staticmethod
    def _normalize_box(box: Any) -> dict[str, int | float]:
        if not isinstance(box, dict):
            raise RemoteDetectorError("La respuesta IA contiene una bbox inválida.")
        required = ("id", "x1", "y1", "x2", "y2", "conf")
        if any(key not in box for key in required):
            raise RemoteDetectorError("La respuesta IA contiene una bbox incompleta.")
        try:
            return {
                "id": int(box["id"]),
                "x1": float(box["x1"]),
                "y1": float(box["y1"]),
                "x2": float(box["x2"]),
                "y2": float(box["y2"]),
                "conf": float(box["conf"]),
            }
        except (TypeError, ValueError) as exc:
            raise RemoteDetectorError(
                "La respuesta IA contiene valores de bbox inválidos."
            ) from exc

    @staticmethod
    def _normalize_lap_score(score: Any) -> dict[str, Any]:
        if not isinstance(score, dict):
            raise RemoteDetectorError("La respuesta IA contiene un lap_score inválido.")
        required = (
            "lane_id",
            "lap_score",
            "observation_quality",
            "evaluable",
            "window_start_ms",
            "window_end_ms",
            "score_version",
            "evidence",
        )
        if any(key not in score for key in required):
            raise RemoteDetectorError(
                "La respuesta IA contiene un lap_score incompleto."
            )
        evidence = score["evidence"]
        evidence_fields = ("wall", "approach", "reversal", "departure", "track_quality")
        if not isinstance(evidence, dict) or any(
            key not in evidence for key in evidence_fields
        ):
            raise RemoteDetectorError(
                "La respuesta IA contiene evidencia de vuelta inválida."
            )
        if not isinstance(score["lane_id"], str) or not score["lane_id"]:
            raise RemoteDetectorError("La respuesta IA contiene un lane_id inválido.")
        if not isinstance(score["score_version"], str) or not score["score_version"]:
            raise RemoteDetectorError(
                "La respuesta IA contiene una versión de score inválida."
            )
        if not isinstance(score["evaluable"], bool):
            raise RemoteDetectorError(
                "La respuesta IA contiene un estado evaluable inválido."
            )

        def unit_value(value: Any, field: str) -> float:
            try:
                normalized = float(value)
            except (TypeError, ValueError) as exc:
                raise RemoteDetectorError(
                    f"La respuesta IA contiene {field} inválido."
                ) from exc
            if not 0.0 <= normalized <= 1.0:
                raise RemoteDetectorError(
                    f"La respuesta IA contiene {field} fuera de rango."
                )
            return normalized

        try:
            normalized = {
                "lane_id": score["lane_id"],
                "lap_score": unit_value(score["lap_score"], "lap_score"),
                "observation_quality": unit_value(
                    score["observation_quality"], "observation_quality"
                ),
                "evaluable": score["evaluable"],
                "window_start_ms": float(score["window_start_ms"]),
                "window_end_ms": float(score["window_end_ms"]),
                "score_version": score["score_version"],
                "evidence": {
                    field: unit_value(evidence[field], f"evidence.{field}")
                    for field in evidence_fields
                },
            }
            optional_unit_fields = ("no_lap_score", "longitudinal_position")
            for field in optional_unit_fields:
                if score.get(field) is not None:
                    normalized[field] = unit_value(score[field], field)
            if score.get("track_id") is not None:
                normalized["track_id"] = int(score["track_id"])
            if score.get("candidate_time_ms") is not None:
                normalized["candidate_time_ms"] = float(score["candidate_time_ms"])
        except (TypeError, ValueError) as exc:
            raise RemoteDetectorError(
                "La respuesta IA contiene valores de lap_score inválidos."
            ) from exc
        endpoint = score.get("endpoint")
        if endpoint is not None:
            if endpoint not in {"far", "near"}:
                raise RemoteDetectorError(
                    "La respuesta IA contiene un endpoint inválido."
                )
            normalized["endpoint"] = endpoint
        return normalized

    @classmethod
    def _normalize_tracking_diagnostics(cls, diagnostics: Any) -> dict[str, Any]:
        if not isinstance(diagnostics, dict):
            raise RemoteDetectorError(
                "La respuesta IA contiene tracking_diagnostics inválidos."
            )
        required = (
            "diagnostic_floor",
            "person_candidates",
            "detector_accepted",
            "lanes",
        )
        if any(field not in diagnostics for field in required):
            raise RemoteDetectorError(
                "La respuesta IA contiene tracking_diagnostics incompletos."
            )

        try:
            diagnostic_floor = float(diagnostics["diagnostic_floor"])
        except (TypeError, ValueError) as exc:
            raise RemoteDetectorError(
                "La respuesta IA contiene diagnostic_floor inválido."
            ) from exc
        if not math.isfinite(diagnostic_floor) or not 0.0 <= diagnostic_floor <= 1.0:
            raise RemoteDetectorError(
                "La respuesta IA contiene diagnostic_floor fuera de rango."
            )

        lanes = diagnostics["lanes"]
        if not isinstance(lanes, list):
            raise RemoteDetectorError(
                "La respuesta IA contiene lanes de diagnostics inválidos."
            )

        return {
            "diagnostic_floor": diagnostic_floor,
            "person_candidates": cls._normalize_diagnostic_group(
                diagnostics["person_candidates"], "person_candidates"
            ),
            "detector_accepted": cls._normalize_diagnostic_group(
                diagnostics["detector_accepted"], "detector_accepted"
            ),
            "lanes": [cls._normalize_lane_diagnostics(lane) for lane in lanes],
        }

    @classmethod
    def _normalize_lane_diagnostics(cls, lane: Any) -> dict[str, Any]:
        if not isinstance(lane, dict):
            raise RemoteDetectorError(
                "La respuesta IA contiene diagnostics de carril inválidos."
            )
        required = (
            "lane_id",
            "after_roi",
            "active_track_ids",
            "retained_lost_track_count",
        )
        if any(field not in lane for field in required):
            raise RemoteDetectorError(
                "La respuesta IA contiene diagnostics de carril incompletos."
            )
        if not isinstance(lane["lane_id"], str) or not lane["lane_id"]:
            raise RemoteDetectorError(
                "La respuesta IA contiene un lane_id de diagnostics inválido."
            )

        active_track_ids = lane["active_track_ids"]
        if not isinstance(active_track_ids, list) or any(
            not cls._is_integer(track_id) for track_id in active_track_ids
        ):
            raise RemoteDetectorError(
                "La respuesta IA contiene active_track_ids inválidos."
            )
        retained_lost_track_count = lane["retained_lost_track_count"]
        if (
            not cls._is_integer(retained_lost_track_count)
            or retained_lost_track_count < 0
        ):
            raise RemoteDetectorError(
                "La respuesta IA contiene retained_lost_track_count inválido."
            )

        return {
            "lane_id": lane["lane_id"],
            "after_roi": cls._normalize_diagnostic_group(
                lane["after_roi"], "after_roi"
            ),
            "active_track_ids": [int(track_id) for track_id in active_track_ids],
            "retained_lost_track_count": int(retained_lost_track_count),
        }

    @classmethod
    def _normalize_diagnostic_group(cls, group: Any, field: str) -> dict[str, Any]:
        if not isinstance(group, dict) or "count" not in group:
            raise RemoteDetectorError(
                f"La respuesta IA contiene {field} de diagnostics inválido."
            )
        count = group["count"]
        if not cls._is_integer(count) or count < 0:
            raise RemoteDetectorError(
                f"La respuesta IA contiene count de {field} inválido."
            )

        normalized: dict[str, Any] = {"count": int(count)}
        boxes = group.get("boxes")
        if boxes is not None:
            if not isinstance(boxes, list):
                raise RemoteDetectorError(
                    f"La respuesta IA contiene boxes de {field} inválidas."
                )
            normalized_boxes = [cls._normalize_diagnostic_box(box) for box in boxes]
            if len(normalized_boxes) != count:
                raise RemoteDetectorError(
                    f"La respuesta IA contiene count y boxes inconsistentes en {field}."
                )
            normalized["boxes"] = normalized_boxes
        return normalized

    @staticmethod
    def _normalize_diagnostic_box(box: Any) -> dict[str, float]:
        if not isinstance(box, dict):
            raise RemoteDetectorError(
                "La respuesta IA contiene una diagnostic bbox inválida."
            )
        required = ("x1", "y1", "x2", "y2", "conf")
        if any(field not in box for field in required):
            raise RemoteDetectorError(
                "La respuesta IA contiene una diagnostic bbox incompleta."
            )
        try:
            normalized = {field: float(box[field]) for field in required}
        except (TypeError, ValueError) as exc:
            raise RemoteDetectorError(
                "La respuesta IA contiene valores de diagnostic bbox inválidos."
            ) from exc
        if any(not math.isfinite(value) for value in normalized.values()):
            raise RemoteDetectorError(
                "La respuesta IA contiene valores de diagnostic bbox inválidos."
            )
        if not 0.0 <= normalized["conf"] <= 1.0:
            raise RemoteDetectorError(
                "La respuesta IA contiene conf de diagnostic bbox fuera de rango."
            )
        return normalized

    @staticmethod
    def _is_integer(value: Any) -> bool:
        return isinstance(value, int) and not isinstance(value, bool)

    def _close_session(self, client: httpx.Client, session_id: str) -> None:
        """Cierre best-effort; el TTL remoto cubre una caída total de red."""
        for attempt in range(self.max_retries + 1):
            try:
                response = client.delete(
                    f"{self.base_url}/v1/tracking-sessions/{session_id}",
                    timeout=self.cleanup_timeout,
                )
            except httpx.HTTPError:
                if attempt < self.max_retries:
                    self._wait_before_retry(attempt)
                    continue
                return

            if response.status_code in {204, 404}:
                return
            if (
                response.status_code in _RETRYABLE_STATUS_CODES
                and attempt < self.max_retries
            ):
                self._wait_before_retry(attempt)
                continue
            return

    def _wait_before_retry(self, attempt: int) -> None:
        delay = self.retry_backoff_seconds * (2**attempt)
        if delay > 0:
            self._sleep(delay)

    @staticmethod
    def _response_json(response: httpx.Response) -> dict[str, Any]:
        try:
            payload = response.json()
        except ValueError as exc:
            raise RemoteDetectorError("El servicio IA devolvió JSON inválido.") from exc
        if not isinstance(payload, dict):
            raise RemoteDetectorError("El servicio IA devolvió una respuesta inválida.")
        return payload

    @classmethod
    def _ensure_success(cls, response: httpx.Response, *, expected_status: int) -> None:
        if response.status_code == expected_status:
            return
        detail = ""
        try:
            payload = response.json()
            if isinstance(payload, dict):
                error = payload.get("error")
                if isinstance(error, dict):
                    detail = str(error.get("detail") or error.get("code") or "")
                else:
                    detail = str(payload.get("detail") or error or "")
        except ValueError:
            pass
        suffix = f": {detail}" if detail else ""
        raise RemoteDetectorError(
            f"El servicio IA respondió HTTP {response.status_code}{suffix}"
        )
