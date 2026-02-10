from __future__ import annotations
from engine.models import Market, Order

def is_marketable(o: Order, m: Market) -> bool:
    if o.side == "buy":
        return o.price >= m.last
    return o.price <= m.last

def fee_for(qty: int) -> float:
    return 2.0 * qty
