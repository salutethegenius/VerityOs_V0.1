from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Protocol
from uuid import uuid4


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def canonical_config_hash(brand_id: str, voice_md: str, config: dict[str, Any], version: int) -> str:
    payload = {
        "brand_id": brand_id,
        "config_version": version,
        "voice_md": voice_md,
        "config": config,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return sha256_text(encoded)


@dataclass
class Brand:
    organization_id: str
    brand_id: str
    display_name: str
    active: bool
    voice_md: str
    config_json: dict[str, Any]
    content_pillars: list[Any]
    visual_identity: dict[str, Any]
    platforms: list[str]
    posting_cadence_days: int
    config_version: int
    config_hash: str
    id: str = field(default_factory=lambda: str(uuid4()))


@dataclass
class ContentItem:
    organization_id: str
    brand_id: str
    platform: str
    draft_text: str
    artifact_hash: str
    status: str
    execution_id: str | None = None
    verity_record_id: str | None = None
    approval_id: str | None = None
    pillar: str | None = None
    slack_channel: str | None = None
    slack_message_ts: str | None = None
    id: str = field(default_factory=lambda: str(uuid4()))
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass
class OnboardingSession:
    organization_id: str
    brand_id: str
    display_name: str
    channel: str
    thread_ts: str
    phase: str = "identity"
    answers: dict[str, Any] = field(default_factory=dict)
    draft_voice_md: str | None = None
    draft_config: dict[str, Any] | None = None
    proposed_config_hash: str | None = None
    proposed_config_version: int | None = None
    execution_id: str | None = None
    status: str = "in_progress"
    id: str = field(default_factory=lambda: str(uuid4()))


@dataclass
class SkillRun:
    organization_id: str
    execution_id: str
    skill_id: str
    skill_version: str
    actor_id: str
    status: str
    config_hash: str | None = None
    artifact_hash: str | None = None
    id: str = field(default_factory=lambda: str(uuid4()))


class Store(Protocol):
    def map_identity(
        self, organization_id: str, provider: str, external_user_id: str, verity_user_id: str
    ) -> None: ...

    def resolve_identity(self, organization_id: str, provider: str, external_user_id: str) -> str | None: ...

    def upsert_brand(self, brand: Brand) -> Brand: ...

    def get_brand(self, organization_id: str, brand_id: str) -> Brand | None: ...

    def list_active_brands(self, organization_id: str) -> list[Brand]: ...

    def save_item(self, item: ContentItem) -> ContentItem: ...

    def get_item(self, item_id: str) -> ContentItem | None: ...

    def get_item_by_execution(self, execution_id: str) -> ContentItem | None: ...

    def list_items(self, organization_id: str, brand_id: str | None = None) -> list[ContentItem]: ...

    def count_drafts(self, organization_id: str, brand_id: str, platform: str) -> int: ...

    def pending_backlog(self, organization_id: str, brand_id: str) -> bool: ...

    def last_activity(self, organization_id: str, brand_id: str) -> datetime | None: ...

    def save_session(self, session: OnboardingSession) -> OnboardingSession: ...

    def get_session(self, organization_id: str, brand_id: str) -> OnboardingSession | None: ...

    def get_session_by_thread(self, organization_id: str, thread_ts: str) -> OnboardingSession | None: ...

    def get_session_by_id(self, session_id: str) -> OnboardingSession | None: ...

    def save_skill_run(self, run: SkillRun) -> SkillRun: ...

    def get_skill_run(self, organization_id: str, execution_id: str) -> SkillRun | None: ...


class MemoryStore:
    """In-memory store for tests only. Real runtime uses PostgresStore."""

    def __init__(self) -> None:
        self.identities: dict[tuple[str, str, str], str] = {}
        self.brands: dict[tuple[str, str], Brand] = {}
        self.items: dict[str, ContentItem] = {}
        self.sessions: dict[tuple[str, str], OnboardingSession] = {}
        self.sessions_by_thread: dict[tuple[str, str], OnboardingSession] = {}
        self.sessions_by_id: dict[str, OnboardingSession] = {}
        self.skill_runs: dict[tuple[str, str], SkillRun] = {}

    def map_identity(self, organization_id: str, provider: str, external_user_id: str, verity_user_id: str) -> None:
        self.identities[(organization_id, provider, external_user_id)] = verity_user_id

    def resolve_identity(self, organization_id: str, provider: str, external_user_id: str) -> str | None:
        return self.identities.get((organization_id, provider, external_user_id))

    def upsert_brand(self, brand: Brand) -> Brand:
        brand.config_hash = canonical_config_hash(
            brand.brand_id, brand.voice_md, brand.config_json, brand.config_version
        )
        self.brands[(brand.organization_id, brand.brand_id)] = brand
        return brand

    def get_brand(self, organization_id: str, brand_id: str) -> Brand | None:
        return self.brands.get((organization_id, brand_id))

    def list_active_brands(self, organization_id: str) -> list[Brand]:
        return [b for (org, _), b in self.brands.items() if org == organization_id and b.active]

    def save_item(self, item: ContentItem) -> ContentItem:
        self.items[item.id] = item
        return item

    def get_item(self, item_id: str) -> ContentItem | None:
        return self.items.get(item_id)

    def get_item_by_execution(self, execution_id: str) -> ContentItem | None:
        return next((i for i in self.items.values() if i.execution_id == execution_id), None)

    def list_items(self, organization_id: str, brand_id: str | None = None) -> list[ContentItem]:
        rows = [i for i in self.items.values() if i.organization_id == organization_id]
        if brand_id:
            rows = [i for i in rows if i.brand_id == brand_id]
        return rows

    def count_drafts(self, organization_id: str, brand_id: str, platform: str) -> int:
        return sum(
            1
            for i in self.items.values()
            if i.organization_id == organization_id and i.brand_id == brand_id and i.platform == platform
        )

    def pending_backlog(self, organization_id: str, brand_id: str) -> bool:
        return any(
            i.organization_id == organization_id
            and i.brand_id == brand_id
            and i.status == "pending_approval"
            for i in self.items.values()
        )

    def last_activity(self, organization_id: str, brand_id: str) -> datetime | None:
        times = [
            i.created_at
            for i in self.items.values()
            if i.organization_id == organization_id and i.brand_id == brand_id and i.status != "rejected"
        ]
        return max(times) if times else None

    def save_session(self, session: OnboardingSession) -> OnboardingSession:
        self.sessions[(session.organization_id, session.brand_id)] = session
        self.sessions_by_thread[(session.organization_id, session.thread_ts)] = session
        self.sessions_by_id[session.id] = session
        return session

    def get_session_by_thread(self, organization_id: str, thread_ts: str) -> OnboardingSession | None:
        return self.sessions_by_thread.get((organization_id, thread_ts))

    def get_session(self, organization_id: str, brand_id: str) -> OnboardingSession | None:
        return self.sessions.get((organization_id, brand_id))

    def get_session_by_id(self, session_id: str) -> OnboardingSession | None:
        return self.sessions_by_id.get(session_id)

    def save_skill_run(self, run: SkillRun) -> SkillRun:
        self.skill_runs[(run.organization_id, run.execution_id)] = run
        return run

    def get_skill_run(self, organization_id: str, execution_id: str) -> SkillRun | None:
        return self.skill_runs.get((organization_id, execution_id))


def is_due_for_post(brand: Brand, last_activity: datetime | None) -> bool:
    if last_activity is None:
        return True
    cadence = int(brand.posting_cadence_days or 1)
    if cadence <= 0:
        return True
    last = last_activity
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) >= last + timedelta(days=cadence)
