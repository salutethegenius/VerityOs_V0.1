from __future__ import annotations

from verityos_nova.store import Brand, is_due_for_post


def brands_due(store, organization_id: str) -> list[Brand]:
    due = []
    for brand in store.list_active_brands(organization_id):
        if store.pending_backlog(organization_id, brand.brand_id):
            continue
        if is_due_for_post(brand, store.last_activity(organization_id, brand.brand_id)):
            due.append(brand)
    return due
