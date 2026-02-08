
from __future__ import annotations

from pathlib import Path
from fastapi import FastAPI, WebSocket
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from loguru import logger
from backend.engine.state import GameState
from fastapi.middleware.cors import CORSMiddleware
import json
import secrets
from fastapi import Request, Response
from backend.persist import init_db, load_state_json, save_state_json, delete_session


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

init_db()
def _get_session_id(req: Request, resp: Response) -> str:
    sid = req.cookies.get("session_id")
    if sid and isinstance(sid, str) and len(sid) >= 16:
        return sid
    sid = secrets.token_urlsafe(24)
    # 同站 cookie；线上 https 建议加 secure=True（Render 上通常是 https）
    resp.set_cookie("session_id", sid, httponly=True, samesite="lax")
    return sid


def _load_state(session_id: str) -> GameState:
    raw = load_state_json(session_id)
    if raw:
        d = json.loads(raw)
        return GameState.from_dict(d, frontend_dir=FRONTEND_DIR)
    # 新 session：新开一局（保留你的随机 specs）
    return GameState(frontend_dir=FRONTEND_DIR)


def _save_state(session_id: str, gs: GameState) -> None:
    save_state_json(session_id, json.dumps(gs.to_dict(), ensure_ascii=False))


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return (FRONTEND_DIR / "index.html").read_text(encoding="utf-8")


@app.get("/api/bootstrap")
def bootstrap(req: Request, resp: Response) -> dict:
    sid = _get_session_id(req, resp)
    gs = _load_state(sid)
    _save_state(sid, gs)  # 保险：第一次 bootstrap 时也落盘
    return gs.bootstrap_payload()

@app.get("/api/state")
def get_state(req: Request, resp: Response) -> dict:
    sid = _get_session_id(req, resp)
    gs = _load_state(sid)
    return gs.state_payload()

@app.post("/api/tick")
def tick(req: Request, resp: Response) -> dict:
    sid = _get_session_id(req, resp)
    gs = _load_state(sid)
    gs.advance_tick()
    _save_state(sid, gs)
    return {"ok": True}

@app.post("/api/reset_all")
def reset_all(req: Request, resp: Response) -> dict:
    sid = _get_session_id(req, resp)
    delete_session(sid)  # 直接删档，下次 load 会生成新局
    return {"ok": True}

@app.post("/api/orders")
def place_order(payload: dict, req: Request, resp: Response) -> dict:
    sid = _get_session_id(req, resp)
    gs = _load_state(sid)
    out = gs.place_order(payload)
    _save_state(sid, gs)
    return out



@app.post("/api/cancel_all")
def cancel_all(req: Request, resp: Response) -> dict:
    sid = _get_session_id(req, resp)
    gs = _load_state(sid)

    gs.cancel_all()

    _save_state(sid, gs)
    return {"ok": True}


@app.post("/api/close")
def close_position(payload: dict, req: Request, resp: Response) -> dict:
    sid = _get_session_id(req, resp)
    gs = _load_state(sid)

    gs.close_position(payload)

    _save_state(sid, gs)
    return {"ok": True}

'''
@app.websocket("/ws")
    #TODO:websocket
'''