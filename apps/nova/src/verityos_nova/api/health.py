from __future__ import annotations

from fastapi import APIRouter

from verityos_nova import __version__

router = APIRouter()


@router.get("/health")
@router.get("/")
def health() -> dict:
    return {
        "status": "ok",
        "component": "nova",
        "phase": "9",
        "version": __version__,
        "runtime": "verityos",
    }
