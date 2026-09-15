from __future__ import annotations

from verityos_nova.runtime.errors import ConnectorUnavailableError
from verityos_nova.store import sha256_text


def generate_image_placeholder(draft_text: str, brand_id: str) -> dict:
    """Preserve an image-generation API without live provider calls.

    Phase 8 does not require the design-system pipeline as an acceptance gate.
    """
    artifact = f"image-placeholder:{brand_id}:{draft_text[:80]}"
    return {
        "image_kind": "placeholder",
        "artifact_hash": sha256_text(artifact),
        "message": "image generation is mocked in Phase 8; design-system templates remain deferred",
    }


def publish_meta(*_args, **_kwargs):
    raise ConnectorUnavailableError("meta")
