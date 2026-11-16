export const deployFiles = (cfg: { symbols: string[]; timeframes: Record<string, string[]>; rr: number; accountId: string }) => ({
  Dockerfile: `FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir ctrader-open-api twisted pyyaml
COPY scanner.py config.yaml ./
CMD ["python", "scanner.py"]`,
  "docker-compose.yml": `services:
  scanner:
    build: .
    restart: unless-stopped
    env_file: .env
    volumes: ["./logs:/app/logs"]`,
  ".env.example": `CTRADER_CLIENT_ID=
CTRADER_CLIENT_SECRET=
CTRADER_ACCESS_TOKEN=
CTRADER_ACCOUNT_ID=${cfg.accountId}
CTRADER_HOST=demo.ctraderapi.com   # live.ctraderapi.com for live`,
  "config.yaml": `# each symbol has its own timeframes
watchlist:
${cfg.symbols.map((s) => `  ${s}: [${(cfg.timeframes[s] ?? []).map((t) => `"${t}"`).join(", ")}]`).join("\n")}
atr_period: 14
min_body_ratio: 0.60      # body:wick 60:40 minimum
size_multiple: 2.0        # legin >= 2x boring, legout >= 2x legin
max_legout_offset: 3      # legout 1, 2 or 3
reward_risk: ${cfg.rr}
volume_lots: 0.10
auto_execute: false`,
  "run.sh": `#!/usr/bin/env bash
set -e
cp -n .env.example .env || true
docker compose up -d --build
docker compose logs -f scanner`,
  "scanner.py": `"""Legin-Boring-Legout scanner skeleton for cTrader Open API.
Subscribe to trendbars for each symbol/timeframe, run detect() on close,
and place LIMIT orders: bullish limit=boring high SL=boring low; bearish limit=boring low SL=boring high."""
import os, yaml
cfg = yaml.safe_load(open("config.yaml"))

def tr(c, p): return max(c["h"]-c["l"], abs(c["h"]-p["c"]), abs(c["l"]-p["c"]))
def atr(cs, i, n=14):
    r = [tr(cs[k], cs[k-1]) for k in range(max(1, i-n), i)]
    return sum(r)/len(r) if r else cs[i]["h"]-cs[i]["l"]
def body(c): return abs(c["c"]-c["o"])/(c["h"]-c["l"]) if c["h"]>c["l"] else 0

def detect(cs, i):
    li, b = cs[i], cs[i+1]
    if not (tr(li, cs[i-1]) > atr(cs, i) and body(li) >= cfg["min_body_ratio"]): return None
    if not (tr(b, li) < atr(cs, i+1) and body(b) < 0.5 and li["v"] > b["v"]): return None
    if tr(li, cs[i-1]) < cfg["size_multiple"]*tr(b, li): return None
    for k in range(1, cfg["max_legout_offset"]+1):
        if i+1+k >= len(cs): break
        o = cs[i+1+k]
        if tr(o, cs[i+k]) > atr(cs, i+1+k) and body(o) >= cfg["min_body_ratio"] \\
           and tr(o, cs[i+k]) >= cfg["size_multiple"]*tr(li, cs[i-1]) and o["v"] > li["v"]:
            bull = o["c"] > o["o"]
            limit, sl = (b["h"], b["l"]) if bull else (b["l"], b["h"])
            risk = abs(limit-sl)
            tp = limit + risk*cfg["reward_risk"] if bull else limit - risk*cfg["reward_risk"]
            return {"side": "BUY" if bull else "SELL", "limit": limit, "sl": sl, "tp": tp}
    return None

if __name__ == "__main__":
    print("Connect with ctrader-open-api using env credentials", os.environ.get("CTRADER_HOST"))
    # TODO: ProtoOAApplicationAuthReq -> ProtoOAAccountAuthReq -> ProtoOASubscribeLiveTrendbarReq
    # on bar close: sig = detect(bars, len(bars)-3); if sig: ProtoOANewOrderReq(orderType=LIMIT, ...)`,
});
