# LBL Scanner - VPS package

Everything runs on the VPS: Postgres database, FastAPI (port 8000), cTrader engine.
The dashboard on Netlify calls `https://<site>.netlify.app/api/*`, which Netlify forwards to this VPS.

## Setup (Ubuntu 24.04)
```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
# copy this folder to /opt/lbl, then:
cd /opt/lbl && cp .env.example .env && nano .env   # fill credentials
nano config.yaml                                    # symbols + timeframes
./run.sh
docker compose logs -f engine                       # expect "ready: XAUUSD, ..."
curl -H "X-API-Key: <API_KEY>" http://localhost:8000/status
sudo ufw allow 22 && sudo ufw allow 8000 && sudo ufw enable
```

## Safety
- `CTRADER_ENV=demo` + `AUTO_EXECUTE=false` first: signals are only logged.
- Then `AUTO_EXECUTE=true` on demo. Live = `CTRADER_ENV=live` + live account id + token with trading scope.
- Placing orders needs a token with the "Account info and trading" scope.
- Access tokens expire (~30 days); regenerate and update `.env`, then `docker compose restart engine`.
- Second timeframes (15/30/45 SEC) are not supported yet.

## Watchlist from the dashboard
Pick tickers/timeframes in "Symbols & Timeframes" and press **Save & apply to VPS**. The API writes `config.yaml` (shared with the engine) and the engine restarts itself within seconds. First time only: `git pull && docker compose up -d --build`.
