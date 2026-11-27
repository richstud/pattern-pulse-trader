"""cTrader Open API engine: auth -> load symbols -> seed history once -> build every timeframe from
live ticks -> detect on bar close -> (optional) LIMIT order. No trendbar polling while running.
Runs under Twisted. Signals and status are written to Postgres for the API/dashboard."""
import os, time, math, logging, yaml
from twisted.internet import reactor, task
from ctrader_open_api import Client, Protobuf, TcpProtocol, EndPoints
from ctrader_open_api.messages.OpenApiMessages_pb2 import (
    ProtoOAApplicationAuthReq, ProtoOAAccountAuthReq, ProtoOASymbolsListReq,
    ProtoOASymbolByIdReq, ProtoOAGetTrendbarsReq, ProtoOANewOrderReq, ProtoOAErrorRes,
    ProtoOAGetAccountListByAccessTokenReq, ProtoOASubscribeSpotsReq, ProtoOASpotEvent)
from ctrader_open_api.messages.OpenApiModelMessages_pb2 import ProtoOATrendbarPeriod, ProtoOAOrderType, ProtoOATradeSide
from . import db
from .patterns import detect

os.makedirs("logs", exist_ok=True)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s",
                    handlers=[logging.StreamHandler(), logging.FileHandler("logs/engine.log")])
log = logging.getLogger("engine")

CFG = yaml.safe_load(open("config.yaml"))
CFG_MTIME = os.path.getmtime("config.yaml")

def watch_config():
    """Exit when the dashboard saves a new watchlist; Docker restarts the engine with it."""
    if os.path.getmtime("config.yaml") != CFG_MTIME:
        log.info("config.yaml changed - restarting engine to apply new watchlist")
        reactor.stop()
        os._exit(0)
ENV = os.environ.get("CTRADER_ENV", "demo").lower()
HOST = EndPoints.PROTOBUF_LIVE_HOST if ENV == "live" else EndPoints.PROTOBUF_DEMO_HOST
ACC = int(os.environ["CTRADER_ACCOUNT_ID"])
AUTO = os.environ.get("AUTO_EXECUTE", "false").lower() == "true"

NATIVE = {"M1": 1, "M2": 2, "M3": 3, "M4": 4, "M5": 5, "M10": 10, "M15": 15, "M30": 30,
          "H1": 60, "H4": 240, "H12": 720, "D1": 1440, "W1": 10080}
CUSTOM = {"M45": 45, "M75": 75, "M125": 125, "H2": 120}  # built from M1 bars
SECONDS = {"S1": 1, "S5": 5, "S10": 10, "S15": 15, "S30": 30, "S45": 45}
# Every timeframe (seconds and minutes) is built live from ticks; length in seconds.
TF_SECS = {**SECONDS, **{k: v * 60 for k, v in NATIVE.items()}, **{k: v * 60 for k, v in CUSTOM.items()}}
SEED_BASE = {"M45": "M15", "M75": "M15", "M125": "M5", "H2": "H1"}  # native period used to seed custom TFs
SEED_BARS = max(40, int(CFG.get("atr_period", 14)) + 20)  # closed bars seeded once per minute timeframe (enough for ATR)
tick_bars = {}     # (sym, tf) -> list of closed bars (in memory, newest last)
cur_bar = {}       # (sym, tf) -> bar being built
last_px = {}       # sym -> last bid
by_symbol_id = {}  # symbolId -> name
MAX_TICK_BARS = 200

client = Client(HOST, EndPoints.PROTOBUF_PORT, TcpProtocol)
symbols = {}       # name -> {id, digits, lotSize}
ready = False
seed_queue = []    # startup history requests (sym, tf, req, mins, start), sent one at a time
PACE = 1.2         # seconds between seed requests (~50/min, under cTrader's history quota)
COOLDOWN = 6.0     # pause after a rate-limit reply before retrying
busy_until = 0.0   # no seed request is sent before this time (in-flight or cooling down)

# Broker names differ (e.g. Pepperstone uses NAS100 for US100). Tried in order.
ALIASES = {
    "US100": ["NAS100", "USTEC", "NDX100", "US100.cash", "NAS100.cash"],
    "US500": ["SPX500", "US500.cash", "SP500"],
    "US30": ["DJ30", "WS30", "US30.cash"],
    "GER40": ["GER30", "DE40", "GER40.cash"],
    "UK100": ["UK100.cash", "FTSE100"],
    "XAUUSD": ["GOLD"], "XAGUSD": ["SILVER"],
    "USOIL": ["SpotCrude", "WTI", "XTIUSD"], "UKOIL": ["SpotBrent", "BRENT", "XBRUSD"],
}

def norm(n):
    return n.upper().replace(".CASH", "").replace(".", "").replace("_", "").replace("-", "")

def resolve(wanted, available):
    """Map each configured name to the broker's real symbol name, or None."""
    exact = {a: a for a in available}
    by_norm = {}
    for a in available:
        by_norm.setdefault(norm(a), a)
    out = {}
    for w in wanted:
        hit = None
        for cand in [w] + ALIASES.get(w.upper(), []):
            hit = exact.get(cand) or by_norm.get(norm(cand))
            if hit:
                break
        out[w] = hit
    return out

def beat(ok, detail=""):
    try:
        with db.conn() as c:
            c.execute("""insert into heartbeat (id, updated_at, connected, env, account_id, detail)
                values (1, now(), %s, %s, %s, %s) on conflict (id) do update set
                updated_at=now(), connected=excluded.connected, env=excluded.env,
                account_id=excluded.account_id, detail=excluded.detail""", (ok, ENV, str(ACC), detail))
    except Exception as e:
        log.warning("heartbeat failed: %s", e)

def send(req):
    d = client.send(req)
    d.addErrback(lambda f: log.error("request failed: %s", f.getErrorMessage()))
    return d

def check(msg):
    m = Protobuf.extract(msg)
    if isinstance(m, ProtoOAErrorRes):
        raise RuntimeError(f"{m.errorCode}: {m.description}")
    return m

def on_connected(_):
    log.info("connected to %s (%s)", HOST, ENV)
    r = ProtoOAApplicationAuthReq(clientId=os.environ["CTRADER_CLIENT_ID"],
                                  clientSecret=os.environ["CTRADER_CLIENT_SECRET"])
    send(r).addCallback(lambda m: (check(m), account_auth()))

def account_auth():
    # CTRADER_ACCOUNT_ID may be the login shown in cTrader (traderLogin) or the internal
    # ctidTraderAccountId. Ask cTrader which accounts this token can use and resolve it.
    global ACC
    token = os.environ["CTRADER_ACCESS_TOKEN"]
    def got(m):
        global ACC
        m = check(m)
        want_live = ENV == "live"
        accs = list(m.ctidTraderAccount)
        for a in accs:
            log.info("token account: login=%s ctid=%s %s", a.traderLogin, a.ctidTraderAccountId,
                     "LIVE" if a.isLive else "DEMO")
        log.info("token scope: %s", "trading" if m.permissionScope == 1 else "account info only")
        match = [a for a in accs if ACC in (a.traderLogin, a.ctidTraderAccountId)]
        if not match:
            msg = f"account {ACC} is not authorized for this token"
            log.error(msg); beat(False, msg); return
        a = match[0]
        if a.isLive != want_live:
            msg = f"account {ACC} is {'LIVE' if a.isLive else 'DEMO'} but CTRADER_ENV={ENV}"
            log.error(msg); beat(False, msg); return
        ACC = a.ctidTraderAccountId
        log.info("using ctidTraderAccountId=%s (login %s)", ACC, a.traderLogin)
        r = ProtoOAAccountAuthReq(ctidTraderAccountId=ACC, accessToken=token)
        send(r).addCallback(lambda x: (check(x), log.info("account authorized"), load_symbols()))
    send(ProtoOAGetAccountListByAccessTokenReq(accessToken=token)).addCallback(got)

def load_symbols():
    def got(m):
        m = check(m)
        ids = {s.symbolName: s.symbolId for s in m.symbol}
        mapping = resolve(CFG["watchlist"], ids)
        found = {}
        for w, real in mapping.items():
            if real is None:
                log.warning("symbol not on this account: %s", w)
                continue
            if real != w:
                log.info("symbol %s -> broker name %s", w, real)
            found[w] = ids[real]
        req = ProtoOASymbolByIdReq(ctidTraderAccountId=ACC, symbolId=list(found.values()))
        send(req).addCallback(lambda d: got_details(d, found))
    send(ProtoOASymbolsListReq(ctidTraderAccountId=ACC)).addCallback(got)

def got_details(m, found):
    global ready
    m = check(m)
    by_id = {v: k for k, v in found.items()}
    for s in m.symbol:
        symbols[by_id[s.symbolId]] = {"id": s.symbolId, "digits": s.digits, "lotSize": s.lotSize}
    ready = True
    by_symbol_id.clear()
    by_symbol_id.update({v["id"]: k for k, v in symbols.items()})
    r = ProtoOASubscribeSpotsReq(ctidTraderAccountId=ACC, symbolId=[v["id"] for v in symbols.values()])
    send(r).addCallback(lambda x: (check(x), log.info("live ticks subscribed: %s", ", ".join(symbols))))
    queue_seeds()
    beat(True, f"{len(symbols)} symbols, auto_execute={AUTO}")
    log.info("ready: %s", ", ".join(symbols))

def on_disconnected(_, reason):
    global ready
    ready = False
    seed_queue.clear()
    cur_bar.clear()
    beat(False, f"disconnected: {reason}")
    log.warning("disconnected: %s - reconnecting in 5s", reason)
    reactor.callLater(5, client.startService)

def to_bars(m, digits_scale=100000):
    out = []
    for b in m.trendbar:
        low = b.low / digits_scale
        out.append({"t": b.utcTimestampInMinutes * 60000, "o": low + b.deltaOpen / digits_scale,
                    "h": low + b.deltaHigh / digits_scale, "l": low,
                    "c": low + b.deltaClose / digits_scale, "v": b.volume})
    return out

def aggregate(bars, minutes):
    groups = {}
    for b in bars:
        k = (b["t"] // 60000) // minutes * minutes * 60000
        g = groups.get(k)
        if not g:
            groups[k] = dict(b, t=k)
        else:
            g["h"], g["l"] = max(g["h"], b["h"]), min(g["l"], b["l"])
            g["c"], g["v"] = b["c"], g["v"] + b["v"]
    return [groups[k] for k in sorted(groups)]

def queue_seeds():
    """Queue one history download per minute timeframe so ATR works immediately after a restart."""
    seed_queue.clear()
    now = int(time.time() * 1000)
    for sym, tfs in CFG["watchlist"].items():
        if sym not in symbols:
            continue
        for tf in tfs:
            secs = TF_SECS.get(tf)
            if not secs or tf in SECONDS or len(tick_bars.get((sym, tf), [])) >= SEED_BARS:
                continue
            mins = secs // 60
            base = tf if tf in NATIVE else SEED_BASE.get(tf, "M1")
            start = now // (secs * 1000) * secs * 1000  # start of the open bar
            req = ProtoOAGetTrendbarsReq(ctidTraderAccountId=ACC, symbolId=symbols[sym]["id"],
                period=ProtoOATrendbarPeriod.Value(base),
                fromTimestamp=start - secs * 1000 * SEED_BARS, toTimestamp=start)
            seed_queue.append((sym, tf, req, mins, start, base == tf))
    log.info("seeding history for %d feeds (one-time, ~%ds)", len(seed_queue), int(len(seed_queue) * PACE))

def drain():
    """Send one seed request at a time; on rate limit, cool down and retry the same item."""
    global busy_until
    if not ready or not seed_queue or time.time() < busy_until:
        return
    item = seed_queue.pop(0)
    sym, tf, req, mins, start, native = item
    busy_until = time.time() + 30  # held until the reply arrives
    def ok(m):
        global busy_until
        try:
            res = check(m)
        except RuntimeError as e:
            if "BLOCKED_PAYLOAD_TYPE" in str(e) or "rate" in str(e).lower():
                log.warning("history throttled on %s %s - pausing %.0fs", sym, tf, COOLDOWN)
                seed_queue.insert(0, item)
                busy_until = time.time() + COOLDOWN
            else:
                log.error("history %s %s: %s", sym, tf, e)
                busy_until = time.time() + PACE
            return
        busy_until = time.time() + PACE
        bars = to_bars(res)
        if not native:
            bars = aggregate(bars, mins)
        seed(sym, tf, [b for b in bars if b["t"] < start])
        if not seed_queue:
            log.info("history seeded - running 100%% on live ticks")
    def fail(f):
        global busy_until
        seed_queue.insert(0, item)
        busy_until = time.time() + COOLDOWN
    send(req).addCallbacks(ok, fail)

def seed(sym, tf, bars):
    """Put downloaded history before any bars already built from ticks. No scan: old setups are stale."""
    key = (sym, tf)
    live = tick_bars.get(key, [])
    first = live[0]["t"] if live else float("inf")
    merged = [b for b in bars if b["t"] < first] + live
    tick_bars[key] = merged[-MAX_TICK_BARS:]

def on_tick(sym, price, ts_ms):
    """Feed one tick into every timeframe bar for this symbol."""
    for tf in CFG["watchlist"].get(sym, []):
        secs = TF_SECS.get(tf)
        if not secs:
            continue
        key = (sym, tf)
        start = ts_ms // (secs * 1000) * secs * 1000
        b = cur_bar.get(key)
        if b and b["t"] != start:
            close_bar(key)
            b = None
        if not b:
            cur_bar[key] = {"t": start, "o": price, "h": price, "l": price, "c": price, "v": 1}
        else:
            b["h"], b["l"], b["c"] = max(b["h"], price), min(b["l"], price), price
            b["v"] += 1  # tick count used as volume (cTrader trendbar volume is also tick volume)

def close_bar(key):
    b = cur_bar.pop(key, None)
    if not b:
        return
    lst = tick_bars.setdefault(key, [])
    if lst and lst[-1]["t"] >= b["t"]:
        return
    lst.append(b)
    del lst[:-MAX_TICK_BARS]
    try:
        scan_bars(key[0], key[1], lst)
    except Exception as e:
        log.exception("scan %s %s failed: %s", key[0], key[1], e)

def flush_bars():
    """Close bars whose time has passed even if no new tick arrived."""
    now = int(time.time() * 1000)
    for key, b in list(cur_bar.items()):
        if now >= b["t"] + TF_SECS[key[1]] * 1000:
            close_bar(key)

def on_message(_, msg):
    if msg.payloadType != ProtoOASpotEvent().payloadType:
        return
    m = Protobuf.extract(msg)
    sym = by_symbol_id.get(m.symbolId)
    if not sym:
        return
    if m.HasField("bid"):
        last_px[sym] = m.bid / 100000
    if sym in last_px:
        ts = m.timestamp if m.HasField("timestamp") and m.timestamp else int(time.time() * 1000)
        on_tick(sym, last_px[sym], ts)

def scan_bars(sym, tf, bars):
    if len(bars) < CFG["atr_period"] + 5:
        return
    # newest completed setup: Legout is the last closed bar, offset 1..3
    # newest completed setup: legout must be the last closed bar (base 1..3, offset 1..3)
    last = len(bars) - 1
    for i in range(last - 2, max(0, last - 2 - 3 - CFG["max_legout_offset"]), -1):
        sig = detect(bars, i, CFG)
        if sig and sig["end_index"] == last:
            save(sym, tf, sig)
            break

def save(sym, tf, s):
    with db.conn() as c:
        row = c.execute("""insert into signals (symbol,timeframe,code,side,boring_high,boring_low,
            limit_price,sl,tp,base_ts,status) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            on conflict do nothing returning id""",
            (sym, tf, s["code"], s["side"], s["boring_high"], s["boring_low"], s["limit"],
             s["sl"], s["tp"], s["base_ts"], "pending" if AUTO else "detected")).fetchone()
    if not row:
        return
    log.info("SIGNAL %s %s %s limit=%s sl=%s tp=%s", sym, tf, s["code"], s["limit"], s["sl"], s["tp"])
    if AUTO:
        place(row[0], sym, s)

def place(sig_id, sym, s):
    info = symbols[sym]
    rnd = lambda p: round(p, info["digits"])
    vol = int(math.floor(CFG["volume_lots"] * info["lotSize"] / 100) * 100)
    req = ProtoOANewOrderReq(ctidTraderAccountId=ACC, symbolId=info["id"],
        orderType=ProtoOAOrderType.Value("LIMIT"),
        tradeSide=ProtoOATradeSide.Value(s["side"]), volume=vol,
        limitPrice=rnd(s["limit"]), stopLoss=rnd(s["sl"]), takeProfit=rnd(s["tp"]),
        label="LBL", comment=f"{s['code']}")
    def ok(m):
        try:
            check(m); status, note = "sent", ""
        except RuntimeError as e:
            status, note = "rejected", str(e)
        with db.conn() as c:
            c.execute("update signals set status=%s, note=%s where id=%s", (status, note, sig_id))
        log.info("order %s for signal %s %s", status, sig_id, note)
    send(req).addCallback(ok)

if __name__ == "__main__":
    db.init()
    beat(False, "starting")
    log.info("env=%s account=%s auto_execute=%s", ENV, ACC, AUTO)
    client.setConnectedCallback(on_connected)
    client.setDisconnectedCallback(on_disconnected)
    client.setMessageReceivedCallback(on_message)
    client.startService()
    task.LoopingCall(drain).start(0.2)
    task.LoopingCall(flush_bars).start(0.5)
    task.LoopingCall(watch_config).start(3.0)
    task.LoopingCall(lambda: ready and beat(True, f"{len(symbols)} symbols, auto_execute={AUTO}")).start(30.0)
    reactor.run()
