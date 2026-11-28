"""Legin-Boring-Legout detector. MUST mirror src/lib/patterns.ts."""

def tr(c, p):
    return max(c["h"] - c["l"], abs(c["h"] - p["c"]), abs(c["l"] - p["c"]))

def atr(cs, i, n=14):
    r = [tr(cs[k], cs[k - 1]) for k in range(max(1, i - n), i)]
    return sum(r) / len(r) if r else cs[i]["h"] - cs[i]["l"]

def body(c):
    rng = c["h"] - c["l"]
    return abs(c["c"] - c["o"]) / rng if rng > 0 else 0

def size(c):
    return c["h"] - c["l"]  # wick to wick

MAX_BORING = 3
MAX_LEGOUT = 3
BORING_MAX_BODY = 0.5
LEGOUT_GAP = 0.001  # next legout open within 0.1% of previous legout close

def evaluate(cs, i, cfg):
    """i = legin index. None = no candidate; {"ok": True, ...signal} or {"ok": False, "reason": ...}."""
    if i < 1 or i >= len(cs):
        return None
    n, mb, sm = cfg["atr_period"], cfg["min_body_ratio"], cfg["size_multiple"]
    li = cs[i]
    li_tr, li_atr = tr(li, cs[i - 1]), atr(cs, i, n)
    if not (li_tr > li_atr and body(li) >= mb):
        return None
    s_in = size(li)
    nb = 0
    while i + nb + 1 < len(cs) and body(cs[i + nb + 1]) < BORING_MAX_BODY:
        nb += 1
    if nb == 0 or i + nb + 1 >= len(cs):
        return None

    def fail(reason, end, lo=0):
        return {"ok": False, "reason": reason, "boring_count": min(nb, MAX_BORING), "legout_count": lo,
                "legin_ts": li["t"], "end_ts": cs[end]["t"], "end_index": end, "tr_legin": li_tr, "atr_legin": li_atr}

    if nb > MAX_BORING:
        return fail(f"{nb} boring candles (max {MAX_BORING})", i + MAX_BORING + 1)
    zh, zl = float("-inf"), float("inf")
    for k in range(1, nb + 1):
        bi = i + k
        b = cs[bi]
        b_tr, b_atr = tr(b, cs[bi - 1]), atr(cs, bi, n)
        if not (b_tr < b_atr):
            return fail(f"Boring #{k} TR {b_tr:.5f} ≥ ATR {b_atr:.5f}", bi)
        if not (li["v"] > b["v"]):
            return fail(f"Boring #{k} volume not below legin volume", bi)
        if s_in < sm * size(b):
            return fail(f"Legin size not 2× boring #{k} size", bi)
        zh, zl = max(zh, b["h"]), min(zl, b["l"])
    start = i + nb + 1
    up = cs[start]["c"] > cs[start]["o"]
    total = 0.0
    for k in range(1, MAX_LEGOUT + 1):
        j = start + k - 1
        if j >= len(cs):
            return None
        o = cs[j]
        if k > 1:
            p = cs[j - 1]
            if (o["c"] > o["o"]) != up or abs(o["o"] - p["c"]) > LEGOUT_GAP * p["c"]:
                return fail(f"Legout size {total:.5f} < 2× legin {s_in:.5f} (legout #{k} not a continuation)", j, k - 1)
        o_tr, o_atr = tr(o, cs[j - 1]), atr(cs, j, n)
        if not (o_tr > o_atr):
            return fail(f"Legout #{k} TR {o_tr:.5f} < ATR {o_atr:.5f}", j, k)
        if body(o) < mb:
            return fail(f"Legout #{k} body {body(o) * 100:.0f}% < 60%", j, k)
        if not (o["v"] > li["v"]):
            return fail(f"Legout #{k} volume not above legin volume", j, k)
        total += size(o)
        if total >= sm * s_in:
            leg_in_up = li["c"] > li["o"]
            code = ("RBR" if leg_in_up else "DBR") if up else ("RBD" if leg_in_up else "DBD")
            limit, sl = (zh, zl) if up else (zl, zh)
            risk = abs(limit - sl)
            rr = cfg["reward_risk"]
            tp = limit + risk * rr if up else limit - risk * rr
            return {"ok": True, "code": code, "side": "BUY" if up else "SELL", "limit": limit,
                    "sl": sl, "tp": tp, "boring_high": zh, "boring_low": zl, "boring_count": nb,
                    "base_ts": cs[i + nb]["t"], "legout_offset": k, "end_index": j}
    return fail(f"Legout size {total:.5f} < 2× legin {s_in:.5f} after {MAX_LEGOUT} candles", start + MAX_LEGOUT - 1, MAX_LEGOUT)

def detect(cs, i, cfg):
    r = evaluate(cs, i, cfg)
    return r if r and r["ok"] else None
