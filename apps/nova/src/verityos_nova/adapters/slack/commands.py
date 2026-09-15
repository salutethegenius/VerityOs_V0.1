from __future__ import annotations

from typing import Any

from verityos_nova.adapters.slack.client import SlackClient, unique_action_id
from verityos_nova.store import Store


async def handle_command(
    *,
    text: str,
    user_id: str,
    store: Store,
    slack: SlackClient,
    organization_id: str,
    channel: str,
) -> dict[str, Any]:
    command = (text or "").strip().split()
    verb = command[0] if command else "generate"
    if verb == "help":
        return {"text": "Use `/nova` to pick a brand, or `/nova generate`."}
    actor = store.resolve_identity(organization_id, "slack", user_id)
    if not actor:
        return {"text": "Your Slack account is not linked to a VerityOS user."}
    brands = store.list_active_brands(organization_id)
    elements = [
        {
            "type": "button",
            "text": {"type": "plain_text", "text": brand.display_name},
            "action_id": unique_action_id("gen_pick_brand", brand.brand_id),
            "value": brand.brand_id,
        }
        for brand in brands
    ]
    await slack.post_message(
        channel,
        "Pick a brand",
        blocks=[{"type": "actions", "elements": elements}] if elements else [],
    )
    return {"ok": True}
