from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx

from verityos_nova.runtime.errors import NovaError


@dataclass
class SlackMessage:
    channel: str
    text: str
    ts: str
    thread_ts: str | None = None
    blocks: list[dict[str, Any]] = field(default_factory=list)
    updated: bool = False


class SlackClient:
    """Interface. Production uses HTTP; tests inject FakeSlackClient."""

    async def post_message(self, channel: str, text: str, **kwargs: Any) -> SlackMessage:
        raise NotImplementedError

    async def update_message(self, channel: str, ts: str, text: str, **kwargs: Any) -> SlackMessage:
        raise NotImplementedError


class FakeSlackClient(SlackClient):
    def __init__(self) -> None:
        self.messages: dict[str, SlackMessage] = {}
        self._seq = 0
        self.posted: list[SlackMessage] = []

    async def post_message(self, channel: str, text: str, **kwargs: Any) -> SlackMessage:
        self._seq += 1
        msg = SlackMessage(
            channel=channel,
            text=text,
            ts=f"{1000 + self._seq}.000001",
            thread_ts=kwargs.get("thread_ts"),
            blocks=list(kwargs.get("blocks") or []),
        )
        self.posted.append(msg)
        return msg

    async def update_message(self, channel: str, ts: str, text: str, **kwargs: Any) -> SlackMessage:
        msg = SlackMessage(
            channel=channel,
            text=text,
            ts=ts,
            blocks=list(kwargs.get("blocks") or []),
            updated=True,
        )
        self.posted.append(msg)
        return msg


class HttpSlackClient(SlackClient):
    """Slack Web API client. Tests inject an httpx client with MockTransport."""

    def __init__(self, token: str, http: httpx.AsyncClient | None = None) -> None:
        if not token:
            raise NovaError("SLACK_NOT_CONFIGURED", "SLACK_BOT_TOKEN is required", 500)
        self._token = token
        self._http = http or httpx.AsyncClient(base_url="https://slack.com/api/", timeout=30.0)
        self._owns_http = http is None

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def _call(self, method: str, payload: dict[str, Any]) -> dict[str, Any]:
        response = await self._http.post(
            method if not method.startswith("/") else method[1:],
            json=payload,
            headers={
                "authorization": f"Bearer {self._token}",
                "content-type": "application/json; charset=utf-8",
            },
        )
        if response.status_code >= 400:
            raise NovaError("SLACK_HTTP_ERROR", "slack request failed", 502)
        body = response.json()
        if not body.get("ok"):
            raise NovaError("SLACK_API_ERROR", "slack api rejected the request", 502)
        return body

    async def post_message(self, channel: str, text: str, **kwargs: Any) -> SlackMessage:
        payload: dict[str, Any] = {"channel": channel, "text": text}
        if kwargs.get("thread_ts"):
            payload["thread_ts"] = kwargs["thread_ts"]
        if kwargs.get("blocks") is not None:
            payload["blocks"] = kwargs["blocks"]
        body = await self._call("chat.postMessage", payload)
        return SlackMessage(
            channel=body.get("channel") or channel,
            text=text,
            ts=str(body.get("ts") or ""),
            thread_ts=kwargs.get("thread_ts"),
            blocks=list(kwargs.get("blocks") or []),
        )

    async def update_message(self, channel: str, ts: str, text: str, **kwargs: Any) -> SlackMessage:
        payload: dict[str, Any] = {"channel": channel, "ts": ts, "text": text}
        if kwargs.get("blocks") is not None:
            payload["blocks"] = kwargs["blocks"]
        body = await self._call("chat.update", payload)
        return SlackMessage(
            channel=channel,
            text=text,
            ts=str(body.get("ts") or ts),
            blocks=list(kwargs.get("blocks") or []),
            updated=True,
        )


def unique_action_id(prefix: str, *parts: str) -> str:
    suffix = "_".join(parts)
    return f"{prefix}_{suffix}" if suffix else prefix


def platform_picker_blocks(brand_id: str, platforms: list[str]) -> list[dict[str, Any]]:
    return [
        {
            "type": "actions",
            "elements": [
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": platform},
                    "action_id": unique_action_id("gen_pick_platform", brand_id, platform),
                    "value": f"{brand_id}:{platform}",
                }
                for platform in platforms
            ],
        }
    ]


def onboarding_decision_blocks(session_id: str) -> list[dict[str, Any]]:
    return [
        {
            "type": "actions",
            "elements": [
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Approve"},
                    "action_id": unique_action_id("onboard_approve", session_id),
                    "value": session_id,
                },
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Reject"},
                    "action_id": unique_action_id("onboard_reject", session_id),
                    "value": session_id,
                },
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Regenerate"},
                    "action_id": unique_action_id("onboard_regen", session_id),
                    "value": session_id,
                },
            ],
        }
    ]


def draft_blocks(item_id: str, brand_id: str, platform: str, draft: str, artifact_hash: str) -> list[dict[str, Any]]:
    return [
        {"type": "section", "text": {"type": "mrkdwn", "text": f"*{brand_id}* / {platform}\n{draft}"}},
        {
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": f"artifact `{artifact_hash[:12]}…`"}],
        },
        {
            "type": "actions",
            "elements": [
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Approve"},
                    "action_id": unique_action_id("approve", item_id),
                    "value": f"approve_{item_id}",
                },
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Reject"},
                    "action_id": unique_action_id("reject", item_id),
                    "value": f"reject_{item_id}",
                },
            ],
        },
    ]


def resolved_blocks(original: list[dict[str, Any]], status: str, user_id: str | None) -> list[dict[str, Any]]:
    blocks = [b for b in original if b.get("type") != "actions"]
    label = "Approved" if status == "approved" else "Rejected"
    mention = f" by <@{user_id}>" if user_id else ""
    blocks.append(
        {
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": f"*{label}*{mention}"}],
        }
    )
    if status == "approved":
        blocks.append(
            {
                "type": "context",
                "elements": [
                    {
                        "type": "mrkdwn",
                        "text": "Publishing is `CONNECTOR_NOT_AVAILABLE` in this runtime.",
                    }
                ],
            }
        )
    return blocks
