"""Native Verity Knowledge extractors (Phase 6). Open WebUI is not used."""

from __future__ import annotations

import hashlib
import re

__version__ = "0.1.0"

PARSER_VERSION = "verity-knowledge-0.1"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def strip_html(html: str) -> str:
    html = re.sub(r"<script[\s\S]*?</script>", " ", html, flags=re.IGNORECASE)
    html = re.sub(r"<style[\s\S]*?</style>", " ", html, flags=re.IGNORECASE)
    html = re.sub(r"<[^>]+>", " ", html)
    html = (
        html.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
    )
    return re.sub(r"\s+", " ", html).strip()


def extract_text(mime: str, data: bytes) -> str:
    if mime in {"text/plain", "text/markdown"}:
        return data.decode("utf-8")
    if mime == "text/html":
        return strip_html(data.decode("utf-8"))
    raise ValueError("unsupported file type")
