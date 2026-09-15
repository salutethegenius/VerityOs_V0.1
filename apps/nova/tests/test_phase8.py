from __future__ import annotations

import hashlib
import hmac
import json
import time
from pathlib import Path

import pytest
from fakes import FakeCoreClient
from fastapi.testclient import TestClient
from verityos_nova import __version__
from verityos_nova.adapters.slack.client import (
    FakeSlackClient,
    draft_blocks,
    unique_action_id,
)
from verityos_nova.adapters.slack.interactions import (
    handle_interaction,
    post_draft_after_checkpoint,
)
from verityos_nova.adapters.slack.verify import verify_slack_signature
from verityos_nova.app.main import create_app
from verityos_nova.runtime.context import NovaContext
from verityos_nova.runtime.engine import SkillEngine
from verityos_nova.runtime.errors import (
    BrandUnavailableError,
    ConnectorUnavailableError,
    NovaError,
)
from verityos_nova.runtime.registry import SkillRegistry
from verityos_nova.skills.drafting.skill import DraftingSkill
from verityos_nova.skills.research.skill import ResearchSkill
from verityos_nova.skills.social.generator import pick_pillar
from verityos_nova.skills.social.image import generate_image_placeholder, publish_meta
from verityos_nova.skills.social.onboarding import (
    apply_proposed_brand,
    next_phase,
    synthesis_prompt,
    synthesize_session,
)
from verityos_nova.skills.social.skill import SocialDraftSkill
from verityos_nova.store import Brand, MemoryStore, canonical_config_hash, sha256_text

FORBIDDEN_BRANDS = (
    "biccu",
    "kgc",
    "lawbey",
    "kemispay",
    "kemisdigital",
    "kemisemail",
    "drewber",
    "bahamas_open_data",
)


@pytest.fixture
def store() -> MemoryStore:
    mem = MemoryStore()
    mem.upsert_brand(
        Brand(
            organization_id="org-1",
            brand_id="acme",
            display_name="Acme Co",
            active=True,
            voice_md="Warm neighbor voice. No em-dashes.",
            config_json={"display_name": "Acme Co"},
            content_pillars=[
                {"pillar": "Education", "description": "teach"},
                {"pillar": "Community", "description": "together"},
                {"pillar": "Products", "description": "tools"},
            ],
            visual_identity={},
            platforms=["facebook", "instagram"],
            posting_cadence_days=2,
            config_version=1,
            config_hash="",
        )
    )
    mem.map_identity("org-1", "slack", "U123", "user-human")
    return mem


def test_version() -> None:
    assert __version__ == "0.11.0"


def test_skill_registry_and_manifests(store: MemoryStore) -> None:
    registry = SkillRegistry()
    registry.register(SocialDraftSkill(store))
    registry.register(ResearchSkill())
    registry.register(DraftingSkill())
    ids = {m.id for m in registry.list_enabled()}
    assert ids == {"nova.social.draft", "nova.research", "nova.drafting"}
    social = registry.get("nova.social.draft")
    social.manifest.validate()
    assert social.manifest.approval["required_for_external_action"] is True


def test_brand_agnostic_core_has_no_hardcoded_brands() -> None:
    root = Path(__file__).resolve().parents[1] / "src" / "verityos_nova"
    for path in root.rglob("*.py"):
        text = path.read_text()
        for brand in FORBIDDEN_BRANDS:
            assert brand not in text, f"{brand} hardcoded in {path}"


def test_provider_direct_guard() -> None:
    root = Path(__file__).resolve().parents[1] / "src" / "verityos_nova"
    banned = ("import anthropic", "from anthropic", "import openai", "from openai", "OpenAI(", "Anthropic(")
    for path in root.rglob("*.py"):
        text = path.read_text()
        for token in banned:
            assert token not in text, f"{token} in {path}"


def test_pillar_rotation_offsets() -> None:
    config = {
        "content_pillars": [
            {"pillar": "A", "description": ""},
            {"pillar": "B", "description": ""},
            {"pillar": "C", "description": ""},
        ]
    }
    facebook = pick_pillar(config, "facebook", 0)
    instagram = pick_pillar(config, "instagram", 0)
    linkedin = pick_pillar(config, "linkedin", 0)
    assert facebook != instagram
    assert facebook != linkedin or instagram != linkedin
    later = pick_pillar(config, "facebook", 1)
    assert later != facebook


def test_slack_signature_and_replay() -> None:
    secret = "signing"
    ts = str(int(time.time()))
    body = b'{"ok":true}'
    sig = "v0=" + hmac.new(secret.encode(), f"v0:{ts}:".encode() + body, hashlib.sha256).hexdigest()
    assert verify_slack_signature(ts, sig, body, secret)
    assert not verify_slack_signature(str(int(time.time()) - 400), sig, body, secret)
    assert not verify_slack_signature(ts, "v0=deadbeef", body, secret)


@pytest.mark.asyncio
async def test_unmapped_slack_user_denied(store: MemoryStore) -> None:
    from verityos_nova.adapters.slack.events import handle_event
    from verityos_nova.runtime.errors import UnmappedActorError

    store.save_session(
        __import__("verityos_nova.store", fromlist=["OnboardingSession"]).OnboardingSession(
            organization_id="org-1",
            brand_id="acme",
            display_name="Acme",
            channel="C1",
            thread_ts="1.0",
        )
    )
    with pytest.raises(UnmappedActorError):
        await handle_event(
            store=store,
            slack=FakeSlackClient(),
            organization_id="org-1",
            event={"event": {"channel": "C1", "thread_ts": "1.0", "user": "U-unknown", "text": "hello", "type": "message"}},
        )


@pytest.mark.asyncio
async def test_private_channel_onboarding_path(store: MemoryStore) -> None:
    from verityos_nova.adapters.slack.events import (
        handle_event,
        start_onboarding_session,
    )

    slack = FakeSlackClient()
    session = start_onboarding_session(
        store,
        organization_id="org-1",
        brand_id="acme",
        display_name="Acme",
        channel="CGROUP",
        thread_ts="99.1",
    )
    result = await handle_event(
        store=store,
        slack=slack,
        organization_id="org-1",
        event={"event": {"channel": "CGROUP", "thread_ts": session.thread_ts, "user": "U123", "text": "We sell shoes", "type": "message"}},
    )
    assert result["recorded"] is True
    nxt = await handle_event(
        store=store,
        slack=slack,
        organization_id="org-1",
        event={"event": {"channel": "CGROUP", "thread_ts": session.thread_ts, "user": "U123", "text": "next", "type": "message"}},
    )
    assert nxt["phase"] == next_phase("identity")
    assert any(m.thread_ts == session.thread_ts for m in slack.posted)


@pytest.mark.asyncio
async def test_social_e2e_approve_and_reject(store: MemoryStore) -> None:
    core = FakeCoreClient()
    engine = SkillEngine(core, store)  # type: ignore[arg-type]
    skill = SocialDraftSkill(store)
    slack = FakeSlackClient()
    ctx = NovaContext(
        organization_id="org-1",
        actor_id="user-human",
        skill_id="nova.social.draft",
        request={"brand_id": "acme", "platform": "facebook"},
        system_actor_id="user-system",
    )
    waiting = await engine.run(skill, ctx)
    assert waiting.status == "waiting_approval"
    assert waiting.artifact_hash == sha256_text(waiting.artifact or "")
    assert "nova.skill.started" in waiting.events
    assert "approval.requested" in waiting.events
    assert any(name == "skill_start" for name, _ in core.calls)
    requested = [kwargs for name, kwargs in core.calls if name == "request_approval"]
    assert requested
    assert all(call["requested_by"] == "user-human" for call in requested)
    item = store.get_item(waiting.item_id)
    assert item is not None
    ts = await post_draft_after_checkpoint(
        slack, "C-test", item.id, item.brand_id, item.platform, item.draft_text, item.artifact_hash
    )
    item.slack_message_ts = ts
    assert slack.posted[0].text == item.draft_text

    approved = await engine.decide_social(
        execution_id=waiting.execution_id,
        approval_id=waiting.approval_id or "",
        actor_id="user-human",
        allow=True,
        artifact_hash=waiting.artifact_hash or "",
    )
    assert approved.status == "approved"
    assert store.get_item(item.id).status == "approved"
    published = await engine.publish_social(
        execution_id=waiting.execution_id,
        actor_id="user-human",
        action="publish_post",
    )
    assert published.status == "completed"
    assert store.get_item(item.id).status == "posted"
    assert any(name == "request_connector_action" for name, _ in core.calls)
    assert any(name == "skill_complete" for name, _ in core.calls)
    assert any(name == "finalize_execution" for name, _ in core.calls)

    core2 = FakeCoreClient()
    engine2 = SkillEngine(core2, store)  # type: ignore[arg-type]
    waiting2 = await engine2.run(skill, ctx)
    rejected = await engine2.decide_social(
        execution_id=waiting2.execution_id,
        approval_id=waiting2.approval_id or "",
        actor_id="user-human",
        allow=False,
        artifact_hash=waiting2.artifact_hash or "",
    )
    assert rejected.status == "blocked"
    assert any(name == "skill_fail" for name, _ in core2.calls)


@pytest.mark.asyncio
async def test_changed_artifact_invalidates_approval(store: MemoryStore) -> None:
    core = FakeCoreClient()
    engine = SkillEngine(core, store)  # type: ignore[arg-type]
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
    with pytest.raises(NovaError) as raised:
        await engine.decide_social(
            execution_id=waiting.execution_id,
            approval_id=waiting.approval_id or "",
            actor_id="user-human",
            allow=True,
            artifact_hash=sha256_text("tampered"),
        )
    assert raised.value.code == "ARTIFACT_HASH_MISMATCH"


@pytest.mark.asyncio
async def test_research_citations_and_insufficient(store: MemoryStore) -> None:
    core = FakeCoreClient()
    engine = SkillEngine(core, store)  # type: ignore[arg-type]
    ctx = NovaContext(
        organization_id="org-1",
        actor_id="user-human",
        skill_id="nova.research",
        request={"question": "What is the capital of France?", "collection_ids": ["c1"]},
        collection_ids=["c1"],
        knowledge_mode="strict",
    )
    done = await engine.run(ResearchSkill(), ctx)
    assert done.status == "completed"
    assert done.citations
    assert done.verity_record_id

    core.insufficient = True
    blocked = await engine.run(ResearchSkill(), ctx)
    assert blocked.status == "blocked"
    assert any(name == "skill_fail" for name, _ in core.calls)


@pytest.mark.asyncio
async def test_drafting_skill(store: MemoryStore) -> None:
    core = FakeCoreClient()
    engine = SkillEngine(core, store)  # type: ignore[arg-type]
    done = await engine.run(
        DraftingSkill(),
        NovaContext(
            organization_id="org-1",
            actor_id="user-human",
            skill_id="nova.drafting",
            request={"instruction": "Write a memo about office hours", "document_type": "memo"},
        ),
    )
    assert done.status == "completed"
    assert done.artifact_hash
    assert "finalize.completed" in done.events


@pytest.mark.asyncio
async def test_onboarding_governed_synthesis(store: MemoryStore) -> None:
    core = FakeCoreClient()
    core.model_text = '# Voice\nBe kind.\n{"display_name":"Acme","content_pillars":[{"pillar":"Education"}]}'
    engine = SkillEngine(core, store)  # type: ignore[arg-type]
    from verityos_nova.adapters.slack.events import start_onboarding_session

    session = start_onboarding_session(
        store,
        organization_id="org-1",
        brand_id="acme-onboard",
        display_name="Acme Co",
        channel="C1",
        thread_ts="10.0",
    )
    session.answers = {"identity": ["We sell tools"]}
    outcome = await synthesize_session(engine, session, "user-human", "user-system")
    store.save_session(session)
    assert outcome.status == "completed"
    assert any(name == "execute_model" for name, _ in core.calls)
    assert session.status == "proposed"
    assert session.draft_voice_md
    assert session.proposed_config_hash
    brand = apply_proposed_brand(store, session)
    session.status = "approved"
    store.save_session(session)
    assert brand.config_version >= 1
    assert brand.config_hash == session.proposed_config_hash
    assert brand.config_hash == canonical_config_hash(
        brand.brand_id, brand.voice_md, brand.config_json, brand.config_version
    )
    assert store.get_brand("org-1", "acme-onboard") is not None

    first_hash = session.proposed_config_hash
    core.model_text = '# Voice\nBe bolder.\n{"display_name":"Acme","content_pillars":[{"pillar":"Community"}]}'
    regenerated = await synthesize_session(engine, session, "user-human", "user-system")
    assert regenerated.execution_id != outcome.execution_id
    assert session.status == "proposed"
    assert session.proposed_config_version == brand.config_version + 1
    assert session.proposed_config_hash != first_hash
    apply_proposed_brand(store, session)
    updated = store.get_brand("org-1", "acme-onboard")
    assert updated is not None
    assert updated.config_version == brand.config_version + 1
    assert updated.config_hash == session.proposed_config_hash
    assert synthesis_prompt("Acme Co", {"identity": ["We sell tools"]})


def test_meta_unavailable() -> None:
    with pytest.raises(ConnectorUnavailableError):
        publish_meta()


def test_cron_uses_system_actor(store: MemoryStore) -> None:
    core = FakeCoreClient()
    app = create_app(
        store=store,
        client=core,  # type: ignore[arg-type]
        slack=FakeSlackClient(),
        organization_id="org-1",
        system_actor_id="user-system",
    )
    app.state.nova.cron_secret = "s3cret"
    client = TestClient(app)
    response = client.post("/cron/generate", headers={"X-Cron-Secret": "s3cret"})
    assert response.status_code == 200
    opens = [kwargs for name, kwargs in core.calls if name == "open_execution"]
    assert opens
    assert all(call["actor_id"] == "user-system" for call in opens)
    requested = [kwargs for name, kwargs in core.calls if name == "request_approval"]
    assert requested
    assert all(call["requested_by"] == "user-system" for call in requested)


def test_health_and_skills_api(store: MemoryStore) -> None:
    app = create_app(
        store=store,
        organization_id="org-1",
        system_actor_id="user-system",
        internal_token="internal-secret",
    )
    client = TestClient(app)
    health = client.get("/health")
    assert health.json()["phase"] == "11"
    denied = client.get("/internal/v1/skills")
    assert denied.status_code == 401
    skills = client.get("/internal/v1/skills", headers={"authorization": "Bearer internal-secret"})
    assert len(skills.json()["skills"]) == 3


def test_slack_events_signature_required(store: MemoryStore) -> None:
    app = create_app(store=store, organization_id="org-1", system_actor_id="user-system")
    app.state.nova.slack_signing_secret = "signing"
    client = TestClient(app)
    body = json.dumps({"type": "url_verification", "challenge": "abc"})
    denied = client.post("/slack/events", content=body, headers={"content-type": "application/json"})
    assert denied.status_code == 401
    ts = str(int(time.time()))
    sig = "v0=" + hmac.new(b"signing", f"v0:{ts}:".encode() + body.encode(), hashlib.sha256).hexdigest()
    ok = client.post(
        "/slack/events",
        content=body,
        headers={
            "content-type": "application/json",
            "x-slack-request-timestamp": ts,
            "x-slack-signature": sig,
        },
    )
    assert ok.status_code == 200
    assert ok.json()["challenge"] == "abc"


def test_same_execution_id_through_skill_knowledge_model(store: MemoryStore) -> None:
    import asyncio

    core = FakeCoreClient()
    engine = SkillEngine(core, store)  # type: ignore[arg-type]
    asyncio.run(
        engine.run(
            ResearchSkill(),
            NovaContext(
                organization_id="org-1",
                actor_id="user-human",
                skill_id="nova.research",
                request={"question": "capital?", "collection_ids": ["c1"]},
                collection_ids=["c1"],
                knowledge_mode="grounded",
            ),
        )
    )
    eids = [val["execution_id"] for name, val in core.calls if name != "open_execution" and "execution_id" in val]
    assert len(set(eids)) == 1


def test_unique_action_ids() -> None:
    blocks = draft_blocks("item-1", "acme", "facebook", "hello", "a" * 64)
    ids = [el["action_id"] for b in blocks if b.get("type") == "actions" for el in b["elements"]]
    assert len(ids) == len(set(ids))
    assert unique_action_id("approve", "item-1") != unique_action_id("reject", "item-1")


def test_external_identity_mapping(store: MemoryStore) -> None:
    assert store.resolve_identity("org-1", "slack", "U123") == "user-human"
    assert store.resolve_identity("org-1", "slack", "U-unknown") is None
    client = TestClient(
        create_app(
            store=store,
            organization_id="org-1",
            system_actor_id="user-system",
            internal_token="internal-secret",
        )
    )
    mapped = client.post(
        "/internal/v1/identities",
        headers={"authorization": "Bearer internal-secret"},
        json={
            "organization_id": "org-1",
            "provider": "slack",
            "external_user_id": "U999",
            "verity_user_id": "user-mapped",
        },
    )
    assert mapped.status_code == 200
    assert store.resolve_identity("org-1", "slack", "U999") == "user-mapped"


@pytest.mark.asyncio
async def test_brand_unavailable(store: MemoryStore) -> None:
    core = FakeCoreClient()
    engine = SkillEngine(core, store)  # type: ignore[arg-type]
    with pytest.raises(BrandUnavailableError):
        await engine.run(
            SocialDraftSkill(store),
            NovaContext(
                organization_id="org-1",
                actor_id="user-human",
                skill_id="nova.social.draft",
                request={"brand_id": "missing", "platform": "facebook"},
            ),
        )
    assert any(name == "skill_fail" for name, _ in core.calls)
    assert any(name == "finalize_execution" for name, _ in core.calls)


@pytest.mark.asyncio
async def test_slack_generate_then_approve(store: MemoryStore) -> None:
    core = FakeCoreClient()
    slack = FakeSlackClient()
    engine = SkillEngine(core, store)  # type: ignore[arg-type]
    registry = SkillRegistry()
    registry.register(SocialDraftSkill(store))
    picked = await handle_interaction(
        payload={
            "user": {"id": "U123"},
            "channel": {"id": "C-test"},
            "actions": [{"action_id": "gen_pick_brand_acme", "value": "acme"}],
        },
        store=store,
        slack=slack,
        engine=engine,
        registry=registry,
        organization_id="org-1",
        system_actor_id="user-system",
    )
    assert picked["brand_id"] == "acme"
    generated = await handle_interaction(
        payload={
            "user": {"id": "U123"},
            "channel": {"id": "C-test"},
            "actions": [{"action_id": "gen_pick_platform_acme_facebook", "value": "acme:facebook"}],
        },
        store=store,
        slack=slack,
        engine=engine,
        registry=registry,
        organization_id="org-1",
        system_actor_id="user-system",
    )
    assert generated["status"] == "waiting_approval"
    assert slack.posted[-1].text
    item = next(iter(store.list_items("org-1")), None)
    assert item is not None
    approved = await handle_interaction(
        payload={
            "user": {"id": "U123"},
            "channel": {"id": "C-test"},
            "message": {"ts": slack.posted[-1].ts, "blocks": slack.posted[-1].blocks},
            "actions": [{"action_id": f"approve_{item.id}", "value": f"approve_{item.id}"}],
        },
        store=store,
        slack=slack,
        engine=engine,
        registry=registry,
        organization_id="org-1",
        system_actor_id="user-system",
    )
    assert approved["status"] == "approved"
    assert store.get_item(item.id).status == "approved"
    published = await handle_interaction(
        payload={
            "user": {"id": "U123"},
            "channel": {"id": "C-test"},
            "message": {"ts": slack.posted[-1].ts, "blocks": slack.posted[-1].blocks},
            "actions": [{"action_id": f"publish_now_{item.id}", "value": item.id}],
        },
        store=store,
        slack=slack,
        engine=engine,
        registry=registry,
        organization_id="org-1",
        system_actor_id="user-system",
    )
    assert published["status"] == "completed"
    assert store.get_item(item.id).status == "posted"


def test_image_placeholder_hash() -> None:
    image = generate_image_placeholder("hello draft", "acme")
    assert len(image["artifact_hash"]) == 64


def test_content_loop_production_untouched() -> None:
    root = Path(__file__).resolve().parents[3]
    assert not (root / "app" / "core" / "content_loop.py").exists()
    assert not (root / "app" / "core" / "meta_publisher.py").exists()
    doc = (root / "docs" / "migration" / "nova-phase8.md").read_text()
    assert "ba9f5634a33bcf064561cad73966eab72a2cf896" in doc
    assert "not modified" in doc.lower() or "were **not modified**" in doc
