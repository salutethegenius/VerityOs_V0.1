"""Brand profile accessors. Brands are data, never hardcoded in core."""

from verityos_nova.store import Brand, MemoryStore


def load_brand(store: MemoryStore, organization_id: str, brand_id: str) -> Brand:
    brand = store.get_brand(organization_id, brand_id)
    if brand is None:
        raise KeyError("brand unavailable")
    return brand
