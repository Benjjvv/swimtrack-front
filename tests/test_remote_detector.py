import json
import logging
import threading
import uuid

import httpx
import numpy as np
import pytest

import remote_detector
from remote_detector import RemoteSwimmerDetector


class FakeCapture:
    def __init__(self, frames, fps=2.0):
        self.frames = list(frames)
        self.fps = fps
        self.released = False
        self.frames_depleted = threading.Event()
        self.read_calls = 0

    def isOpened(self):
        return True

    def get(self, prop):
        if prop == remote_detector.cv2.CAP_PROP_FPS:
            return self.fps
        return 0

    def read(self):
        self.read_calls += 1
        if not self.frames:
            return False, None
        frame = self.frames.pop(0)
        if not self.frames:
            self.frames_depleted.set()
        return True, frame

    def release(self):
        self.released = True


class FakeNDJSONResponse:
    def __init__(
        self,
        lines,
        *,
        status_code=200,
        headers=None,
        error_payload=None,
    ):
        self.status_code = status_code
        self.headers = headers or {"content-type": "application/x-ndjson"}
        self._lines = list(lines)
        self._error_payload = error_payload or {"detail": "video unavailable"}
        self.read_called = False

    def iter_lines(self):
        yield from self._lines

    def read(self):
        self.read_called = True
        return json.dumps(self._error_payload).encode("utf-8")

    def json(self):
        return self._error_payload


class FakeStreamContext:
    def __init__(self, response):
        self.response = response
        self.entered = False
        self.closed = False

    def __enter__(self):
        self.entered = True
        return self.response

    def __exit__(self, _exc_type, _exc_value, _traceback):
        self.closed = True
        return False


class FakeVisionClient:
    def __init__(
        self,
        *,
        transient_first_batch=False,
        include_lap_scores=False,
        tracking_diagnostics_payload=None,
        timing_headers=None,
        video_lines=None,
        video_status=200,
        video_headers=None,
        video_error_payload=None,
        **kwargs,
    ):
        self.kwargs = kwargs
        self.transient_first_batch = transient_first_batch
        self.include_lap_scores = include_lap_scores
        self.tracking_diagnostics_payload = tracking_diagnostics_payload
        self.timing_headers = timing_headers or {}
        self.video_lines = list(video_lines or [])
        self.video_status = video_status
        self.video_headers = video_headers
        self.video_error_payload = video_error_payload
        self.session_payloads = []
        self.batch_calls = []
        self.video_calls = []
        self.video_stream_contexts = []
        self.deleted = []
        self.closed = False

    def post(self, url, *, json=None, data=None, files=None):
        if url.endswith("/v1/tracking-sessions"):
            self.session_payloads.append(json)
            return httpx.Response(
                201,
                json={"session_id": "session-1", "next_sequence": 0},
            )

        metadata = data["metadata"]
        self.batch_calls.append(
            {
                "metadata": metadata,
                "files": [(name, file_tuple) for name, file_tuple in files],
            }
        )
        if self.transient_first_batch and len(self.batch_calls) == 1:
            return httpx.Response(503, json={"detail": "warming up"})

        request = __import__("json").loads(metadata)
        response_frames = []
        for frame in request["frames"]:
            response_frame = {
                "frame_index": frame["frame_index"],
                "time_ms": frame["time_ms"],
                "width": frame["original_width"],
                "height": frame["original_height"],
                "boxes": [
                    {
                        "id": 7,
                        "x1": 1,
                        "y1": 2,
                        "x2": 10,
                        "y2": 12,
                        "conf": 0.9,
                        "class_id": 0,
                    }
                ],
            }
            if self.include_lap_scores:
                response_frame["lap_scores"] = [
                    {
                        "lane_id": "center",
                        "track_id": 7,
                        "lap_score": 0.82,
                        "no_lap_score": 0.18,
                        "observation_quality": 0.93,
                        "evaluable": True,
                        "longitudinal_position": 0.91,
                        "endpoint": "near",
                        "candidate_time_ms": frame["time_ms"],
                        "candidate_episode_id": 1,
                        "window_start_ms": 0.0,
                        "window_end_ms": frame["time_ms"],
                        "score_version": "trajectory-v5",
                        "evidence": {
                            "wall": 0.96,
                            "approach": 0.84,
                            "reversal": 0.88,
                            "departure": 0.79,
                            "track_quality": 0.93,
                        },
                    }
                ]
            if self.tracking_diagnostics_payload is not None:
                response_frame["tracking_diagnostics"] = (
                    self.tracking_diagnostics_payload
                )
            response_frames.append(response_frame)
        return httpx.Response(
            200,
            headers=self.timing_headers,
            json={
                "session_id": "session-1",
                "batch_id": request["batch_id"],
                "sequence": request["sequence"],
                "next_sequence": request["sequence"] + 1,
                "frames": response_frames,
            },
        )

    def delete(self, url, *, timeout=None):
        self.deleted.append(url)
        assert timeout == 5.0
        return httpx.Response(204)

    def close(self):
        self.closed = True

    def stream(self, method, url, *, data=None, files=None, headers=None):
        video = files["video"]
        self.video_calls.append(
            {
                "method": method,
                "url": url,
                "data": data,
                "headers": headers,
                "filename": video[0],
                "bytes": video[1].read(),
                "media_type": video[2],
            }
        )
        context = FakeStreamContext(
            FakeNDJSONResponse(
                self.video_lines,
                status_code=self.video_status,
                headers=self.video_headers,
                error_payload=self.video_error_payload,
            )
        )
        self.video_stream_contexts.append(context)
        return context


class BlockingFakeVisionClient(FakeVisionClient):
    """Hace visible si el consumidor abre requests simultáneos en una sesión."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.first_batch_started = threading.Event()
        self.release_first_batch = threading.Event()
        self._batch_post_lock = threading.Lock()
        self._started_batch_count = 0
        self.active_batch_posts = 0
        self.max_active_batch_posts = 0

    def post(self, url, *, json=None, data=None, files=None):
        if url.endswith("/v1/tracking-sessions"):
            return super().post(url, json=json, data=data, files=files)

        with self._batch_post_lock:
            self._started_batch_count += 1
            batch_call_number = self._started_batch_count
            self.active_batch_posts += 1
            self.max_active_batch_posts = max(
                self.max_active_batch_posts, self.active_batch_posts
            )
        try:
            if batch_call_number == 1:
                self.first_batch_started.set()
                assert self.release_first_batch.wait(timeout=2)
            return super().post(url, json=json, data=data, files=files)
        finally:
            with self._batch_post_lock:
                self.active_batch_posts -= 1


def _build_detector(
    monkeypatch,
    *,
    transient_first_batch=False,
    lap_calibration_id=None,
    include_lap_scores=False,
    tracking_diagnostics="none",
    tracking_diagnostics_payload=None,
    timing_headers=None,
    block_first_batch=False,
    transport="frames",
    video_lines=None,
    video_status=200,
    video_headers=None,
    video_error_payload=None,
    frame_count=3,
    fps=2.0,
    max_fps=15.0,
    batch_size=2,
):
    frames = [np.zeros((20, 40, 3), dtype=np.uint8) for _ in range(frame_count)]
    capture = FakeCapture(frames, fps=fps)
    monkeypatch.setattr(remote_detector.cv2, "VideoCapture", lambda _path: capture)
    client_class = BlockingFakeVisionClient if block_first_batch else FakeVisionClient
    client = client_class(
        transient_first_batch=transient_first_batch,
        include_lap_scores=include_lap_scores,
        tracking_diagnostics_payload=tracking_diagnostics_payload,
        timing_headers=timing_headers,
        video_lines=video_lines,
        video_status=video_status,
        video_headers=video_headers,
        video_error_payload=video_error_payload,
    )
    batch_ids = iter(uuid.UUID(int=index) for index in range(1, 100))
    detector = RemoteSwimmerDetector(
        base_url="http://vision.test/",
        auth_token="secret",
        lap_calibration_id=lap_calibration_id,
        tracking_diagnostics=tracking_diagnostics,
        transport=transport,
        batch_size=batch_size,
        max_fps=max_fps,
        max_retries=2,
        retry_backoff_seconds=0,
        client_factory=lambda **_kwargs: client,
        uuid_factory=lambda: next(batch_ids),
    )
    return detector, capture, client


def test_stream_sends_sequential_batches_and_normalizes_results(monkeypatch):
    detector, capture, client = _build_detector(monkeypatch)

    results = list(detector.stream("video.mp4"))

    assert [frame["time"] for frame in results] == [0.0, 0.5, 1.0]
    assert [(frame["width"], frame["height"]) for frame in results] == [
        (40, 20),
        (40, 20),
        (40, 20),
    ]
    assert results[0]["boxes"] == [
        {
            "id": 7,
            "x1": 1.0,
            "y1": 2.0,
            "x2": 10.0,
            "y2": 12.0,
            "conf": 0.9,
        }
    ]
    assert client.session_payloads == [{"fps": 2.0}]
    assert len(client.batch_calls) == 2
    first = json.loads(client.batch_calls[0]["metadata"])
    second = json.loads(client.batch_calls[1]["metadata"])
    assert first["sequence"] == 0
    assert second["sequence"] == 1
    assert [item["frame_index"] for item in first["frames"]] == [0, 1]
    assert first["frames"][0]["original_width"] == 40
    assert first["frames"][0]["original_height"] == 20
    assert all(field == "frames" for field, _file in client.batch_calls[0]["files"])
    first_jpeg = client.batch_calls[0]["files"][0][1][1]
    decoded = remote_detector.cv2.imdecode(
        np.frombuffer(first_jpeg, dtype=np.uint8), remote_detector.cv2.IMREAD_COLOR
    )
    assert decoded.shape == (640, 640, 3)
    assert capture.released
    assert client.closed
    assert client.deleted == ["http://vision.test/v1/tracking-sessions/session-1"]


def test_stream_samples_high_fps_and_preserves_source_timestamps(monkeypatch):
    detector, _capture, client = _build_detector(
        monkeypatch,
        frame_count=12,
        fps=60.0,
        max_fps=15.0,
        batch_size=2,
    )

    results = list(detector.stream("video.mp4"))

    assert client.session_payloads == [{"fps": 15.0}]
    assert [frame["time"] for frame in results] == pytest.approx([0.0, 4 / 60, 8 / 60])
    assert [
        item["frame_index"]
        for call in client.batch_calls
        for item in json.loads(call["metadata"])["frames"]
    ] == [0, 4, 8]


def test_video_transport_uploads_original_once_and_streams_ndjson(
    monkeypatch, tmp_path
):
    video_path = tmp_path / "sample.mp4"
    video_path.write_bytes(b"original-compressed-video")
    detector, capture, client = _build_detector(
        monkeypatch,
        transport="video",
        fps=60.0,
        max_fps=15.0,
        video_lines=[
            json.dumps(
                {
                    "frame_index": 0,
                    "time_ms": 0.0,
                    "width": 1920,
                    "height": 1080,
                    "boxes": [
                        {
                            "id": 7,
                            "x1": 1,
                            "y1": 2,
                            "x2": 10,
                            "y2": 12,
                            "conf": 0.9,
                        }
                    ],
                }
            ),
            json.dumps(
                {
                    "frame_index": 4,
                    "time_ms": 1000 / 15,
                    "width": 1920,
                    "height": 1080,
                    "boxes": [],
                }
            ),
        ],
    )

    results = list(detector.stream(str(video_path)))

    assert results == [
        {
            "time": 0.0,
            "width": 1920,
            "height": 1080,
            "boxes": [
                {
                    "id": 7,
                    "x1": 1.0,
                    "y1": 2.0,
                    "x2": 10.0,
                    "y2": 12.0,
                    "conf": 0.9,
                }
            ],
        },
        {"time": pytest.approx(1 / 15), "width": 1920, "height": 1080, "boxes": []},
    ]
    assert capture.read_calls == 0
    assert capture.released
    assert client.session_payloads == [{"fps": 15.0}]
    assert client.batch_calls == []
    assert client.video_calls == [
        {
            "method": "POST",
            "url": "http://vision.test/v1/tracking-sessions/session-1/video",
            "data": {"sample_fps": "15.0"},
            "headers": {"Accept": "application/x-ndjson"},
            "filename": "upload.mp4",
            "bytes": b"original-compressed-video",
            "media_type": "video/mp4",
        }
    ]
    assert client.video_stream_contexts[0].entered
    assert client.video_stream_contexts[0].closed
    assert client.deleted == ["http://vision.test/v1/tracking-sessions/session-1"]
    assert client.closed


def test_video_transport_forwards_weak_tracking_diagnostics(monkeypatch, tmp_path):
    video_path = tmp_path / "sample.mp4"
    video_path.write_bytes(b"original-compressed-video")
    diagnostics = {
        "diagnostic_floor": 0.1,
        "person_candidates": {"count": 1},
        "detector_accepted": {"count": 0},
        "weak_candidates": {"count": 1},
        "lanes": [
            {
                "lane_id": "center",
                "after_roi": {"count": 0},
                "weak_candidates_after_roi": {"count": 1},
                "active_track_ids": [],
                "retained_lost_track_count": 1,
                "weak_reactivated_track_ids": [7],
            }
        ],
    }
    detector, _capture, _client = _build_detector(
        monkeypatch,
        transport="video",
        video_lines=[
            json.dumps(
                {
                    "frame_index": 0,
                    "time_ms": 0.0,
                    "width": 1920,
                    "height": 1080,
                    "boxes": [],
                    "tracking_diagnostics": diagnostics,
                }
            )
        ],
    )

    results = list(detector.stream(str(video_path)))

    assert results[0]["tracking_diagnostics"] == diagnostics


def test_video_transport_rejects_out_of_order_ndjson_and_cleans_up(
    monkeypatch, tmp_path
):
    video_path = tmp_path / "sample.mp4"
    video_path.write_bytes(b"original-compressed-video")
    detector, capture, client = _build_detector(
        monkeypatch,
        transport="video",
        video_lines=[
            json.dumps(
                {
                    "frame_index": 2,
                    "time_ms": 500.0,
                    "width": 40,
                    "height": 20,
                    "boxes": [],
                }
            ),
            json.dumps(
                {
                    "frame_index": 1,
                    "time_ms": 1000.0,
                    "width": 40,
                    "height": 20,
                    "boxes": [],
                }
            ),
        ],
    )

    with pytest.raises(
        remote_detector.RemoteDetectorError, match="alteró el orden de los frames"
    ):
        list(detector.stream(str(video_path)))

    assert capture.read_calls == 0
    assert capture.released
    assert client.video_stream_contexts[0].closed
    assert client.deleted == ["http://vision.test/v1/tracking-sessions/session-1"]
    assert client.closed


def test_stream_prepares_ahead_but_keeps_one_ordered_request_in_flight(monkeypatch):
    detector, capture, client = _build_detector(
        monkeypatch,
        block_first_batch=True,
        frame_count=8,
        batch_size=2,
    )
    results = []
    errors = []

    def consume():
        try:
            results.extend(detector.stream("video.mp4"))
        except BaseException as exc:  # noqa: BLE001 - se propaga para el assert
            errors.append(exc)

    consumer = threading.Thread(target=consume)
    consumer.start()
    try:
        assert client.first_batch_started.wait(timeout=2)
        # Mientras el primer request espera la GPU, el productor alcanzó a
        # preparar los batches siguientes sin abrir otro request de la sesión.
        assert capture.frames_depleted.wait(timeout=2)
        assert client._started_batch_count == 1
        assert client.max_active_batch_posts == 1
    finally:
        client.release_first_batch.set()
        consumer.join(timeout=2)

    assert not consumer.is_alive()
    assert errors == []
    assert [frame["time"] for frame in results] == pytest.approx(
        [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5]
    )
    assert [
        json.loads(call["metadata"])["sequence"] for call in client.batch_calls
    ] == [0, 1, 2, 3]
    assert client.max_active_batch_posts == 1
    assert capture.released


def test_stream_logs_front_and_ai_batch_timings(monkeypatch, caplog):
    detector, _capture, _client = _build_detector(
        monkeypatch,
        timing_headers={
            "X-Swimtrack-Decode-Ms": "3.25",
            "X-Swimtrack-Process-Ms": "12.5",
            "X-Swimtrack-Total-Ms": "15.75",
        },
    )

    caplog.set_level(logging.INFO, logger=remote_detector.__name__)
    list(detector.stream("video.mp4"))

    assert "vision_batch_timing" in caplog.text
    assert "vision_prepare_batch_timing" in caplog.text
    assert "vision_prepare_timing" in caplog.text
    assert "request_transport_ms=" in caplog.text
    assert "ai_decode_ms=3.2" in caplog.text
    assert "ai_process_ms=12.5" in caplog.text
    assert "ai_total_ms=15.8" in caplog.text


def test_stream_enables_and_forwards_fixed_camera_lap_scores(monkeypatch):
    detector, _capture, client = _build_detector(
        monkeypatch,
        lap_calibration_id="fixed-camera-v1",
        include_lap_scores=True,
    )

    results = list(detector.stream("video.mp4"))

    assert client.session_payloads == [
        {"fps": 2.0, "lap_calibration_id": "fixed-camera-v1"}
    ]
    score = results[0]["lap_scores"][0]
    assert score["lane_id"] == "center"
    assert score["lap_score"] == 0.82
    assert score["candidate_episode_id"] == 1
    assert score["evidence"]["reversal"] == 0.88


def test_stream_requests_and_forwards_tracking_diagnostics(monkeypatch):
    diagnostics = {
        "diagnostic_floor": 0.1,
        "person_candidates": {
            "count": 2,
            "boxes": [
                {"x1": 1, "y1": 2, "x2": 10, "y2": 12, "conf": 0.14},
                {"x1": 3, "y1": 4, "x2": 13, "y2": 14, "conf": 0.8},
            ],
        },
        "detector_accepted": {
            "count": 1,
            "boxes": [{"x1": 3, "y1": 4, "x2": 13, "y2": 14, "conf": 0.8}],
        },
        "weak_candidates": {
            "count": 1,
            "boxes": [{"x1": 1, "y1": 2, "x2": 10, "y2": 12, "conf": 0.14}],
        },
        "lanes": [
            {
                "lane_id": "center",
                "after_roi": {
                    "count": 1,
                    "boxes": [{"x1": 3, "y1": 4, "x2": 13, "y2": 14, "conf": 0.8}],
                },
                "weak_candidates_after_roi": {
                    "count": 1,
                    "boxes": [{"x1": 1, "y1": 2, "x2": 10, "y2": 12, "conf": 0.14}],
                },
                "active_track_ids": [7],
                "retained_lost_track_count": 2,
                "weak_reactivated_track_ids": [7],
            }
        ],
    }
    detector, _capture, client = _build_detector(
        monkeypatch,
        tracking_diagnostics="boxes",
        tracking_diagnostics_payload=diagnostics,
    )

    results = list(detector.stream("video.mp4"))

    assert client.session_payloads == [{"fps": 2.0, "diagnostics": "boxes"}]
    forwarded = results[0]["tracking_diagnostics"]
    assert forwarded["diagnostic_floor"] == 0.1
    assert forwarded["person_candidates"]["count"] == 2
    assert forwarded["person_candidates"]["boxes"][0] == {
        "x1": 1.0,
        "y1": 2.0,
        "x2": 10.0,
        "y2": 12.0,
        "conf": 0.14,
    }
    assert forwarded["weak_candidates"] == {
        "count": 1,
        "boxes": [
            {
                "x1": 1.0,
                "y1": 2.0,
                "x2": 10.0,
                "y2": 12.0,
                "conf": 0.14,
            }
        ],
    }
    assert forwarded["lanes"] == [
        {
            "lane_id": "center",
            "after_roi": {
                "count": 1,
                "boxes": [
                    {
                        "x1": 3.0,
                        "y1": 4.0,
                        "x2": 13.0,
                        "y2": 14.0,
                        "conf": 0.8,
                    }
                ],
            },
            "weak_candidates_after_roi": {
                "count": 1,
                "boxes": [
                    {
                        "x1": 1.0,
                        "y1": 2.0,
                        "x2": 10.0,
                        "y2": 12.0,
                        "conf": 0.14,
                    }
                ],
            },
            "active_track_ids": [7],
            "retained_lost_track_count": 2,
            "weak_reactivated_track_ids": [7],
        }
    ]


def test_stream_rejects_malformed_tracking_diagnostics(monkeypatch):
    detector, capture, client = _build_detector(
        monkeypatch,
        tracking_diagnostics="counts",
        tracking_diagnostics_payload={
            "diagnostic_floor": 0.1,
            "person_candidates": {"count": 1},
            "detector_accepted": {"count": 1},
            "weak_candidates": {"count": 1},
            "lanes": [
                {
                    "lane_id": "center",
                    "after_roi": {"count": 1},
                    "weak_candidates_after_roi": {"count": 1},
                    "active_track_ids": "7",
                    "retained_lost_track_count": 0,
                    "weak_reactivated_track_ids": [],
                }
            ],
        },
    )

    with pytest.raises(
        remote_detector.RemoteDetectorError,
        match="active_track_ids inválidos",
    ):
        list(detector.stream("video.mp4"))

    assert capture.released
    assert client.closed
    assert client.deleted == ["http://vision.test/v1/tracking-sessions/session-1"]


@pytest.mark.parametrize(
    ("diagnostics", "error"),
    [
        (
            {
                "diagnostic_floor": 0.1,
                "person_candidates": {"count": 1},
                "detector_accepted": {"count": 1},
                "lanes": [],
            },
            "tracking_diagnostics incompletos",
        ),
        (
            {
                "diagnostic_floor": 0.1,
                "person_candidates": {"count": 1},
                "detector_accepted": {"count": 1},
                "weak_candidates": {"count": 1},
                "lanes": [
                    {
                        "lane_id": "center",
                        "after_roi": {"count": 1},
                        "active_track_ids": [],
                        "retained_lost_track_count": 0,
                        "weak_reactivated_track_ids": [],
                    }
                ],
            },
            "diagnostics de carril incompletos",
        ),
        (
            {
                "diagnostic_floor": 0.1,
                "person_candidates": {"count": 1},
                "detector_accepted": {"count": 1},
                "weak_candidates": {"count": 1},
                "lanes": [
                    {
                        "lane_id": "center",
                        "after_roi": {"count": 1},
                        "weak_candidates_after_roi": {"count": 1},
                        "active_track_ids": [],
                        "retained_lost_track_count": 0,
                        "weak_reactivated_track_ids": [True],
                    }
                ],
            },
            "weak_reactivated_track_ids inválidos",
        ),
    ],
)
def test_stream_rejects_malformed_weak_tracking_diagnostics(
    monkeypatch, diagnostics, error
):
    detector, capture, client = _build_detector(
        monkeypatch,
        tracking_diagnostics="counts",
        tracking_diagnostics_payload=diagnostics,
    )

    with pytest.raises(remote_detector.RemoteDetectorError, match=error):
        list(detector.stream("video.mp4"))

    assert capture.released
    assert client.closed
    assert client.deleted == ["http://vision.test/v1/tracking-sessions/session-1"]


def test_constructor_rejects_unknown_tracking_diagnostics_mode():
    with pytest.raises(ValueError, match="debe ser none, counts o boxes"):
        RemoteSwimmerDetector(
            base_url="http://vision.test",
            auth_token="secret",
            tracking_diagnostics="verbose",  # type: ignore[arg-type]
        )


def test_constructor_rejects_unknown_video_transport():
    with pytest.raises(ValueError, match="VISION_TRANSPORT debe ser frames o video"):
        RemoteSwimmerDetector(
            base_url="http://vision.test",
            auth_token="secret",
            transport="auto",  # type: ignore[arg-type]
        )


def test_constructor_rejects_non_positive_sampling_fps():
    with pytest.raises(ValueError, match="VISION_MAX_FPS debe ser mayor que cero"):
        RemoteSwimmerDetector(
            base_url="http://vision.test",
            auth_token="secret",
            max_fps=0,
        )


def test_constructor_rejects_non_positive_prepared_batch_queue_size():
    with pytest.raises(
        ValueError, match="VISION_PREPARED_BATCH_QUEUE_SIZE debe ser al menos 1"
    ):
        RemoteSwimmerDetector(
            base_url="http://vision.test",
            auth_token="secret",
            prepared_batch_queue_size=0,
        )


def test_batch_retry_reuses_identical_id_metadata_and_bytes(monkeypatch):
    detector, _capture, client = _build_detector(
        monkeypatch, transient_first_batch=True
    )

    list(detector.stream("video.mp4"))

    first_attempt, retry = client.batch_calls[:2]
    assert retry["metadata"] == first_attempt["metadata"]
    assert json.loads(retry["metadata"])["batch_id"] == str(uuid.UUID(int=1))
    assert [item[1][1] for item in retry["files"]] == [
        item[1][1] for item in first_attempt["files"]
    ]


def test_closing_stream_releases_video_client_and_remote_session(monkeypatch):
    detector, capture, client = _build_detector(monkeypatch)

    stream = detector.stream("video.mp4")
    next(stream)
    stream.close()

    assert capture.released
    assert client.closed
    assert client.deleted == ["http://vision.test/v1/tracking-sessions/session-1"]
