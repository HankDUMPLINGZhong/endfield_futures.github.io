from __future__ import annotations
import random
from time import strftime

from engine.models import Market, Spec

def _sign(x: float) -> int:
    return 1 if x > 0 else -1 if x < 0 else 0

def round_to(x: float, tick: float) -> float:
    return round(x / tick) * tick


def clamp(x: float, a: float, b: float) -> float:
    return max(a, min(b, x))


def now_str() -> str:
    return strftime("%H:%M:%S")


def init_market(symbol: str, code: str, spec: Spec) -> Market:
    prev_settle = round_to(spec.base, spec.tick)
    limit_up = round_to(prev_settle * (1 + spec.limit_pct), spec.tick)
    limit_down = round_to(prev_settle * (1 - spec.limit_pct), spec.tick)
    open_px = clamp(
        round_to(prev_settle * (1 + (random.random() - 0.5) * 0.01), spec.tick),
        limit_down,
        limit_up,
    )
    return Market(
        symbol=symbol,
        code=code,
        prev_settle=prev_settle,
        limit_up=limit_up,
        limit_down=limit_down,
        open=open_px,
        high=open_px,
        low=open_px,
        last=open_px,
        vol=0,
        oi=int(2000 + random.random() * 6000),
        series=[open_px] * 120,
    )


def advance_market_tick(m: Market, spec: Spec) -> None:
    step = spec.tick * (-1 if random.random() < 0.5 else 1) * (1 + int(random.random() * 3))
    nxt = round_to(m.last + step, spec.tick)

    # tiny mean reversion
    pull = (m.prev_settle - nxt) * 0.01
    nxt = round_to(nxt + pull, spec.tick)

    nxt = clamp(nxt, m.limit_down, m.limit_up)

    m.last = nxt
    m.high = max(m.high, nxt)
    m.low = min(m.low, nxt)
    m.vol += int(1 + random.random() * 6)

    m.series.append(nxt)
    if len(m.series) > 180:
        m.series.pop(0)

def roll_market_day(m: Market, spec: Spec) -> None:
    # 以最后一个 tick 的价格作为新昨结
    new_prev = round_to(m.last, spec.tick)

    m.prev_settle = new_prev
    m.limit_up = round_to(new_prev * (1 + spec.limit_pct), spec.tick)
    m.limit_down = round_to(new_prev * (1 - spec.limit_pct), spec.tick)

    # 新一天开盘价用昨收（也就是新昨结）
    m.open = new_prev
    m.high = new_prev
    m.low = new_prev
    m.vol = 0