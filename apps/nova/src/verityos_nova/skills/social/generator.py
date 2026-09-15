from __future__ import annotations

from datetime import UTC, datetime

PLATFORM_OFFSETS = {
    "facebook": 0,
    "instagram": 1,
    "linkedin": 2,
}


def normalize_pillars(raw):
    if not raw:
        return []
    out = []
    for item in raw:
        if isinstance(item, str):
            out.append({"pillar": item, "description": ""})
        elif isinstance(item, dict) and item.get("pillar"):
            out.append({"pillar": item["pillar"], "description": item.get("description", "")})
    return out


def pick_pillar(brand_config, platform=None, draft_count=0):
    """Rotate pillars deterministically with per-platform offsets.

    Uses draft_count so multiple same-day runs advance, plus a date ordinal
    so cadence-spaced days also move. Platform offsets keep Facebook /
    Instagram / LinkedIn on different pillars in the same run.
    """
    pillars = normalize_pillars(brand_config.get("content_pillars"))
    if not pillars:
        return None
    offset = PLATFORM_OFFSETS.get(platform, 0)
    idx = (int(draft_count or 0) + datetime.now(UTC).date().toordinal() + offset) % len(pillars)
    return pillars[idx]


FORMAT_RULES = (
    "Formatting (required): Write in short paragraphs or sentences only. "
    "Never use bullet points, numbered lists, markdown, or list markers. "
    "No headings, no bold or italic markup. "
    "Vary the opening line. Do not start with a slogan. "
    "Never refuse to write the post."
)

PLATFORM_FORMAT_HINTS = {
    "facebook": (
        "Facebook: conversational, community-oriented tone. Short paragraphs only. "
        "Use 2 to 4 hashtags at the end unless voice rules say otherwise."
    ),
    "instagram": (
        "Instagram: punchy opening line, line breaks for readability, hashtags and emoji per voice rules."
    ),
    "linkedin": (
        "LinkedIn: professional tone, short paragraphs, minimal hashtags unless voice rules say otherwise."
    ),
}


def build_social_prompt(voice_md: str, display_name: str, platform: str, pillar: dict | None, topic: str | None) -> str:
    format_hint = PLATFORM_FORMAT_HINTS.get(platform, "")
    pillar_line = ""
    if pillar:
        pillar_line = (
            f"Content pillar: {pillar.get('pillar')}. "
            f"{pillar.get('description') or 'Stay on this theme.'}\n"
        )
    topic_line = f"Operator topic: {topic}\n" if topic else ""
    return (
        f"{voice_md}\n\n"
        f"You are drafting a {platform} post for {display_name}.\n"
        f"{format_hint}\n"
        f"{FORMAT_RULES}\n"
        f"{pillar_line}{topic_line}"
        "Follow the voice rules exactly. Return only the post copy."
    )
