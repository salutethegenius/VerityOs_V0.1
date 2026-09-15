from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from verityos_nova.runtime.client import VerityCoreClient
from verityos_nova.runtime.context import NovaContext, SkillResult
from verityos_nova.runtime.errors import NovaError
from verityos_nova.runtime.registry import NovaSkill
from verityos_nova.store import ContentItem, SkillRun, Store

logger = logging.getLogger("verityos_nova.engine")


@dataclass
class SkillRunOutcome:
    execution_id: str
    verity_record_id: str
    status: str
    artifact: str | None = None
    artifact_hash: str | None = None
    approval_id: str | None = None
    item_id: str | None = None
    citations: list[dict[str, Any]] = field(default_factory=list)
    record: dict[str, Any] | None = None
    events: list[str] = field(default_factory=list)


class SkillEngine:
    def __init__(self, client: VerityCoreClient, store: Store) -> None:
        self.client = client
        self.store = store

    def _persist_run(
        self,
        context: NovaContext,
        execution_id: str,
        skill: NovaSkill,
        status: str,
        config_hash: str | None = None,
        artifact_hash: str | None = None,
    ) -> None:
        existing = self.store.get_skill_run(context.organization_id, execution_id)
        self.store.save_skill_run(
            SkillRun(
                id=existing.id if existing else str(uuid4()),
                organization_id=context.organization_id,
                execution_id=execution_id,
                skill_id=skill.manifest.id,
                skill_version=skill.manifest.version,
                actor_id=context.actor_id,
                status=status,
                config_hash=config_hash,
                artifact_hash=artifact_hash,
            )
        )

    async def _fail_open_execution(
        self, execution_id: str, skill: NovaSkill, reason_code: str, outcome: str = "failed"
    ) -> None:
        try:
            await self.client.skill_fail(
                execution_id,
                skill_id=skill.manifest.id,
                skill_version=skill.manifest.version,
                reason_code=reason_code,
            )
            await self.client.finalize_execution(execution_id, outcome)
        except NovaError:
            logger.exception("failed to seal Nova execution after error")

    async def run(self, skill: NovaSkill, context: NovaContext) -> SkillRunOutcome:
        opened = await self.client.open_execution(
            organization_id=context.organization_id,
            actor_id=context.actor_id,
            skill_id=skill.manifest.id,
            risk_tier=skill.manifest.risk_tier,
            request=context.request,
        )
        execution_id = opened["execution_id"]
        verity_record_id = opened["verity_record_id"]
        events = ["execution.opened"]
        try:
            plan = await skill.plan(context)
            start_meta = {
                "skill_id": skill.manifest.id,
                "skill_version": skill.manifest.version,
            }
            if plan.metadata.get("brand_id"):
                start_meta["brand_id"] = plan.metadata["brand_id"]
            if plan.metadata.get("config_hash"):
                start_meta["config_hash"] = plan.metadata["config_hash"]
            await self.client.skill_start(execution_id, **start_meta)
            events.append("nova.skill.started")
            self._persist_run(
                context,
                execution_id,
                skill,
                "started",
                config_hash=plan.metadata.get("config_hash"),
            )

            retrieval_run_id = None
            chunk_ids: list[str] = []
            if plan.retrieve:
                knowledge = await self.client.retrieve_knowledge(
                    execution_id,
                    query=plan.query or "",
                    collection_ids=plan.collection_ids,
                    mode=plan.knowledge_mode,
                )
                events.append("knowledge.retrieve")
                plan.metadata["insufficient_evidence"] = bool(knowledge.get("insufficient_evidence"))
                hits = knowledge.get("hits") or []
                plan.metadata["citations"] = [
                    {
                        "chunk_id": hit.get("chunk_id"),
                        "source_id": hit.get("source_id"),
                        "source_version_id": hit.get("source_version_id"),
                        "title": hit.get("title"),
                    }
                    for hit in hits
                ]
                if knowledge.get("insufficient_evidence") and plan.knowledge_mode == "strict":
                    await self.client.skill_fail(
                        execution_id,
                        skill_id=skill.manifest.id,
                        skill_version=skill.manifest.version,
                        reason_code="INSUFFICIENT_EVIDENCE",
                    )
                    events.append("nova.skill.failed")
                    self._persist_run(context, execution_id, skill, "failed")
                    finalized = await self.client.finalize_execution(execution_id, "blocked")
                    events.append("finalize.blocked")
                    result = SkillResult(
                        artifact="",
                        artifact_hash="",
                        metadata=plan.metadata,
                        citations=plan.metadata.get("citations") or [],
                        insufficient_evidence=True,
                    )
                    return SkillRunOutcome(
                        execution_id=execution_id,
                        verity_record_id=finalized.get("verity_record_id", verity_record_id),
                        status="blocked",
                        citations=result.citations,
                        events=events,
                    )
                retrieval_run_id = knowledge.get("retrieval_run_id")
                chunk_ids = [hit["chunk_id"] for hit in hits if hit.get("chunk_id")]

            executed = await self.client.execute_model(
                execution_id,
                task=skill.manifest.id,
                content=plan.prompt,
                risk_tier=skill.manifest.risk_tier,
                retrieval_run_id=retrieval_run_id,
                context_chunk_ids=chunk_ids or None,
            )
            events.append("model.execute")
            model_text = executed.get("text") or ""
            result = await skill.execute(context, plan, model_text)
            result.citations = plan.metadata.get("citations") or result.citations
            result.insufficient_evidence = bool(plan.metadata.get("insufficient_evidence"))
            validation = await skill.validate(context, result)
            if not validation.ok:
                await self.client.skill_fail(
                    execution_id,
                    skill_id=skill.manifest.id,
                    skill_version=skill.manifest.version,
                    reason_code=validation.reason_code,
                )
                events.append("nova.skill.failed")
                self._persist_run(context, execution_id, skill, "failed")
                finalized = await self.client.finalize_execution(execution_id, "failed")
                return SkillRunOutcome(
                    execution_id=execution_id,
                    verity_record_id=finalized.get("verity_record_id", verity_record_id),
                    status="failed",
                    events=events,
                )

            needs_approval = skill.manifest.approval.get("required_for_external_action")
            item_id = None
            approval_id = None
            if skill.manifest.id == "nova.social.draft":
                item = self.store.save_item(
                    ContentItem(
                        organization_id=context.organization_id,
                        brand_id=plan.metadata["brand_id"],
                        platform=plan.metadata.get("platform") or "facebook",
                        draft_text=result.artifact,
                        artifact_hash=result.artifact_hash,
                        status="pending_approval",
                        execution_id=execution_id,
                        verity_record_id=verity_record_id,
                        pillar=plan.metadata.get("pillar"),
                    )
                )
                item_id = item.id

            if needs_approval:
                approval = await self.client.request_approval(
                    execution_id,
                    skill_id=skill.manifest.id,
                    requested_by=context.actor_id,
                    artifact_hash=result.artifact_hash,
                )
                events.append("approval.requested")
                approval_id = approval.get("approval_id")
                if item_id:
                    stored = self.store.get_item(item_id)
                    if stored:
                        stored.approval_id = approval_id
                        self.store.save_item(stored)
                self._persist_run(
                    context,
                    execution_id,
                    skill,
                    "waiting_approval",
                    config_hash=plan.metadata.get("config_hash"),
                    artifact_hash=result.artifact_hash,
                )
                return SkillRunOutcome(
                    execution_id=execution_id,
                    verity_record_id=verity_record_id,
                    status="waiting_approval",
                    artifact=result.artifact,
                    artifact_hash=result.artifact_hash,
                    approval_id=approval_id,
                    item_id=item_id,
                    citations=result.citations,
                    events=events,
                )

            await self.client.skill_complete(
                execution_id,
                skill_id=skill.manifest.id,
                skill_version=skill.manifest.version,
                result_artifact_hash=result.artifact_hash,
                **{k: v for k, v in start_meta.items() if k not in {"skill_id", "skill_version"}},
            )
            events.append("nova.skill.completed")
            self._persist_run(
                context,
                execution_id,
                skill,
                "completed",
                config_hash=plan.metadata.get("config_hash"),
                artifact_hash=result.artifact_hash,
            )
            finalized = await self.client.finalize_execution(execution_id, "completed")
            events.append("finalize.completed")
            record = await self.client.get_record(execution_id)
            return SkillRunOutcome(
                execution_id=execution_id,
                verity_record_id=finalized.get("verity_record_id", verity_record_id),
                status="completed",
                artifact=result.artifact,
                artifact_hash=result.artifact_hash,
                item_id=item_id,
                citations=result.citations,
                record=record,
                events=events,
            )
        except NovaError as err:
            await self._fail_open_execution(execution_id, skill, err.code)
            self._persist_run(context, execution_id, skill, "failed")
            raise
        except Exception:
            logger.exception("unexpected Nova skill failure")
            await self._fail_open_execution(execution_id, skill, "NOVA_INTERNAL_ERROR")
            self._persist_run(context, execution_id, skill, "failed")
            raise NovaError("NOVA_INTERNAL_ERROR", "skill execution failed", 500) from None

    async def decide_social(
        self,
        *,
        execution_id: str,
        approval_id: str,
        actor_id: str,
        allow: bool,
        artifact_hash: str,
        skill_id: str = "nova.social.draft",
        skill_version: str = "1.0.0",
    ) -> SkillRunOutcome:
        decision = await self.client.decide_approval(
            execution_id,
            approval_id=approval_id,
            actor_id=actor_id,
            allow=allow,
            artifact_hash=artifact_hash,
        )
        item = self.store.get_item_by_execution(execution_id)
        if item and item.artifact_hash != artifact_hash:
            raise NovaError("ARTIFACT_HASH_MISMATCH", "content changed after approval request", 409)
        if item:
            item.status = "approved" if allow else "rejected"
            self.store.save_item(item)
        if allow:
            await self.client.skill_complete(
                execution_id,
                skill_id=skill_id,
                skill_version=skill_version,
                result_artifact_hash=artifact_hash,
            )
            finalized = await self.client.finalize_execution(execution_id, "completed")
            status = "completed"
        else:
            await self.client.skill_fail(
                execution_id,
                skill_id=skill_id,
                skill_version=skill_version,
                reason_code="APPROVAL_REJECTED",
            )
            finalized = await self.client.finalize_execution(execution_id, "blocked")
            status = "blocked"
        record = await self.client.get_record(execution_id)
        return SkillRunOutcome(
            execution_id=execution_id,
            verity_record_id=finalized.get("verity_record_id"),
            status=status,
            artifact_hash=artifact_hash,
            approval_id=decision.get("approval_id"),
            item_id=item.id if item else None,
            record=record,
            events=["approval.decided", "finalize"],
        )
