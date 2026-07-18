import io
import json
import os

import pytest

from app import create_app


class FakeDetector:
    def __init__(self):
        self.video_path = None
        self.existed_during_stream = False

    def stream(self, video_path):
        self.video_path = video_path
        self.existed_during_stream = os.path.exists(video_path)
        yield {
            "time": 0.0,
            "width": 40,
            "height": 20,
            "boxes": [{"id": 3, "x1": 1, "y1": 2, "x2": 10, "y2": 12, "conf": 0.9}],
            "lap_scores": [
                {
                    "lane_id": "center",
                    "lap_score": 0.0,
                    "observation_quality": 0.2,
                    "evaluable": False,
                    "window_start_ms": 0.0,
                    "window_end_ms": 0.0,
                    "score_version": "trajectory-v5",
                    "evidence": {
                        "wall": 0.0,
                        "approach": 0.0,
                        "reversal": 0.0,
                        "departure": 0.0,
                        "track_quality": 0.2,
                    },
                }
            ],
        }
        yield {
            "time": 0.5,
            "width": 40,
            "height": 20,
            "boxes": [
                {"id": 3, "x1": 2, "y1": 2, "x2": 11, "y2": 12, "conf": 0.8},
                {"id": 4, "x1": 20, "y1": 2, "x2": 30, "y2": 12, "conf": 0.7},
            ],
        }


class FakeLapDetector:
    def stream(self, _video_path):
        for time, score in ((0.0, 0.4), (0.5, 0.6), (1.0, 0.8)):
            yield {
                "time": time,
                "width": 40,
                "height": 20,
                "boxes": [
                    {
                        "id": 3,
                        "x1": 1,
                        "y1": 2,
                        "x2": 10,
                        "y2": 12,
                        "conf": 0.9,
                    }
                ],
                "lap_scores": [
                    {
                        "lane_id": "center",
                        "lap_score": score,
                        "candidate_time_ms": time * 1000,
                        "candidate_episode_id": 7,
                        "score_version": "trajectory-v5",
                        "endpoint": "near",
                    }
                ],
            }


def _events(response):
    return [
        json.loads(chunk.removeprefix("data: "))
        for chunk in response.get_data(as_text=True).strip().split("\n\n")
    ]


def test_detect_preserves_sse_contract_and_removes_upload():
    detector = FakeDetector()
    app = create_app({"TESTING": True, "URL_PREFIX": "/"}, detector=detector)

    with app.test_client() as client:
        response = client.post(
            "/api/detect",
            data={"video": (io.BytesIO(b"fake-video"), "sample.mp4")},
            content_type="multipart/form-data",
        )
        frames = _events(response)
        response.close()

    assert response.status_code == 200
    assert response.mimetype == "text/event-stream"
    assert [frame["count"] for frame in frames] == [1, 2]
    assert frames[0]["lap_scores"][0]["lane_id"] == "center"
    assert frames[0]["lap_scores"][0]["score_version"] == "trajectory-v5"
    assert detector.existed_during_stream
    assert not os.path.exists(detector.video_path)


def test_detect_logs_safe_upload_and_sse_timings(caplog):
    caplog.set_level("INFO")
    app = create_app({"TESTING": True, "URL_PREFIX": "/"}, detector=FakeDetector())

    with app.test_client() as client:
        response = client.post(
            "/api/detect",
            data={"video": (io.BytesIO(b"fake-video"), "sample.mp4")},
            content_type="multipart/form-data",
        )
        response.get_data()
        response.close()

    assert "vision_upload_timing" in caplog.text
    assert "vision_sse_timing" in caplog.text
    assert "upload_bytes=" in caplog.text
    assert "request_to_first_event_ms=" in caplog.text
    assert "sample.mp4" not in caplog.text
    assert "fake-video" not in caplog.text


def test_detect_rejects_non_video_before_starting_sse():
    detector = FakeDetector()
    app = create_app({"TESTING": True, "URL_PREFIX": "/"}, detector=detector)

    with app.test_client() as client:
        response = client.post(
            "/api/detect",
            data={"video": (io.BytesIO(b"text"), "notes.txt")},
            content_type="multipart/form-data",
        )

    assert response.status_code == 400
    assert response.get_json()["ok"] is False
    assert detector.video_path is None


def test_detect_rejects_video_over_configured_upload_limit():
    detector = FakeDetector()
    app = create_app(
        {"TESTING": True, "URL_PREFIX": "/", "MAX_CONTENT_LENGTH": 64},
        detector=detector,
    )

    with app.test_client() as client:
        response = client.post(
            "/api/detect",
            data={"video": (io.BytesIO(b"x" * 128), "sample.mp4")},
            content_type="multipart/form-data",
        )

    assert response.status_code == 413
    assert detector.video_path is None


def test_detect_emits_one_shadow_decision_without_changing_visible_count(caplog):
    caplog.set_level("INFO")
    app = create_app(
        {
            "TESTING": True,
            "URL_PREFIX": "/",
            "LAP_EPISODE_MODE": "shadow",
            "LAP_CONFIDENCE_THRESHOLD": 0.5,
        },
        detector=FakeLapDetector(),
    )

    with app.test_client() as client:
        response = client.post(
            "/api/detect",
            data={"video": (io.BytesIO(b"fake-video"), "sample.mp4")},
            content_type="multipart/form-data",
        )
        frames = _events(response)
        response.close()

    assert [frame["count"] for frame in frames] == [1, 1, 1]
    decisions = [
        decision
        for frame in frames
        for decision in frame.get("lap_decisions", [])
    ]
    assert len(decisions) == 1
    assert decisions[0] == {
        "lane_id": "center",
        "candidate_episode_id": 7,
        "candidate_time_ms": 500.0,
        "lap_score": 0.6,
        "score_version": "trajectory-v5",
        "endpoint": "near",
        "predicted_label": "lap",
        "threshold": 0.5,
        "mode": "shadow",
        "would_increment_lap_count": True,
        "lap_count_incremented": False,
    }
    assert "lap_shadow_decision lane_id=center episode_id=7" in caplog.text
    assert "max_lap_score=0.800000" in caplog.text


def test_detect_shadow_state_resets_for_each_video_request():
    app = create_app(
        {
            "TESTING": True,
            "URL_PREFIX": "/",
            "LAP_EPISODE_MODE": "shadow",
            "LAP_CONFIDENCE_THRESHOLD": 0.5,
        },
        detector=FakeLapDetector(),
    )

    with app.test_client() as client:
        decision_counts = []
        for filename in ("first.mp4", "second.mp4"):
            response = client.post(
                "/api/detect",
                data={"video": (io.BytesIO(b"fake-video"), filename)},
                content_type="multipart/form-data",
            )
            frames = _events(response)
            response.close()
            decision_counts.append(
                sum(len(frame.get("lap_decisions", [])) for frame in frames)
            )

    assert decision_counts == [1, 1]


def test_create_app_rejects_active_mode_and_invalid_threshold():
    with pytest.raises(ValueError, match="off o shadow"):
        create_app(
            {"TESTING": True, "LAP_EPISODE_MODE": "active"},
            detector=FakeLapDetector(),
        )
    with pytest.raises(ValueError, match="entre 0 y 1"):
        create_app(
            {
                "TESTING": True,
                "LAP_EPISODE_MODE": "shadow",
                "LAP_CONFIDENCE_THRESHOLD": 2,
            },
            detector=FakeLapDetector(),
        )
