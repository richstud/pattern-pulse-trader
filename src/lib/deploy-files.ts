import patternsPy from "../../vps/app/patterns.py?raw";
export const deployFiles = (cfg: { symbols: string[]; timeframes: Record<string, string[]>; rr: number; accountId: string; atrPeriod?: number }) => ({
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
atr_period: ${cfg.atrPeriod ?? 14}
min_body_ratio: 0.60      # body:wick 60:40 minimum
size_multiple: 2.0        # legin >= 2x boring, legout >= 2x legin
max_legout_offset: 3      # base of 1-3 boring candles, legout right after
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

${patternsPy}
if __name__ == "__main__":
    print("Connect with ctrader-open-api using env credentials", os.environ.get("CTRADER_HOST"))
    # TODO: ProtoOAApplicationAuthReq -> ProtoOAAccountAuthReq -> ProtoOASubscribeLiveTrendbarReq
    # on bar close: sig = evaluate(bars, i, cfg) for recent i; if r and r["ok"]: ProtoOANewOrderReq(orderType=LIMIT, ...)`,
});
