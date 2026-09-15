from __future__ import annotations

import os
from uuid import uuid4

import httpx
import pytest
from fakes import FakeCoreClient
from fastapi.testclient import TestClient
from verityos_nova.adapters.slack.client import HttpSlackClient
from verityos_nova.app.main import create_app, create_runtime_app, load_runtime_env
from verityos_nova.runtime.context import (
    NovaContext,
    SkillPlan,
    SkillResult,
    ValidationResult,
)
from verityos_nova.runtime.engine import SkillEngine
from verityos_nova.runtime.errors import NovaError, RuntimeConfigError
from verityos_nova.skills.social.onboarding import (
    apply_proposed_brand,
    synthesize_session,
)
from verityos_nova.skills.social.skill import SocialDraftSkill
from verityos_nova.store import (
    Brand,
    MemoryStore,
    OnboardingSession,
    SkillRun,
    canonical_config_hash,
    sha256_text,
)

DATABASE_URL = os.environ.get("DATABASE_URL")
needs_postgres = pytest.mark.skipif(not DATABASE_URL, reason="DATABASE_URL is required")


@pytest.fixture
def store() -> MemoryStore:
    mem = MemoryStore()
    mem.upsert_brand(
        Brand(
            organization_id="org-1",
            brand_id="acme",
            display_name="Acme Co",
            active=True,
            voice_md="Warm neighbor voice.",
            config_json={"display_name": "Acme Co"},
            content_pillars=[{"pillar": "Education", "description": "teach"}],
            visual_identity={},
            platforms=["facebook"],
            posting_cadence_days=2,
            config_version=1,
            config_hash="",
        )
    )
    mem.map_identity("org-1", "slack", "U123", "user-human")
    return mem


def test_runtime_missing_config_fails_startup() -> None:
    with pytest.raises(RuntimeConfigError, match="DATABASE_URL"):
        load_runtime_env({})
    with pytest.raises(RuntimeConfigError, match="SLACK_SIGNING_SECRET"):
        create_runtime_app(
            {
                "DATABASE_URL": "postgres://x",
                "CORE_API_URL": "http://127.0.0.1:8080",
                "NOVA_SERVICE_TOKEN": "tok",
                "NOVA_ORGANIZATION_ID": "org",
                "NOVA_SYSTEM_ACTOR_ID": "user",
                "NOVA_INTERNAL_TOKEN": "int",
                "SLACK_BOT_TOKEN": "xoxb",
                "SLACK_CONTENT_CHANNEL": "C1",
                "CRON_SECRET": "cron",
            }
        )


def test_create_app_refuses_non_test_startup(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    with pytest.raises(RuntimeConfigError, match="create_runtime_app"):
        create_app()


def test_runtime_mode_slack_and_cron_fail_closed(store: MemoryStore) -> None:
    app = create_app(store=store, organization_id="org-1", system_actor_id="user-system")
    app.state.nova.runtime_mode = True
    app.state.nova.slack_signing_secret = ""
    app.state.nova.cron_secret = ""
    app.state.nova.internal_token = ""
    client = TestClient(app)
    assert client.post("/slack/events", content=b"{}").status_code == 401
    assert client.post("/cron/generate").status_code == 503
    assert client.post("/internal/v1/identities", json={}).status_code == 503
    assert client.get("/health").status_code == 200


def test_missing_cron_and_internal_secrets_fail_closed(store: MemoryStore) -> None:
    app = create_app(store=store, organization_id="org-1", system_actor_id="user-system")
    client = TestClient(app)
    assert client.post("/cron/generate").status_code == 503
    assert client.post("/generate/start", json={"brand_id": "acme"}).status_code == 503
    assert client.post("/internal/v1/identities", json={}).status_code == 503
    assert client.get("/internal/v1/skills").status_code == 503
    assert client.get("/health").status_code == 200


def test_internal_auth_and_org_override_rejected(store: MemoryStore) -> None:
    app = create_app(
        store=store,
        organization_id="org-1",
        system_actor_id="user-system",
        internal_token="internal-secret",
    )
    client = TestClient(app)
    denied = client.post(
        "/internal/v1/identities",
        json={
            "organization_id": "org-1",
            "external_user_id": "U999",
            "verity_user_id": "user-mapped",
        },
    )
    assert denied.status_code == 401
    headers = {"authorization": "Bearer internal-secret"}
    cross = client.post(
        "/internal/v1/identities",
        headers=headers,
        json={
            "organization_id": "org-other",
            "external_user_id": "U999",
            "verity_user_id": "user-mapped",
        },
    )
    assert cross.status_code == 403
    ok = client.post(
        "/internal/v1/identities",
        headers=headers,
        json={
            "organization_id": "org-1",
            "external_user_id": "U999",
            "verity_user_id": "user-mapped",
        },
    )
    assert ok.status_code == 200
    assert store.resolve_identity("org-1", "slack", "U999") == "user-mapped"


@pytest.mark.asyncio
async def test_http_slack_client_mocked_transport() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"ok": True, "ts": "123.456", "channel": "C1"})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="https://slack.com/api/")
    slack = HttpSlackClient("xoxb-test", http=http)
    posted = await slack.post_message(
        "C1",
        "hello",
        thread_ts="99.1",
        blocks=[{"type": "section", "text": {"type": "plain_text", "text": "hi"}}],
    )
    assert posted.ts == "123.456"
    updated = await slack.update_message("C1", posted.ts, "updated", blocks=[])
    assert updated.updated is True
    assert len(seen) == 2
    assert seen[0].url.path.endswith("chat.postMessage")
    assert seen[1].url.path.endswith("chat.update")
    import json

    body = json.loads(seen[0].content.decode())
    assert body["thread_ts"] == "99.1"
    assert body["blocks"]
    await http.aclose()


@pytest.mark.asyncio
async def test_postprocessed_artifact_hash_and_human_requester(store: MemoryStore) -> None:
    core = FakeCoreClient()
    core.model_text = "  padded social draft  \n"
    engine = SkillEngine(core, store)
    waiting = await engine.run(
        SocialDraftSkill(store),
        NovaContext(
            organization_id="org-1",
            actor_id="user-human",
            skill_id="nova.social.draft",
            request={"brand_id": "acme", "platform": "facebook"},
            system_actor_id="user-system",
        ),
    )
    assert waiting.artifact == "padded social draft"
    assert waiting.artifact_hash == sha256_text("padded social draft")
    assert waiting.artifact_hash != sha256_text(core.model_text)
    requested = next(kwargs for name, kwargs in core.calls if name == "request_approval")
    assert requested["requested_by"] == "user-human"
    assert requested["artifact_hash"] == waiting.artifact_hash
    approved = await engine.decide_social(
        execution_id=waiting.execution_id,
        approval_id=waiting.approval_id or "",
        actor_id="user-human",
        allow=True,
        artifact_hash=waiting.artifact_hash or "",
    )
    complete = [kwargs for name, kwargs in core.calls if name == "skill_complete"][-1]
    assert complete["result_artifact_hash"] == waiting.artifact_hash
    assert approved.status == "completed"


@pytest.mark.asyncio
async def test_existing_brand_onboarding_version_hash_stable(store: MemoryStore) -> None:
    store.upsert_brand(
        Brand(
            organization_id="org-1",
            brand_id="legacy",
            display_name="Legacy",
            active=True,
            voice_md="old voice",
            config_json={"display_name": "Legacy"},
            content_pillars=[],
            visual_identity={},
            platforms=["facebook"],
            posting_cadence_days=3,
            config_version=3,
            config_hash="",
        )
    )
    seeded = store.get_brand("org-1", "legacy")
    assert seeded is not None
    assert seeded.config_version == 3
    core = FakeCoreClient()
    core.model_text = '# Voice\nNew voice.\n{"display_name":"Legacy","content_pillars":[]}'
    engine = SkillEngine(core, store)
    session = OnboardingSession(
        organization_id="org-1",
        brand_id="legacy",
        display_name="Legacy",
        channel="C1",
        thread_ts="1.0",
        answers={"identity": ["We still sell tools"]},
    )
    await synthesize_session(engine, session, "user-human", "user-system")
    assert session.proposed_config_version == 4
    expected = canonical_config_hash(
        "legacy", session.draft_voice_md or "", session.draft_config or {}, 4
    )
    assert session.proposed_config_hash == expected
    first_hash = session.proposed_config_hash
    core.model_text = '# Voice\nNewer voice.\n{"display_name":"Legacy","content_pillars":[]}'
    await synthesize_session(engine, session, "user-human", "user-system")
    assert session.proposed_config_version == 4
    assert session.proposed_config_hash != first_hash
    regenerated_hash = canonical_config_hash(
        "legacy", session.draft_voice_md or "", session.draft_config or {}, 4
    )
    assert session.proposed_config_hash == regenerated_hash
    brand = apply_proposed_brand(store, session)
    assert brand.config_version == 4
    assert brand.config_hash == regenerated_hash
    assert brand.config_hash == session.proposed_config_hash


@pytest.mark.asyncio
async def test_unexpected_skill_exception_is_terminal(store: MemoryStore) -> None:
    class BoomSkill:
        manifest = SocialDraftSkill(store).manifest

        async def plan(self, context: NovaContext) -> SkillPlan:
            return SkillPlan(prompt="go", metadata={"brand_id": "acme"})

        async def execute(self, context: NovaContext, plan: SkillPlan, model_text: str) -> SkillResult:
            raise RuntimeError("token=supersecret")

        async def validate(self, context: NovaContext, result: SkillResult) -> ValidationResult:
            return ValidationResult(True)

    core = FakeCoreClient()
    engine = SkillEngine(core, store)
    with pytest.raises(NovaError) as raised:
        await engine.run(
            BoomSkill(),  # type: ignore[arg-type]
            NovaContext(
                organization_id="org-1",
                actor_id="user-human",
                skill_id="nova.social.draft",
                request={"brand_id": "acme"},
            ),
        )
    assert raised.value.code == "NOVA_INTERNAL_ERROR"
    assert "supersecret" not in str(raised.value)
    assert any(name == "skill_fail" for name, _ in core.calls)
    assert any(
        name == "finalize_execution" and kwargs.get("outcome") == "failed" for name, kwargs in core.calls
    )
    fail = [kwargs for name, kwargs in core.calls if name == "skill_fail"][-1]
    assert fail["reason_code"] == "NOVA_INTERNAL_ERROR"


def _seed_tenant(dsn: str) -> tuple[str, str]:
    import psycopg

    org = str(uuid4())
    user = str(uuid4())
    role = str(uuid4())
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO auth.organizations (id, name, slug) VALUES (%s, %s, %s)",
            (org, f"Org {org[:8]}", f"org-{org[:8]}"),
        )
        conn.execute(
            """
            INSERT INTO auth.users (id, email, password_hash, display_name)
            VALUES (%s, %s, %s, %s)
            """,
            (user, f"{user[:8]}@example.test", "hash", "Tester"),
        )
        conn.execute(
            "INSERT INTO auth.roles (id, organization_id, name) VALUES (%s, %s, 'admin')",
            (role, org),
        )
        conn.execute(
            """
            INSERT INTO auth.memberships (id, organization_id, user_id, role_id)
            VALUES (%s, %s, %s, %s)
            """,
            (str(uuid4()), org, user, role),
        )
    return org, user


def _insert_execution(dsn: str, org: str, actor: str) -> str:
    import psycopg

    execution_id = str(uuid4())
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(
            """
            INSERT INTO audit.executions (
              id, verity_record_id, organization_id, actor_id, skill_id, status, risk_tier
            ) VALUES (%s, %s, %s, %s, 'nova.social.draft', 'waiting_approval', 'medium')
            """,
            (execution_id, f"VTY-2026-{execution_id[:8].upper()}", org, actor),
        )
    return execution_id


def _insert_approval(dsn: str, org: str, execution_id: str, actor: str) -> str:
    import psycopg

    approval_id = str(uuid4())
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(
            """
            INSERT INTO command.approvals (
              id, organization_id, execution_id, skill_id, requested_by, status, artifact_hash
            ) VALUES (%s, %s, %s, 'nova.social.draft', %s, 'pending', %s)
            """,
            (approval_id, org, execution_id, actor, "a" * 64),
        )
    return approval_id


@needs_postgres
def test_postgres_persistence_survives_restart() -> None:
    from verityos_nova.persistence import PostgresStore
    from verityos_nova.store import ContentItem

    assert DATABASE_URL
    org, user = _seed_tenant(DATABASE_URL)
    execution_id = _insert_execution(DATABASE_URL, org, user)
    approval_id = _insert_approval(DATABASE_URL, org, execution_id, user)
    store = PostgresStore(DATABASE_URL)
    store.map_identity(org, "slack", "U-persist", user)
    store.upsert_brand(
        Brand(
            organization_id=org,
            brand_id="acme",
            display_name="Acme",
            active=True,
            voice_md="voice",
            config_json={"display_name": "Acme"},
            content_pillars=[],
            visual_identity={},
            platforms=["facebook"],
            posting_cadence_days=3,
            config_version=1,
            config_hash="",
        )
    )
    item = store.save_item(
        ContentItem(
            organization_id=org,
            brand_id="acme",
            platform="facebook",
            draft_text="pending draft",
            artifact_hash="a" * 64,
            status="pending_approval",
            execution_id=execution_id,
            verity_record_id="VTY-1",
            approval_id=approval_id,
            slack_channel="C-test",
            slack_message_ts="111.222",
        )
    )
    store.save_session(
        OnboardingSession(
            organization_id=org,
            brand_id="acme",
            display_name="Acme",
            channel="C-test",
            thread_ts="9.9",
            phase="voice",
            answers={"identity": ["hello"]},
            proposed_config_version=2,
            proposed_config_hash="b" * 64,
        )
    )
    store.save_skill_run(
        SkillRun(
            organization_id=org,
            execution_id=execution_id,
            skill_id="nova.social.draft",
            skill_version="1.0.0",
            actor_id=user,
            status="waiting_approval",
            artifact_hash="a" * 64,
        )
    )
    item_id = item.id
    store.close()

    restarted = PostgresStore(DATABASE_URL)
    assert restarted.resolve_identity(org, "slack", "U-persist") == user
    brand = restarted.get_brand(org, "acme")
    assert brand is not None
    assert brand.voice_md == "voice"
    loaded = restarted.get_item(item_id)
    assert loaded is not None
    assert loaded.status == "pending_approval"
    assert loaded.execution_id == execution_id
    assert loaded.approval_id == approval_id
    assert loaded.artifact_hash == "a" * 64
    assert loaded.slack_channel == "C-test"
    assert loaded.slack_message_ts == "111.222"
    session = restarted.get_session_by_thread(org, "9.9")
    assert session is not None
    assert session.phase == "voice"
    assert session.proposed_config_version == 2
    run = restarted.get_skill_run(org, execution_id)
    assert run is not None
    assert run.status == "waiting_approval"
    assert run.artifact_hash == "a" * 64
    restarted.close()
