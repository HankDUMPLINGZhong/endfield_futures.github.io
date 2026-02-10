from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Spec:
    base: float
    tick: float
    limit_pct: float
    margin: float
    mult: int


@dataclass
class Market:
    symbol: str
    code: str
    prev_settle: float
    limit_up: float
    limit_down: float
    open: float
    high: float
    low: float
    last: float
    vol: int
    oi: int
    series: list[float]


@dataclass
class Position:
    symbol: str
    side: str  # long/short
    qty: int
    avg_open: float
    mult: int
    margin: float


@dataclass
class Order:
    order_id: int
    symbol: str
    side: str   # buy/sell
    effect: str # open/close
    price: float
    qty: int
    status: str
    ts: str


@dataclass
class Trade:
    trade_id: str
    symbol: str
    side: str
    effect: str
    price: float
    qty: int
    fee: float
    ts: str
