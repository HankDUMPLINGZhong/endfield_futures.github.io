
from __future__ import annotations

from pathlib import Path
from fastapi import FastAPI, WebSocket
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from loguru import logger
from backend.engine.state import GameState
from fastapi.middleware.cors import CORSMiddleware


BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = (BASE_DIR.parent / "frontend").resolve()

app = FastAPI(title="Futures Sim Backend (调度券版)")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIR / "assets")), name="assets")

state = GameState(frontend_dir=FRONTEND_DIR)


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return (FRONTEND_DIR / "index.html").read_text(encoding="utf-8")


@app.get("/api/bootstrap")
def bootstrap() -> dict:
    return state.bootstrap_payload()


@app.get("/api/state")
def get_state() -> dict:
    return state.state_payload()

@app.post("/api/reset_player")
def reset_player() -> dict:
    state.reset_player()
    return {"ok": True}


@app.post("/api/reset_market")
def reset_market() -> dict:
    state.reset_market()
    return {"ok": True}

@app.post("/api/tick")
def tick() -> dict:
    state.advance_tick()
    return {"ok": True}

@app.post("/api/reset_all")
def reset_all() -> dict:
    global state
    state = GameState(frontend_dir=FRONTEND_DIR)
    return {"ok": True}

@app.post("/api/orders")
def place_order(payload: dict) -> dict:
    return state.place_order(payload)


@app.post("/api/cancel_all")
def cancel_all() -> dict:
    state.cancel_all()
    return {"ok": True}


@app.post("/api/close")
def close_position(payload: dict) -> dict:
    state.close_position(payload)
    return {"ok": True}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    client_id = state.ws_register(ws)
    logger.info("ws connected: {}", client_id)
    try:
        await ws.send_json({"type": "bootstrap", "data": state.bootstrap_payload()})
        await ws.send_json({"type": "state", "data": state.state_payload()})
        while True:
            msg = await ws.receive_json()
            # Minimal protocol: client can request tick / place order / cancel
            mtype = msg.get("type")
            data = msg.get("data", {})
            if mtype == "tick":
                state.advance_tick()
                await state.ws_broadcast_state()
            elif mtype == "order":
                state.place_order(data)
                await state.ws_broadcast_state()
            elif mtype == "cancel_all":
                state.cancel_all()
                await state.ws_broadcast_state()
            elif mtype == "close":
                state.close_position(data)
                await state.ws_broadcast_state()
            else:
                await ws.send_json({"type": "error", "message": "unknown message type"})
    finally:
        state.ws_unregister(client_id)
        logger.info("ws disconnected: {}", client_id)
