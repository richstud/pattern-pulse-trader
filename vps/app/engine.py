"""cTrader Open API engine: auth -> load symbols -> poll closed bars -> detect -> (optional) LIMIT order.
Runs under Twisted. Signals and status are written to Postgres for the API/dashboard."""
import os, time, math, logging, yaml
from twisted.internet import reactor, task
from ctrader_open_api import Client, Protobuf, TcpProtocol, EndPoints
from ctrader_open_api.messages.OpenApiMessages_pb2 import (
    ProtoOAApplicationAuthReq, ProtoOAAccountAuthReq, ProtoOASymbolsListReq,
    ProtoOASymbolByIdReq, ProtoOAGetTrendbarsReq, ProtoOANewOrderReq, ProtoOAErrorRes,
    ProtoOAGetAccountListByAccessTokenReq)
from ctrader_open_api.messages.OpenApiModelMessages_pb2 import ProtoOATrendbarPeriod, ProtoOAOrderType, ProtoOATradeSide
from . import db
from .patterns import detect

os.makedirs("logs", exist_ok=True)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s",
                    handlers=[logging.StreamHandler(), logging.FileHandler("logs/engine.log")])
log = logging.getLogger("engine")

CFG = yaml.safe_load(open("config.yaml"))
ENV = os.environ.get("CTRADER_ENV", "demo").lower()
HOST = EndPoints.PROTOBUF_LIVE_HOST if ENV == "live" else EndPoints.PROTOBUF_DEMO_HOST
ACC = int(os.environ["CTRADER_ACCOUNT_ID"])
AUTO = os.environ.get("AUTO_EXECUTE", "false").lower() == "true"

NATIVE = {"M1": 1, "M2": 2, "M3": 3, "M4": 4, "M5": 5, "M10": 10, "M15": 15, "M30": 30,
          "H1": 60, "H4": 240, "H12": 720, "D1": 1440, "W1": 10080}
CUSTOM = {"M45": 45, "M75": 75, "M125": 125, "H2": 120}  # built from M1 bars

client = Client(HOST, EndPoints.PROTOBUF_PORT, TcpProtocol)
symbols = {}       # name -> {id, digits, lotSize}
last_bar = {}      # (sym, tf) -> last processed bar ts
ready = False

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
        wanted = set(CFG["watchlist"])
        found = {s.symbolName: s.symbolId for s in m.symbol if s.symbolName in wanted}
        missing = wanted - set(found)
        if missing:
            log.warning("symbols not on this account: %s", ", ".join(sorted(missing)))
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
    beat(True, f"{len(symbols)} symbols, auto_execute={AUTO}")
    log.info("ready: %s", ", ".join(symbols))

def on_disconnected(_, reason):
    global ready
    ready = False
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

def poll():
    if not ready:
        return
    now = int(time.time() * 1000)
    for sym, tfs in CFG["watchlist"].items():
        if sym not in symbols:
            continue
        for tf in tfs:
            mins = NATIVE.get(tf) or CUSTOM.get(tf)
            if not mins:
                continue  # second periods unsupported
            closed = now // (mins * 60000) * mins * 60000  # start of the current (open) bar
            if last_bar.get((sym, tf)) == closed:
                continue
            last_bar[(sym, tf)] = closed
            base_tf = tf if tf in NATIVE else "M1"
            base_min = NATIVE[base_tf]
            req = ProtoOAGetTrendbarsReq(ctidTraderAccountId=ACC, symbolId=symbols[sym]["id"],
                period=ProtoOATrendbarPeriod.Value(base_tf),
                fromTimestamp=closed - mins * 60000 * 80, toTimestamp=closed)
            send(req).addCallback(lambda m, s=sym, t=tf, mn=mins, c=closed, nat=(tf in NATIVE):
                                  scan(s, t, check(m), mn, c, nat))

def scan(sym, tf, m, mins, closed, native):
    bars = to_bars(m)
    if not native:
        bars = aggregate(bars, mins)
    bars = [b for b in bars if b["t"] < closed]  # closed bars only
    if len(bars) < CFG["atr_period"] + 5:
        return
    # newest completed setup: Legout is the last closed bar, offset 1..3
    for k in range(1, CFG["max_legout_offset"] + 1):
        i = len(bars) - 2 - k
        sig = detect(bars, i, CFG)
        if sig and sig["legout_offset"] == k:
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
    client.setMessageReceivedCallback(lambda c, m: None)
    client.startService()
    task.LoopingCall(poll).start(5.0)
    task.LoopingCall(lambda: ready and beat(True, f"{len(symbols)} symbols, auto_execute={AUTO}")).start(30.0)
    reactor.run()
