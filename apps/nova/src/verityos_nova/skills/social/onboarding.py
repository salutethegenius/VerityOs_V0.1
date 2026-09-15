from __future__ import annotations

import json
import re
from uuid import uuid4

PHASES = [
    (
        "identity",
        "Phase 1 - Identity (who you are)",
        [
            "What is the full legal name of the business, and what do you want to be called in posts?",
            "In one or two sentences, what does the business do?",
            "Where are you based, and who is your primary customer?",
            "What is the one thing you want people to feel when they interact with your brand?",
            "What makes you different from similar businesses?",
            "Are there sister brands we should reference or avoid?",
        ],
    ),
    (
        "voice",
        "Phase 2 - Voice and tone (how you sound)",
        [
            "If your brand were a person at a dinner table, how would they speak?",
            "On a scale of 1 to 5, how formal are you?",
            "Name three brands whose tone you respect.",
            "Are there words or phrases you never want in a post?",
            "Do you use emojis, exclamation marks, or hashtags?",
            "Is humor allowed, and what kind?",
        ],
    ),
    (
        "content",
        "Phase 3 - Content territory (what you post about)",
        [
            "What are the 4 to 8 recurring content pillars?",
            "For each pillar, give one example post idea.",
            "Are there topics you never want to touch?",
        ],
    ),
    (
        "compliance",
        "Phase 4 - Constraints and compliance",
        [
            "Is Slack approval the only gate, or is there a compliance review?",
            "Are there legal disclaimers that must appear?",
            "Are there products or promotions you cannot mention?",
        ],
    ),
    (
        "platform",
        "Phase 5 - Platform behavior",
        [
            "How should voice differ between Facebook and Instagram, if at all?",
            "Preferred post length and hashtag count per platform.",
        ],
    ),
    (
        "cadence",
        "Phase 6 - Cadence",
        [
            "How often should Nova draft posts (days between drafts)?",
        ],
    ),
    (
        "visual",
        "Phase 7 - Visual identity",
        [
            "Describe colors, typography, and imagery to use or avoid.",
        ],
    ),
]

PHASE_ORDER = [p[0] for p in PHASES]


def next_phase(current: str) -> str | None:
    if current == "awaiting_approval":
        return None
    try:
        idx = PHASE_ORDER.index(current)
    except ValueError:
        return None
    if idx + 1 >= len(PHASE_ORDER):
        return "awaiting_approval"
    return PHASE_ORDER[idx + 1]


def synthesis_prompt(display_name: str, answers: dict) -> str:
    return (
        f"Synthesize a brand voice.md and config.json for {display_name} "
        "from the interview answers. Return markdown voice rules first, then a JSON object "
        "with display_name, platforms, posting_cadence_days, content_pillars, visual_identity. "
        f"Answers: {answers}"
    )


def parse_synthesis(text: str, display_name: str) -> tuple[str, dict]:
    """Split model output into voice markdown and a JSON config object."""
    voice = text.strip()
    config: dict = {
        "display_name": display_name,
        "platforms": ["facebook"],
        "posting_cadence_days": 3,
        "content_pillars": [],
        "visual_identity": {},
    }
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        try:
            parsed = json.loads(match.group(0))
            if isinstance(parsed, dict):
                config.update(parsed)
                voice = text[: match.start()].strip() or voice
        except json.JSONDecodeError:
            pass
    if not config.get("display_name"):
        config["display_name"] = display_name
    return voice, config


def apply_proposed_brand(store, session):
    from verityos_nova.store import Brand

    existing = store.get_brand(session.organization_id, session.brand_id)
    config = session.draft_config or {}
    version = session.proposed_config_version
    if version is None:
        version = (existing.config_version + 1) if existing else 1
    brand = Brand(
        organization_id=session.organization_id,
        brand_id=session.brand_id,
        display_name=session.display_name,
        active=True,
        voice_md=session.draft_voice_md or "",
        config_json=config,
        content_pillars=config.get("content_pillars") or [],
        visual_identity=config.get("visual_identity") or {},
        platforms=list(config.get("platforms") or ["facebook"]),
        posting_cadence_days=int(config.get("posting_cadence_days") or 3),
        config_version=version,
        config_hash="",
        id=existing.id if existing else str(uuid4()),
    )
    brand = store.upsert_brand(brand)
    if session.proposed_config_hash and brand.config_hash != session.proposed_config_hash:
        from verityos_nova.runtime.errors import NovaError

        raise NovaError("CONFIG_HASH_MISMATCH", "activated brand hash does not match the approved proposal", 409)
    return brand


async def synthesize_session(engine, session, actor_id: str, system_actor_id: str | None = None):
    from verityos_nova.runtime.context import NovaContext
    from verityos_nova.skills.drafting.skill import DraftingSkill
    from verityos_nova.store import canonical_config_hash

    prompt = synthesis_prompt(session.display_name, session.answers)
    outcome = await engine.run(
        DraftingSkill(),
        NovaContext(
            organization_id=session.organization_id,
            actor_id=actor_id,
            skill_id="nova.drafting",
            request={"instruction": prompt, "document_type": "general"},
            system_actor_id=system_actor_id,
        ),
    )
    voice, config = parse_synthesis(outcome.artifact or "", session.display_name)
    existing = engine.store.get_brand(session.organization_id, session.brand_id)
    version = (existing.config_version + 1) if existing else 1
    session.draft_voice_md = voice
    session.draft_config = config
    session.proposed_config_version = version
    session.proposed_config_hash = canonical_config_hash(session.brand_id, voice, config, version)
    session.execution_id = outcome.execution_id
    session.phase = "awaiting_approval"
    session.status = "proposed"
    return outcome
