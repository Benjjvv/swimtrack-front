"""Reducción stateful de scores de vuelta para el modo shadow del Front."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any


@dataclass
class _Episode:
    lane_id: str
    candidate_episode_id: int
    lap_score: float
    candidate_time_ms: float
    score_version: str
    endpoint: str | None
    decision_emitted: bool = False

    def public_state(self) -> dict[str, Any]:
        state: dict[str, Any] = {
            "lane_id": self.lane_id,
            "candidate_episode_id": self.candidate_episode_id,
            "candidate_time_ms": self.candidate_time_ms,
            "lap_score": self.lap_score,
            "score_version": self.score_version,
            "decision_emitted": self.decision_emitted,
        }
        if self.endpoint is not None:
            state["endpoint"] = self.endpoint
        return state


class LapEpisodeReducer:
    """Mantiene un máximo y emite a lo sumo una decisión por episodio.

    La instancia debe pertenecer a un único request/video. Por eso la key interna
    sólo necesita ``(lane_id, candidate_episode_id)`` y nunca mezcla sesiones.
    Si ``threshold`` es ``None``, el reducer conserva y permite auditar los
    episodios, pero no produce una clasificación positiva.
    """

    def __init__(self, threshold: float | None) -> None:
        self.threshold = self._normalize_threshold(threshold)
        self._episodes: dict[tuple[str, int], _Episode] = {}

    def observe(self, lap_scores: Any) -> list[dict[str, Any]]:
        """Incorpora los scores de un frame y retorna nuevas decisiones shadow."""
        if lap_scores is None:
            return []
        if not isinstance(lap_scores, list):
            raise ValueError("lap_scores debe ser una lista.")

        decisions: list[dict[str, Any]] = []
        for raw_score in lap_scores:
            observation = self._candidate_observation(raw_score)
            if observation is None:
                continue

            key = (observation.lane_id, observation.candidate_episode_id)
            episode = self._episodes.get(key)
            if episode is None:
                episode = observation
                self._episodes[key] = episode
            elif observation.lap_score > episode.lap_score:
                episode.lap_score = observation.lap_score
                episode.candidate_time_ms = observation.candidate_time_ms
                episode.score_version = observation.score_version
                episode.endpoint = observation.endpoint

            if (
                self.threshold is not None
                and not episode.decision_emitted
                and episode.lap_score >= self.threshold
            ):
                episode.decision_emitted = True
                decisions.append(self._shadow_decision(episode))

        return decisions

    def snapshot(self) -> list[dict[str, Any]]:
        """Devuelve el máximo final de cada episodio para logs y tests."""
        return [
            self._episodes[key].public_state()
            for key in sorted(self._episodes, key=lambda item: (item[0], item[1]))
        ]

    def _shadow_decision(self, episode: _Episode) -> dict[str, Any]:
        decision = episode.public_state()
        decision.pop("decision_emitted")
        decision.update(
            {
                "predicted_label": "lap",
                "threshold": self.threshold,
                "mode": "shadow",
                "would_increment_lap_count": True,
                "lap_count_incremented": False,
            }
        )
        return decision

    @classmethod
    def _candidate_observation(cls, score: Any) -> _Episode | None:
        if not isinstance(score, dict):
            raise ValueError("Cada lap_score debe ser un objeto.")

        raw_episode_id = score.get("candidate_episode_id")
        raw_candidate_time = score.get("candidate_time_ms")
        # La IA publica scores evaluables antes de que exista un episodio. Esos
        # frames no son candidatos y no deben crear estado en el reducer.
        if raw_episode_id is None and raw_candidate_time is None:
            return None
        if raw_episode_id is None or raw_candidate_time is None:
            raise ValueError(
                "candidate_episode_id y candidate_time_ms deben aparecer juntos."
            )

        lane_id = score.get("lane_id")
        if not isinstance(lane_id, str) or not lane_id:
            raise ValueError("lane_id debe ser un string no vacío.")
        if (
            not isinstance(raw_episode_id, int)
            or isinstance(raw_episode_id, bool)
            or raw_episode_id < 1
        ):
            raise ValueError("candidate_episode_id debe ser un entero positivo.")

        lap_score = cls._unit_float(score.get("lap_score"), "lap_score")
        candidate_time_ms = cls._finite_float(
            raw_candidate_time, "candidate_time_ms"
        )
        if candidate_time_ms < 0:
            raise ValueError("candidate_time_ms no puede ser negativo.")
        score_version = score.get("score_version")
        if not isinstance(score_version, str) or not score_version:
            raise ValueError("score_version debe ser un string no vacío.")
        endpoint = score.get("endpoint")
        if endpoint is not None and endpoint not in {"far", "near"}:
            raise ValueError("endpoint debe ser far o near.")

        return _Episode(
            lane_id=lane_id,
            candidate_episode_id=raw_episode_id,
            lap_score=lap_score,
            candidate_time_ms=candidate_time_ms,
            score_version=score_version,
            endpoint=endpoint,
        )

    @classmethod
    def _normalize_threshold(cls, threshold: float | None) -> float | None:
        if threshold is None or threshold == "":
            return None
        return cls._unit_float(threshold, "LAP_CONFIDENCE_THRESHOLD")

    @classmethod
    def _unit_float(cls, value: Any, field: str) -> float:
        normalized = cls._finite_float(value, field)
        if not 0.0 <= normalized <= 1.0:
            raise ValueError(f"{field} debe estar entre 0 y 1.")
        return normalized

    @staticmethod
    def _finite_float(value: Any, field: str) -> float:
        if isinstance(value, bool):
            raise ValueError(f"{field} debe ser numérico.")
        try:
            normalized = float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{field} debe ser numérico.") from exc
        if not math.isfinite(normalized):
            raise ValueError(f"{field} debe ser finito.")
        return normalized
