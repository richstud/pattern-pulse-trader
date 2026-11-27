# Dashboard connection updates
- [x] Remember successful VPS connections and reconnect on page open; forget on disconnect.
- [x] Recover polling after timeouts and display genuine connection/engine issues.
- [x] Show SCANNING/patterns only for healthy active feeds.
- [x] Run connection tests and browser checks, then commit.

Validation: 15 tests passed; browser checks cover saved-key reload, timeout recovery, engine disconnect, API failure, forgetting credentials, and mobile layouts using controlled VPS responses. Live VPS access and Netlify deployment were not verified.