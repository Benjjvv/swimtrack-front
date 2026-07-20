"""Adaptador del front Flask hacia el servicio remoto de visión.

El navegador continúa subiendo un video completo a ``POST /api/detect``. Según
``VISION_TRANSPORT``, este módulo envía batches JPEG preparados localmente o el
archivo original al decoder de la GPU. El contrato público de ``stream()``
sigue siendo el que consume el generador SSE del front.
"""

from __future__ import annotations

import json
import logging
import math
import mimetypes
import queue
import threading
import time
import uuid
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import cv2
import httpx


_RETRYABLE_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}
_LOGGER = logging.getLogger(__name__)


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


@dataclass(frozen=True)
class _StreamInfo:
    """Metadata del video disponible antes de iniciar el transporte remoto."""

    source_fps: float
    tracking_fps: float
    sample_stride: int


@dataclass(frozen=True)
class _PreparedBatch:
    """Un batch JPEG preparado por el productor local, aún no enviado."""

    frames: tuple[_EncodedFrame, ...]


@dataclass(frozen=True)
class _PreparationComplete:
    """Marca ordenada que cierra la cola de batches preparados."""

    source_frame_count: int


@dataclass(frozen=True)
class _PreparationFailure:
    """Error de decode/encode enviado al consumidor en vez de un thread traceback."""

    error: RemoteDetectorError


@dataclass
class _PreparationTimings:
    """Acumuladores locales del productor, expresados en milisegundos."""

    decode_ms: float = 0.0
    select_ms: float = 0.0
    resize_ms: float = 0.0
    jpeg_encode_ms: float = 0.0
    queue_wait_ms: float = 0.0
    jpeg_bytes: int = 0
    source_frames: int = 0
    selected_frames: int = 0
    batches: int = 0


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
        transport: Literal["frames", "video"] = "frames",
        batch_size: int = 4,
        prepared_batch_queue_size: int = 2,
        max_fps: float = 30.0,
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
        logger: logging.Logger | None = None,
    ) -> None:
        if not base_url.strip():
            raise ValueError("VISION_BASE_URL no puede estar vacío.")
        if batch_size < 1:
            raise ValueError("VISION_BATCH_SIZE debe ser al menos 1.")
        if prepared_batch_queue_size < 1:
            raise ValueError("VISION_PREPARED_BATCH_QUEUE_SIZE debe ser al menos 1.")
        if not math.isfinite(max_fps) or max_fps <= 0:
            raise ValueError("VISION_MAX_FPS debe ser mayor que cero.")
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
        if not isinstance(transport, str):
            raise ValueError("VISION_TRANSPORT debe ser frames o video.")
        transport = transport.strip().lower()
        if transport not in {"frames", "video"}:
            raise ValueError("VISION_TRANSPORT debe ser frames o video.")

        self.base_url = base_url.rstrip("/")
        self.auth_token = auth_token
        self.lap_calibration_id = (
            lap_calibration_id.strip() if lap_calibration_id else None
        )
        self.tracking_diagnostics = tracking_diagnostics
        self.transport = transport
        self.batch_size = batch_size
        self.prepared_batch_queue_size = prepared_batch_queue_size
        self.max_fps = max_fps
        self.inference_size = inference_size
        self.jpeg_quality = jpeg_quality
        self.max_retries = max_retries
        self.retry_backoff_seconds = retry_backoff_seconds
        self.fallback_fps = fallback_fps
        self.cleanup_timeout = cleanup_timeout
        self._client_factory = client_factory or httpx.Client
        self._sleep = sleep
        self._uuid_factory = uuid_factory
        self._logger = logger or _LOGGER
        self._timeout = httpx.Timeout(
            read_timeout,
            connect=connect_timeout,
            read=read_timeout,
            write=write_timeout,
            pool=pool_timeout,
        )

    @classmethod
    def from_flask_config(
        cls, config: dict[str, Any], *, logger: logging.Logger | None = None
    ) -> "RemoteSwimmerDetector":
        """Construye el adaptador desde ``app.config``."""
        return cls(
            base_url=config["VISION_BASE_URL"],
            auth_token=config.get("VISION_AUTH_TOKEN", ""),
            lap_calibration_id=config.get("VISION_LAP_CALIBRATION_ID"),
            tracking_diagnostics=config.get("VISION_TRACKING_DIAGNOSTICS", "none"),
            transport=config.get("VISION_TRANSPORT", "frames"),
            batch_size=int(config["VISION_BATCH_SIZE"]),
            prepared_batch_queue_size=int(
                config.get("VISION_PREPARED_BATCH_QUEUE_SIZE", 2)
            ),
            max_fps=float(config["VISION_MAX_FPS"]),
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
            logger=logger,
        )

    def stream(self, video_path: str) -> Iterator[dict[str, Any]]:
        """Emite resultados ordenados usando el transporte configurado.

        ``frames`` conserva el transporte JPEG idempotente actual. ``video``
        evita decodificar el archivo en el Front: sólo inspecciona su FPS y lo
        retransmite una vez al servicio que decodifica en la GPU.
        """
        if self.transport == "video":
            yield from self._stream_video(video_path)
            return
        yield from self._stream_frames(video_path)

    def _stream_frames(self, video_path: str) -> Iterator[dict[str, Any]]:
        """Emite resultados ordenados mientras prepara el siguiente batch.

        El productor solo lee, muestrea y codifica JPEG. El consumidor (este
        generador) conserva un único request HTTP en vuelo, por lo que ByteTrack
        recibe exactamente la misma secuencia temporal que antes. La cola tiene
        un límite estricto para no acumular video comprimido si la GPU se atrasa.
        """
        info_queue: queue.Queue[_StreamInfo | _PreparationFailure] = queue.Queue(
            maxsize=1
        )
        prepared_queue: queue.Queue[
            _PreparedBatch | _PreparationComplete | _PreparationFailure
        ] = queue.Queue(maxsize=self.prepared_batch_queue_size)
        stop_event = threading.Event()
        preparer = threading.Thread(
            target=self._prepare_video,
            args=(video_path, info_queue, prepared_queue, stop_event),
            name="swimtrack-frame-preparer",
            daemon=True,
        )
        client: httpx.Client | None = None
        session_id: str | None = None
        sequence = 0

        preparer.start()
        try:
            info_message = self._next_preparation_message(info_queue, preparer)
            if isinstance(info_message, _PreparationFailure):
                raise info_message.error
            if not isinstance(info_message, _StreamInfo):  # defensa de contrato
                raise RemoteDetectorError(
                    "El preparador de video respondió inválidamente."
                )

            client = self._client_factory(
                headers={"X-Swimtrack-Auth": self.auth_token},
                timeout=self._timeout,
            )
            session_started = time.perf_counter()
            session_id = self._create_session(client, info_message.tracking_fps)
            self._logger.info(
                "vision_session_timing source_fps=%.3f sampled_fps=%.3f stride=%d "
                "create_ms=%.1f",
                info_message.source_fps,
                info_message.tracking_fps,
                info_message.sample_stride,
                (time.perf_counter() - session_started) * 1000.0,
            )

            while True:
                prepared_message = self._next_preparation_message(
                    prepared_queue, preparer
                )
                if isinstance(prepared_message, _PreparationFailure):
                    raise prepared_message.error
                if isinstance(prepared_message, _PreparationComplete):
                    if prepared_message.source_frame_count == 0:
                        raise RemoteDetectorError(
                            "El video subido no contiene frames decodificables."
                        )
                    break
                if not isinstance(prepared_message, _PreparedBatch):
                    raise RemoteDetectorError(
                        "El preparador de video respondió con un batch inválido."
                    )

                # Solo este consumidor toca ``client``. No hay dos requests de
                # la misma sesión en paralelo y las secuencias siguen siendo 0,1,2…
                results, sequence = self._send_batch(
                    client,
                    session_id,
                    sequence,
                    prepared_message.frames,
                )
                yield from results
        finally:
            self._stop_preparer(preparer, stop_event)
            if client is not None and session_id is not None:
                self._close_session(client, session_id)
            if client is not None:
                client.close()

    def _stream_video(self, video_path: str) -> Iterator[dict[str, Any]]:
        """Reenvía un video original y normaliza su NDJSON de resultados.

        Esta ruta no hace ``capture.read()``: el Front sólo obtiene FPS para
        mantener el sampling histórico de ByteTrack. El upload de streaming no
        se reintenta, porque el endpoint avanza estado de tracking y no tiene
        un ``batch_id`` idempotente equivalente al transporte JPEG.
        """
        stream_info = self._read_video_stream_info(video_path)
        client: httpx.Client | None = None
        session_id: str | None = None
        try:
            client = self._client_factory(
                headers={"X-Swimtrack-Auth": self.auth_token},
                timeout=self._timeout,
            )
            session_started = time.perf_counter()
            session_id = self._create_session(client, stream_info.tracking_fps)
            self._logger.info(
                "vision_session_timing transport=video source_fps=%.3f "
                "sampled_fps=%.3f stride=%d create_ms=%.1f",
                stream_info.source_fps,
                stream_info.tracking_fps,
                stream_info.sample_stride,
                (time.perf_counter() - session_started) * 1000.0,
            )
            yield from self._upload_video_stream(
                client,
                session_id,
                video_path,
                stream_info,
            )
        finally:
            if client is not None and session_id is not None:
                self._close_session(client, session_id)
            if client is not None:
                client.close()

    def _read_video_stream_info(self, video_path: str) -> _StreamInfo:
        """Obtiene únicamente FPS local; el decode completo queda en la GPU."""
        capture: Any | None = None
        try:
            capture = cv2.VideoCapture(video_path)
            if not capture.isOpened():
                raise RemoteDetectorError("No se pudo abrir el video subido.")
            fps = float(capture.get(cv2.CAP_PROP_FPS))
        except RemoteDetectorError:
            raise
        except Exception as exc:  # noqa: BLE001 - normaliza errores del backend OpenCV
            raise RemoteDetectorError(
                "No se pudo inspeccionar el video subido."
            ) from exc
        finally:
            if capture is not None:
                capture.release()

        if not math.isfinite(fps) or fps <= 0:
            fps = self.fallback_fps
        sample_stride = max(1, math.ceil(fps / self.max_fps))
        stream_info = _StreamInfo(
            source_fps=fps,
            tracking_fps=fps / sample_stride,
            sample_stride=sample_stride,
        )
        self._logger.info(
            "vision_video_metadata source_fps=%.3f sampled_fps=%.3f stride=%d",
            stream_info.source_fps,
            stream_info.tracking_fps,
            stream_info.sample_stride,
        )
        return stream_info

    def _upload_video_stream(
        self,
        client: httpx.Client,
        session_id: str,
        video_path: str,
        stream_info: _StreamInfo,
    ) -> Iterator[dict[str, Any]]:
        """Envía una vez el archivo y consume un ``FrameResult`` NDJSON por línea."""
        upload_started = time.perf_counter()
        first_frame_at: float | None = None
        previous_frame_index: int | None = None
        previous_time_ms: float | None = None
        emitted_frames = 0
        completed = False
        path = Path(video_path)
        suffix = path.suffix.lower() or ".mp4"
        filename = f"upload{suffix}"
        media_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        try:
            with path.open("rb") as video_file:
                with client.stream(
                    "POST",
                    f"{self.base_url}/v1/tracking-sessions/{session_id}/video",
                    data={"sample_fps": str(stream_info.tracking_fps)},
                    files={"video": (filename, video_file, media_type)},
                    headers={"Accept": "application/x-ndjson"},
                ) as response:
                    if response.status_code != 200:
                        # En HTTPX streaming, el body aún no se ha leído y
                        # ``response.json()`` no estaría disponible sin esto.
                        response.read()
                        self._ensure_success(response, expected_status=200)
                    content_type = response.headers.get("content-type", "")
                    content_type = content_type.split(";", 1)[0].strip().lower()
                    if content_type != "application/x-ndjson":
                        raise RemoteDetectorError(
                            "El servicio IA no devolvió application/x-ndjson."
                        )
                    for line in response.iter_lines():
                        if not line:
                            continue
                        if isinstance(line, bytes):
                            try:
                                line = line.decode("utf-8")
                            except UnicodeDecodeError as exc:
                                raise RemoteDetectorError(
                                    "El servicio IA devolvió NDJSON inválido."
                                ) from exc
                        try:
                            payload = json.loads(line)
                        except (TypeError, ValueError) as exc:
                            raise RemoteDetectorError(
                                "El servicio IA devolvió NDJSON inválido."
                            ) from exc
                        frame, previous_frame_index, previous_time_ms = (
                            self._normalize_video_stream_frame(
                                payload,
                                previous_frame_index=previous_frame_index,
                                previous_time_ms=previous_time_ms,
                            )
                        )
                        emitted_frames += 1
                        if first_frame_at is None:
                            first_frame_at = time.perf_counter()
                        yield frame
            if emitted_frames == 0:
                raise RemoteDetectorError(
                    "El servicio IA no emitió frames para el video subido."
                )
            completed = True
        except OSError as exc:
            raise RemoteDetectorError("No se pudo leer el video subido.") from exc
        except httpx.HTTPError as exc:
            raise RemoteDetectorError(
                "No se pudo conectar con el servicio de detección."
            ) from exc
        finally:
            finished_at = time.perf_counter()
            first_frame_ms = (
                "unavailable"
                if first_frame_at is None
                else f"{(first_frame_at - upload_started) * 1000.0:.1f}"
            )
            self._logger.info(
                "vision_video_upload_timing source_fps=%.3f sampled_fps=%.3f "
                "stride=%d frames=%d first_frame_ms=%s elapsed_ms=%.1f completed=%s",
                stream_info.source_fps,
                stream_info.tracking_fps,
                stream_info.sample_stride,
                emitted_frames,
                first_frame_ms,
                (finished_at - upload_started) * 1000.0,
                str(completed).lower(),
            )

    def _normalize_video_stream_frame(
        self,
        payload: Any,
        *,
        previous_frame_index: int | None,
        previous_time_ms: float | None,
    ) -> tuple[dict[str, Any], int, float]:
        """Valida el contrato NDJSON y lo convierte al FrameResult del BFF."""
        if not isinstance(payload, dict):
            raise RemoteDetectorError("El servicio IA devolvió un frame inválido.")
        frame_index = payload.get("frame_index")
        width = payload.get("width")
        height = payload.get("height")
        time_ms = payload.get("time_ms")
        if not self._is_integer(frame_index) or frame_index < 0:
            raise RemoteDetectorError("El servicio IA devolvió frame_index inválido.")
        if not self._is_integer(width) or width < 1:
            raise RemoteDetectorError("El servicio IA devolvió width inválido.")
        if not self._is_integer(height) or height < 1:
            raise RemoteDetectorError("El servicio IA devolvió height inválido.")
        if isinstance(time_ms, bool):
            raise RemoteDetectorError("El servicio IA devolvió time_ms inválido.")
        try:
            normalized_time_ms = float(time_ms)
        except (TypeError, ValueError) as exc:
            raise RemoteDetectorError(
                "El servicio IA devolvió time_ms inválido."
            ) from exc
        if not math.isfinite(normalized_time_ms) or normalized_time_ms < 0:
            raise RemoteDetectorError("El servicio IA devolvió time_ms inválido.")
        if previous_frame_index is not None and frame_index <= previous_frame_index:
            raise RemoteDetectorError("El servicio IA alteró el orden de los frames.")
        if previous_time_ms is not None and normalized_time_ms < previous_time_ms:
            raise RemoteDetectorError("El servicio IA alteró el orden temporal.")

        boxes = payload.get("boxes")
        if not isinstance(boxes, list):
            raise RemoteDetectorError("El servicio IA contiene boxes inválidas.")
        normalized_frame: dict[str, Any] = {
            "time": normalized_time_ms / 1000.0,
            "width": int(width),
            "height": int(height),
            "boxes": [self._normalize_box(box) for box in boxes],
        }
        identity_summary = payload.get("identity_summary")
        if identity_summary is not None:
            normalized_frame["identity_summary"] = self._normalize_identity_summary(
                identity_summary
            )
        lap_scores = payload.get("lap_scores")
        if lap_scores is not None:
            if not isinstance(lap_scores, list):
                raise RemoteDetectorError(
                    "El servicio IA contiene lap_scores inválidos."
                )
            normalized_frame["lap_scores"] = [
                self._normalize_lap_score(score) for score in lap_scores
            ]
        tracking_diagnostics = payload.get("tracking_diagnostics")
        if tracking_diagnostics is not None:
            normalized_frame["tracking_diagnostics"] = (
                self._normalize_tracking_diagnostics(tracking_diagnostics)
            )
        return normalized_frame, frame_index, normalized_time_ms

    def _prepare_video(
        self,
        video_path: str,
        info_queue: queue.Queue[_StreamInfo | _PreparationFailure],
        prepared_queue: queue.Queue[
            _PreparedBatch | _PreparationComplete | _PreparationFailure
        ],
        stop_event: threading.Event,
    ) -> None:
        """Produce batches JPEG ordenados sin bloquear al request en curso."""
        capture: Any | None = None
        info_sent = False
        timings = _PreparationTimings()
        preparation_started = time.perf_counter()
        completed = False
        try:
            capture = cv2.VideoCapture(video_path)
            if not capture.isOpened():
                raise RemoteDetectorError("No se pudo abrir el video subido.")

            fps = float(capture.get(cv2.CAP_PROP_FPS))
            if not math.isfinite(fps) or fps <= 0:
                fps = self.fallback_fps
            sample_stride = max(1, math.ceil(fps / self.max_fps))
            tracking_fps = fps / sample_stride
            stream_info = _StreamInfo(
                source_fps=fps,
                tracking_fps=tracking_fps,
                sample_stride=sample_stride,
            )
            self._logger.info(
                "vision_stream_sampling source_fps=%.3f sampled_fps=%.3f stride=%d "
                "prepared_batch_queue_size=%d",
                fps,
                tracking_fps,
                sample_stride,
                self.prepared_batch_queue_size,
            )
            if not self._put_preparation_message(info_queue, stream_info, stop_event):
                return
            info_sent = True

            pending: list[_EncodedFrame] = []
            batch_timings = _PreparationTimings()
            source_frame_count = 0
            batch_index = 0

            while not stop_event.is_set():
                decode_started = time.perf_counter()
                ok, frame = capture.read()
                decode_ms = (time.perf_counter() - decode_started) * 1000.0
                timings.decode_ms += decode_ms
                batch_timings.decode_ms += decode_ms
                if not ok:
                    break

                frame_index = source_frame_count
                source_frame_count += 1
                timings.source_frames += 1
                batch_timings.source_frames += 1

                select_started = time.perf_counter()
                selected = frame_index % sample_stride == 0
                select_ms = (time.perf_counter() - select_started) * 1000.0
                timings.select_ms += select_ms
                batch_timings.select_ms += select_ms
                if not selected:
                    continue

                encoded, resize_ms, jpeg_encode_ms = self._encode_frame(
                    frame, frame_index, fps
                )
                timings.selected_frames += 1
                batch_timings.selected_frames += 1
                timings.resize_ms += resize_ms
                batch_timings.resize_ms += resize_ms
                timings.jpeg_encode_ms += jpeg_encode_ms
                batch_timings.jpeg_encode_ms += jpeg_encode_ms
                timings.jpeg_bytes += len(encoded.jpeg)
                batch_timings.jpeg_bytes += len(encoded.jpeg)
                pending.append(encoded)

                if len(pending) == self.batch_size:
                    if not self._enqueue_prepared_batch(
                        prepared_queue,
                        _PreparedBatch(frames=tuple(pending)),
                        stop_event,
                        batch_index,
                        batch_timings,
                        timings,
                    ):
                        return
                    batch_index += 1
                    pending = []
                    batch_timings = _PreparationTimings()

            if pending and not stop_event.is_set():
                if not self._enqueue_prepared_batch(
                    prepared_queue,
                    _PreparedBatch(frames=tuple(pending)),
                    stop_event,
                    batch_index,
                    batch_timings,
                    timings,
                ):
                    return

            if not stop_event.is_set():
                completed = self._put_preparation_message(
                    prepared_queue,
                    _PreparationComplete(source_frame_count=source_frame_count),
                    stop_event,
                )
        except Exception as exc:  # noqa: BLE001 - el error cruza el límite del thread
            error = (
                exc
                if isinstance(exc, RemoteDetectorError)
                else RemoteDetectorError("No se pudo preparar el video subido.")
            )
            self._logger.warning(
                "vision_prepare_failed error_type=%s", type(exc).__name__
            )
            target_queue: queue.Queue[Any] = prepared_queue if info_sent else info_queue
            self._put_preparation_message(
                target_queue, _PreparationFailure(error=error), stop_event
            )
        finally:
            if capture is not None:
                capture.release()
            self._logger.info(
                "vision_prepare_timing source_frames=%d selected_frames=%d batches=%d "
                "decode_ms=%.1f select_ms=%.1f resize_ms=%.1f jpeg_encode_ms=%.1f "
                "jpeg_bytes=%d queue_wait_ms=%.1f elapsed_ms=%.1f completed=%s",
                timings.source_frames,
                timings.selected_frames,
                timings.batches,
                timings.decode_ms,
                timings.select_ms,
                timings.resize_ms,
                timings.jpeg_encode_ms,
                timings.jpeg_bytes,
                timings.queue_wait_ms,
                (time.perf_counter() - preparation_started) * 1000.0,
                str(completed).lower(),
            )

    def _enqueue_prepared_batch(
        self,
        prepared_queue: queue.Queue[
            _PreparedBatch | _PreparationComplete | _PreparationFailure
        ],
        batch: _PreparedBatch,
        stop_event: threading.Event,
        batch_index: int,
        batch_timings: _PreparationTimings,
        total_timings: _PreparationTimings,
    ) -> bool:
        queue_started = time.perf_counter()
        queued = self._put_preparation_message(prepared_queue, batch, stop_event)
        queue_wait_ms = (time.perf_counter() - queue_started) * 1000.0
        batch_timings.queue_wait_ms += queue_wait_ms
        total_timings.queue_wait_ms += queue_wait_ms
        if not queued:
            return False

        batch_timings.batches = 1
        total_timings.batches += 1
        frames = batch.frames
        self._logger.info(
            "vision_prepare_batch_timing batch_index=%d frames=%d frame_range=%d-%d "
            "source_frames=%d decode_ms=%.1f select_ms=%.1f resize_ms=%.1f "
            "jpeg_encode_ms=%.1f jpeg_bytes=%d queue_wait_ms=%.1f",
            batch_index,
            len(frames),
            frames[0].frame_index,
            frames[-1].frame_index,
            batch_timings.source_frames,
            batch_timings.decode_ms,
            batch_timings.select_ms,
            batch_timings.resize_ms,
            batch_timings.jpeg_encode_ms,
            batch_timings.jpeg_bytes,
            batch_timings.queue_wait_ms,
        )
        return True

    @staticmethod
    def _put_preparation_message(
        message_queue: queue.Queue[Any],
        message: Any,
        stop_event: threading.Event,
    ) -> bool:
        """Hace el put cancelable para que un cliente desconectado no deje hilos."""
        while not stop_event.is_set():
            try:
                message_queue.put(message, timeout=0.1)
                return True
            except queue.Full:
                continue
        return False

    @staticmethod
    def _next_preparation_message(
        message_queue: queue.Queue[Any], preparer: threading.Thread
    ) -> Any:
        while True:
            try:
                return message_queue.get(timeout=0.1)
            except queue.Empty:
                if not preparer.is_alive():
                    raise RemoteDetectorError(
                        "La preparación del video terminó inesperadamente."
                    )

    def _stop_preparer(
        self, preparer: threading.Thread, stop_event: threading.Event
    ) -> None:
        stop_event.set()
        preparer.join(timeout=self.cleanup_timeout)
        if preparer.is_alive():
            self._logger.warning(
                "vision_prepare_shutdown_timeout timeout_seconds=%.1f",
                self.cleanup_timeout,
            )

    def _encode_frame(
        self, frame: Any, frame_index: int, fps: float
    ) -> tuple[_EncodedFrame, float, float]:
        height, width = frame.shape[:2]
        resize_started = time.perf_counter()
        resized = cv2.resize(
            frame,
            (self.inference_size, self.inference_size),
            interpolation=cv2.INTER_LINEAR,
        )
        resize_ms = (time.perf_counter() - resize_started) * 1000.0
        jpeg_started = time.perf_counter()
        ok, encoded = cv2.imencode(
            ".jpg",
            resized,
            [cv2.IMWRITE_JPEG_QUALITY, self.jpeg_quality],
        )
        jpeg_encode_ms = (time.perf_counter() - jpeg_started) * 1000.0
        if not ok:
            raise RemoteDetectorError(f"No se pudo codificar el frame {frame_index}.")
        return (
            _EncodedFrame(
                frame_index=frame_index,
                time_ms=frame_index * 1000.0 / fps,
                original_width=int(width),
                original_height=int(height),
                jpeg=encoded.tobytes(),
            ),
            resize_ms,
            jpeg_encode_ms,
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
        batch_started = time.perf_counter()
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
        request_transport_ms = 0.0
        retry_backoff_ms = 0.0
        for attempt in range(self.max_retries + 1):
            request_started = time.perf_counter()
            try:
                response = client.post(
                    f"{self.base_url}/v1/tracking-sessions/{session_id}/batches",
                    data={"metadata": metadata_json},
                    files=files,
                )
                last_transport_error = None
            except httpx.HTTPError as exc:
                request_transport_ms += (time.perf_counter() - request_started) * 1000.0
                last_transport_error = exc
                if attempt == self.max_retries:
                    break
                backoff_started = time.perf_counter()
                self._wait_before_retry(attempt)
                retry_backoff_ms += (time.perf_counter() - backoff_started) * 1000.0
                continue
            request_transport_ms += (time.perf_counter() - request_started) * 1000.0

            if (
                response.status_code in _RETRYABLE_STATUS_CODES
                and attempt < self.max_retries
            ):
                backoff_started = time.perf_counter()
                self._wait_before_retry(attempt)
                retry_backoff_ms += (time.perf_counter() - backoff_started) * 1000.0
                continue
            break

        if last_transport_error is not None:
            raise RemoteDetectorError(
                f"Falló el envío del batch {batch_id} al servicio IA."
            ) from last_transport_error
        if response is None:  # defensa; el loop siempre asigna respuesta o error
            raise RemoteDetectorError(f"El batch {batch_id} no obtuvo respuesta.")

        self._ensure_success(response, expected_status=200)
        self._log_batch_timing(
            response=response,
            sequence=sequence,
            frames=frames,
            attempts=attempt + 1,
            roundtrip_ms=(time.perf_counter() - batch_started) * 1000.0,
            request_transport_ms=request_transport_ms,
            retry_backoff_ms=retry_backoff_ms,
        )
        payload = self._response_json(response)
        results = self._validate_batch_response(
            payload,
            session_id=session_id,
            batch_id=batch_id,
            sequence=sequence,
            frames=frames,
        )
        return results, sequence + 1

    @staticmethod
    def _response_timing(response: httpx.Response, header: str) -> float | None:
        value = response.headers.get(header)
        if value is None:
            return None
        try:
            timing = float(value)
        except (TypeError, ValueError):
            return None
        if not math.isfinite(timing) or timing < 0:
            return None
        return timing

    def _log_batch_timing(
        self,
        *,
        response: httpx.Response,
        sequence: int,
        frames: Sequence[_EncodedFrame],
        attempts: int,
        roundtrip_ms: float,
        request_transport_ms: float,
        retry_backoff_ms: float,
    ) -> None:
        def metric(header: str) -> str:
            value = self._response_timing(response, header)
            return "unavailable" if value is None else f"{value:.1f}"

        self._logger.info(
            "vision_batch_timing sequence=%d frames=%d frame_range=%d-%d attempts=%d "
            "roundtrip_ms=%.1f request_transport_ms=%.1f retry_backoff_ms=%.1f "
            "ai_decode_ms=%s ai_process_ms=%s ai_total_ms=%s",
            sequence,
            len(frames),
            frames[0].frame_index,
            frames[-1].frame_index,
            attempts,
            roundtrip_ms,
            request_transport_ms,
            retry_backoff_ms,
            metric("X-Swimtrack-Decode-Ms"),
            metric("X-Swimtrack-Process-Ms"),
            metric("X-Swimtrack-Total-Ms"),
        )

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
            identity_summary = result.get("identity_summary")
            if identity_summary is not None:
                normalized_frame["identity_summary"] = self._normalize_identity_summary(
                    identity_summary
                )
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
    def _normalize_box(box: Any) -> dict[str, Any]:
        if not isinstance(box, dict):
            raise RemoteDetectorError("La respuesta IA contiene una bbox inválida.")
        required = ("id", "x1", "y1", "x2", "y2", "conf")
        if any(key not in box for key in required):
            raise RemoteDetectorError("La respuesta IA contiene una bbox incompleta.")
        try:
            normalized: dict[str, Any] = {
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
        lane_id = box.get("lane_id")
        if lane_id is not None:
            if not isinstance(lane_id, str) or not lane_id:
                raise RemoteDetectorError("La respuesta IA contiene un lane_id de bbox inválido.")
            normalized["lane_id"] = lane_id
        for field in ("track_id", "identity_id"):
            value = box.get(field)
            if value is None:
                continue
            if not RemoteSwimmerDetector._is_integer(value) or value < 1:
                raise RemoteDetectorError(
                    f"La respuesta IA contiene {field} de bbox inválido."
                )
            normalized[field] = int(value)
        return normalized

    @staticmethod
    def _normalize_identity_summary(summary: Any) -> dict[str, int]:
        if not isinstance(summary, dict):
            raise RemoteDetectorError("La respuesta IA contiene identity_summary inválido.")
        required = ("confirmed_count", "active_count")
        if any(field not in summary for field in required):
            raise RemoteDetectorError("La respuesta IA contiene identity_summary incompleto.")
        confirmed_count = summary["confirmed_count"]
        active_count = summary["active_count"]
        if (
            not RemoteSwimmerDetector._is_integer(confirmed_count)
            or confirmed_count < 0
            or not RemoteSwimmerDetector._is_integer(active_count)
            or active_count < 0
            or active_count > confirmed_count
        ):
            raise RemoteDetectorError("La respuesta IA contiene identity_summary inválido.")
        return {
            "confirmed_count": int(confirmed_count),
            "active_count": int(active_count),
        }

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
            if score.get("identity_id") is not None:
                raw_identity_id = score["identity_id"]
                if not RemoteSwimmerDetector._is_integer(raw_identity_id) or raw_identity_id < 1:
                    raise ValueError("identity_id must be a positive integer")
                normalized["identity_id"] = int(raw_identity_id)
            if score.get("candidate_time_ms") is not None:
                normalized["candidate_time_ms"] = float(score["candidate_time_ms"])
            if score.get("candidate_episode_id") is not None:
                raw_episode_id = score["candidate_episode_id"]
                if isinstance(raw_episode_id, bool):
                    raise ValueError("candidate_episode_id must be an integer")
                episode_id = int(raw_episode_id)
                if episode_id < 1 or episode_id != raw_episode_id:
                    raise ValueError("candidate_episode_id must be a positive integer")
                normalized["candidate_episode_id"] = episode_id
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
            "weak_candidates",
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
            "weak_candidates": cls._normalize_diagnostic_group(
                diagnostics["weak_candidates"], "weak_candidates"
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
            "weak_candidates_after_roi",
            "active_track_ids",
            "retained_lost_track_count",
            "weak_reactivated_track_ids",
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
        weak_reactivated_track_ids = lane["weak_reactivated_track_ids"]
        if not isinstance(weak_reactivated_track_ids, list) or any(
            not cls._is_integer(track_id) for track_id in weak_reactivated_track_ids
        ):
            raise RemoteDetectorError(
                "La respuesta IA contiene weak_reactivated_track_ids inválidos."
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
            "weak_candidates_after_roi": cls._normalize_diagnostic_group(
                lane["weak_candidates_after_roi"], "weak_candidates_after_roi"
            ),
            "active_track_ids": [int(track_id) for track_id in active_track_ids],
            "retained_lost_track_count": int(retained_lost_track_count),
            "weak_reactivated_track_ids": [
                int(track_id) for track_id in weak_reactivated_track_ids
            ],
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
