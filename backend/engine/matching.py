from __future__ import annotations

from backend.engine.models import Market, Order


def is_marketable(o: Order, m: Market) -> bool:
    # demo rule: buy price >= last OR sell price <= last
    if o.side == "buy":
        return o.price >= m.last
    return o.price <= m.last


def fee_for(qty: int) -> float:
    # demo: 2 券/手
    return 2.0 * qty
