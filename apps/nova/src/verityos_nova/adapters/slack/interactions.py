from __future__ import annotations

from typing import Any

from verityos_nova.adapters.slack.client import (
    SlackClient,
    draft_blocks,
    onboarding_decision_blocks,
    platform_picker_blocks,
    resolved_blocks,
)
from verityos_nova.runtime.context import NovaContext
from verityos_nova.runtime.engine import SkillEngine
from verityos_nova.runtime.errors import ConnectorUnavailableError, NovaError
from verityos_nova.runtime.registry import SkillRegistry
from verityos_nova.skills.social.onboarding import (
    apply_proposed_brand,
    synthesize_session,
)
from verityos_nova.store import Store


async def handle_interaction(
    *,
    payload: dict[str, Any],
    store: Store,
    slack: SlackClient,
    engine: SkillEngine,
    registry: SkillRegistry,
    organization_id: str,
    system_actor_id: str | None = None,
) -> dict[str, Any]:
    user_id = ((payload.get("user") or {}).get("id")) or ""
    actor_id = store.resolve_identity(organization_id, "slack", user_id)
    if not actor_id:
        return {
            "text": "Your Slack account is not linked to a VerityOS user.",
        }
    actions = payload.get("actions") or []
    if not actions:
        return {"ok": True}
    action = actions[0]
    action_id = action.get("action_id") or ""
    if action_id.startswith(("publish_", "schedule_")):
        raise ConnectorUnavailableError("meta")
    channel = ((payload.get("channel") or {}).get("id")) or ""
    message = payload.get("message") or {}
    ts = message.get("ts") or ""
    original_blocks = message.get("blocks") or []

    if action_id.startswith("gen_pick_brand_"):
        brand_id = action.get("value") or action_id.split("gen_pick_brand_", 1)[-1]
        brand = store.get_brand(organization_id, brand_id)
        platforms = (brand.platforms if brand else None) or ["facebook"]
        await slack.post_message(
            channel,
            "Pick a platform",
            blocks=platform_picker_blocks(brand_id, platforms),
        )
        return {"ok": True, "brand_id": brand_id}

    if action_id.startswith("gen_pick_platform_"):
        raw = action.get("value") or ""
        brand_id, _, platform = raw.partition(":")
        skill = registry.get("nova.social.draft")
        outcome = await engine.run(
            skill,
            NovaContext(
                organization_id=organization_id,
                actor_id=actor_id,
                skill_id="nova.social.draft",
                request={"brand_id": brand_id, "platform": platform or "facebook"},
                system_actor_id=system_actor_id,
            ),
        )
        if outcome.status == "waiting_approval" and outcome.item_id and outcome.artifact:
            item = store.get_item(outcome.item_id)
            if item:
                posted_ts = await post_draft_after_checkpoint(
                    slack,
                    channel,
                    item.id,
                    item.brand_id,
                    item.platform,
                    item.draft_text,
                    item.artifact_hash,
                )
                item.slack_message_ts = posted_ts
                item.slack_channel = channel
                store.save_item(item)
        return {"ok": True, "status": outcome.status, "execution_id": outcome.execution_id}

    if action_id.startswith(("onboard_approve_", "onboard_reject_", "onboard_regen_")):
        session_id = action.get("value") or ""
        session = store.get_session_by_id(session_id)
        if session is None:
            return {"ok": False, "error": "session_not_found"}
        if action_id.startswith("onboard_approve_"):
            apply_proposed_brand(store, session)
            session.status = "approved"
            store.save_session(session)
            await slack.update_message(channel, ts, "Brand configuration approved")
            return {"ok": True, "status": "approved", "config_hash": session.proposed_config_hash}
        if action_id.startswith("onboard_reject_"):
            session.status = "rejected"
            store.save_session(session)
            await slack.update_message(channel, ts, "Brand configuration rejected")
            return {"ok": True, "status": "rejected"}
        await synthesize_session(engine, session, actor_id, system_actor_id)
        store.save_session(session)
        await slack.update_message(
            channel,
            ts,
            session.draft_voice_md or "Regenerated proposal",
            blocks=onboarding_decision_blocks(session.id),
        )
        return {
            "ok": True,
            "status": "proposed",
            "execution_id": session.execution_id,
            "config_hash": session.proposed_config_hash,
        }

    if action_id.startswith(("approve_", "reject_")):
        item_id = (action.get("value") or "").rsplit("_", 1)[-1]
        item = store.get_item(item_id)
        if item is None:
            return {"ok": False, "error": "item_not_found"}
        allow = action_id.startswith("approve_")
        if not item.execution_id or not item.approval_id:
            return {"ok": False, "error": "missing_approval"}
        try:
            outcome = await engine.decide_social(
                execution_id=item.execution_id,
                approval_id=item.approval_id,
                actor_id=actor_id,
                allow=allow,
                artifact_hash=item.artifact_hash,
            )
        except NovaError as err:
            return {"ok": False, "error": err.code, "message": err.message}
        status = "approved" if allow else "rejected"
        await slack.update_message(
            channel,
            ts,
            f"{status}",
            blocks=resolved_blocks(original_blocks, status, user_id),
        )
        return {"ok": True, "status": outcome.status, "execution_id": outcome.execution_id}
    return {"ok": True, "ignored": action_id}


async def post_draft_after_checkpoint(
    slack: SlackClient,
    channel: str,
    item_id: str,
    brand_id: str,
    platform: str,
    draft: str,
    artifact_hash: str,
) -> str:
    msg = await slack.post_message(
        channel,
        draft,
        blocks=draft_blocks(item_id, brand_id, platform, draft, artifact_hash),
    )
    return msg.ts
