import pytest

from lap_episode_reducer import LapEpisodeReducer


def _score(
    lap_score,
    candidate_time_ms,
    *,
    lane_id="center",
    candidate_episode_id=1,
    score_version="trajectory-v5",
    endpoint="near",
    identity_id=None,
):
    result = {
        "lane_id": lane_id,
        "candidate_episode_id": candidate_episode_id,
        "candidate_time_ms": candidate_time_ms,
        "lap_score": lap_score,
        "score_version": score_version,
        "endpoint": endpoint,
    }
    if identity_id is not None:
        result["identity_id"] = identity_id
    return result


def test_reducer_keeps_maximum_with_its_time_and_emits_once():
    reducer = LapEpisodeReducer(0.5)

    assert reducer.observe([_score(0.4, 1000.0)]) == []
    decisions = reducer.observe([_score(0.6, 1200.0)])
    assert reducer.observe([_score(0.8, 1100.0)]) == []
    assert reducer.observe([_score(0.7, 900.0)]) == []

    assert decisions == [
        {
            "lane_id": "center",
            "candidate_episode_id": 1,
            "candidate_time_ms": 1200.0,
            "lap_score": 0.6,
            "score_version": "trajectory-v5",
            "endpoint": "near",
            "predicted_label": "lap",
            "threshold": 0.5,
            "mode": "shadow",
            "would_increment_lap_count": True,
            "lap_count_incremented": False,
        }
    ]
    assert reducer.snapshot() == [
        {
            "lane_id": "center",
            "candidate_episode_id": 1,
            "candidate_time_ms": 1100.0,
            "lap_score": 0.8,
            "score_version": "trajectory-v5",
            "decision_emitted": True,
            "endpoint": "near",
        }
    ]


def test_reducer_keys_episodes_by_lane_and_id_without_temporal_deduplication():
    reducer = LapEpisodeReducer(0.5)

    decisions = reducer.observe(
        [
            _score(0.8, 1000.0, candidate_episode_id=1),
            _score(0.9, 1001.0, candidate_episode_id=2),
            _score(0.7, 1002.0, lane_id="left", candidate_episode_id=1),
        ]
    )

    assert [
        (decision["lane_id"], decision["candidate_episode_id"])
        for decision in decisions
    ] == [("center", 1), ("center", 2), ("left", 1)]
    assert len(reducer.snapshot()) == 3


def test_reducer_keeps_same_episode_number_for_two_identities_separate():
    reducer = LapEpisodeReducer(0.5)

    decisions = reducer.observe(
        [
            _score(0.8, 1_000.0, identity_id=1),
            _score(0.9, 1_001.0, identity_id=2),
        ]
    )

    assert [(decision["identity_id"], decision["candidate_episode_id"]) for decision in decisions] == [
        (1, 1),
        (2, 1),
    ]
    assert len(reducer.snapshot()) == 2


def test_unconfigured_threshold_collects_episodes_without_classifying():
    reducer = LapEpisodeReducer(None)

    assert reducer.observe([_score(1.0, 1000.0)]) == []
    assert reducer.snapshot()[0]["decision_emitted"] is False


@pytest.mark.parametrize("threshold", [-0.01, 1.01, float("nan"), True])
def test_reducer_rejects_invalid_threshold(threshold):
    with pytest.raises(ValueError):
        LapEpisodeReducer(threshold)


@pytest.mark.parametrize("episode_id", [0, -1, 1.5, True])
def test_reducer_rejects_invalid_episode_id(episode_id):
    reducer = LapEpisodeReducer(0.5)

    with pytest.raises(ValueError, match="entero positivo"):
        reducer.observe([_score(0.8, 1000.0, candidate_episode_id=episode_id)])


def test_reducer_ignores_scores_without_candidate_and_rejects_half_candidate():
    reducer = LapEpisodeReducer(0.5)

    assert (
        reducer.observe(
            [
                {
                    "lane_id": "center",
                    "lap_score": 0.0,
                    "score_version": "trajectory-v5",
                }
            ]
        )
        == []
    )
    with pytest.raises(ValueError, match="deben aparecer juntos"):
        reducer.observe(
            [
                {
                    "lane_id": "center",
                    "candidate_episode_id": 1,
                    "lap_score": 0.8,
                    "score_version": "trajectory-v5",
                }
            ]
        )
