import json
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

    def isOpened(self):
        return True

    def get(self, prop):
        if prop == remote_detector.cv2.CAP_PROP_FPS:
            return self.fps
        return 0

    def read(self):
        if not self.frames:
            return False, None
        return True, self.frames.pop(0)

    def release(self):
        self.released = True


class FakeVisionClient:
    def __init__(
        self,
        *,
        transient_first_batch=False,
        include_lap_scores=False,
        tracking_diagnostics_payload=None,
        **kwargs,
    ):
        self.kwargs = kwargs
        self.transient_first_batch = transient_first_batch
        self.include_lap_scores = include_lap_scores
        self.tracking_diagnostics_payload = tracking_diagnostics_payload
        self.session_payloads = []
        self.batch_calls = []
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
                        "score_version": "trajectory-v3",
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


def _build_detector(
    monkeypatch,
    *,
    transient_first_batch=False,
    lap_calibration_id=None,
    include_lap_scores=False,
    tracking_diagnostics="none",
    tracking_diagnostics_payload=None,
):
    frames = [np.zeros((20, 40, 3), dtype=np.uint8) for _ in range(3)]
    capture = FakeCapture(frames)
    monkeypatch.setattr(remote_detector.cv2, "VideoCapture", lambda _path: capture)
    client = FakeVisionClient(
        transient_first_batch=transient_first_batch,
        include_lap_scores=include_lap_scores,
        tracking_diagnostics_payload=tracking_diagnostics_payload,
    )
    batch_ids = iter((uuid.UUID(int=1), uuid.UUID(int=2), uuid.UUID(int=3)))
    detector = RemoteSwimmerDetector(
        base_url="http://vision.test/",
        auth_token="secret",
        lap_calibration_id=lap_calibration_id,
        tracking_diagnostics=tracking_diagnostics,
        batch_size=2,
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
        "lanes": [
            {
                "lane_id": "center",
                "after_roi": {
                    "count": 1,
                    "boxes": [{"x1": 3, "y1": 4, "x2": 13, "y2": 14, "conf": 0.8}],
                },
                "active_track_ids": [7],
                "retained_lost_track_count": 2,
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
            "active_track_ids": [7],
            "retained_lost_track_count": 2,
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
            "lanes": [
                {
                    "lane_id": "center",
                    "after_roi": {"count": 1},
                    "active_track_ids": "7",
                    "retained_lost_track_count": 0,
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


def test_constructor_rejects_unknown_tracking_diagnostics_mode():
    with pytest.raises(ValueError, match="debe ser none, counts o boxes"):
        RemoteSwimmerDetector(
            base_url="http://vision.test",
            auth_token="secret",
            tracking_diagnostics="verbose",  # type: ignore[arg-type]
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
