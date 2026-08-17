"""Resolve a model-fusion environment consistently across operating systems."""

from __future__ import annotations

import os
import platform
from typing import Any


def resolve_environment_name(
    config: dict[str, Any],
    requested_environment: str | None = None,
    *,
    platform_name: str | None = None,
) -> str:
    """Return the explicit, platform-selected, or configured environment name.

    ``MODEL_FUSION_ENV`` and the function argument are escape hatches for CI
    and local debugging. Otherwise, ``platform_environments`` selects a
    platform-specific environment while ``active_environment`` remains the
    backward-compatible fallback.
    """

    explicit = requested_environment or os.environ.get("MODEL_FUSION_ENV")
    if explicit:
        return explicit

    platform_environments = config.get("platform_environments")
    detected_platform = (platform_name or platform.system()).casefold()
    if isinstance(platform_environments, dict):
        selected = platform_environments.get(detected_platform)
        if isinstance(selected, str) and selected:
            return selected

    active_environment = config.get("active_environment")
    if isinstance(active_environment, str) and active_environment:
        return active_environment

    raise ValueError(
        "No active environment configured; set active_environment, "
        "platform_environments, or MODEL_FUSION_ENV"
    )
