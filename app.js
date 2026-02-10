// ========== Backend-driven Frontend (Pyodide Local) ==========
const API_BASE = "";
console.log("API_BASE =", API_BASE);

const CONTRACT_MONTHS = ["2603","2604","2606"];

// UI helpers
const el = (id) => document.getElementById(id);
function fmt(n, d=2){ return Number(n).toLocaleString('zh-CN', {minimumFractionDigits:d, maximumFractionDigits:d}); }
function fmt0(n){ return Number(n).toLocaleString('zh-CN'); }
function nowStr(){ return new Date().toLocaleTimeString('zh-CN', {hour12:false}); }

// Local save keys
const SAVE_KEY = "EF_SAVE_V1";

// State from engine
let PRODUCTS = [];
let MARKET = {};      // symbol -> market snapshot
let SPECS = {};       // code -> spec
let ACCOUNT = null;   // snapshot
let POSITIONS = [];
let ORDERS = [];
let TRADES = [];
let ROUND_LOG = [];

let selectedProductCode = null;
let selectedContractSymbol = null;
let currentAction = "open_long";
let activeTab = "orders";
let chartMode = "tick"; // "tick" | "day"
let DAY_KLINES = {};
let tickAutoScale = true; // true=按数据缩放，false=按涨跌停缩放

// ========== Pyodide Local API ==========
let pyodideReady = null;

async function initPy(){
  if(pyodideReady) return pyodideReady;

  pyodideReady = (async () => {
    const pyodide = await loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.1/full/" });

    // 写入 engine 源码到 Pyodide FS
    pyodide.FS.mkdirTree("/engine");
    const files = ["__init__.py", "models.py", "matching.py", "market.py", "state.py"];
    for(const f of files){
      const res = await fetch(`py/engine/${f}`);
      if(!res.ok) throw new Error(`load py/engine/${f} failed (${res.status})`);
      const code = await res.text();
      pyodide.FS.writeFile(`/engine/${f}`, code);
    }

    // 初始化 Python 侧 API
    await pyodide.runPythonAsync(`
import sys, json
sys.path.append("/")

from engine.state import GameState

gs = GameState()

def _load(raw):
    global gs
    if raw:
        gs = GameState.from_dict(json.loads(raw))
    else:
        gs = GameState()

def _dump():
    return json.dumps(gs.to_dict(), ensure_ascii=False, allow_nan=False)

def api_bootstrap():
    return json.dumps(gs.bootstrap_payload(), ensure_ascii=False, allow_nan=False)

def api_state():
    return json.dumps(gs.state_payload(), ensure_ascii=False, allow_nan=False)

def api_tick():
    gs.advance_tick()
    return json.dumps({"ok": True}, ensure_ascii=False, allow_nan=False)

def api_orders(payload_json):
    payload = json.loads(payload_json)
    out = gs.place_order(payload)
    return json.dumps(out, ensure_ascii=False, allow_nan=False)

def api_cancel_all():
    gs.cancel_all()
    return json.dumps({"ok": True}, ensure_ascii=False, allow_nan=False)

def api_close(payload_json):
    payload = json.loads(payload_json)
    gs.close_position(payload)
    return json.dumps({"ok": True}, ensure_ascii=False, allow_nan=False)

def api_reset_all():
    gs.reset_all()
    return json.dumps({"ok": True}, ensure_ascii=False, allow_nan=False)
    `);

    // 载入存档
    const raw = localStorage.getItem(SAVE_KEY);
    pyodide.globals.get("_load")(raw);

    return pyodide;
  })();

  return pyodideReady;
}

async function localCall(name, payload){
  const pyodide = await initPy();
  const fn = pyodide.globals.get(name);
  try{
    const out = (payload === undefined) ? fn() : fn(payload);

    // 每次调用后持久化
    const dumpFn = pyodide.globals.get("_dump");
    const raw = dumpFn();
    localStorage.setItem(SAVE_KEY, raw);

    return JSON.parse(out);
  } finally {
    if(fn && fn.destroy) fn.destroy();
  }
}

async function apiGet(path){
  if(path === "/api/bootstrap") return await localCall("api_bootstrap");
  if(path === "/api/state") return await localCall("api_state");
  throw new Error("Unknown GET " + path);
}

async function apiPost(path, payload){
  if(path === "/api/tick") return await localCall("api_tick");
  if(path === "/api/orders") return await localCall("api_orders", JSON.stringify(payload || {}));
  if(path === "/api/cancel_all") return await localCall("api_cancel_all");
  if(path === "/api/close") return await localCall("api_close", JSON.stringify(payload || {}));
  if(path === "/api/reset_all"){
    // 先清本地存档，再重置引擎
    localStorage.removeItem(SAVE_KEY);
    return await localCall("api_reset_all");
  }
  throw new Error("Unknown POST " + path);
}

// Toast
function toast(title, detail){
  const wrap = el("toast");
  const t = document.createElement("div");
  t.className = "item";
  t.innerHTML = `<div style="font-weight:900">${title}</div><div class="small">${detail}</div>`;
  wrap.prepend(t);
  setTimeout(()=>{ t.style.opacity="0"; t.style.transform="translateY(-6px)"; t.style.transition="all .25s ease"; }, 2400);
  setTimeout(()=>t.remove(), 2800);
}

function actionLabel(a){
  return ({
    open_long: "开多",
    open_short: "开空",
    close_long: "平多",
    close_short: "平空",
  })[a] || a;
}

function setAction(a){
  currentAction = a;
  const map = {
    open_long: "btnOpenLong",
    open_short: "btnOpenShort",
    close_long: "btnCloseLong",
    close_short: "btnCloseShort",
  };
  Object.values(map).forEach(id => el(id).classList.remove("primary"));
  el(map[a]).classList.add("primary");
  renderAll();
}

// Left list
function buildList(){
  const q = (el("search").value || "").trim().toUpperCase();
  const productList = el("productList");
  productList.innerHTML = "";

  PRODUCTS
    .filter(p => !q || p.code.includes(q) || p.name.includes(q))
    .forEach(p => {
      const mainSymbol = p.main_contract;
      const m = MARKET[mainSymbol];
      const chg = (m.last - m.prev_settle);
      const chgPct = chg / m.prev_settle;
      const up = chg >= 0;

      const card = document.createElement("div");
      card.className = "card" + (p.code===selectedProductCode ? " active" : "");
      card.innerHTML = `
        <div class="icon">${p.asset_file ? `<img src="${p.asset_file}" alt="${p.name}"/>` : ""}</div>
        <div class="meta">
          <div class="name">${p.name}</div>
          <div class="code">${p.code} · 主力 ${mainSymbol.slice(-4)}</div>
        </div>
        <div class="meta2">
          <div class="px">${fmt(m.last, 2)}</div>
          <div class="chg ${up ? "up":"down"}">${up?"+":""}${fmt(chg,2)} (${up?"+":""}${(chgPct*100).toFixed(2)}%)</div>
        </div>
      `;
      card.onclick = () => {
        selectedProductCode = p.code;
        selectedContractSymbol = p.main_contract;
        toast(`切换品种：${p.name}`, `主力合约 ${selectedContractSymbol}`);
        buildList();
        renderAll();
      };
      productList.appendChild(card);
    });
}

function drawChart(series, dn, up){
  const canvas = el("chart");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0,0,W,H);

  // grid
  ctx.globalAlpha = 0.8;
  ctx.strokeStyle = "rgba(31,42,58,0.8)";
  ctx.lineWidth = 1;
  for(let i=1;i<6;i++){
    const y = Math.round(H*i/6);
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
  }
  for(let i=1;i<10;i++){
    const x = Math.round(W*i/10);
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke();
  }

  // ====== scale: auto by series bounds or fixed by limit ======
  let min = dn, max = up;

  if (tickAutoScale && series && series.length > 1) {
    let smin = Infinity, smax = -Infinity;
    for (const v of series) {
      if (v < smin) smin = v;
      if (v > smax) smax = v;
    }

    // 给上下留 6% 空气，防止贴边
    let span = smax - smin;
    if (!(span > 0)) span = 1;

    const pad = span * 0.06;
    min = smin - pad;
    max = smax + pad;

    // 可选：仍然把显示范围限制在涨跌停附近，避免极端点把图拉扁
    const limitPad = (up - dn) * 0.02;
    min = Math.max(min, dn - limitPad);
    max = Math.min(max, up + limitPad);
  }

  // 防止除零
  if (!(max > min)) {
    max = min + 1;
  }
  const padL = 26, padT = 18;
  const innerW = W - padL*2;
  const innerH = H - padT*2;

  function toXY(i, v){
    const x = padL + (i/(series.length-1))*innerW;
    const t = (v - min)/(max-min);
    const y = padT + (1-t)*innerH;
    return [x,y];
  }

  ctx.globalAlpha = 1;
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.beginPath();
  series.forEach((v,i)=>{
    const [x,y] = toXY(i,v);
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke();

  // limit bands (mapped to price)
  const yUp = toXY(0, up)[1];
  const yDn = toXY(0, dn)[1];

  ctx.setLineDash([6,6]);
  ctx.strokeStyle = "rgba(255,204,102,0.55)";
  ctx.lineWidth = 1.2;

  ctx.beginPath(); ctx.moveTo(padL, yUp); ctx.lineTo(W-padT, yUp); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(padL, yDn); ctx.lineTo(W-padL, yDn); ctx.stroke();

  ctx.setLineDash([]);

  ctx.font = "12px ui-monospace, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
  ctx.fillStyle = "rgba(143,162,186,0.9)";
  ctx.fillText("涨停 " + up.toFixed(2), 12, 14);
  ctx.fillText("跌停 " + dn.toFixed(2), 12, H-6);
}

function drawDayK(klines){
  const canvas = el("chart");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0,0,W,H);

  // grid（沿用你现在的风格）
  ctx.globalAlpha = 0.8;
  ctx.strokeStyle = "rgba(31,42,58,0.8)";
  ctx.lineWidth = 1;
  for(let i=1;i<6;i++){
    const y = Math.round(H*i/6);
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
  }
  for(let i=1;i<10;i++){
    const x = Math.round(W*i/10);
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke();
  }
  ctx.globalAlpha = 1;

  if(!klines || klines.length === 0){
    ctx.font = "14px ui-monospace, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
    ctx.fillStyle = "rgba(143,162,186,0.9)";
    ctx.fillText("暂无日K数据（先推进到换日）", 18, 26);
    return;
  }

  // 取最近 N 根
  const N = Math.min(60, klines.length);
  const data = klines.slice(-N);

  let lo = Infinity, hi = -Infinity;
  for(const k of data){
    lo = Math.min(lo, k.low);
    hi = Math.max(hi, k.high);
  }
  if(!(hi > lo)) hi = lo + 1;

  const padL = 26, padR = 26;
  const padT = 18, padB = 44;   // 👈 底部加大
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  function yOf(v){
    const t = (v - lo) / (hi - lo);
    return padT + (1 - t) * innerH;
  }

  const xStep = innerW / N;
  const bodyW = Math.max(3, xStep * 0.55);

  // 画蜡烛
  for(let i=0;i<N;i++){
    const k = data[i];
    const x = padL + i * xStep + xStep/2;

    const yo = yOf(k.open);
    const yc = yOf(k.close);
    const yh = yOf(k.high);
    const yl = yOf(k.low);

    const up = k.close >= k.open;

    // 影线
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yh);
    ctx.lineTo(x, yl);
    ctx.stroke();

    // 实体
    const top = Math.min(yo, yc);
    const bot = Math.max(yo, yc);
    const h = Math.max(2, bot - top);

    ctx.fillStyle = up ? "rgba(120,220,160,0.75)" : "rgba(255,120,120,0.75)";
    ctx.fillRect(x - bodyW/2, top, bodyW, h);
  }

  // 左上/左下标尺
  ctx.font = "12px ui-monospace, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
  ctx.fillStyle = "rgba(143,162,186,0.9)";
  ctx.fillText("日高 " + hi.toFixed(2), 12, 14);
  ctx.fillText("日低 " + lo.toFixed(2), 12, H-10);
}

function renderMid(){
  const p = PRODUCTS.find(x => x.code===selectedProductCode);
  const m = MARKET[selectedContractSymbol];
  const spec = SPECS[p.code];

  el("instName").textContent = `${m.symbol}  ${p.name}`;
  el("instMeta").textContent = `乘数 ${spec.mult} · 保证金 ${Math.round(spec.margin*100)}% · 涨跌停 ±${Math.round(spec.limit_pct*100)}%`;
  el("limitText").textContent = `涨停 ${fmt(m.limit_up,2)} / 跌停 ${fmt(m.limit_down,2)}`;
  el("settleTag").textContent = `昨结 ${fmt(m.prev_settle,2)}`;
  el("tick").textContent = spec.tick;

  const chg = m.last - m.prev_settle;
  const pct = chg / m.prev_settle * 100;
  const up = chg >= 0;

  const lastEl = el("lastPrice");
  lastEl.textContent = fmt(m.last,2);
  lastEl.className = "big " + (up ? "up":"down");

  el("chgAbs").textContent = `${up?"+":""}${fmt(chg,2)}`;
  el("chgAbs").className = up ? "up" : "down";
  el("chgPct").textContent = `(${up?"+":""}${pct.toFixed(2)}%)`;
  el("chgPct").className = up ? "up" : "down";

  el("openPx").textContent = fmt(m.open,2);
  el("highPx").textContent = fmt(m.high,2);
  el("lowPx").textContent = fmt(m.low,2);
  el("vol").textContent = fmt0(m.vol);
  el("oi").textContent = fmt0(m.oi);

  const t = (m.last - m.limit_down) / (m.limit_up - m.limit_down);
  el("bandMarker").style.left = `${(t*100).toFixed(2)}%`;

  const pi = el("priceInput");
  if(document.activeElement !== pi){
    pi.value = fmt(m.last,2);
  }

  if(chartMode === "tick"){
    drawChart(m.series, m.limit_down, m.limit_up);
    el("chartHint").textContent = "Tick：分时折线（连续 tick 走势）";
  }else{
    const ks = DAY_KLINES?.[selectedContractSymbol] || [];
    drawDayK(ks);
    el("chartHint").textContent = "日K：按天汇总的 K 线（需要先换日产生数据）";
  }
}

function renderAccount(){
  if(!ACCOUNT) return;
  el("equity").textContent = fmt(ACCOUNT.equity,2) + " 券";
  el("avail").textContent = fmt(ACCOUNT.avail,2) + " 券";
  el("marginUsed").textContent = fmt(ACCOUNT.margin_used,2) + " 券";
  el("uPnl").textContent = (ACCOUNT.unrealized_pnl>=0?"+":"") + fmt(ACCOUNT.unrealized_pnl,2) + " 券";
  el("uPnl").className = ACCOUNT.unrealized_pnl>=0 ? "up" : "down";
  el("rPnl").textContent = (ACCOUNT.realized_pnl>=0?"+":"") + fmt(ACCOUNT.realized_pnl,2) + " 券";
  el("rPnl").className = ACCOUNT.realized_pnl>=0 ? "up" : "down";
  el("fees").textContent = fmt(ACCOUNT.fees,2) + " 券";

  const risk = ACCOUNT.equity<=0 ? 100 : Math.max(0, Math.min(999, (ACCOUNT.margin_used/ACCOUNT.equity)*100));
  el("riskPill").textContent = `风险度 ${risk.toFixed(1)}%`;
  el("riskBar").style.width = `${Math.max(0, Math.min(100, risk)).toFixed(1)}%`;

  el("orderHint").textContent = `当前：${selectedContractSymbol} · ${actionLabel(currentAction)} · 余额单位=调度券 · ${ACCOUNT.avail<0 ? "⚠️ 可用为负（后端可实现追保/强平）" : "状态正常"}`;
}

function renderPositions(){
  const wrap = el("positions");
  el("posHint").textContent = `${POSITIONS.length} 条`;

  if(POSITIONS.length===0){
    wrap.innerHTML = `<div class="hint">暂无持仓。试试开多/开空一手，然后点“下一 Tick”推进行情。</div>`;
    return;
  }
  const rows = POSITIONS.map(p => {
    const m = MARKET[p.symbol];
    const diff = m.last - p.avg_open;
    const pnl = (p.side==="long" ? diff : -diff) * p.mult * p.qty;
    const up = pnl >= 0;
    return `
      <tr>
        <td style="white-space:nowrap;">${p.symbol}</td>
        <td>${p.side==="long" ? `<span class="up">多</span>` : `<span class="down">空</span>`}</td>
        <td>${p.qty}</td>
        <td>${fmt(p.avg_open,2)}</td>
        <td class="${up?"up":"down"}">${up?"+":""}${fmt(pnl,2)} 券</td>
        <td>${fmt(p.margin,2)} 券</td>
        <td>
          <button class="btn" style="padding:6px 8px;font-size:12px" onclick="window.__closePos('${p.symbol}','${p.side}',1)">平1</button>
          <button class="btn" style="padding:6px 8px;font-size:12px" onclick="window.__closePos('${p.symbol}','${p.side}',${p.qty})">全平</button>
        </td>
      </tr>
    `;
  }).join("");

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>合约</th><th>方向</th><th>手数</th><th>均价</th><th>浮盈亏</th><th>保证金</th><th>操作</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

window.__closePos = async (symbol, side, qty) => {
  try{
    await apiPost("/api/close", {symbol, side, qty});
    await refreshState();
    toast("平仓完成", `${symbol} ${side==="long"?"多":"空"} ${qty}手`);
  }catch(e){
    toast("平仓失败", String(e));
  }
};

function renderTab(){
  const body = el("tabBody");
  if(activeTab==="orders"){
    if(ORDERS.length===0){
      body.innerHTML = `<div class="hint">暂无委托。提交一笔委托后会在这里出现。</div>`;
      return;
    }
    const rows = ORDERS.slice().reverse().map(o => `
      <tr>
        <td style="white-space:nowrap">${o.symbol}</td>
        <td>${o.side==="buy" ? "<span class='up'>买</span>" : "<span class='down'>卖</span>"}</td>
        <td>${o.effect==="open" ? "开" : "平"}</td>
        <td>${o.qty}</td>
        <td>${fmt(o.price,2)}</td>
        <td>${o.status}</td>
        <td>${o.ts}</td>
      </tr>
    `).join("");
    body.innerHTML = `
      <table>
        <thead><tr><th>合约</th><th>方向</th><th>开平</th><th>手</th><th>价</th><th>状态</th><th>时间</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }else if(activeTab==="trades"){
    if(TRADES.length===0){
      body.innerHTML = `<div class="hint">暂无成交。</div>`;
      return;
    }
    const rows = TRADES.slice().reverse().map(t => `
      <tr>
        <td style="white-space:nowrap">${t.symbol}</td>
        <td>${t.side==="buy" ? "<span class='up'>买</span>" : "<span class='down'>卖</span>"}</td>
        <td>${t.effect==="open" ? "开" : "平"}</td>
        <td>${t.qty}</td>
        <td>${fmt(t.price,2)}</td>
        <td>${fmt(t.fee,2)} 券</td>
        <td>${t.ts}</td>
      </tr>
    `).join("");
    body.innerHTML = `
      <table>
        <thead><tr><th>合约</th><th>方向</th><th>开平</th><th>手</th><th>价</th><th>费</th><th>时间</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }else{
    const items = ROUND_LOG.slice().reverse().map(x => `
      <div class="newsItem" style="margin-bottom:10px">
        <div style="font-weight:900">${x.title}</div>
        <div class="small">${x.detail} · ${x.ts}</div>
      </div>
    `).join("");
    body.innerHTML = `
      <div class="hint" style="margin-bottom:10px">
        公告流：点击“下一 Tick”推进一轮价格，并在这里写入日志。
      </div>
      ${items || `<div class="hint">暂无公告。点一次“下一 Tick”试试。</div>`}
    `;
  }
}

function renderAll(){
  if(!selectedProductCode) return;
  if(!selectedContractSymbol) return;
  if(!MARKET || !MARKET[selectedContractSymbol]) return;
  renderMid();
  renderAccount();
  renderPositions();
  renderTab();
}

async function refreshState(){
  const s = await apiGet("/api/state");
  MARKET = s.market;
  DAY_KLINES = s.day_klines || {};
  ACCOUNT = s.account;
  POSITIONS = s.positions;
  ORDERS = s.orders;
  TRADES = s.trades;
  ROUND_LOG = s.round_log;
  renderAll();
  buildList();
  tutorial.onState(s);
}

// ===== 新手教程系统（最小可用版）=====
class Tutorial {
  constructor(){
    this.shadeTop = el("shadeTop");
    this.shadeLeft = el("shadeLeft");
    this.shadeRight = el("shadeRight");
    this.shadeBottom = el("shadeBottom");
    this.overlay = el("tutorialOverlay");
    this.bubble = el("tutorialBubble");
    this.spot = el("tutorialSpot");

    this.enabled = true;
    this.step = 0;

    this.didSubmit = false;
    this.didTick = false;

    const done = localStorage.getItem("EF_TUTORIAL_DONE");
    if(done === "1") this.enabled = false;

    this.steps = [
      {
        title: "欢迎来到武陵期货交易所",
        body: "我们用 2 个 Tick 完成你的第一笔交易：看价格 → 开多 → 下单 → 推进 Tick 看浮盈亏。",
        target: () => document.querySelector(".brand") || el("clock"),
        nextText: "开始！",
        canNext: () => true,
      },
      {
        title: "先看最新价",
        body: "中间这行大数字是最新价。所有价格都会被限制在涨跌停范围内。",
        target: () => el("lastPrice"),
        nextText: "我懂了！",
        canNext: () => true,
      },
      {
        title: "选择：开多",
        body: "先做最简单的交易：开多 1 手（押注价格上涨）。点右侧的「开多」。",
        target: () => el("btnOpenLong"),
        nextText: "哦齁！",
        canNext: () => true,
        hint: "如果你点了别的（开空/平仓），也没关系，切回开多即可继续。",
      },
      {
        title: "提交第一笔委托",
        body: "点击「提交委托」。价格默认等于最新价，数量默认 1 手。成交后你会在底部看到持仓。",
        target: () => el("btnSubmit"),
        nextText: "好的！",
        canNext: () => true,
        hint: "如果保证金不足/持仓不足，系统会提示错误，你可以先把数量改回 1。",
      },
      {
        title: "推进一个 Tick 看变化",
        body: "点顶部「下一 Tick」，市场报价更新一轮。看看持仓浮盈亏、风险度会怎么跳。",
        target: () => el("btnNextTick"),
        nextText: "冲啊！",
        canNext: () => this.didTick,
        hint: "这是回合制玩法的核心：你决定何时推进市场。",
      },
      {
        title: "你已完成第一轮交易教学",
        body: "恭喜！你已经学会：看价 → 下单 → 推进 Tick → 观察盈亏与风险。接下来可以尝试：挂更远的限价单、开空、或多品种轮动。",
        target: () => el("positions") || el("tabBody"),
        nextText: "开始在期市遨游！",
        canNext: () => true,
      },
    ];

    window.addEventListener("resize", () => this.render());
    window.addEventListener("scroll", () => this.render(), true);
  }

  start(){
    if(!this.enabled) return;
    this.show();
    this.step = 0;
    this.didSubmit = false;
    this.didTick = false;
    this.render();
  }

  show(){
    this.overlay.classList.add("show");
    this.bubble.style.display = "block";
    this.spot.style.display = "block";
  }
  hide(){
    this.overlay.classList.remove("show");
    this.bubble.style.display = "none";
    this.spot.style.display = "none";
  }

  finish(){
    localStorage.setItem("EF_TUTORIAL_DONE", "1");
    this.enabled = false;
    this.hide();
    toast("教程完成", "你已完成新手引导");
  }

  onAction(type){
    if(!this.enabled) return;
    if(type === "submit_ok") this.didSubmit = true;
    if(type === "tick_ok") this.didTick = true;
    this.render();
  }

  onState(state){
    if(!this.enabled) return;

    const hasPos = (state.positions || []).length > 0;
    if(hasPos && this.step < 4){
      this.didSubmit = true;
    }
    this.render();
  }

  next(){
    if(!this.enabled) return;
    const s = this.steps[this.step];
    if(!s) return;

    if(this.step === this.steps.length - 1){
      this.finish();
      return;
    }

    this.step += 1;
    this.render();
  }

  skip(){
    this.finish();
  }

  render(){
    if(!this.enabled) return;

    const s = this.steps[this.step];
    if(!s){
      this.finish();
      return;
    }

    const target = s.target();
    if(!target){
      setTimeout(() => this.render(), 120);
      return;
    }

    const rect = target.getBoundingClientRect();
    const pad = 8;

    const x = Math.max(8, rect.left - pad);
    const y = Math.max(8, rect.top - pad);
    const w = Math.min(window.innerWidth - 16, rect.width + pad*2);
    const h = Math.min(window.innerHeight - 16, rect.height + pad*2);

    this.shadeTop.style.left = "0px";
    this.shadeTop.style.top = "0px";
    this.shadeTop.style.width = window.innerWidth + "px";
    this.shadeTop.style.height = y + "px";

    this.shadeBottom.style.left = "0px";
    this.shadeBottom.style.top = (y + h) + "px";
    this.shadeBottom.style.width = window.innerWidth + "px";
    this.shadeBottom.style.height = Math.max(0, window.innerHeight - (y + h)) + "px";

    this.shadeLeft.style.left = "0px";
    this.shadeLeft.style.top = y + "px";
    this.shadeLeft.style.width = x + "px";
    this.shadeLeft.style.height = h + "px";

    this.shadeRight.style.left = (x + w) + "px";
    this.shadeRight.style.top = y + "px";
    this.shadeRight.style.width = Math.max(0, window.innerWidth - (x + w)) + "px";
    this.shadeRight.style.height = h + "px";

    this.spot.style.left = x + "px";
    this.spot.style.top = y + "px";
    this.spot.style.width = w + "px";
    this.spot.style.height = h + "px";

    const bubbleW = Math.min(380, window.innerWidth - 24);
    const bubbleH = 160;
    let bx = rect.right + 14;
    let by = rect.top;

    if(bx + bubbleW > window.innerWidth - 12){
      bx = rect.left - bubbleW - 14;
    }
    if(bx < 12){
      bx = 12;
      by = rect.bottom + 14;
    }
    if(by + bubbleH > window.innerHeight - 12){
      by = Math.max(12, rect.top - bubbleH - 14);
    }

    this.bubble.style.left = bx + "px";
    this.bubble.style.top = by + "px";

    const hintHtml = s.hint ? `<div class="tHint">${s.hint}</div>` : "";

    this.bubble.innerHTML = `
      <div class="tTitle">${s.title}</div>
      <div class="tBody">${s.body}</div>
      ${hintHtml}
      <div class="tBtns">
        <button class="btn" id="tSkip">跳过教程</button>
        <button class="btn primary" id="tNext">${s.nextText || "下一步"}</button>
      </div>
    `;

    el("tSkip").onclick = () => this.skip();
    el("tNext").onclick = () => this.next();
  }
}

const tutorial = new Tutorial();

window.resetTutorial = () => {
  localStorage.removeItem("EF_TUTORIAL_DONE");
  tutorial.enabled = true;
  tutorial.start();
};

// Bind UI events
el("search").addEventListener("input", buildList);

document.querySelectorAll(".tab").forEach(t => {
  t.onclick = () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    activeTab = t.dataset.tab;
    renderTab();
  };
});

el("btnOpenLong").onclick = () => setAction("open_long");
el("btnOpenShort").onclick = () => setAction("open_short");
el("btnCloseLong").onclick = () => setAction("close_long");
el("btnCloseShort").onclick = () => setAction("close_short");

el("btnCancelAll").onclick = async () => {
  try{
    await apiPost("/api/cancel_all", {});
    await refreshState();
    toast("撤单完成", "已撤销所有未成交委托");
  }catch(e){
    toast("撤单失败", String(e));
  }
};

el("tabTick").onclick = () => {
  chartMode = "tick";
  el("tabTick").classList.add("active");
  el("tabDay").classList.remove("active");
  renderAll();
};

el("tabDay").onclick = () => {
  chartMode = "day";
  el("tabDay").classList.add("active");
  el("tabTick").classList.remove("active");
  renderAll();
};

el("btnSubmit").onclick = async () => {
  const price = Number(String(el("priceInput").value).replace(/,/g,""));
  const qty = Math.max(1, Math.floor(Number(el("qtyInput").value || "1")));
  if(!Number.isFinite(price)){
    toast("委托失败", "价格格式不正确");
    return;
  }

  let side = "buy", effect="open";
  if(currentAction==="open_long"){ side="buy"; effect="open"; }
  if(currentAction==="open_short"){ side="sell"; effect="open"; }
  if(currentAction==="close_long"){ side="sell"; effect="close"; }
  if(currentAction==="close_short"){ side="buy"; effect="close"; }

  try{
    await apiPost("/api/orders", {symbol: selectedContractSymbol, side, effect, price, qty});
    await refreshState();
    tutorial.onAction("submit_ok");
    toast("已提交委托", `${selectedContractSymbol} ${side==="buy"?"买":"卖"}${qty}手 @ ${fmt(price,2)}（${effect==="open"?"开":"平"}）`);
  }catch(e){
    toast("委托失败", String(e));
  }
};

el("btnReset").onclick = async () => {
  const ok = confirm("确定要空中飞人吗？\n\n将清空：持仓/委托/成交/公告。\n\n投资有风险，决策需谨慎！");
  if(!ok) return;

  try{
    await apiPost("/api/reset_all", {});

    const boot = await apiGet("/api/bootstrap");
    PRODUCTS = boot.products;
    SPECS = boot.specs;
    selectedProductCode = PRODUCTS[0].code;
    selectedContractSymbol = PRODUCTS[0].main_contract;

    await refreshState();
    buildList();

    localStorage.removeItem("EF_TUTORIAL_DONE");
    tutorial.enabled = true;
    tutorial.start();

    toast("已重置", "市场与玩家状态已恢复初始");
  }catch(e){
    toast("重置失败", String(e));
  }
};

el("btnNextTick").onclick = async () => {
  try{
    await apiPost("/api/tick", {});
    await refreshState();
    tutorial.onAction("tick_ok");
    toast("Tick 已推进", "市场已更新一轮报价");
  }catch(e){
    toast("推进失败", String(e));
  }
};

el("btnAutoScale").onclick = () => {
  tickAutoScale = !tickAutoScale;
  el("btnAutoScale").textContent = "自动缩放：" + (tickAutoScale ? "开" : "关");
  renderAll();
};

// Init
function clockLoop(){
  el("clock").textContent = nowStr();
  el("tradingDay").textContent = "2026-02-05";
}
setInterval(clockLoop, 500);
clockLoop();

function setDrawerOpen(isOpen){
  const d = el("bottomDrawer");
  d.classList.toggle("open", isOpen);
  el("drawerToggle").textContent = isOpen ? "收起" : "展开";
  el("drawerSub").textContent = isOpen ? "（点击收起）" : "（点击展开）";
  localStorage.setItem("drawerOpen", isOpen ? "1" : "0");
}

function initDrawer(){
  setDrawerOpen(true);

  el("drawerTab").onclick = () => setDrawerOpen(!el("bottomDrawer").classList.contains("open"));
  el("drawerToggle").onclick = (e) => {
    e.stopPropagation();
    setDrawerOpen(!el("bottomDrawer").classList.contains("open"));
  };
}
initDrawer();

(async () => {
  const boot = await apiGet("/api/bootstrap");
  PRODUCTS = boot.products;
  SPECS = boot.specs;

  selectedProductCode = PRODUCTS[0].code;
  selectedContractSymbol = PRODUCTS[0].main_contract;

  setAction("open_long");
  await refreshState();
  tutorial.start();
})().catch(e => {
  toast("初始化失败", String(e));
});
