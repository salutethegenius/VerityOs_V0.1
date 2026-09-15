from __future__ import annotations

from typing import Protocol

from verityos_nova.runtime.context import (
    NovaContext,
    SkillManifest,
    SkillPlan,
    SkillResult,
    ValidationResult,
)


class NovaSkill(Protocol):
    manifest: SkillManifest

    async def plan(self, context: NovaContext) -> SkillPlan: ...

    async def execute(self, context: NovaContext, plan: SkillPlan, model_text: str) -> SkillResult: ...

    async def validate(self, context: NovaContext, result: SkillResult) -> ValidationResult: ...


class SkillRegistry:
    def __init__(self) -> None:
        self._skills: dict[str, NovaSkill] = {}

    def register(self, skill: NovaSkill) -> None:
        skill.manifest.validate()
        self._skills[skill.manifest.id] = skill

    def get(self, skill_id: str) -> NovaSkill:
        skill = self._skills.get(skill_id)
        if skill is None:
            raise KeyError(skill_id)
        return skill

    def list_enabled(self) -> list[SkillManifest]:
        return [skill.manifest for skill in self._skills.values()]
