from __future__ import annotations

from typing import Any
from uuid import uuid4

from verityos_nova.store import sha256_text


class FakeCoreClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.executions: dict[str, dict[str, Any]] = {}
        self.events: dict[str, list[str]] = {}
        self.approvals: dict[str, dict[str, Any]] = {}
        self.insufficient = False
        self.model_text = "Draft copy for the selected platform."
        self.fail_next = False

    async def open_execution(self, **kwargs: Any) -> dict[str, Any]:
        execution_id = str(uuid4())
        record = f"VTY-2026-{execution_id[:8].upper()}"
        self.executions[execution_id] = {
            "execution_id": execution_id,
            "verity_record_id": record,
            "status": "running",
            "actor_id": kwargs.get("actor_id"),
            "skill_id": kwargs.get("skill_id"),
            "organization_id": kwargs.get("organization_id"),
        }
        self.events[execution_id] = ["execution.created"]
        self.calls.append(("open_execution", kwargs))
        return self.executions[execution_id]

    async def retrieve_knowledge(self, execution_id: str, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("retrieve_knowledge", {"execution_id": execution_id, **kwargs}))
        self.events[execution_id].append("knowledge.retrieval")
        if self.insufficient:
            return {
                "retrieval_run_id": str(uuid4()),
                "insufficient_evidence": True,
                "hits": [],
                "mode": kwargs.get("mode"),
            }
        return {
            "retrieval_run_id": str(uuid4()),
            "insufficient_evidence": False,
            "mode": kwargs.get("mode"),
            "hits": [
                {
                    "chunk_id": str(uuid4()),
                    "source_id": str(uuid4()),
                    "source_version_id": str(uuid4()),
                    "title": "Policy",
                    "text": "Paris is the capital of France.",
                }
            ],
        }

    async def execute_model(self, execution_id: str, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("execute_model", {"execution_id": execution_id, **kwargs}))
        if "anthropic" in str(kwargs).lower() or kwargs.get("provider"):
            raise AssertionError("Nova must not select a provider")
        self.events[execution_id].append("model.execution")
        text = self.model_text
        return {
            "text": text,
            "output_hash": sha256_text(text),
            "prompt_hash": sha256_text(kwargs.get("content") or ""),
            "provider": "mock",
        }

    async def skill_start(self, execution_id: str, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("skill_start", {"execution_id": execution_id, **kwargs}))
        self.events[execution_id].append("nova.skill.started")
        return {"event_type": "nova.skill.started"}

    async def skill_complete(self, execution_id: str, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("skill_complete", {"execution_id": execution_id, **kwargs}))
        self.events[execution_id].append("nova.skill.completed")
        return {"event_type": "nova.skill.completed"}

    async def skill_fail(self, execution_id: str, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("skill_fail", {"execution_id": execution_id, **kwargs}))
        self.events[execution_id].append("nova.skill.failed")
        return {"event_type": "nova.skill.failed"}

    async def request_approval(self, execution_id: str, **kwargs: Any) -> dict[str, Any]:
        approval_id = str(uuid4())
        self.approvals[approval_id] = {**kwargs, "execution_id": execution_id, "status": "pending"}
        self.calls.append(("request_approval", {"execution_id": execution_id, **kwargs}))
        self.events[execution_id].append("approval.requested")
        self.executions[execution_id]["status"] = "waiting_approval"
        return {"approval_id": approval_id, "status": "waiting_approval", "artifact_hash": kwargs.get("artifact_hash")}

    async def decide_approval(self, execution_id: str, **kwargs: Any) -> dict[str, Any]:
        approval = self.approvals.get(kwargs["approval_id"])
        if not approval:
            raise RuntimeError("approval missing")
        if approval.get("artifact_hash") != kwargs.get("artifact_hash"):
            from verityos_nova.runtime.errors import NovaError

            raise NovaError("ARTIFACT_HASH_MISMATCH", "approval does not bind this artifact hash", 409)
        status = "approved" if kwargs.get("allow") else "rejected"
        approval["status"] = status
        self.calls.append(("decide_approval", {"execution_id": execution_id, **kwargs}))
        self.events[execution_id].append("approval.approved" if kwargs.get("allow") else "approval.rejected")
        return {"approval_id": kwargs["approval_id"], "status": status, "artifact_hash": kwargs.get("artifact_hash")}

    async def finalize_execution(self, execution_id: str, outcome: str = "completed") -> dict[str, Any]:
        self.calls.append(("finalize_execution", {"execution_id": execution_id, "outcome": outcome}))
        self.events[execution_id].append("finalize")
        rec = self.executions[execution_id]
        rec["status"] = outcome
        return {**rec, "execution_graph_hash": sha256_text(execution_id)}

    async def get_record(self, execution_id: str) -> dict[str, Any]:
        rec = self.executions[execution_id]
        return {
            "execution_id": execution_id,
            "verity_record_id": rec["verity_record_id"],
            "integrity_status": "not_verified",
            "provenance_status": "linked",
            "events": self.events[execution_id],
        }

    async def request_connector_action(self, execution_id: str, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("request_connector_action", {"execution_id": execution_id, **kwargs}))
        if any(key in str(kwargs).lower() for key in ("access_token", "meta_page_access")):
            raise AssertionError("Nova must not send Meta secrets")
        payload = kwargs.get("payload") or {}
        message = payload.get("message") or ""
        if kwargs.get("artifact_hash") != sha256_text(message):
            from verityos_nova.runtime.errors import NovaError

            raise NovaError("APPROVAL_ARTIFACT_MISMATCH", "payload message does not match artifact hash", 409)
        action_id = str(uuid4())
        result = {
            "action_id": action_id,
            "status": getattr(self, "connector_status", "succeeded"),
            "external_action_id": "fb_post_1",
            "artifact_hash": kwargs.get("artifact_hash"),
            "error_code": getattr(self, "connector_error", None),
        }
        self.events[execution_id].append("tool.requested")
        self.events[execution_id].append("tool.authorized")
        if result["status"] == "succeeded":
            self.events[execution_id].append("tool.completed")
        else:
            self.events[execution_id].append("tool.failed")
        return result
