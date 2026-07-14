import io
import json
import os

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
                    "score_version": "trajectory-v1",
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
    assert frames[0]["lap_scores"][0]["score_version"] == "trajectory-v1"
    assert detector.existed_during_stream
    assert not os.path.exists(detector.video_path)


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
