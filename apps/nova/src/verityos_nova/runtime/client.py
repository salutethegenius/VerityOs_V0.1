from __future__ import annotations

from typing import Any

import httpx

from verityos_nova.runtime.errors import NovaError


class VerityCoreClient:
    """HTTP client for Verity Core Phase 7/8 APIs. Nova never talks to providers."""

    def __init__(self, base_url: str, token: str, timeout: float = 30.0) -> None:
        self._base = base_url.rstrip("/")
        self._token = token
        self._client = httpx.AsyncClient(
            base_url=self._base,
            headers={"authorization": f"Bearer {token}"},
            timeout=timeout,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _post(self, path: str, json: dict[str, Any]) -> dict[str, Any]:
        response = await self._client.post(path, json=json)
        if response.status_code >= 400:
            payload = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
            error = payload.get("error") or {}
            raise NovaError(
                error.get("code") or "CORE_ERROR",
                error.get("message") or response.text,
                response.status_code,
            )
        return response.json()

    async def _get(self, path: str) -> dict[str, Any]:
        response = await self._client.get(path)
        if response.status_code >= 400:
            payload = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
            error = payload.get("error") or {}
            raise NovaError(
                error.get("code") or "CORE_ERROR",
                error.get("message") or response.text,
                response.status_code,
            )
        return response.json()

    async def open_execution(
        self,
        *,
        organization_id: str,
        actor_id: str,
        skill_id: str,
        risk_tier: str = "medium",
        request: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return await self._post(
            "/internal/v1/executions",
            {
                "organization_id": organization_id,
                "actor_id": actor_id,
                "skill_id": skill_id,
                "risk_tier": risk_tier,
                "request": request or {},
            },
        )

    async def retrieve_knowledge(
        self,
        execution_id: str,
        *,
        query: str,
        collection_ids: list[str],
        mode: str = "grounded",
        top_k: int = 8,
    ) -> dict[str, Any]:
        return await self._post(
            f"/internal/v1/executions/{execution_id}/knowledge/retrieve",
            {
                "query": query,
                "collection_ids": collection_ids,
                "mode": mode,
                "top_k": top_k,
            },
        )

    async def execute_model(
        self,
        execution_id: str,
        *,
        task: str,
        content: str,
        risk_tier: str,
        data_classification: str = "internal",
        retrieval_run_id: str | None = None,
        context_chunk_ids: list[str] | None = None,
        prefer_local: bool = True,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "task": task,
            "content": content,
            "risk_tier": risk_tier,
            "data_classification": data_classification,
            "prefer_local": prefer_local,
        }
        if retrieval_run_id:
            body["retrieval_run_id"] = retrieval_run_id
        if context_chunk_ids:
            body["context_chunk_ids"] = context_chunk_ids
        return await self._post(f"/internal/v1/executions/{execution_id}/model/execute", body)

    async def skill_start(self, execution_id: str, **kwargs: Any) -> dict[str, Any]:
        return await self._post(f"/internal/v1/executions/{execution_id}/skill/start", kwargs)

    async def skill_complete(self, execution_id: str, **kwargs: Any) -> dict[str, Any]:
        return await self._post(f"/internal/v1/executions/{execution_id}/skill/complete", kwargs)

    async def skill_fail(self, execution_id: str, **kwargs: Any) -> dict[str, Any]:
        return await self._post(f"/internal/v1/executions/{execution_id}/skill/fail", kwargs)

    async def request_approval(self, execution_id: str, **kwargs: Any) -> dict[str, Any]:
        return await self._post(f"/internal/v1/executions/{execution_id}/approval/request", kwargs)

    async def decide_approval(self, execution_id: str, **kwargs: Any) -> dict[str, Any]:
        return await self._post(f"/internal/v1/executions/{execution_id}/approval/decide", kwargs)

    async def finalize_execution(self, execution_id: str, outcome: str = "completed") -> dict[str, Any]:
        return await self._post(
            f"/internal/v1/executions/{execution_id}/finalize",
            {"outcome": outcome},
        )

    async def get_record(self, execution_id: str) -> dict[str, Any]:
        return await self._get(f"/internal/v1/executions/{execution_id}/record")
