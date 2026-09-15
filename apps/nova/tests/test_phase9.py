from __future__ import annotations

from pathlib import Path

import pytest

from verityos_nova.adapters.slack.client import publish_action_blocks, unique_action_id
from verityos_nova.adapters.slack.interactions import handle_interaction
from verityos_nova.runtime.context import NovaContext
from verityos_nova.runtime.engine import SkillEngine
from verityos_nova.runtime.errors import ConnectorUnavailableError, NovaError
from verityos_nova.runtime.registry import SkillRegistry
from verityos_nova.skills.social.skill import SocialDraftSkill
from verityos_nova.store import Brand, MemoryStore, sha256_text

from fakes import FakeCoreClient, FakeSlackClient

NOVA_ROOT = Path(__file__).resolve().parents[1] / "src" / "verityos_nova"
REPO_ROOT = Path(__file__).resolve().parents[3]


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


def _nova_source() -> str:
    parts = [path.read_text() for path in NOVA_ROOT.rglob("*.py")]
    return "\n".join(parts)


def test_nova_never_holds_meta_secrets_or_http() -> None:
    source = _nova_source()
    assert "graph.facebook.com" not in source
    assert "GRAPH_BASE" not in source
    assert "META_PAGE_ACCESS_TOKEN" not in source
    assert "page_access_token" not in source


def test_exact_byte_artifact_hash() -> None:
    text = "Exact approved Facebook draft"
    assert sha256_text(text) == sha256_text("Exact approved Facebook draft")
    assert sha256_text(text) != sha256_text(text + " ")
    assert sha256_text("café") != sha256_text("cafe")


def test_publish_and_schedule_action_ids_are_unique() -> None:
    item_id = "item-42"
    blocks = publish_action_blocks(item_id)
    ids = [el["action_id"] for b in blocks if b.get("type") == "actions" for el in b["elements"]]
    assert len(ids) == 2
    assert len(set(ids)) == 2
    assert unique_action_id("publish_now", item_id) != unique_action_id("schedule_now", item_id)
    assert unique_action_id("publish_now", item_id).startswith("publish_now_")
    assert unique_action_id("schedule_now", item_id).startswith("schedule_now_")


@pytest.mark.asyncio
async def test_approved_artifact_is_sent_to_core_without_token(store: MemoryStore) -> None:
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
    assert waiting.artifact_hash == sha256_text(waiting.artifact or "")
    await engine.decide_social(
        execution_id=waiting.execution_id,
        approval_id=waiting.approval_id or "",
        actor_id="user-human",
        allow=True,
        artifact_hash=waiting.artifact_hash or "",
    )
    published = await engine.publish_social(
        execution_id=waiting.execution_id,
        actor_id="user-human",
        action="publish_post",
    )
    assert published.status == "completed"
    request = next(kwargs for name, kwargs in core.calls if name == "request_connector_action")
    assert request["artifact_hash"] == waiting.artifact_hash
    assert request["payload"]["message"] == waiting.artifact
    assert sha256_text(request["payload"]["message"]) == waiting.artifact_hash
    blob = str(request).lower()
    assert "access_token" not in blob
    assert "fake-page-token" not in str(core.calls)


@pytest.mark.asyncio
async def test_rejected_approval_never_calls_connector(store: MemoryStore) -> None:
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
    rejected = await engine.decide_social(
        execution_id=waiting.execution_id,
        approval_id=waiting.approval_id or "",
        actor_id="user-human",
        allow=False,
        artifact_hash=waiting.artifact_hash or "",
    )
    assert rejected.status == "blocked"
    assert store.get_item(waiting.item_id or "").status == "rejected"
    with pytest.raises(NovaError) as raised:
        await engine.publish_social(execution_id=waiting.execution_id, actor_id="user-human")
    assert raised.value.code == "INVALID_STATE"
    assert not any(name == "request_connector_action" for name, _ in core.calls)


@pytest.mark.asyncio
async def test_needs_review_does_not_finalize(store: MemoryStore) -> None:
    core = FakeCoreClient()
    core.connector_status = "needs_review"
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
    await engine.decide_social(
        execution_id=waiting.execution_id,
        approval_id=waiting.approval_id or "",
        actor_id="user-human",
        allow=True,
        artifact_hash=waiting.artifact_hash or "",
    )
    outcome = await engine.publish_social(execution_id=waiting.execution_id, actor_id="user-human")
    assert outcome.status == "needs_review"
    assert store.get_item(waiting.item_id or "").status == "needs_review"
    assert not any(
        name == "finalize_execution" and kwargs.get("outcome") == "completed" for name, kwargs in core.calls
    )


@pytest.mark.asyncio
async def test_legacy_publish_button_stays_unavailable(store: MemoryStore) -> None:
    slack = FakeSlackClient()
    engine = SkillEngine(FakeCoreClient(), store)  # type: ignore[arg-type]
    registry = SkillRegistry()
    with pytest.raises(ConnectorUnavailableError):
        await handle_interaction(
            payload={
                "user": {"id": "U123"},
                "channel": {"id": "C-test"},
                "actions": [{"action_id": "publish_item-1", "value": "item-1"}],
            },
            store=store,
            slack=slack,
            engine=engine,
            registry=registry,
            organization_id="org-1",
        )


def test_content_loop_and_production_meta_untouched() -> None:
    assert not (REPO_ROOT / "app" / "core" / "meta_publisher.py").exists()
    assert not (REPO_ROOT / "app" / "core" / "content_loop.py").exists()
    connectors = (REPO_ROOT / "docs" / "architecture" / "connectors.md").read_text()
    assert "Production Content-Loop" in connectors
    assert "BICCU" not in (REPO_ROOT / "packages" / "connectors" / "src" / "meta-facebook.ts").read_text()
