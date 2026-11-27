"""Legin-Boring-Legout detector. MUST mirror src/lib/patterns.ts."""

def tr(c, p):
    return max(c["h"] - c["l"], abs(c["h"] - p["c"]), abs(c["l"] - p["c"]))

def atr(cs, i, n=14):
    r = [tr(cs[k], cs[k - 1]) for k in range(max(1, i - n), i)]
    return sum(r) / len(r) if r else cs[i]["h"] - cs[i]["l"]

def body(c):
    rng = c["h"] - c["l"]
    return abs(c["c"] - c["o"]) / rng if rng > 0 else 0

MAX_BORING = 3
BORING_MAX_BODY = 0.5

def detect(cs, i, cfg):
    """i = index of Legin candle. Base = 1..3 boring candles; zone = max high / min low."""
    if i < 1 or i + 2 >= len(cs):
        return None
    n, mb, sm = cfg["atr_period"], cfg["min_body_ratio"], cfg["size_multiple"]
    li = cs[i]
    li_tr = tr(li, cs[i - 1])
    if not (li_tr > atr(cs, i, n) and body(li) >= mb):
        return None
    zh, zl, max_b = float("-inf"), float("inf"), 0.0
    for nb in range(1, MAX_BORING + 1):
        bi = i + nb
        if bi >= len(cs):
            return None
        b = cs[bi]
        b_tr = tr(b, cs[bi - 1])
        if not (b_tr < atr(cs, bi, n) and body(b) < BORING_MAX_BODY and li["v"] > b["v"]):
            return None
        zh, zl, max_b = max(zh, b["h"]), min(zl, b["l"]), max(max_b, b_tr)
        if li_tr < sm * max_b:
            return None
        k = nb  # legout follows the base directly
        j = bi + 1
        if j < len(cs):
            o = cs[j]
            o_tr = tr(o, cs[j - 1])
            if o_tr > atr(cs, j, n) and body(o) >= mb and o_tr >= sm * li_tr and o["v"] > li["v"]:
                bull = o["c"] > o["o"]
                leg_in_up = li["c"] > li["o"]
                code = ("RBR" if leg_in_up else "DBR") if bull else ("RBD" if leg_in_up else "DBD")
                limit, sl = (zh, zl) if bull else (zl, zh)
                risk = abs(limit - sl)
                rr = cfg["reward_risk"]
                tp = limit + risk * rr if bull else limit - risk * rr
                return {"code": code, "side": "BUY" if bull else "SELL", "limit": limit,
                        "sl": sl, "tp": tp, "boring_high": zh, "boring_low": zl, "boring_count": nb,
                        "base_ts": b["t"], "legout_offset": k, "end_index": j}
    return None
