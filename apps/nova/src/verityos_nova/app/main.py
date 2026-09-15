from __future__ import annotations

import os
from dataclasses import dataclass

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from verityos_nova.adapters.slack.client import (
    FakeSlackClient,
    HttpSlackClient,
    SlackClient,
)
from verityos_nova.adapters.slack.commands import handle_command
from verityos_nova.adapters.slack.events import handle_event
from verityos_nova.adapters.slack.interactions import (
    handle_interaction,
    post_draft_after_checkpoint,
)
from verityos_nova.adapters.slack.verify import verify_slack_signature
from verityos_nova.api.health import router as health_router
from verityos_nova.api.internal import router as internal_router
from verityos_nova.persistence import PostgresStore
from verityos_nova.runtime.client import VerityCoreClient
from verityos_nova.runtime.engine import SkillEngine
from verityos_nova.runtime.errors import (
    ConnectorUnavailableError,
    NovaError,
    RuntimeConfigError,
    UnmappedActorError,
)
from verityos_nova.runtime.registry import SkillRegistry
from verityos_nova.skills.drafting.skill import DraftingSkill
from verityos_nova.skills.research.skill import ResearchSkill
from verityos_nova.skills.social.skill import SocialDraftSkill
from verityos_nova.store import MemoryStore, Store

REQUIRED_RUNTIME_ENV = (
    "DATABASE_URL",
    "CORE_API_URL",
    "NOVA_SERVICE_TOKEN",
    "NOVA_ORGANIZATION_ID",
    "NOVA_SYSTEM_ACTOR_ID",
    "NOVA_INTERNAL_TOKEN",
    "SLACK_BOT_TOKEN",
    "SLACK_SIGNING_SECRET",
    "SLACK_CONTENT_CHANNEL",
    "CRON_SECRET",
)


@dataclass
class NovaRuntime:
    organization_id: str
    system_actor_id: str
    registry: SkillRegistry
    engine: SkillEngine | None
    store: Store
    slack: SlackClient
    slack_channel: str
    slack_signing_secret: str
    cron_secret: str
    internal_token: str
    runtime_mode: bool
    client: VerityCoreClient | None = None


def build_registry(store: Store) -> SkillRegistry:
    registry = SkillRegistry()
    registry.register(SocialDraftSkill(store))
    registry.register(ResearchSkill())
    registry.register(DraftingSkill())
    return registry


def load_runtime_env(environ: dict[str, str] | None = None) -> dict[str, str]:
    source = environ if environ is not None else os.environ
    missing = [name for name in REQUIRED_RUNTIME_ENV if not (source.get(name) or "").strip()]
    if missing:
        raise RuntimeConfigError(
            "Nova runtime missing required configuration: " + ", ".join(missing)
        )
    return {name: (source.get(name) or "").strip() for name in REQUIRED_RUNTIME_ENV}


def create_app(
    *,
    store: Store | None = None,
    client: VerityCoreClient | None = None,
    slack: SlackClient | None = None,
    organization_id: str | None = None,
    system_actor_id: str | None = None,
    slack_signing_secret: str | None = None,
    cron_secret: str | None = None,
    internal_token: str | None = None,
    slack_channel: str | None = None,
    runtime_mode: bool = False,
) -> FastAPI:
    """Test-oriented factory. Inject MemoryStore / FakeSlackClient / fake Core here."""
    if runtime_mode:
        raise RuntimeConfigError("use create_runtime_app() for the real Nova runtime")
    if (
        "PYTEST_CURRENT_TEST" not in os.environ
        and store is None
        and client is None
        and slack is None
    ):
        raise RuntimeConfigError("create_app() is test-only; start Nova with create_runtime_app()")
    store = store or MemoryStore()
    slack = slack or FakeSlackClient()
    registry = build_registry(store)
    engine = SkillEngine(client, store) if client else None
    app = FastAPI(title="VerityOS Nova", version="0.10.0")
    app.state.nova = NovaRuntime(
        organization_id=organization_id or os.environ.get("NOVA_ORGANIZATION_ID") or "",
        system_actor_id=system_actor_id or os.environ.get("NOVA_SYSTEM_ACTOR_ID") or "",
        registry=registry,
        engine=engine,
        store=store,
        slack=slack,
        slack_channel=slack_channel or os.environ.get("SLACK_CONTENT_CHANNEL") or "C-test",
        slack_signing_secret=slack_signing_secret
        if slack_signing_secret is not None
        else os.environ.get("SLACK_SIGNING_SECRET") or "",
        cron_secret=cron_secret if cron_secret is not None else os.environ.get("CRON_SECRET") or "",
        internal_token=internal_token
        if internal_token is not None
        else os.environ.get("NOVA_INTERNAL_TOKEN") or "",
        runtime_mode=False,
        client=client,
    )
    _register_routes(app)
    return app


def create_runtime_app(environ: dict[str, str] | None = None) -> FastAPI:
    """Environment-backed ASGI app for non-production VerityOS deploys.

    Start with::

        uvicorn verityos_nova.app.main:create_runtime_app --factory --host 0.0.0.0 --port 8090
    """
    cfg = load_runtime_env(environ)
    store = PostgresStore(cfg["DATABASE_URL"])
    client = VerityCoreClient(cfg["CORE_API_URL"], cfg["NOVA_SERVICE_TOKEN"])
    slack = HttpSlackClient(cfg["SLACK_BOT_TOKEN"])
    registry = build_registry(store)
    engine = SkillEngine(client, store)
    app = FastAPI(title="VerityOS Nova", version="0.10.0")
    app.state.nova = NovaRuntime(
        organization_id=cfg["NOVA_ORGANIZATION_ID"],
        system_actor_id=cfg["NOVA_SYSTEM_ACTOR_ID"],
        registry=registry,
        engine=engine,
        store=store,
        slack=slack,
        slack_channel=cfg["SLACK_CONTENT_CHANNEL"],
        slack_signing_secret=cfg["SLACK_SIGNING_SECRET"],
        cron_secret=cfg["CRON_SECRET"],
        internal_token=cfg["NOVA_INTERNAL_TOKEN"],
        runtime_mode=True,
        client=client,
    )
    _register_routes(app)
    return app


REQUIRED_DEV_ENV = (
    "DATABASE_URL",
    "CORE_API_URL",
    "NOVA_SERVICE_TOKEN",
    "NOVA_ORGANIZATION_ID",
    "NOVA_SYSTEM_ACTOR_ID",
    "NOVA_INTERNAL_TOKEN",
)


def create_dev_app(
    environ: dict[str, str] | None = None,
    *,
    store: Store | None = None,
    client: VerityCoreClient | None = None,
) -> FastAPI:
    """Local/demo Nova factory. Uses FakeSlackClient; no Slack tokens required.

    Start with::

        NOVA_DEV_MODE=1 uvicorn verityos_nova.app.main:create_dev_app --factory --host 0.0.0.0 --port 8090

    Nova remains single-organization per process (`NOVA_ORGANIZATION_ID`).
    """
    source = environ if environ is not None else os.environ
    if (source.get("NOVA_DEV_MODE") or "").strip() != "1":
        raise RuntimeConfigError("create_dev_app() requires NOVA_DEV_MODE=1")
    missing = [name for name in REQUIRED_DEV_ENV if not (source.get(name) or "").strip()]
    if missing and store is None:
        raise RuntimeConfigError("Nova dev missing required configuration: " + ", ".join(missing))
    cfg = {name: (source.get(name) or "").strip() for name in REQUIRED_DEV_ENV}
    resolved_store = store or PostgresStore(cfg["DATABASE_URL"])
    resolved_client = client or VerityCoreClient(cfg["CORE_API_URL"], cfg["NOVA_SERVICE_TOKEN"])
    slack = FakeSlackClient()
    registry = build_registry(resolved_store)
    engine = SkillEngine(resolved_client, resolved_store)
    app = FastAPI(title="VerityOS Nova", version="0.10.0")
    app.state.nova = NovaRuntime(
        organization_id=cfg["NOVA_ORGANIZATION_ID"] or (source.get("NOVA_ORGANIZATION_ID") or ""),
        system_actor_id=cfg["NOVA_SYSTEM_ACTOR_ID"] or (source.get("NOVA_SYSTEM_ACTOR_ID") or ""),
        registry=registry,
        engine=engine,
        store=resolved_store,
        slack=slack,
        slack_channel=source.get("SLACK_CONTENT_CHANNEL") or "C-dev",
        slack_signing_secret="",
        cron_secret=source.get("CRON_SECRET") or "dev-cron-not-for-production",
        internal_token=cfg["NOVA_INTERNAL_TOKEN"] or (source.get("NOVA_INTERNAL_TOKEN") or ""),
        runtime_mode=False,
        client=resolved_client,
    )
    _register_routes(app)
    return app


def _register_routes(app: FastAPI) -> None:
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
        if not nova.slack_signing_secret or not verify_slack_signature(
            timestamp, signature, body, nova.slack_signing_secret
        ):
            raise HTTPException(status_code=401, detail="invalid slack signature")

    @app.post("/slack/events")
    async def slack_events(request: Request):
        body = await request.body()
        nova: NovaRuntime = request.app.state.nova
        if nova.runtime_mode or nova.slack_signing_secret:
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
        if nova.runtime_mode or nova.slack_signing_secret:
            _require_slack(request, body)
        import json
        from urllib.parse import parse_qs

        form = parse_qs(body.decode())
        payload_raw = form.get("payload", [body.decode()])[0]
        payload = json.loads(payload_raw) if payload_raw.startswith("{") else json.loads(body)
        if nova.engine is None:
            raise HTTPException(status_code=503, detail="nova engine is not configured")
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
        if nova.runtime_mode or nova.slack_signing_secret:
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
