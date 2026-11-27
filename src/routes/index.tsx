import { toast } from "sonner";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { scanLatest, gradeBody, type Candle, type Signal } from "@/lib/patterns";
import { SYMBOLS, SYMBOL_GROUPS, TIMEFRAMES, MAX_SYMBOLS, MAX_TIMEFRAMES, seedCandles, advance, digits } from "@/lib/mock-feed";
import { readVps, saveWatchlist, saveAtrPeriod, timeframeCode, heartbeatFresh, timeframeLabel, type Heartbeat, type DisplaySignal } from "@/lib/vps-feed";
import { deployFiles } from "@/lib/deploy-files";
import { CONNECTION_STORAGE_KEY, restoreConnection, rememberConnection, connectionIssue, scannerState, reportFailure, startVpsPolling } from "@/lib/vps-connection";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "LBL Scanner — Pepperstone cTrader pattern automation" },
      { name: "description", content: "Scan up to 6 Pepperstone symbols, each with its own set of up to 13 timeframes, for Legin-Boring-Legout setups and auto-calculate limit orders." },
      { property: "og:title", content: "LBL Scanner — cTrader pattern automation" },
      { property: "og:description", content: "Legin-Boring-Legout scanner with limit price, stop loss and VPS export." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Dashboard,
});

type Settings = { accountId: string; mock: boolean; autoExecute: boolean; rr: number; atrPeriod: number };
const DEFAULT_TFS = ["15 SEC", "30 SEC", "1 MIN", "5 MIN", "15 MIN", "1 HR"];
const DEFAULT_SETTINGS: Settings = { accountId: "", mock: false, autoExecute: true, rr: 2, atrPeriod: 14 };

function Dashboard() {
  const [symbols, setSymbols] = useState<string[]>(["US100", "EURUSD", "GBPUSD", "XAUUSD", "US500", "BTCUSD"]);
  const [tfMap, setTfMap] = useState<Record<string, string[]>>({});
  const [editing, setEditing] = useState("US100");
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [apiUrl, setApiUrl] = useState("/api");
  const [apiKey, setApiKey] = useState("");
  const [activeConnection, setActiveConnection] = useState<{ url: string; key: string } | null>(null);
  const [heartbeat, setHeartbeat] = useState<Heartbeat | null>(null);
  const latestHeartbeat = useRef<Heartbeat | null>(null);
  const [serverWatchlist, setServerWatchlist] = useState<Record<string, string[]>>({});
  const [connectionError, setConnectionError] = useState("");
  const [lastRead, setLastRead] = useState<number | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [clock, setClock] = useState(0);
  const [storageNotice, setStorageNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    // Show what the VPS is scanning in the picker, unless the user has unsaved edits.
    if (settings.mock || dirty || !Object.keys(serverWatchlist).length) return;
    setSymbols(Object.keys(serverWatchlist));
    setTfMap(Object.fromEntries(Object.entries(serverWatchlist).map(([k, v]) => [k, v.map(timeframeLabel)])));
    setEditing((e) => (e in serverWatchlist ? e : Object.keys(serverWatchlist)[0] ?? e));
  }, [serverWatchlist, settings.mock, dirty]);
  const applyToVps = async () => {
    if (!activeConnection) { setSaveMsg("Connect to the VPS first (VPS Connection tab)."); return; }
    setSaving(true); setSaveMsg("");
    try {
      await saveWatchlist(activeConnection.url, activeConnection.key, Object.fromEntries(symbols.map((s) => [s, tfsPick(s)])));
      setDirty(false); setSaveMsg("Saved. The VPS engine restarts with the new list in about 10 seconds."); setRefresh((v) => v + 1);
    } catch (e) { setSaveMsg(e instanceof Error ? e.message : "Save failed."); }
    finally { setSaving(false); }
  };
  const tfsPick = (s: string) => tfMap[s] ?? DEFAULT_TFS;
  const tfsOf = (s: string) => settings.mock ? tfMap[s] ?? DEFAULT_TFS : (serverWatchlist[s] ?? []).map(timeframeLabel);
  const displaySymbols = settings.mock ? symbols : Object.keys(serverWatchlist);
  const pairs = useMemo(() => displaySymbols.flatMap((s) => tfsOf(s).map((tf) => [s, tf] as const)), [symbols, tfMap, settings.mock, serverWatchlist]);
  const allTfs = useMemo(() => [...new Set(pairs.map(([, tf]) => tf))], [pairs]);
  const [series, setSeries] = useState<Record<string, Candle[]>>({});
  const [signals, setSignals] = useState<DisplaySignal[]>([]);
  const [running, setRunning] = useState(true);
  const [conn, setConn] = useState<"disconnected" | "connecting" | "connected" | "error">("disconnected");
  const seen = useRef(new Set<string>());

  useEffect(() => {
    // Discard legacy browser-stored broker credentials. VPS owns broker authentication.
    try {
      localStorage.removeItem("lbl-settings");
      const saved = restoreConnection(localStorage);
      const savedUrl = localStorage.getItem("lbl-vps-url");
      if (saved) {
        setApiUrl(saved.url); setApiKey(saved.key);
        setActiveConnection(saved); setConn("connecting");
      } else if (savedUrl) setApiUrl(savedUrl);
    } catch { setStorageNotice("This browser cannot remember your connection. Keep this page open or allow site storage."); }
  }, []);
  useEffect(() => {
    setSeries({}); setSignals([]); seen.current.clear();
  }, [settings.mock]);

  useEffect(() => {
    if (settings.mock || !activeConnection) return;
    let failures = 0;
    let remembered = false;
    return startVpsPolling({
      read: signal => readVps(activeConnection.url, activeConnection.key, signal),
      onResult: result => {
        latestHeartbeat.current = result.heartbeat; failures = 0;
        setHeartbeat(result.heartbeat); setServerWatchlist(result.watchlist); setSettings((cur) => cur.atrPeriod === result.atrPeriod ? cur : { ...cur, atrPeriod: result.atrPeriod });
        if (running) setSignals(result.signals);
        setLastRead(Date.now()); setClock(Date.now()); setConnectionError("");
        setConn(heartbeatFresh(result.heartbeat) ? "connected" : "error");
        if (!heartbeatFresh(result.heartbeat)) setConnectionError(result.heartbeat.connected
          ? "VPS engine heartbeat is stale. Scanning cannot be confirmed. Rechecking automatically…"
          : "VPS engine is disconnected from cTrader. Scanning cannot be confirmed. Rechecking automatically…");
        if (!remembered) {
          try { rememberConnection(localStorage, activeConnection); setStorageNotice(""); remembered = true; }
          catch { setStorageNotice("Connection works, but this browser cannot save the key for your next visit."); }
        }
      },
      onError: (error, aborted) => {
        failures += 1;
        if (reportFailure(latestHeartbeat.current, failures) || !aborted && !(error instanceof TypeError)) {
          setConn("error"); setConnectionError(connectionIssue(error, aborted));
        }
      },
    });
  }, [activeConnection, settings.mock, running, refresh]);

  useEffect(() => {
    if (settings.mock || !activeConnection) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [settings.mock, activeConnection]);

  useEffect(() => {
    if (!running || !settings.mock) return;
    const id = setInterval(() => {
      setSeries((prev) => {
        const next: Record<string, Candle[]> = {};
        const found: Signal[] = [];
        for (const [s, tf] of pairs) {
          const key = `${s}|${tf}`;
          const cur = advance(prev[key] ?? seedCandles(s), s);
          next[key] = cur;
          const r = scanLatest(cur, settings.rr, settings.atrPeriod);
          const sk = `${key}|${r?.time}`;
          if (r && !seen.current.has(sk)) {
            seen.current.add(sk);
            found.push({ ...r, id: sk, symbol: s, tf, time: Date.now(), status: settings.autoExecute ? "PLACED" : "PENDING" });
          }
        }
        if (found.length) setSignals((old) => [...found, ...old].slice(0, 100));
        return next;
      });
      setSignals((old) => old.map((x) => (x.status === "PLACED" && Math.random() < 0.08 ? { ...x, status: "FILLED" } : x)));
    }, 1500);
    return () => clearInterval(id);
  }, [running, pairs, settings.mock, settings.rr, settings.autoExecute]);

  const latestByCell = useMemo(() => {
    const m: Record<string, DisplaySignal> = {};
    for (const s of signals) { const k = `${s.symbol}|${s.tf}`; if (!m[k]) m[k] = s; }
    return m;
  }, [signals]);

  const toggle = (list: string[], set: (v: string[]) => void, v: string, max: number) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : list.length >= max ? list : [...list, v]);

  const testConnection = () => {
    latestHeartbeat.current = null;
    setSettings(v => ({ ...v, mock: false }));
    setSeries({}); setSignals([]); setServerWatchlist({}); setHeartbeat(null); setLastRead(null);
    setConn("connecting"); setConnectionError("");

    setActiveConnection({ url: apiUrl, key: apiKey });
  };
  const liveHealthy = conn === "connected" && heartbeat !== null && heartbeatFresh(heartbeat, clock || Date.now());
  const healthError = connectionError || (activeConnection && heartbeat && !heartbeatFresh(heartbeat, clock || Date.now())
    ? "VPS engine is disconnected or its heartbeat is stale. Scanning cannot be confirmed. Rechecking automatically…" : "");
  const status = settings.mock ? "SIMULATED FEED" : liveHealthy ? `VPS ${heartbeat?.env?.toUpperCase() ?? "UNKNOWN"} · ${running ? "CONNECTED" : "PAUSED"}` : healthError ? "OFFLINE" : conn.toUpperCase();
  const statusColor = settings.mock ? "bg-muted-foreground" : liveHealthy ? "bg-bull" : healthError ? "bg-bear" : "bg-muted-foreground";

  return (
    <div className="min-h-screen bg-background font-sans text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight"><span className="text-primary">LBL</span> Scanner</h1>
          <p className="text-xs text-muted-foreground">Legin · Boring · Legout — Pepperstone cTrader</p>
        </div>
        <div className="flex flex-wrap items-center gap-4 font-mono text-xs">
          <span className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${statusColor} ${running ? "animate-pulse" : ""}`} />{status}</span>
          <span className="text-muted-foreground">{displaySymbols.length}/{MAX_SYMBOLS} SYM · {pairs.length} FEEDS · {signals.length} SIG</span>
          <Button size="sm" variant={running ? "secondary" : "default"} onClick={() => setRunning(!running)}>{running ? "Pause display" : "Resume display"}</Button>
        </div>
      </header>

      <Tabs defaultValue="scanner" className="p-6">
        <TabsList className="h-auto flex-wrap justify-start gap-1">
          <TabsTrigger value="scanner">Scanner</TabsTrigger>
          <TabsTrigger value="signals">Signals & Orders</TabsTrigger>
          <TabsTrigger value="rules">Rules</TabsTrigger>
          <TabsTrigger value="setup">Symbols & Timeframes</TabsTrigger>
          <TabsTrigger value="settings">VPS Connection</TabsTrigger>
          <TabsTrigger value="deploy">VPS Export</TabsTrigger>
        </TabsList>

        {!settings.mock && healthError && <div role="alert" className="mt-4 rounded-md border border-bear/40 bg-bear/10 p-3 text-sm text-bear">{healthError}</div>}

        <TabsContent value="scanner" className="mt-4 space-y-6">
          {!settings.mock && <div className="space-y-2 text-sm">
            {!activeConnection && <p className="text-muted-foreground">VPS not connected. Enter your API address and key in VPS Connection.</p>}
            {heartbeat && <p className="font-mono text-xs text-muted-foreground">Account {heartbeat.account_id ?? "—"} · {heartbeat.env ?? "unknown"} · {heartbeat.detail} · Last read {lastRead ? new Date(lastRead).toLocaleTimeString() : "—"}</p>}
            {activeConnection && <p className="text-xs text-muted-foreground">VPS signals and order responses only; live prices and candle charts are not supplied by this API. Pausing this display does not stop VPS trading.</p>}
            {activeConnection && <Button variant="outline" size="sm" onClick={() => setRefresh(v => v + 1)}>Refresh now</Button>}
          </div>}
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full border-collapse font-mono text-xs">
              <thead><tr className="bg-card">
                <th className="sticky left-0 bg-card px-3 py-2 text-left text-muted-foreground">SYMBOL</th>
                {allTfs.map((tf) => <th key={tf} className="px-2 py-2 text-muted-foreground">{tf}</th>)}
              </tr></thead>
              <tbody>
                {displaySymbols.map((s) => (
                  <tr key={s} className="border-t border-border">
                    <td className="sticky left-0 bg-background px-3 py-2 font-semibold">{s}<div className="text-[10px] font-normal text-muted-foreground">{series[`${s}|${tfsOf(s)[0]}`]?.at(-1)?.c.toFixed(digits(s)) ?? "—"}</div></td>
                    {allTfs.map((tf) => tfsOf(s).includes(tf) ? <Cell key={tf} live={!settings.mock} healthy={liveHealthy} running={running} candles={series[`${s}|${tf}`]} sig={latestByCell[`${s}|${tf}`]} /> : <td key={tf} className="px-2 py-2 text-center text-muted-foreground/40">·</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <SignalTable signals={signals.slice(0, 8)} />
        </TabsContent>

        <TabsContent value="signals" className="mt-4"><SignalTable signals={signals} /></TabsContent>

        <TabsContent value="rules" className="mt-4">
          <RulesTab atrPeriod={settings.atrPeriod} rr={settings.rr} onAtr={async (n) => {
            if (!settings.mock && activeConnection) {
              try { await saveAtrPeriod(activeConnection.url, activeConnection.key, n); toast.success(`ATR(${n}) saved to VPS — scanner restarts with it.`); }
              catch (e) { toast.error(e instanceof Error ? e.message : "Could not save ATR period."); return; }
            }
            setSettings((cur) => ({ ...cur, atrPeriod: n }));
          }} />
        </TabsContent>

        <TabsContent value="setup" className="mt-4 grid gap-6 md:grid-cols-2">
          {!settings.mock && <div className="md:col-span-2 rounded-md border border-border bg-card p-4"><div className="mb-2 flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">{liveHealthy ? "VPS is scanning" : "VPS scanning not confirmed"} · {pairs.length} feeds</h2><Button onClick={applyToVps} disabled={saving || !activeConnection}>{saving ? "Saving…" : "Save & apply to VPS"}</Button></div>
            <p className="mb-3 text-xs text-muted-foreground">{dirty ? "You have unsaved changes below." : "Pick tickers and timeframes below, then press Save & apply."} Second timeframes start empty and need a few minutes of live ticks.</p>
            {saveMsg && <p role="status" className="mb-2 text-sm">{saveMsg}</p>}
            {Object.entries(serverWatchlist).map(([symbol, frames]) => <p key={symbol} className="mb-2 break-words font-mono text-xs"><strong>{symbol}</strong> · {frames.length} timeframes · {frames.map(timeframeLabel).join(", ")}</p>)}
          </div>}
          <div className="contents">
          <section className="rounded-md border border-border bg-card p-4">
            <h2 className="mb-1 font-semibold">Symbols <span className="font-mono text-xs text-muted-foreground">({symbols.length}/{MAX_SYMBOLS})</span></h2>
            <p className="mb-3 text-xs text-muted-foreground">Pepperstone cTrader catalogue. Pick up to 6. Type any other symbol name and press Enter to add it.</p>
            <Input placeholder="Search or add symbol…" value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { const v = query.trim(); if (e.key === "Enter" && v && !symbols.includes(v) && symbols.length < MAX_SYMBOLS) { setDirty(true); setSymbols([...symbols, v]); setEditing(v); setQuery(""); } }} className="mb-3 font-mono" />
            <div className="max-h-96 space-y-3 overflow-y-auto pr-1">
              {Object.entries(SYMBOL_GROUPS).map(([g, list]) => {
                const shown = list.filter((s) => s.toLowerCase().includes(query.toLowerCase()));
                if (!shown.length) return null;
                return (
                  <div key={g}>
                    <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">{g}</div>
                    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                      {shown.map((s) => (
                        <label key={s} className="flex items-center gap-2 font-mono text-xs">
                          <Checkbox checked={symbols.includes(s)} disabled={!symbols.includes(s) && symbols.length >= MAX_SYMBOLS} onCheckedChange={() => { setDirty(true); toggle(symbols, setSymbols, s, MAX_SYMBOLS); if (!symbols.includes(s)) setEditing(s); }} />{s}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            {symbols.filter((s) => !SYMBOLS.includes(s)).length > 0 && <p className="mt-2 font-mono text-xs">Custom: {symbols.filter((s) => !SYMBOLS.includes(s)).map((s) => <button key={s} className="mr-2 underline" onClick={() => { setDirty(true); setSymbols(symbols.filter((x) => x !== s)); }}>{s} ×</button>)}</p>}
          </section>
          <section className="rounded-md border border-border bg-card p-4">
            <h2 className="mb-1 font-semibold">Timeframes per symbol</h2>
            <p className="mb-3 text-xs text-muted-foreground">Each symbol has its own timeframes — up to {MAX_TIMEFRAMES} each. Choose a symbol, then tick its timeframes.</p>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {symbols.map((s) => (
                <Button key={s} size="sm" variant={editing === s ? "default" : "outline"} className="font-mono text-xs" onClick={() => setEditing(s)}>{s} <span className="ml-1 opacity-70">{tfsPick(s).length}</span></Button>
              ))}
            </div>
            {symbols.includes(editing) ? (() => {
              const cur = tfsPick(editing);
              const set = (v: string[]) => { setDirty(true); setTfMap({ ...tfMap, [editing]: TIMEFRAMES.filter((x) => v.includes(x)) }); };
              return (<>
                <div className="mb-2 flex items-center justify-between font-mono text-xs"><span>{editing}: {cur.length}/{MAX_TIMEFRAMES}</span>
                  <button className="underline text-muted-foreground" onClick={() => { const n: Record<string, string[]> = { ...tfMap }; symbols.forEach((s) => (n[s] = cur)); setTfMap(n); setDirty(true); }}>Copy to all symbols</button></div>
                <div className="grid grid-cols-3 gap-2">
                  {TIMEFRAMES.filter((t) => settings.mock || timeframeCode(t)).map((t) => (
                    <label key={t} className="flex items-center gap-2 font-mono text-sm">
                      <Checkbox checked={cur.includes(t)} disabled={!cur.includes(t) && cur.length >= MAX_TIMEFRAMES} onCheckedChange={() => toggle(cur, set, t, MAX_TIMEFRAMES)} />{t}
                    </label>
                  ))}
                </div>
              </>);
            })() : <p className="text-xs text-muted-foreground">Select a symbol above.</p>}
          </section>
          </div>
          <section className="rounded-md border border-border bg-card p-4 md:col-span-2 text-sm">
            <h2 className="mb-2 font-semibold">Pattern rules</h2>
            <ul className="grid gap-1 text-muted-foreground md:grid-cols-2">
              <li>• Legin: TR &gt; ATR(14), body ≥ 60% (80:20 perfect, 70:30 average, 60:40 normal)</li>
              <li>• Boring: TR &lt; ATR, small body</li>
              <li>• Legout (1st–3rd candle after base): TR &gt; ATR, body ≥ 60%</li>
              <li>• Size: Legin ≥ 2× Boring, Legout ≥ 2× Legin</li>
              <li>• Volume: Legout &gt; Legin &gt; Boring</li>
              <li>• Buy: limit = boring high, SL = boring low · Sell: limit = boring low, SL = boring high</li>
            </ul>
          </section>
        </TabsContent>

        <TabsContent value="settings" className="mt-4 max-w-xl space-y-4 rounded-md border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-4"><div><Label htmlFor="simulation">Simulated data</Label><p className="text-xs text-muted-foreground">No broker orders; generated prices only.</p></div><Switch id="simulation" checked={settings.mock} onCheckedChange={(v) => { setSettings({ ...settings, mock: v }); setConn("disconnected"); }} /></div>
          <div className="space-y-1"><Label htmlFor="vps-url">VPS API address</Label><Input id="vps-url" value={apiUrl} onChange={e => setApiUrl(e.target.value.trim())} placeholder="/api or https://api.example.com" className="font-mono" /></div>
          <p className="text-xs text-muted-foreground">Use /api on your Netlify site. This HTTPS preview needs an HTTPS VPS address; http://103.77.155.79:8000 is blocked by browser security. Netlify's current proxy uses HTTP to the VPS, so that server-side connection is not encrypted.</p>
          <div className="space-y-1"><Label htmlFor="vps-key">VPS API key</Label><Input id="vps-key" type="password" autoComplete="off" value={apiKey} onChange={e => setApiKey(e.target.value)} className="font-mono" /></div>
          <p className="text-xs text-muted-foreground">Key is remembered on this browser and is not encrypted on this device. Disconnect forgets it. Broker credentials stay on your VPS. Rotate any key shared in screenshots.</p>
          <div className="flex flex-wrap items-center gap-3"><Button onClick={testConnection} disabled={conn === "connecting"}>Connect VPS</Button><Button variant="outline" onClick={() => { try { localStorage.removeItem(CONNECTION_STORAGE_KEY); localStorage.removeItem("lbl-vps-url"); setStorageNotice(""); } catch { setStorageNotice("Unable to forget the saved key. Clear this site's browser storage."); } setActiveConnection(null); setApiKey(""); setHeartbeat(null); setServerWatchlist({}); setSeries({}); setSignals([]); setLastRead(null); setConn("disconnected"); setConnectionError(""); }}>Disconnect</Button><span className="font-mono text-xs">{conn}</span></div>
          {storageNotice && <p role="status" className="text-sm text-muted-foreground">{storageNotice}</p>}
          <p className="text-xs text-muted-foreground">Connection is read-only. Trading is controlled by AUTO_EXECUTE on the VPS; “SENT” is a server response, not proof of a fill. Confirm orders in cTrader.</p>
          {settings.mock && <>
            <div className="flex items-center justify-between"><Label htmlFor="simulation-orders">Simulate order placement</Label><Switch id="simulation-orders" checked={settings.autoExecute} onCheckedChange={v => setSettings({ ...settings, autoExecute: v })} /></div>
            <div className="space-y-1"><Label htmlFor="rr">Simulation Reward : Risk</Label><Input id="rr" type="number" min={0.5} max={10} step={0.5} value={settings.rr} onChange={e => setSettings({ ...settings, rr: Math.min(10, Math.max(0.5, Number(e.target.value) || 2)) })} className="w-28 font-mono" /></div>
          </>}
        </TabsContent>

        <TabsContent value="deploy" className="mt-4"><DeployTab files={deployFiles({ symbols, timeframes: Object.fromEntries(symbols.map((s) => [s, tfsOf(s)])), rr: settings.rr, accountId: settings.accountId, atrPeriod: settings.atrPeriod })} /></TabsContent>
      </Tabs>
    </div>
  );
}

function Cell({ candles, sig, live, healthy, running }: { candles?: Candle[] | undefined; sig?: DisplaySignal | undefined; live: boolean; healthy: boolean; running: boolean }) {
  const state = live ? scannerState(healthy, running, sig?.type) : scannerState(true, running, sig?.type);
  const fresh = (!live || healthy) && sig && Date.now() - sig.time < 15000;
  const pts = candles?.slice(-30) ?? [];
  const lo = Math.min(...pts.map((c) => c.l)), hi = Math.max(...pts.map((c) => c.h));
  const path = pts.map((c, i) => `${(i / 29) * 100},${30 - ((c.c - lo) / (hi - lo || 1)) * 28 - 1}`).join(" ");
  return (
    <td className={`border-l border-border px-1 py-1 text-center ${fresh ? (sig?.side === "BUY" ? "bg-bull/15" : "bg-bear/15") : ""}`}>
      {!live && <svg viewBox="0 0 100 30" className="h-6 w-full min-w-16" preserveAspectRatio="none"><polyline points={path} fill="none" stroke="currentColor" strokeWidth="1.2" className="text-muted-foreground" vectorEffect="non-scaling-stroke" /></svg>}
      <div className={`flex min-h-10 min-w-24 items-center justify-center gap-1 whitespace-nowrap text-[10px] ${state === "OFFLINE" ? "text-bear" : state === "PAUSED" ? "text-muted-foreground" : sig?.side === "SELL" ? "text-bear" : "text-bull"}`}>
        {state === "SCANNING" && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-bull motion-safe:animate-pulse" />}{state}
      </div>
    </td>
  );
}

function SignalTable({ signals }: { signals: DisplaySignal[] }) {
  if (!signals.length) return <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No signals to display.</p>;
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full font-mono text-xs">
        <thead className="bg-card text-muted-foreground"><tr>{["TIME", "SYMBOL", "TF", "PATTERN", "SIDE", "BORING H", "BORING L", "LIMIT", "SL", "TP", "R:R", "BODY", "STATUS"].map((h) => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr></thead>
        <tbody>
          {signals.map((s) => { const d = digits(s.symbol); return (
            <tr key={s.id} className="border-t border-border">
              <td className="px-3 py-2">{new Date(s.time).toLocaleTimeString()}</td>
              <td className="px-3 py-2 font-semibold">{s.symbol}</td>
              <td className="px-3 py-2">{s.tf}</td>
              <td className="px-3 py-2">{s.type} {s.legoutIndex && <span className="text-muted-foreground">L{s.legoutIndex}</span>}</td>
              <td className={`px-3 py-2 font-semibold ${s.side === "BUY" ? "text-bull" : "text-bear"}`}>{s.side} LMT</td>
              <td className="px-3 py-2">{s.boringHigh.toFixed(d)}</td>
              <td className="px-3 py-2">{s.boringLow.toFixed(d)}</td>
              <td className="px-3 py-2 text-primary">{s.limit.toFixed(d)}</td>
              <td className="px-3 py-2 text-bear">{s.sl.toFixed(d)}</td>
              <td className="px-3 py-2 text-bull">{s.tp.toFixed(d)}</td>
              <td className="px-3 py-2">1:{s.rr}</td>
              <td className="px-3 py-2 text-muted-foreground">{s.bodyRatioLegin !== undefined && s.bodyRatioLegout !== undefined ? gradeBody(Math.min(s.bodyRatioLegin, s.bodyRatioLegout)) : "—"}</td>
              <td className="px-3 py-2"><Badge variant={s.status === "FILLED" ? "default" : "secondary"}>{s.status}</Badge>{s.note && <div className="mt-1 max-w-64 whitespace-normal text-bear">{s.note}</div>}</td>
            </tr>); })}
        </tbody>
      </table>
    </div>
  );
}

function DeployTab({ files }: { files: Record<string, string> }) {
  const names = Object.keys(files);
  const [sel, setSel] = useState<string>(names[0] ?? "");
  const download = (name: string) => {
    const url = URL.createObjectURL(new Blob([files[name] ?? ""], { type: "text/plain" }));
    const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
  };
  return (
    <div className="grid gap-4 md:grid-cols-[200px_1fr]">
      <div className="space-y-1">
        {names.map((n) => <button key={n} onClick={() => setSel(n)} className={`block w-full rounded px-3 py-2 text-left font-mono text-sm ${sel === n ? "bg-secondary text-primary" : "text-muted-foreground hover:bg-muted"}`}>{n}</button>)}
        <Button className="mt-3 w-full" onClick={() => names.forEach(download)}>Download all</Button>
      </div>
      <div className="rounded-md border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-2 font-mono text-xs"><span>{sel}</span>
          <div className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(files[sel] ?? "")}>Copy</Button><Button size="sm" variant="secondary" onClick={() => download(sel)}>Download</Button></div></div>
        <pre className="max-h-[560px] overflow-auto p-4 font-mono text-xs leading-relaxed">{files[sel] ?? ""}</pre>
      </div>
    </div>
  );
}

function RulesTab({ atrPeriod, rr, onAtr }: { atrPeriod: number; rr: number; onAtr: (n: number) => void }) {
  const rules = [
    ["Leg-in", `True Range > ATR(${atrPeriod}); body ≥ 60% of range (80:20 perfect, 70:30 average, 60:40 normal).`],
    ["Boring base", `1 to 3 consecutive candles; each True Range < ATR(${atrPeriod}) and body < 50% of range.`],
    ["Leg-out", `Within 1–3 candles after the base; True Range > ATR(${atrPeriod}); body ≥ 60% of range.`],
    ["Size", "Leg-in True Range ≥ 2× the largest boring candle; leg-out True Range ≥ 2× leg-in."],
    ["Volume", "Leg-in volume > every boring candle; leg-out volume > leg-in."],
    ["Zone", "Zone high = highest high of the boring candles; zone low = lowest low."],
    ["Bullish (RBR / DBR)", `Buy Limit at zone high, Stop Loss at zone low, Target ${rr}R.`],
    ["Bearish (RBD / DBD)", `Sell Limit at zone low, Stop Loss at zone high, Target ${rr}R.`],
  ];
  return (
    <div className="grid gap-6 md:grid-cols-[280px_1fr]">
      <div className="space-y-3 rounded-md border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">ATR period</h3>
        <p className="text-xs text-muted-foreground">True Range = max(High−Low, |High−prev Close|, |Low−prev Close|). ATR = average True Range of the previous N candles.</p>
        <div className="flex gap-2">
          {[14, 100].map((n) => (
            <Button key={n} size="sm" variant={atrPeriod === n ? "default" : "outline"} onClick={() => onAtr(n)}>ATR {n}</Button>
          ))}
        </div>
        <p className="font-mono text-xs">Active: ATR({atrPeriod})</p>
      </div>
      <ol className="space-y-2">
        {rules.map(([t, d], i) => (
          <li key={t} className="rounded-md border border-border bg-card p-3 text-sm">
            <span className="mr-2 font-mono text-xs text-muted-foreground">{i + 1}.</span><span className="font-semibold">{t}</span>
            <p className="mt-1 text-muted-foreground">{d}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
