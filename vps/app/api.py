"""REST API for the dashboard. Reached through the Netlify proxy at /api/*."""
import os, yaml
from fastapi import FastAPI, Header, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from . import db

app = FastAPI(title="LBL Scanner API")
app.add_middleware(CORSMiddleware, allow_origins=[os.environ.get("CORS_ORIGIN", "*")],
                   allow_methods=["GET"], allow_headers=["X-API-Key"])

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
