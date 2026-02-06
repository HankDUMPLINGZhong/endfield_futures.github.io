# 调度券期货模拟（回合制 Tick）— 前后端一体 Demo

## 结构
- `frontend/`：静态页面 + 12 个货品素材（直接由后端提供）
- `backend/`：FastAPI 后端（内存态，单用户演示）
  - `backend/app.py`：HTTP + WebSocket 入口
  - `backend/engine/`：撮合/行情/状态

## 运行（推荐用 uv）
在项目根目录：

```bash
uv init
uv add fastapi uvicorn loguru
uv run uvicorn backend.app:app --reload --host 127.0.0.1 --port 5000
```

然后打开：`http://127.0.0.1:5000/`

## 玩法
- 点顶部「下一 Tick」：后端推进一轮行情（所有主力合约）
- 下单：`POST /api/orders`，后端校验涨跌停/tick/保证金，并尝试成交
- 平仓：持仓表按钮会调用 `POST /api/close`
- 公告：来自后端 round_log（Tick 推进/委托/成交）

## 后续 TODO（你再说一声我就能继续补）
- 多用户：按 session / user_id 隔离 GameState
- 真正订单簿撮合（maker/taker、价时优先）
- 逐日盯市（日结结算价）、追保/强平
- 多合约月份（不仅主力）
- WS 推送（前端已经能用 REST；也可切 WS）
