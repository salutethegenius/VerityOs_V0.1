from __future__ import annotations

import os

from fastapi import APIRouter, Request

from verityos_nova import __version__

router = APIRouter()


def _payload(status: str) -> dict:
    return {
        "status": status,
        "component": "nova",
        "phase": "11",
        "version": __version__,
        "runtime": "verityos",
    }


@router.get("/health")
@router.get("/")
@router.get("/health/live")
def health() -> dict:
    return _payload("ok")


@router.get("/health/ready")
def ready(request: Request) -> dict:
    nova = getattr(request.app.state, "nova", None)
    checks: dict[str, str] = {}
    if nova is not None and getattr(nova, "store", None) is not None:
        ping = getattr(nova.store, "ping", None)
        if callable(ping):
            ping()
            checks["store"] = "ok"
        else:
            checks["store"] = "ok"
    core = os.environ.get("CORE_API_URL")
    if core:
        checks["core_url_configured"] = "ok"
    return {**_payload("ok"), "checks": checks}
