from __future__ import annotations

import os
from dataclasses import dataclass

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from verityos_nova.adapters.slack.client import FakeSlackClient, SlackClient
from verityos_nova.adapters.slack.commands import handle_command
from verityos_nova.adapters.slack.events import handle_event
from verityos_nova.adapters.slack.interactions import (
    handle_interaction,
    post_draft_after_checkpoint,
)
from verityos_nova.adapters.slack.verify import verify_slack_signature
from verityos_nova.api.health import router as health_router
from verityos_nova.api.internal import router as internal_router
from verityos_nova.runtime.client import VerityCoreClient
from verityos_nova.runtime.engine import SkillEngine
from verityos_nova.runtime.errors import (
    ConnectorUnavailableError,
    NovaError,
    UnmappedActorError,
)
from verityos_nova.runtime.registry import SkillRegistry
from verityos_nova.skills.drafting.skill import DraftingSkill
from verityos_nova.skills.research.skill import ResearchSkill
from verityos_nova.skills.social.skill import SocialDraftSkill
from verityos_nova.store import MemoryStore


@dataclass
class NovaRuntime:
    organization_id: str
    system_actor_id: str
    registry: SkillRegistry
    engine: SkillEngine
    store: MemoryStore
    slack: SlackClient
    slack_channel: str
    slack_signing_secret: str
    cron_secret: str
    client: VerityCoreClient | None = None


def build_registry(store: MemoryStore) -> SkillRegistry:
    registry = SkillRegistry()
    registry.register(SocialDraftSkill(store))
    registry.register(ResearchSkill())
    registry.register(DraftingSkill())
    return registry


def create_app(
    *,
    store: MemoryStore | None = None,
    client: VerityCoreClient | None = None,
    slack: SlackClient | None = None,
    organization_id: str | None = None,
    system_actor_id: str | None = None,
) -> FastAPI:
    store = store or MemoryStore()
    slack = slack or FakeSlackClient()
    registry = build_registry(store)
    engine = SkillEngine(client, store) if client else None
    app = FastAPI(title="VerityOS Nova", version="0.8.0")
    app.state.nova = NovaRuntime(
        organization_id=organization_id or os.environ.get("NOVA_ORGANIZATION_ID") or "",
        system_actor_id=system_actor_id or os.environ.get("NOVA_SYSTEM_ACTOR_ID") or "",
        registry=registry,
        engine=engine,  # type: ignore[arg-type]
        store=store,
        slack=slack,
        slack_channel=os.environ.get("SLACK_CONTENT_CHANNEL") or "C-test",
        slack_signing_secret=os.environ.get("SLACK_SIGNING_SECRET") or "",
        cron_secret=os.environ.get("CRON_SECRET") or "",
        client=client,
    )
    app.include_router(health_router)
    app.include_router(internal_router)

    @app.exception_handler(UnmappedActorError)
    async def unmapped_handler(_request: Request, err: UnmappedActorError) -> JSONResponse:
        return JSONResponse({"text": err.message, "error": {"code": err.code, "message": err.message}}, status_code=403)

    @app.exception_handler(ConnectorUnavailableError)
    async def connector_handler(_request: Request, err: ConnectorUnavailableError) -> JSONResponse:
        return JSONResponse({"error": {"code": err.code, "message": err.message}}, status_code=409)

    @app.exception_handler(NovaError)
    async def nova_handler(_request: Request, err: NovaError) -> JSONResponse:
        return JSONResponse({"error": {"code": err.code, "message": err.message}}, status_code=err.status_code)

    def _require_slack(request: Request, body: bytes) -> None:
        nova: NovaRuntime = request.app.state.nova
        timestamp = request.headers.get("x-slack-request-timestamp") or ""
        signature = request.headers.get("x-slack-signature") or ""
        if not verify_slack_signature(timestamp, signature, body, nova.slack_signing_secret):
            raise HTTPException(status_code=401, detail="invalid slack signature")

    @app.post("/slack/events")
    async def slack_events(request: Request):
        body = await request.body()
        nova: NovaRuntime = request.app.state.nova
        if nova.slack_signing_secret:
            _require_slack(request, body)
        import json as jsonlib

        payload = jsonlib.loads(body.decode() or "{}")
        if payload.get("type") == "url_verification":
            return {"challenge": payload.get("challenge")}
        return await handle_event(
            store=nova.store,
            slack=nova.slack,
            organization_id=nova.organization_id,
            event=payload,
            engine=nova.engine,
            system_actor_id=nova.system_actor_id,
        )

    @app.post("/slack/interactions")
    async def slack_interactions(request: Request):
        body = await request.body()
        nova: NovaRuntime = request.app.state.nova
        if nova.slack_signing_secret:
            _require_slack(request, body)
        import json
        from urllib.parse import parse_qs

        form = parse_qs(body.decode())
        payload_raw = form.get("payload", [body.decode()])[0]
        payload = json.loads(payload_raw) if payload_raw.startswith("{") else json.loads(body)
        return await handle_interaction(
            payload=payload,
            store=nova.store,
            slack=nova.slack,
            engine=nova.engine,
            registry=nova.registry,
            organization_id=nova.organization_id,
            system_actor_id=nova.system_actor_id,
        )

    @app.post("/slack/commands")
    async def slack_commands(request: Request):
        body = await request.body()
        nova: NovaRuntime = request.app.state.nova
        if nova.slack_signing_secret:
            _require_slack(request, body)
        from urllib.parse import parse_qs

        form = parse_qs(body.decode())
        text = (form.get("text") or [""])[0]
        user_id = (form.get("user_id") or [""])[0]
        channel = (form.get("channel_id") or [nova.slack_channel])[0]
        return await handle_command(
            text=text,
            user_id=user_id,
            store=nova.store,
            slack=nova.slack,
            organization_id=nova.organization_id,
            channel=channel,
        )

    app.state.post_draft_after_checkpoint = post_draft_after_checkpoint
    return app


def app_from_env() -> FastAPI:
    token = os.environ.get("NOVA_SERVICE_TOKEN") or ""
    base = os.environ.get("CORE_API_URL") or "http://127.0.0.1:8080"
    client = VerityCoreClient(base, token) if token else None
    return create_app(client=client)


app = create_app()
