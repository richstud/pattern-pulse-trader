"""REST API for the dashboard. Reached through the Netlify proxy at /api/*."""
import os, re, yaml
from fastapi import FastAPI, Header, HTTPException, Depends, Body
from fastapi.middleware.cors import CORSMiddleware
from . import db

app = FastAPI(title="LBL Scanner API")
app.add_middleware(CORSMiddleware, allow_origins=[os.environ.get("CORS_ORIGIN", "*")],
                   allow_methods=["GET", "PUT"], allow_headers=["X-API-Key", "Content-Type"])

def auth(x_api_key: str = Header(default="")):
    if not os.environ.get("API_KEY") or x_api_key != os.environ["API_KEY"]:
        raise HTTPException(401, "invalid api key")

@app.on_event("startup")
def startup():
    db.init()

@app.get("/health")
def health():
    return {"ok": True}

@app.get("/status", dependencies=[Depends(auth)])
def status():
    with db.conn() as c:
        r = c.execute("select updated_at, connected, env, account_id, detail from heartbeat where id=1").fetchone()
    if not r:
        return {"connected": False, "detail": "engine not started"}
    return {"updated_at": r[0].isoformat(), "connected": r[1], "env": r[2], "account_id": r[3], "detail": r[4]}

@app.get("/signals", dependencies=[Depends(auth)])
def signals(limit: int = 100):
    with db.conn() as c:
        cur = c.execute("""select id, created_at, symbol, timeframe, code, side, boring_high, boring_low,
            limit_price, sl, tp, status, note from signals order by id desc limit %s""", (min(limit, 500),))
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, row)) | {"created_at": row[1].isoformat()} for row in cur.fetchall()]

@app.get("/config", dependencies=[Depends(auth)])
def config():
    return yaml.safe_load(open("config.yaml"))

ALLOWED_TF = {"S1","S5","S10","S15","S30","S45","M1","M2","M3","M4","M5","M10","M15","M30","M45","M75","M125",
              "H1","H2","H4","H12","D1","W1"}
SYMBOL_RE = re.compile(r"^[A-Za-z0-9._#-]{1,20}$")

@app.put("/config/watchlist", dependencies=[Depends(auth)])
def save_watchlist(watchlist: dict = Body(..., embed=True)):
    """Replace the watchlist (max 6 symbols x 13 timeframes). The engine restarts itself to apply it."""
    if not isinstance(watchlist, dict) or not 1 <= len(watchlist) <= 6:
        raise HTTPException(400, "choose 1 to 6 symbols")
    clean = {}
    for sym, tfs in watchlist.items():
        if not isinstance(sym, str) or not SYMBOL_RE.match(sym):
            raise HTTPException(400, f"invalid symbol {sym!r}")
        if not isinstance(tfs, list) or not 1 <= len(tfs) <= 13 or any(t not in ALLOWED_TF for t in tfs):
            raise HTTPException(400, f"{sym}: choose 1 to 13 supported timeframes")
        clean[sym] = list(dict.fromkeys(tfs))
    cfg = yaml.safe_load(open("config.yaml"))
    cfg["watchlist"] = clean
    with open("config.yaml", "w") as f:  # write in place: keeps the shared bind-mounted file
        yaml.safe_dump(cfg, f, sort_keys=False, default_flow_style=None)
    return {"ok": True, "watchlist": clean}
