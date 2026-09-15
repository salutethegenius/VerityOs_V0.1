from __future__ import annotations

from verityos_nova.runtime.context import (
    NovaContext,
    SkillManifest,
    SkillPlan,
    SkillResult,
    ValidationResult,
)
from verityos_nova.store import sha256_text

RESEARCH_MANIFEST = SkillManifest(
    id="nova.research",
    name="Institutional Research",
    version="1.0.0",
    risk_tier="medium",
    required_permissions=["nova.use", "knowledge.read"],
    allowed_tools=["knowledge.retrieve"],
    knowledge_mode="strict",
    approval={"required_for_execution": False, "required_for_external_action": False},
)


class ResearchSkill:
    manifest = RESEARCH_MANIFEST

    async def plan(self, context: NovaContext) -> SkillPlan:
        question = context.request.get("question") or ""
        mode = context.knowledge_mode or context.request.get("knowledge_mode") or self.manifest.knowledge_mode
        collections = context.collection_ids or context.request.get("collection_ids") or []
        return SkillPlan(
            prompt=f"Answer using only the supplied institutional sources.\nQuestion: {question}",
            retrieve=True,
            query=question,
            collection_ids=list(collections),
            knowledge_mode=mode,
            metadata={"skill_id": self.manifest.id, "skill_version": self.manifest.version},
        )

    async def execute(self, context: NovaContext, plan: SkillPlan, model_text: str) -> SkillResult:
        text = (model_text or "").strip()
        return SkillResult(
            artifact=text,
            artifact_hash=sha256_text(text),
            metadata=plan.metadata,
            citations=list(plan.metadata.get("citations") or []),
            insufficient_evidence=bool(plan.metadata.get("insufficient_evidence")),
        )

    async def validate(self, context: NovaContext, result: SkillResult) -> ValidationResult:
        if result.insufficient_evidence:
            return ValidationResult(False, "INSUFFICIENT_EVIDENCE", "strict knowledge is insufficient")
        if not result.artifact:
            return ValidationResult(False, "EMPTY_ARTIFACT", "research answer is empty")
        return ValidationResult(True)
