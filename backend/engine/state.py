from __future__ import annotations

import random
from pathlib import Path
from time import strftime

from fastapi import WebSocket
from loguru import logger

from backend.engine.market import advance_market_tick, init_market, round_to, clamp, now_str
from backend.engine.matching import is_marketable, fee_for
from backend.engine.models import Spec, Market, Position, Order, Trade
from backend.engine.market import roll_market_day


class GameState:
    def __init__(self, frontend_dir: Path) -> None:
        self.frontend_dir = frontend_dir
        self.contract_months = ["2603", "2604", "2606"]

        self.products = [
            {"code": "AKT", "name": "锚点厨具"},
            {"code": "SKB", "name": "悬空骸骨骨雕"},
            {"code": "WMD", "name": "巫术矿钻"},
            {"code": "ANG", "name": "天使罐头"},
            {"code": "HYR", "name": "谷地水培肉"},
            {"code": "TUJ", "name": "团结牌口服液"},
            {"code": "SEK", "name": "塞什卡牌石"},
            {"code": "YSM", "name": "源石树幼苗"},
            {"code": "JJD", "name": "警戒者矿锭"},
            {"code": "XTK", "name": "星体晶块"},
            {"code": "JMB", "name": "边角料积木"},
            {"code": "HNK", "name": "硬脑壳头盔"},
        ]

        self.specs: dict[str, Spec] = {}
        for p in self.products:
            self.specs[p["code"]] = self._make_spec()

        self.market: dict[str, Market] = {}
        for p in self.products:
            code = p["code"]
            for ym in self.contract_months:
                symbol = f"{code}{ym}"
                self.market[symbol] = init_market(symbol=symbol, code=code, spec=self.specs[code])

        # Account snapshot (single player demo)
        self.cash = 200000.0  # 调度券余额
        self.realized_pnl = 0.0
        self.fees = 0.0

        self.positions: list[Position] = []
        self.orders: list[Order] = []
        self.trades: list[Trade] = []
        self.tick = 0
        self.ticks_per_day = 30 
        self.round_log: list[dict] = []

        self._order_id = 1000
        self.ws_clients: dict[str, WebSocket] = {}
        self.day_klines: dict[str, list[dict]] = {}
        for sym in self.market.keys():
            self.day_klines[sym] = []

    def _make_spec(self) -> Spec:
        base = 1000.0 + random.random() * 3000.0  # 1000–4000

        # 四位数标的更常见的最小变动价位（游戏里更好看）
        tick = [1.0, 2.0, 5.0, 10.0][int(random.random() * 4)]

        # 涨跌停、保证金比例保持你原来的风格
        limit_pct = [0.08, 0.10, 0.12][int(random.random() * 3)]
        margin = [0.10, 0.12, 0.14][int(random.random() * 3)]

        # 价格上来后，乘数也可以稍微调小一点，不然权益/保证金波动太夸张
        mult = [5, 10, 20][int(random.random() * 3)]

        return Spec(base=base, tick=tick, limit_pct=limit_pct, margin=margin, mult=mult)

    def _main_contract(self, code: str) -> str:
        return f"{code}{self.contract_months[0]}"

    def bootstrap_payload(self) -> dict:
        products = []
        for p in self.products:
            code = p["code"]
            asset = self.frontend_dir / "assets" / f"{code}.png"
            products.append(
                {
                    "code": code,
                    "name": p["name"],
                    "asset_file": f"/assets/{code}.png" if asset.exists() else None,
                    "main_contract": self._main_contract(code),
                }
            )
        specs = {
            code: {
                "tick": s.tick,
                "limit_pct": s.limit_pct,
                "margin": s.margin,
                "mult": s.mult,
            }
            for code, s in self.specs.items()
        }
        return {"products": products, "specs": specs}

    def state_payload(self) -> dict:
        market = {k: self._market_payload(v) for k, v in self.market.items() if k.endswith(self.contract_months[0])}
        # Only return main contracts for list + active chart simplicity
        # (You can expand later to all contracts)
        return {
            "market": market,
            "account": self._account_payload(),
            "positions": [self._position_payload(p) for p in self.positions],
            "orders": [self._order_payload(o) for o in self.orders],
            "trades": [self._trade_payload(t) for t in self.trades],
            "round_log": self.round_log[-40:],
            "day_klines": self.day_klines,
        }

    def _market_payload(self, m: Market) -> dict:
        return {
            "symbol": m.symbol,
            "prev_settle": m.prev_settle,
            "limit_up": m.limit_up,
            "limit_down": m.limit_down,
            "open": m.open,
            "high": m.high,
            "low": m.low,
            "last": m.last,
            "vol": m.vol,
            "oi": m.oi,
            "series": m.series,
        }

    def _unrealized_pnl(self) -> float:
        total = 0.0
        for p in self.positions:
            m = self.market[p.symbol]
            diff = m.last - p.avg_open
            pnl = (diff if p.side == "long" else -diff) * p.mult * p.qty
            total += pnl
        return total

    def _margin_used(self) -> float:
        mu = 0.0
        for p in self.positions:
            m = self.market[p.symbol]
            spec = self.specs[m.code]
            notional = m.last * spec.mult * p.qty
            mu += notional * spec.margin
        return mu

    def _account_payload(self) -> dict:
        unrealized = self._unrealized_pnl()
        equity = self.cash + unrealized
        margin_used = self._margin_used()
        avail = equity - margin_used
        return {
            "cash": self.cash,
            "equity": equity,
            "avail": avail,
            "margin_used": margin_used,
            "unrealized_pnl": unrealized,
            "realized_pnl": self.realized_pnl,
            "fees": self.fees,
            "unit": "调度券",
        }

    def _position_payload(self, p: Position) -> dict:
        return {
            "symbol": p.symbol,
            "side": p.side,
            "qty": p.qty,
            "avg_open": p.avg_open,
            "mult": p.mult,
            "margin": p.margin,
        }

    def _order_payload(self, o: Order) -> dict:
        return {
            "id": o.order_id,
            "symbol": o.symbol,
            "side": o.side,
            "effect": o.effect,
            "price": o.price,
            "qty": o.qty,
            "status": o.status,
            "ts": o.ts,
        }

    def _trade_payload(self, t: Trade) -> dict:
        return {
            "id": t.trade_id,
            "symbol": t.symbol,
            "side": t.side,
            "effect": t.effect,
            "price": t.price,
            "qty": t.qty,
            "fee": t.fee,
            "ts": t.ts,
        }

    # --------- Core actions ----------
    def advance_tick(self) -> None:
        # advance all MAIN contracts
        for p in self.products:
            code = p["code"]
            sym = self._main_contract(code)
            m = self.market[sym]
            advance_market_tick(m, self.specs[code])

        # attempt match pending orders (main contracts only)
        for o in self.orders:
            if o.status != "new":
                continue
            m = self.market[o.symbol]
            if is_marketable(o, m):
                self._fill_order(o, m.last)

        # round log
        self._append_log("Tick 推进", "市场报价已更新一轮")
        # ...在 advance_tick 末尾（tick += 1 之后或之前都行，但建议之后）
        self.tick += 1

        if self.tick % self.ticks_per_day == 0:
            day = self.tick // self.ticks_per_day  # 第几天（从1开始更直觉也行）

            main_suffix = self.contract_months[0]
            for sym, m in self.market.items():
                if not sym.endswith(main_suffix):
                    continue
                self.day_klines.setdefault(sym, []).append({
                    "day": day,
                    "open": m.open,
                    "high": m.high,
                    "low": m.low,
                    "close": m.last,
                    "vol": m.vol,
                })
                roll_market_day(m, self.specs[m.code])

            self._append_log("换日", f"进入第 {self.tick // self.ticks_per_day + 1} 天，已按收盘价重算涨跌停")

    def place_order(self, payload: dict) -> dict:
        symbol = str(payload.get("symbol", "")).strip()
        side = str(payload.get("side", "")).strip()
        effect = str(payload.get("effect", "")).strip()
        price = float(payload.get("price", 0.0))
        qty = int(payload.get("qty", 0))

        if symbol not in self.market:
            return {"ok": False, "error": "unknown symbol"}

        if qty <= 0:
            return {"ok": False, "error": "qty must be > 0"}

        m = self.market[symbol]
        spec = self.specs[m.code]

        # enforce tick + limit
        px = round_to(price, spec.tick)
        px = clamp(px, m.limit_down, m.limit_up)

        # close availability
        if effect == "close":
            need_side = "long" if side == "sell" else "short"
            pos = self._get_pos(symbol, need_side)
            if pos is None or pos.qty < qty:
                return {"ok": False, "error": "position not enough"}

        # margin check (open)
        if effect == "open":
            notional = px * spec.mult * qty
            need_margin = notional * spec.margin
            avail = self._account_payload()["avail"]
            if avail < need_margin:
                return {"ok": False, "error": "margin not enough"}

        self._order_id += 1
        o = Order(
            order_id=self._order_id,
            symbol=symbol,
            side=side,
            effect=effect,
            price=px,
            qty=qty,
            status="new",
            ts=now_str(),
        )
        self.orders.append(o)

        # try immediate fill
        if is_marketable(o, m):
            self._fill_order(o, m.last)

        self._append_log("委托提交", f"{symbol} {side}/{effect} {qty}手 @ {px:.2f}")
        return {"ok": True, "order_id": o.order_id}

    def cancel_all(self) -> None:
        for o in self.orders:
            if o.status == "new":
                o.status = "cancelled"
        self._append_log("撤单", "已撤销所有未成交委托")

    def close_position(self, payload: dict) -> None:
        symbol = str(payload.get("symbol", "")).strip()
        side = str(payload.get("side", "")).strip()
        qty = int(payload.get("qty", 0))
        if qty <= 0:
            return
        pos = self._get_pos(symbol, side)
        if pos is None:
            return
        q = min(qty, pos.qty)
        m = self.market[symbol]
        spec = self.specs[m.code]
        fee = fee_for(q)
        pnl = (m.last - pos.avg_open) * (1 if side == "long" else -1) * spec.mult * q
        self.cash += pnl - fee
        self.realized_pnl += pnl
        self.fees += fee
        pos.qty -= q
        if pos.qty == 0:
            self.positions = [p for p in self.positions if not (p.symbol == symbol and p.side == side)]
        self.trades.append(
            Trade(
                trade_id=f"C{len(self.trades)+1}",
                symbol=symbol,
                side="sell" if side == "long" else "buy",
                effect="close",
                price=m.last,
                qty=q,
                fee=fee,
                ts=now_str(),
            )
        )
        self._append_log("手动平仓", f"{symbol} {side} 平 {q}手 @ {m.last:.2f}")

    # --------- Internal helpers ----------
    def _get_pos(self, symbol: str, side: str) -> Position | None:
        for p in self.positions:
            if p.symbol == symbol and p.side == side:
                return p
        return None

    def _fill_order(self, o: Order, fill_price: float) -> None:
        if o.status != "new":
            return
        m = self.market[o.symbol]
        spec = self.specs[m.code]

        fee = fee_for(o.qty)
        o.status = "filled"

        self.trades.append(
            Trade(
                trade_id=f"T{o.order_id}",
                symbol=o.symbol,
                side=o.side,
                effect=o.effect,
                price=fill_price,
                qty=o.qty,
                fee=fee,
                ts=now_str(),
            )
        )
        self.fees += fee

        if o.effect == "open":
            pos_side = "long" if o.side == "buy" else "short"
            pos = self._get_pos(o.symbol, pos_side)
            if pos is None:
                self.positions.append(
                    Position(
                        symbol=o.symbol,
                        side=pos_side,
                        qty=o.qty,
                        avg_open=fill_price,
                        mult=spec.mult,
                        margin=fill_price * spec.mult * o.qty * spec.margin,
                    )
                )
            else:
                new_qty = pos.qty + o.qty
                pos.avg_open = (pos.avg_open * pos.qty + fill_price * o.qty) / new_qty
                pos.qty = new_qty
                pos.margin = fill_price * spec.mult * pos.qty * spec.margin
            self.cash -= fee
        else:
            # close
            need_side = "long" if o.side == "sell" else "short"
            pos = self._get_pos(o.symbol, need_side)
            if pos is None:
                return
            q = min(o.qty, pos.qty)
            pnl = (fill_price - pos.avg_open) * (1 if need_side == "long" else -1) * spec.mult * q
            self.cash += pnl - fee
            self.realized_pnl += pnl
            pos.qty -= q
            pos.margin = fill_price * spec.mult * pos.qty * spec.margin
            if pos.qty == 0:
                self.positions = [p for p in self.positions if not (p.symbol == o.symbol and p.side == need_side)]

        self._append_log("成交回报", f"{o.symbol} {o.side}/{o.effect} {o.qty}手 @ {fill_price:.2f}，费 {fee:.2f}")

    def _append_log(self, title: str, detail: str) -> None:
        self.round_log.append({"title": title, "detail": detail, "ts": now_str()})
        if len(self.round_log) > 80:
            self.round_log.pop(0)

    # --------- WebSocket helpers ----------
    def ws_register(self, ws: WebSocket) -> str:
        cid = f"c{len(self.ws_clients)+1}"
        self.ws_clients[cid] = ws
        return cid

    def ws_unregister(self, client_id: str) -> None:
        if client_id in self.ws_clients:
            del self.ws_clients[client_id]

    async def ws_broadcast_state(self) -> None:
        payload = {"type": "state", "data": self.state_payload()}
        for cid, ws in list(self.ws_clients.items()):
            await ws.send_json(payload)
    
    # --------- Reset helpers ----------
    def reset_player(self) -> None:
        self.cash = 200000.0
        self.realized_pnl = 0.0
        self.fees = 0.0

        self.positions = []
        self.orders = []
        self.trades = []
        self.round_log = []

        self._order_id = 1000

        self._append_log("重置", "已重置玩家账户/持仓/委托/成交")


    def reset_market(self) -> None:
        self.market = {}
        for p in self.products:
            code = p["code"]
            for ym in self.contract_months:
                symbol = f"{code}{ym}"
                self.market[symbol] = init_market(symbol=symbol, code=code, spec=self.specs[code])

        # 市场重置后，旧委托/成交/日志清掉，避免穿越
        self.orders = []
        self.trades = []
        self.round_log = []

        self._append_log("重置", "已重置市场行情并清空委托/成交")

    def reset_all(self) -> None:
        # 最彻底：市场+玩家都回到初始
        self.reset_market()
        self.reset_player()
