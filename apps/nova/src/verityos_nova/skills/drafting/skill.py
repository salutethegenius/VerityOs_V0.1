from __future__ import annotations

from verityos_nova.runtime.context import (
    NovaContext,
    SkillManifest,
    SkillPlan,
    SkillResult,
    ValidationResult,
)
from verityos_nova.store import sha256_text

DOCUMENT_TYPES = {"memo", "brief", "press_release", "public_advisory", "general"}

DRAFTING_MANIFEST = SkillManifest(
    id="nova.drafting",
    name="Institutional Drafting",
    version="1.0.0",
    risk_tier="medium",
    required_permissions=["nova.use"],
    allowed_tools=["knowledge.retrieve"],
    knowledge_mode="grounded",
    approval={"required_for_execution": False, "required_for_external_action": False},
)


class DraftingSkill:
    manifest = DRAFTING_MANIFEST

    async def plan(self, context: NovaContext) -> SkillPlan:
        instruction = context.request.get("instruction") or ""
        document_type = context.request.get("document_type") or "general"
        if document_type not in DOCUMENT_TYPES:
            document_type = "general"
        collections = context.collection_ids or context.request.get("collection_ids") or []
        mode = context.knowledge_mode or context.request.get("knowledge_mode") or self.manifest.knowledge_mode
        return SkillPlan(
            prompt=(
                f"Write a {document_type.replace('_', ' ')} from the instruction. "
                "Keep the document generic and institutional. Do not invent jurisdiction-specific law.\n"
                f"Instruction: {instruction}"
            ),
            retrieve=bool(collections),
            query=instruction,
            collection_ids=list(collections),
            knowledge_mode=mode,
            metadata={
                "skill_id": self.manifest.id,
                "skill_version": self.manifest.version,
                "document_type": document_type,
            },
        )

    async def execute(self, context: NovaContext, plan: SkillPlan, model_text: str) -> SkillResult:
        text = (model_text or "").strip()
        return SkillResult(
            artifact=text,
            artifact_hash=sha256_text(text),
            metadata=plan.metadata,
        )

    async def validate(self, context: NovaContext, result: SkillResult) -> ValidationResult:
        if not result.artifact:
            return ValidationResult(False, "EMPTY_ARTIFACT", "draft is empty")
        return ValidationResult(True)
