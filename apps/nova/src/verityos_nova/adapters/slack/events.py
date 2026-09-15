from __future__ import annotations

from typing import Any

from verityos_nova.adapters.slack.client import SlackClient, onboarding_decision_blocks
from verityos_nova.runtime.engine import SkillEngine
from verityos_nova.runtime.errors import UnmappedActorError
from verityos_nova.skills.social.onboarding import (
    PHASES,
    next_phase,
    synthesize_session,
)
from verityos_nova.store import OnboardingSession, Store


async def handle_event(
    *,
    store: Store,
    slack: SlackClient,
    organization_id: str,
    event: dict[str, Any],
    engine: SkillEngine | None = None,
    system_actor_id: str | None = None,
) -> dict[str, Any]:
    """Private-channel thread replies drive onboarding. message.groups is required live."""
    if event.get("type") == "url_verification":
        return {"challenge": event.get("challenge")}
    inner = event.get("event") or event
    if inner.get("bot_id"):
        return {"ok": True, "ignored": "bot"}
    channel = inner.get("channel")
    thread_ts = inner.get("thread_ts") or inner.get("ts")
    text = (inner.get("text") or "").strip()
    session = store.get_session_by_thread(organization_id, thread_ts)
    if session is None:
        return {"ok": True, "ignored": "no_session"}
    user = inner.get("user")
    actor = store.resolve_identity(organization_id, "slack", user or "")
    if not actor:
        raise UnmappedActorError()
    phase_answers = list(session.answers.get(session.phase) or [])
    if text.lower() == "next":
        nxt = next_phase(session.phase)
        if nxt is None or nxt == "awaiting_approval":
            session.phase = "awaiting_approval"
            if engine is not None:
                await synthesize_session(engine, session, actor, system_actor_id)
                store.save_session(session)
                await slack.post_message(
                    channel,
                    session.draft_voice_md or "Proposed brand configuration",
                    thread_ts=thread_ts,
                    blocks=onboarding_decision_blocks(session.id),
                )
                return {"ok": True, "phase": session.phase, "status": session.status}
        else:
            session.phase = nxt
            title = next(p[1] for p in PHASES if p[0] == nxt)
            questions = next(p[2] for p in PHASES if p[0] == nxt)
            await slack.post_message(
                channel,
                f"*{title}*\n" + "\n".join(f"- {q}" for q in questions),
                thread_ts=thread_ts,
            )
        store.save_session(session)
        return {"ok": True, "phase": session.phase}
    phase_answers.append(text)
    session.answers[session.phase] = phase_answers
    store.save_session(session)
    return {"ok": True, "recorded": True}


def start_onboarding_session(
    store: Store,
    *,
    organization_id: str,
    brand_id: str,
    display_name: str,
    channel: str,
    thread_ts: str,
) -> OnboardingSession:
    session = OnboardingSession(
        organization_id=organization_id,
        brand_id=brand_id,
        display_name=display_name,
        channel=channel,
        thread_ts=thread_ts,
    )
    return store.save_session(session)
