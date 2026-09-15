"""Slack HMAC-SHA256 verification with 5-minute replay protection."""

from __future__ import annotations

import hashlib
import hmac
import time

REPLAY_TOLERANCE_SECONDS = 60 * 5


def verify_slack_signature(
    timestamp: str,
    signature: str,
    body: bytes,
    signing_secret: str,
    now: float | None = None,
) -> bool:
    if not signing_secret or not timestamp or not signature:
        return False
    try:
        ts_int = int(timestamp)
    except (TypeError, ValueError):
        return False
    clock = time.time() if now is None else now
    if abs(clock - ts_int) > REPLAY_TOLERANCE_SECONDS:
        return False
    base = f"v0:{timestamp}:".encode() + body
    expected = "v0=" + hmac.new(signing_secret.encode(), base, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
