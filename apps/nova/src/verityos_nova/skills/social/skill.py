from __future__ import annotations

from verityos_nova.runtime.context import (
    NovaContext,
    SkillManifest,
    SkillPlan,
    SkillResult,
    ValidationResult,
)
from verityos_nova.runtime.errors import BrandUnavailableError
from verityos_nova.skills.social.generator import build_social_prompt, pick_pillar
from verityos_nova.store import sha256_text

SOCIAL_MANIFEST = SkillManifest(
    id="nova.social.draft",
    name="Social Content Drafting",
    version="1.0.0",
    risk_tier="medium",
    required_permissions=["nova.use", "social.draft"],
    allowed_tools=["knowledge.retrieve"],
    knowledge_mode="grounded",
    approval={"required_for_execution": False, "required_for_external_action": True},
)


class SocialDraftSkill:
    manifest = SOCIAL_MANIFEST

    def __init__(self, store) -> None:
        self.store = store

    async def plan(self, context: NovaContext) -> SkillPlan:
        brand_id = context.request["brand_id"]
        platform = context.request.get("platform") or "facebook"
        topic = context.request.get("topic")
        brand = self.store.get_brand(context.organization_id, brand_id)
        if brand is None or not brand.active:
            raise BrandUnavailableError()
        config = {
            **brand.config_json,
            "content_pillars": brand.content_pillars,
            "display_name": brand.display_name,
            "brand_id": brand.brand_id,
        }
        draft_count = self.store.count_drafts(context.organization_id, brand.brand_id, platform)
        pillar = pick_pillar(config, platform, draft_count)
        prompt = build_social_prompt(brand.voice_md, brand.display_name, platform, pillar, topic)
        return SkillPlan(
            prompt=prompt,
            retrieve=bool(context.collection_ids),
            query=topic or (pillar or {}).get("pillar") or brand.display_name,
            collection_ids=list(context.collection_ids),
            knowledge_mode=context.knowledge_mode or self.manifest.knowledge_mode,
            metadata={
                "brand_id": brand.brand_id,
                "platform": platform,
                "pillar": (pillar or {}).get("pillar"),
                "config_hash": brand.config_hash,
                "skill_id": self.manifest.id,
                "skill_version": self.manifest.version,
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
