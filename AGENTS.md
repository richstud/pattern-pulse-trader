<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

## What Lovable manages

Rules outside this block are the project's own. Change the pieces below in
Lovable, not by hand. With the [Lovable MCP](https://mcp.lovable.dev)
connected, `send_message` asks Lovable to do it; otherwise ask the user to
use the editor.

- **Database.** Do not add or edit `supabase/migrations/` or `drizzle/`.
  Ask Lovable to change the schema.
- **Generated files.** Do not edit a file whose header says it is automatically
  generated.
- **AI gateway.** Keep model calls on Lovable's gateway, and keep
  `LOVABLE_API_KEY` out of browser code.
- **Connectors.** Lovable provides native connectors. `list_connectors` shows
  which are enabled; `add_connector` only returns the dashboard link. When a
  connector is enabled, calls go through the connector gateway and need
  `LOVABLE_API_KEY`. When Lovable does not provide one, users can bring their
  own key and store it in Secrets.
- **Secrets.** Lovable manages them. Do not put secret values in the repo.
<!-- LOVABLE:END -->

- Pattern rules live in src/lib/patterns.ts (pure, tested); the in-browser scanner and the VPS scanner.py template must stay in sync — same rules, two runtimes.
- VPS backend lives in vps/ (Docker Compose: Postgres + FastAPI + Twisted cTrader engine); vps/app/patterns.py must mirror src/lib/patterns.ts. Netlify serves static files only and proxies /api/* to the VPS via netlify.toml — no Netlify Functions, to keep all compute on the VPS.
- Dashboard VPS reads use the browser-only adapter in src/lib/vps-feed.ts; require HTTPS from HTTPS pages and derive watchlists and order states from the VPS without inventing candles or fills because the current API exposes no candle stream.
- Keep connection persistence and retry lifecycle in src/lib/vps-connection.ts; restore storage only after hydration and save only successful connections so invalid keys do not replace remembered credentials.
- Scanner cells show a pattern only for SIGNAL_MAX_AGE_MS (src/lib/vps-connection.ts) after the signal time; older signals stay in the Signals table but the cell reverts to SCANNING, so stale patterns never look current.
- Setups that pass Legin + Boring but fail a later rule are recorded as rejections (evaluateAt in patterns.ts / evaluate in patterns.py, rejections table, GET /rejections) and shown in the Detected Trades tab, so failed detections are explainable; the dashboard treats a missing /rejections endpoint as empty for older VPS builds.
