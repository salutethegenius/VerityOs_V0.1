from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Json

from verityos_nova.store import (
    Brand,
    ContentItem,
    OnboardingSession,
    SkillRun,
    canonical_config_hash,
)


def _s(value: Any) -> str:
    return str(value)


def _opt(value: Any) -> str | None:
    return None if value is None else str(value)


def _json(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, str):
        return json.loads(value)
    return value


class PostgresStore:
    """Durable Nova/social store for the real runtime."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._conn = psycopg.connect(dsn, row_factory=dict_row, autocommit=True)

    def close(self) -> None:
        self._conn.close()

    def map_identity(self, organization_id: str, provider: str, external_user_id: str, verity_user_id: str) -> None:
        self._conn.execute(
            """
            INSERT INTO nova.external_identities (
              id, organization_id, provider, external_user_id, verity_user_id
            ) VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (organization_id, provider, external_user_id)
            DO UPDATE SET verity_user_id = EXCLUDED.verity_user_id
            """,
            (str(uuid4()), organization_id, provider, external_user_id, verity_user_id),
        )

    def resolve_identity(self, organization_id: str, provider: str, external_user_id: str) -> str | None:
        row = self._conn.execute(
            """
            SELECT verity_user_id FROM nova.external_identities
            WHERE organization_id = %s AND provider = %s AND external_user_id = %s
            """,
            (organization_id, provider, external_user_id),
        ).fetchone()
        return _opt(row["verity_user_id"]) if row else None

    def upsert_brand(self, brand: Brand) -> Brand:
        brand.config_hash = canonical_config_hash(
            brand.brand_id, brand.voice_md, brand.config_json, brand.config_version
        )
        self._conn.execute(
            """
            INSERT INTO social.brands (
              id, organization_id, brand_id, display_name, active, voice_md, config_json,
              content_pillars, visual_identity, platforms, posting_cadence_days,
              config_version, config_hash, updated_at
            ) VALUES (
              %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now()
            )
            ON CONFLICT (organization_id, brand_id) DO UPDATE SET
              display_name = EXCLUDED.display_name,
              active = EXCLUDED.active,
              voice_md = EXCLUDED.voice_md,
              config_json = EXCLUDED.config_json,
              content_pillars = EXCLUDED.content_pillars,
              visual_identity = EXCLUDED.visual_identity,
              platforms = EXCLUDED.platforms,
              posting_cadence_days = EXCLUDED.posting_cadence_days,
              config_version = EXCLUDED.config_version,
              config_hash = EXCLUDED.config_hash,
              updated_at = now()
            """,
            (
                brand.id,
                brand.organization_id,
                brand.brand_id,
                brand.display_name,
                brand.active,
                brand.voice_md,
                Json(brand.config_json),
                Json(brand.content_pillars),
                Json(brand.visual_identity),
                Json(brand.platforms),
                brand.posting_cadence_days,
                brand.config_version,
                brand.config_hash,
            ),
        )
        stored = self.get_brand(brand.organization_id, brand.brand_id)
        return stored if stored else brand

    def _brand(self, row: dict[str, Any]) -> Brand:
        return Brand(
            id=_s(row["id"]),
            organization_id=_s(row["organization_id"]),
            brand_id=row["brand_id"],
            display_name=row["display_name"],
            active=bool(row["active"]),
            voice_md=row["voice_md"] or "",
            config_json=_json(row["config_json"]) or {},
            content_pillars=_json(row["content_pillars"]) or [],
            visual_identity=_json(row["visual_identity"]) or {},
            platforms=list(_json(row["platforms"]) or []),
            posting_cadence_days=int(row["posting_cadence_days"] or 3),
            config_version=int(row["config_version"] or 1),
            config_hash=row["config_hash"] or "",
        )

    def get_brand(self, organization_id: str, brand_id: str) -> Brand | None:
        row = self._conn.execute(
            """
            SELECT * FROM social.brands
            WHERE organization_id = %s AND brand_id = %s
            """,
            (organization_id, brand_id),
        ).fetchone()
        return self._brand(row) if row else None

    def list_active_brands(self, organization_id: str) -> list[Brand]:
        rows = self._conn.execute(
            "SELECT * FROM social.brands WHERE organization_id = %s AND active = true",
            (organization_id,),
        ).fetchall()
        return [self._brand(row) for row in rows]

    def save_item(self, item: ContentItem) -> ContentItem:
        self._conn.execute(
            """
            INSERT INTO social.content_items (
              id, organization_id, brand_id, platform, draft_text, pillar, status,
              execution_id, verity_record_id, artifact_hash, approval_id,
              slack_channel, slack_message_ts, created_at
            ) VALUES (
              %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
            )
            ON CONFLICT (id) DO UPDATE SET
              draft_text = EXCLUDED.draft_text,
              pillar = EXCLUDED.pillar,
              status = EXCLUDED.status,
              execution_id = EXCLUDED.execution_id,
              verity_record_id = EXCLUDED.verity_record_id,
              artifact_hash = EXCLUDED.artifact_hash,
              approval_id = EXCLUDED.approval_id,
              slack_channel = EXCLUDED.slack_channel,
              slack_message_ts = EXCLUDED.slack_message_ts,
              approved_at = CASE WHEN EXCLUDED.status = 'approved' THEN now() ELSE social.content_items.approved_at END,
              rejected_at = CASE WHEN EXCLUDED.status = 'rejected' THEN now() ELSE social.content_items.rejected_at END
            """,
            (
                item.id,
                item.organization_id,
                item.brand_id,
                item.platform,
                item.draft_text,
                item.pillar,
                item.status,
                item.execution_id,
                item.verity_record_id,
                item.artifact_hash,
                item.approval_id,
                item.slack_channel,
                item.slack_message_ts,
                item.created_at,
            ),
        )
        stored = self.get_item(item.id)
        return stored if stored else item

    def _item(self, row: dict[str, Any]) -> ContentItem:
        created = row["created_at"]
        if isinstance(created, datetime) and created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        return ContentItem(
            id=_s(row["id"]),
            organization_id=_s(row["organization_id"]),
            brand_id=row["brand_id"],
            platform=row["platform"],
            draft_text=row["draft_text"],
            artifact_hash=row["artifact_hash"],
            status=row["status"],
            execution_id=_opt(row["execution_id"]),
            verity_record_id=row["verity_record_id"],
            approval_id=_opt(row["approval_id"]),
            pillar=row["pillar"],
            slack_channel=row["slack_channel"],
            slack_message_ts=row["slack_message_ts"],
            created_at=created,
        )

    def get_item(self, item_id: str) -> ContentItem | None:
        row = self._conn.execute(
            "SELECT * FROM social.content_items WHERE id = %s",
            (item_id,),
        ).fetchone()
        return self._item(row) if row else None

    def get_item_by_execution(self, execution_id: str) -> ContentItem | None:
        row = self._conn.execute(
            "SELECT * FROM social.content_items WHERE execution_id = %s",
            (execution_id,),
        ).fetchone()
        return self._item(row) if row else None

    def list_items(self, organization_id: str, brand_id: str | None = None) -> list[ContentItem]:
        if brand_id:
            rows = self._conn.execute(
                """
                SELECT * FROM social.content_items
                WHERE organization_id = %s AND brand_id = %s
                """,
                (organization_id, brand_id),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM social.content_items WHERE organization_id = %s",
                (organization_id,),
            ).fetchall()
        return [self._item(row) for row in rows]

    def count_drafts(self, organization_id: str, brand_id: str, platform: str) -> int:
        row = self._conn.execute(
            """
            SELECT count(*) AS n FROM social.content_items
            WHERE organization_id = %s AND brand_id = %s AND platform = %s
            """,
            (organization_id, brand_id, platform),
        ).fetchone()
        return int(row["n"] if row else 0)

    def pending_backlog(self, organization_id: str, brand_id: str) -> bool:
        row = self._conn.execute(
            """
            SELECT 1 FROM social.content_items
            WHERE organization_id = %s AND brand_id = %s AND status = 'pending_approval'
            LIMIT 1
            """,
            (organization_id, brand_id),
        ).fetchone()
        return row is not None

    def last_activity(self, organization_id: str, brand_id: str) -> datetime | None:
        row = self._conn.execute(
            """
            SELECT max(created_at) AS ts FROM social.content_items
            WHERE organization_id = %s AND brand_id = %s AND status <> 'rejected'
            """,
            (organization_id, brand_id),
        ).fetchone()
        ts = row["ts"] if row else None
        if isinstance(ts, datetime) and ts.tzinfo is None:
            return ts.replace(tzinfo=timezone.utc)
        return ts

    def save_session(self, session: OnboardingSession) -> OnboardingSession:
        self._conn.execute(
            """
            INSERT INTO social.onboarding_sessions (
              id, organization_id, brand_id, display_name, channel, thread_ts, phase,
              answers, draft_voice_md, draft_config, proposed_config_hash,
              proposed_config_version, execution_id, status, updated_at
            ) VALUES (
              %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now()
            )
            ON CONFLICT (organization_id, brand_id) DO UPDATE SET
              display_name = EXCLUDED.display_name,
              channel = EXCLUDED.channel,
              thread_ts = EXCLUDED.thread_ts,
              phase = EXCLUDED.phase,
              answers = EXCLUDED.answers,
              draft_voice_md = EXCLUDED.draft_voice_md,
              draft_config = EXCLUDED.draft_config,
              proposed_config_hash = EXCLUDED.proposed_config_hash,
              proposed_config_version = EXCLUDED.proposed_config_version,
              execution_id = EXCLUDED.execution_id,
              status = EXCLUDED.status,
              updated_at = now()
            """,
            (
                session.id,
                session.organization_id,
                session.brand_id,
                session.display_name,
                session.channel,
                session.thread_ts,
                session.phase,
                Json(session.answers),
                session.draft_voice_md,
                Json(session.draft_config) if session.draft_config is not None else None,
                session.proposed_config_hash,
                session.proposed_config_version,
                session.execution_id,
                session.status,
            ),
        )
        stored = self.get_session(session.organization_id, session.brand_id)
        return stored if stored else session

    def _session(self, row: dict[str, Any]) -> OnboardingSession:
        return OnboardingSession(
            id=_s(row["id"]),
            organization_id=_s(row["organization_id"]),
            brand_id=row["brand_id"],
            display_name=row["display_name"],
            channel=row["channel"],
            thread_ts=row["thread_ts"],
            phase=row["phase"],
            answers=_json(row["answers"]) or {},
            draft_voice_md=row["draft_voice_md"],
            draft_config=_json(row["draft_config"]),
            proposed_config_hash=row["proposed_config_hash"],
            proposed_config_version=row["proposed_config_version"],
            execution_id=_opt(row["execution_id"]),
            status=row["status"],
        )

    def get_session(self, organization_id: str, brand_id: str) -> OnboardingSession | None:
        row = self._conn.execute(
            """
            SELECT * FROM social.onboarding_sessions
            WHERE organization_id = %s AND brand_id = %s
            """,
            (organization_id, brand_id),
        ).fetchone()
        return self._session(row) if row else None

    def get_session_by_thread(self, organization_id: str, thread_ts: str) -> OnboardingSession | None:
        row = self._conn.execute(
            """
            SELECT * FROM social.onboarding_sessions
            WHERE organization_id = %s AND thread_ts = %s
            """,
            (organization_id, thread_ts),
        ).fetchone()
        return self._session(row) if row else None

    def get_session_by_id(self, session_id: str) -> OnboardingSession | None:
        row = self._conn.execute(
            "SELECT * FROM social.onboarding_sessions WHERE id = %s",
            (session_id,),
        ).fetchone()
        return self._session(row) if row else None

    def save_skill_run(self, run: SkillRun) -> SkillRun:
        self._conn.execute(
            """
            INSERT INTO nova.skill_runs (
              id, organization_id, execution_id, skill_id, skill_version, actor_id,
              status, config_hash, artifact_hash, updated_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, now())
            ON CONFLICT (id) DO UPDATE SET
              status = EXCLUDED.status,
              config_hash = EXCLUDED.config_hash,
              artifact_hash = EXCLUDED.artifact_hash,
              updated_at = now()
            """,
            (
                run.id,
                run.organization_id,
                run.execution_id,
                run.skill_id,
                run.skill_version,
                run.actor_id,
                run.status,
                run.config_hash,
                run.artifact_hash,
            ),
        )
        stored = self.get_skill_run(run.organization_id, run.execution_id)
        return stored if stored else run

    def get_skill_run(self, organization_id: str, execution_id: str) -> SkillRun | None:
        row = self._conn.execute(
            """
            SELECT * FROM nova.skill_runs
            WHERE organization_id = %s AND execution_id = %s
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (organization_id, execution_id),
        ).fetchone()
        if not row:
            return None
        return SkillRun(
            id=_s(row["id"]),
            organization_id=_s(row["organization_id"]),
            execution_id=_s(row["execution_id"]),
            skill_id=row["skill_id"],
            skill_version=row["skill_version"],
            actor_id=_s(row["actor_id"]),
            status=row["status"],
            config_hash=row["config_hash"],
            artifact_hash=row["artifact_hash"],
        )
