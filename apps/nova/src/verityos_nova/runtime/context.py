from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class SkillManifest:
    id: str
    name: str
    version: str
    risk_tier: str
    required_permissions: list[str]
    allowed_tools: list[str]
    knowledge_mode: str
    approval: dict[str, bool]

    def validate(self) -> None:
        if not self.id or not self.version:
            raise ValueError("skill manifest requires id and version")
        if self.risk_tier not in {"low", "medium", "high"}:
            raise ValueError("invalid risk_tier")
        if self.knowledge_mode not in {"strict", "grounded", "general"}:
            raise ValueError("invalid knowledge_mode")
        if "required_for_execution" not in self.approval or "required_for_external_action" not in self.approval:
            raise ValueError("approval flags required")


@dataclass
class NovaContext:
    organization_id: str
    actor_id: str
    skill_id: str
    request: dict[str, Any]
    system_actor_id: str | None = None
    collection_ids: list[str] = field(default_factory=list)
    knowledge_mode: str | None = None


@dataclass
class SkillPlan:
    prompt: str
    retrieve: bool = False
    query: str | None = None
    collection_ids: list[str] = field(default_factory=list)
    knowledge_mode: str = "grounded"
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class SkillResult:
    artifact: str
    artifact_hash: str
    metadata: dict[str, Any] = field(default_factory=dict)
    citations: list[dict[str, Any]] = field(default_factory=list)
    insufficient_evidence: bool = False


@dataclass
class ValidationResult:
    ok: bool
    reason_code: str = "ok"
    message: str = ""
