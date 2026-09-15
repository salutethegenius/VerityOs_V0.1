from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request

from verityos_nova.runtime.context import NovaContext
from verityos_nova.runtime.errors import NovaError

router = APIRouter()


def _app(request: Request):
    return request.app.state.nova


def require_internal_auth(request: Request) -> None:
    nova = _app(request)
    if not nova.internal_token:
        raise HTTPException(status_code=503, detail="internal token is not configured")
    header = request.headers.get("authorization") or ""
    if header != f"Bearer {nova.internal_token}":
        raise HTTPException(status_code=401, detail="invalid internal token")


def require_cron_auth(request: Request, x_cron_secret: str | None) -> None:
    nova = _app(request)
    if not nova.cron_secret:
        raise HTTPException(status_code=503, detail="cron secret is not configured")
    if x_cron_secret != nova.cron_secret:
        raise HTTPException(status_code=401, detail="invalid cron secret")


def locked_organization_id(nova, body: dict[str, Any]) -> str:
    requested = body.get("organization_id")
    if requested and requested != nova.organization_id:
        raise HTTPException(status_code=403, detail="organization override denied")
    return nova.organization_id


@router.get("/internal/v1/skills")
def list_skills(request: Request) -> dict[str, Any]:
    require_internal_auth(request)
    nova = _app(request)
    return {
        "skills": [
            {
                "id": m.id,
                "name": m.name,
                "version": m.version,
                "risk_tier": m.risk_tier,
                "knowledge_mode": m.knowledge_mode,
                "approval": m.approval,
            }
            for m in nova.registry.list_enabled()
        ]
    }


@router.post("/internal/v1/skills/{skill_id}/execute")
async def execute_skill(skill_id: str, request: Request) -> dict[str, Any]:
    require_internal_auth(request)
    nova = _app(request)
    if nova.engine is None:
        raise HTTPException(status_code=503, detail="nova engine is not configured")
    body = await request.json()
    try:
        skill = nova.registry.get(skill_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="skill not found") from exc
    organization_id = locked_organization_id(nova, body)
    context = NovaContext(
        organization_id=organization_id,
        actor_id=body["actor_id"],
        skill_id=skill_id,
        request=body.get("input") or body,
        system_actor_id=body.get("system_actor_id") or nova.system_actor_id,
        collection_ids=body.get("collection_ids") or [],
        knowledge_mode=body.get("knowledge_mode"),
    )
    try:
        outcome = await nova.engine.run(skill, context)
    except NovaError as err:
        raise HTTPException(status_code=err.status_code, detail={"code": err.code, "message": err.message}) from err
    return outcome.__dict__


@router.post("/internal/v1/identities")
async def map_identity(request: Request) -> dict[str, Any]:
    require_internal_auth(request)
    nova = _app(request)
    body = await request.json()
    organization_id = locked_organization_id(nova, body)
    nova.store.map_identity(
        organization_id,
        body.get("provider") or "slack",
        body["external_user_id"],
        body["verity_user_id"],
    )
    return {"ok": True}


@router.post("/generate/start")
async def generate_start(request: Request, x_cron_secret: str | None = Header(default=None, alias="X-Cron-Secret")):
    require_cron_auth(request, x_cron_secret)
    nova = _app(request)
    if nova.engine is None:
        raise HTTPException(status_code=503, detail="nova engine is not configured")
    body = await request.json()
    organization_id = locked_organization_id(nova, body)
    skill = nova.registry.get("nova.social.draft")
    context = NovaContext(
        organization_id=organization_id,
        actor_id=body.get("actor_id") or nova.system_actor_id,
        skill_id="nova.social.draft",
        request=body.get("input") or body,
        system_actor_id=body.get("system_actor_id") or nova.system_actor_id,
        collection_ids=body.get("collection_ids") or [],
    )
    outcome = await nova.engine.run(skill, context)
    if outcome.status == "waiting_approval" and outcome.item_id and outcome.artifact:
        item = nova.store.get_item(outcome.item_id)
        if item:
            ts = await request.app.state.post_draft_after_checkpoint(
                nova.slack,
                nova.slack_channel,
                item.id,
                item.brand_id,
                item.platform,
                item.draft_text,
                item.artifact_hash,
            )
            item.slack_message_ts = ts
            item.slack_channel = nova.slack_channel
            nova.store.save_item(item)
    return outcome.__dict__


@router.post("/cron/generate")
async def cron_generate(request: Request, x_cron_secret: str | None = Header(default=None, alias="X-Cron-Secret")):
    require_cron_auth(request, x_cron_secret)
    nova = _app(request)
    if nova.engine is None:
        raise HTTPException(status_code=503, detail="nova engine is not configured")
    from verityos_nova.skills.social.cadence import brands_due

    results = []
    for brand in brands_due(nova.store, nova.organization_id):
        for platform in brand.platforms or ["facebook"]:
            context = NovaContext(
                organization_id=nova.organization_id,
                actor_id=nova.system_actor_id,
                skill_id="nova.social.draft",
                request={"brand_id": brand.brand_id, "platform": platform},
                system_actor_id=nova.system_actor_id,
            )
            outcome = await nova.engine.run(nova.registry.get("nova.social.draft"), context)
            if outcome.status == "waiting_approval" and outcome.item_id and outcome.artifact:
                item = nova.store.get_item(outcome.item_id)
                if item:
                    ts = await request.app.state.post_draft_after_checkpoint(
                        nova.slack,
                        nova.slack_channel,
                        item.id,
                        item.brand_id,
                        item.platform,
                        item.draft_text,
                        item.artifact_hash,
                    )
                    item.slack_message_ts = ts
                    item.slack_channel = nova.slack_channel
                    nova.store.save_item(item)
            results.append(
                {
                    "brand_id": brand.brand_id,
                    "platform": platform,
                    "status": outcome.status,
                    "execution_id": outcome.execution_id,
                }
            )
    return {"results": results}


@router.post("/onboard/start")
async def onboard_start(request: Request, x_cron_secret: str | None = Header(default=None, alias="X-Cron-Secret")):
    require_cron_auth(request, x_cron_secret)
    nova = _app(request)
    from verityos_nova.adapters.slack.events import start_onboarding_session
    from verityos_nova.skills.social.onboarding import PHASES

    body = await request.json()
    locked_organization_id(nova, body)
    msg = await nova.slack.post_message(body.get("channel") or nova.slack_channel, "Nova onboarding started")
    session = start_onboarding_session(
        nova.store,
        organization_id=nova.organization_id,
        brand_id=body["brand_id"],
        display_name=body.get("display_name") or body["brand_id"],
        channel=body.get("channel") or nova.slack_channel,
        thread_ts=msg.ts,
    )
    title, questions = PHASES[0][1], PHASES[0][2]
    await nova.slack.post_message(
        session.channel, f"*{title}*\n" + "\n".join(f"- {q}" for q in questions), thread_ts=msg.ts
    )
    return {"ok": True, "thread_ts": msg.ts, "session_id": session.id}


@router.post("/publish")
async def publish(request: Request) -> dict[str, Any]:
    require_internal_auth(request)
    nova = _app(request)
    if nova.engine is None:
        raise HTTPException(status_code=503, detail="nova engine is not configured")
    body = await request.json()
    locked_organization_id(nova, body)
    try:
        outcome = await nova.engine.publish_social(
            execution_id=body["execution_id"],
            actor_id=body.get("actor_id") or nova.system_actor_id,
            action=body.get("action") or "publish_post",
            scheduled_for=body.get("scheduled_for"),
        )
    except NovaError as err:
        raise HTTPException(status_code=err.status_code, detail={"code": err.code, "message": err.message}) from err
    return outcome.__dict__
