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
import { SYMBOLS, TIMEFRAMES, MAX_SYMBOLS, MAX_TIMEFRAMES, seedCandles, advance, digits } from "@/lib/mock-feed";
import { deployFiles } from "@/lib/deploy-files";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "LBL Scanner — Pepperstone cTrader pattern automation" },
      { name: "description", content: "Scan up to 6 symbols across 13 timeframes for Legin-Boring-Legout setups and auto-calculate limit orders." },
      { property: "og:title", content: "LBL Scanner — cTrader pattern automation" },
      { property: "og:description", content: "Legin-Boring-Legout scanner with limit price, stop loss and VPS export." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Dashboard,
});

type Settings = { clientId: string; clientSecret: string; accessToken: string; accountId: string; mock: boolean; autoExecute: boolean; rr: number };
const DEFAULT_SETTINGS: Settings = { clientId: "", clientSecret: "", accessToken: "", accountId: "", mock: true, autoExecute: true, rr: 2 };

function Dashboard() {
  const [symbols, setSymbols] = useState<string[]>(["US100", "EURUSD", "GBPUSD", "XAUUSD", "US500", "BTCUSD"]);
  const [tfs, setTfs] = useState<string[]>(["15 SEC", "30 SEC", "1 MIN", "5 MIN", "15 MIN", "1 HR"]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [series, setSeries] = useState<Record<string, Candle[]>>({});
  const [signals, setSignals] = useState<Signal[]>([]);
  const [running, setRunning] = useState(true);
  const [conn, setConn] = useState<"disconnected" | "connecting" | "connected" | "error">("disconnected");
  const seen = useRef(new Set<string>());

  useEffect(() => {
    try { const s = localStorage.getItem("lbl-settings"); if (s) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(s) }); } catch {}
  }, []);
  useEffect(() => { localStorage.setItem("lbl-settings", JSON.stringify(settings)); }, [settings]);

  useEffect(() => {
    if (!running || !settings.mock) return;
    const id = setInterval(() => {
      setSeries((prev) => {
        const next: Record<string, Candle[]> = {};
        const found: Signal[] = [];
        for (const s of symbols) for (const tf of tfs) {
          const key = `${s}|${tf}`;
          const cur = advance(prev[key] ?? seedCandles(s), s);
          next[key] = cur;
          const r = scanLatest(cur, settings.rr);
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
  }, [running, symbols, tfs, settings.mock, settings.rr, settings.autoExecute]);

  const latestByCell = useMemo(() => {
    const m: Record<string, Signal> = {};
    for (const s of signals) { const k = `${s.symbol}|${s.tf}`; if (!m[k]) m[k] = s; }
    return m;
  }, [signals]);

  const toggle = (list: string[], set: (v: string[]) => void, v: string, max: number) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : list.length >= max ? list : [...list, v]);

  const testConnection = () => {
    if (settings.mock) { setConn("connected"); return; }
    const ok = settings.clientId && settings.clientSecret && settings.accessToken && settings.accountId;
    setConn("connecting");
    setTimeout(() => setConn(ok ? "connected" : "error"), 900);
  };

  const status = settings.mock ? "DEMO FEED" : conn.toUpperCase();
  const statusColor = settings.mock || conn === "connected" ? "bg-bull" : conn === "error" ? "bg-bear" : "bg-muted-foreground";

  return (
    <div className="min-h-screen bg-background font-sans text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight"><span className="text-primary">LBL</span> Scanner</h1>
          <p className="text-xs text-muted-foreground">Legin · Boring · Legout — Pepperstone cTrader</p>
        </div>
        <div className="flex items-center gap-4 font-mono text-xs">
          <span className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${statusColor} ${running ? "animate-pulse" : ""}`} />{status}</span>
          <span className="text-muted-foreground">{symbols.length}/{MAX_SYMBOLS} SYM · {tfs.length}/{MAX_TIMEFRAMES} TF · {signals.length} SIG</span>
          <Button size="sm" variant={running ? "secondary" : "default"} onClick={() => setRunning(!running)}>{running ? "Pause" : "Resume"}</Button>
        </div>
      </header>

      <Tabs defaultValue="scanner" className="p-6">
        <TabsList>
          <TabsTrigger value="scanner">Scanner</TabsTrigger>
          <TabsTrigger value="signals">Signals & Orders</TabsTrigger>
          <TabsTrigger value="setup">Symbols & Timeframes</TabsTrigger>
          <TabsTrigger value="settings">cTrader API</TabsTrigger>
          <TabsTrigger value="deploy">VPS Export</TabsTrigger>
        </TabsList>

        <TabsContent value="scanner" className="mt-4 space-y-6">
          {!settings.mock && <p className="rounded-md border border-border bg-card p-3 text-sm text-muted-foreground">Live feed runs in the VPS scanner package. Turn on demo data in cTrader API settings to preview scanning here.</p>}
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full border-collapse font-mono text-xs">
              <thead><tr className="bg-card">
                <th className="sticky left-0 bg-card px-3 py-2 text-left text-muted-foreground">SYMBOL</th>
                {tfs.map((tf) => <th key={tf} className="px-2 py-2 text-muted-foreground">{tf}</th>)}
              </tr></thead>
              <tbody>
                {symbols.map((s) => (
                  <tr key={s} className="border-t border-border">
                    <td className="sticky left-0 bg-background px-3 py-2 font-semibold">{s}<div className="text-[10px] font-normal text-muted-foreground">{series[`${s}|${tfs[0]}`]?.at(-1)?.c.toFixed(digits(s)) ?? "—"}</div></td>
                    {tfs.map((tf) => <Cell key={tf} candles={series[`${s}|${tf}`]} sig={latestByCell[`${s}|${tf}`]} />)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <SignalTable signals={signals.slice(0, 8)} />
        </TabsContent>

        <TabsContent value="signals" className="mt-4"><SignalTable signals={signals} /></TabsContent>

        <TabsContent value="setup" className="mt-4 grid gap-6 md:grid-cols-2">
          <section className="rounded-md border border-border bg-card p-4">
            <h2 className="mb-1 font-semibold">Symbols <span className="font-mono text-xs text-muted-foreground">({symbols.length}/{MAX_SYMBOLS})</span></h2>
            <p className="mb-3 text-xs text-muted-foreground">Pick up to 6 to watch at the same time.</p>
            <div className="grid grid-cols-3 gap-2">
              {SYMBOLS.map((s) => (
                <label key={s} className="flex items-center gap-2 font-mono text-sm">
                  <Checkbox checked={symbols.includes(s)} disabled={!symbols.includes(s) && symbols.length >= MAX_SYMBOLS} onCheckedChange={() => toggle(symbols, setSymbols, s, MAX_SYMBOLS)} />{s}
                </label>
              ))}
            </div>
          </section>
          <section className="rounded-md border border-border bg-card p-4">
            <h2 className="mb-1 font-semibold">Timeframes <span className="font-mono text-xs text-muted-foreground">({tfs.length}/{MAX_TIMEFRAMES})</span></h2>
            <p className="mb-3 text-xs text-muted-foreground">Pick up to 13 active timeframes.</p>
            <div className="grid grid-cols-3 gap-2">
              {TIMEFRAMES.map((t) => (
                <label key={t} className="flex items-center gap-2 font-mono text-sm">
                  <Checkbox checked={tfs.includes(t)} disabled={!tfs.includes(t) && tfs.length >= MAX_TIMEFRAMES} onCheckedChange={() => toggle(tfs, (v) => setTfs(TIMEFRAMES.filter((x) => v.includes(x))), t, MAX_TIMEFRAMES)} />{t}
                </label>
              ))}
            </div>
          </section>
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
          <div className="flex items-center justify-between"><div><Label>Demo data</Label><p className="text-xs text-muted-foreground">Simulated prices for instant testing.</p></div><Switch checked={settings.mock} onCheckedChange={(v) => setSettings({ ...settings, mock: v })} /></div>
          <div className="flex items-center justify-between"><div><Label>Auto-place limit orders</Label><p className="text-xs text-muted-foreground">Otherwise signals wait as pending.</p></div><Switch checked={settings.autoExecute} onCheckedChange={(v) => setSettings({ ...settings, autoExecute: v })} /></div>
          {(["clientId", "clientSecret", "accessToken", "accountId"] as const).map((k) => (
            <div key={k} className="space-y-1">
              <Label htmlFor={k}>{{ clientId: "Client ID", clientSecret: "Client Secret", accessToken: "Access Token", accountId: "Account ID" }[k]}</Label>
              <Input id={k} type={k === "clientSecret" || k === "accessToken" ? "password" : "text"} value={settings[k]} onChange={(e) => setSettings({ ...settings, [k]: e.target.value.trim().slice(0, 500) })} className="font-mono" />
            </div>
          ))}
          <div className="space-y-1"><Label htmlFor="rr">Reward : Risk target</Label><Input id="rr" type="number" min={0.5} max={10} step={0.5} value={settings.rr} onChange={(e) => setSettings({ ...settings, rr: Math.min(10, Math.max(0.5, Number(e.target.value) || 2)) })} className="w-28 font-mono" /></div>
          <div className="flex items-center gap-3">
            <Button onClick={testConnection}>Test connection</Button>
            <span className="font-mono text-xs">{conn === "error" ? "Fill in all four fields" : conn}</span>
          </div>
          <p className="text-xs text-muted-foreground">Keys are kept only in this browser. For live trading, put them in the VPS package's .env file.</p>
        </TabsContent>

        <TabsContent value="deploy" className="mt-4"><DeployTab files={deployFiles({ symbols, timeframes: tfs, rr: settings.rr, accountId: settings.accountId })} /></TabsContent>
      </Tabs>
    </div>
  );
}

function Cell({ candles, sig }: { candles?: Candle[] | undefined; sig?: Signal | undefined }) {
  const fresh = sig && Date.now() - sig.time < 15000;
  const pts = candles?.slice(-30) ?? [];
  const lo = Math.min(...pts.map((c) => c.l)), hi = Math.max(...pts.map((c) => c.h));
  const path = pts.map((c, i) => `${(i / 29) * 100},${30 - ((c.c - lo) / (hi - lo || 1)) * 28 - 1}`).join(" ");
  return (
    <td className={`border-l border-border px-1 py-1 text-center ${fresh ? (sig!.side === "BUY" ? "bg-bull/15" : "bg-bear/15") : ""}`}>
      <svg viewBox="0 0 100 30" className="h-6 w-full min-w-16" preserveAspectRatio="none"><polyline points={path} fill="none" stroke="currentColor" strokeWidth="1.2" className="text-muted-foreground" vectorEffect="non-scaling-stroke" /></svg>
      <div className={`text-[10px] ${sig ? (sig.side === "BUY" ? "text-bull" : "text-bear") : "text-muted-foreground"}`}>{sig ? sig.type : candles ? "scanning" : "—"}</div>
    </td>
  );
}

function SignalTable({ signals }: { signals: Signal[] }) {
  if (!signals.length) return <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No patterns yet — scanner is watching.</p>;
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
              <td className="px-3 py-2">{s.type} <span className="text-muted-foreground">L{s.legoutIndex}</span></td>
              <td className={`px-3 py-2 font-semibold ${s.side === "BUY" ? "text-bull" : "text-bear"}`}>{s.side} LMT</td>
              <td className="px-3 py-2">{s.boringHigh.toFixed(d)}</td>
              <td className="px-3 py-2">{s.boringLow.toFixed(d)}</td>
              <td className="px-3 py-2 text-primary">{s.limit.toFixed(d)}</td>
              <td className="px-3 py-2 text-bear">{s.sl.toFixed(d)}</td>
              <td className="px-3 py-2 text-bull">{s.tp.toFixed(d)}</td>
              <td className="px-3 py-2">1:{s.rr}</td>
              <td className="px-3 py-2 text-muted-foreground">{gradeBody(Math.min(s.bodyRatioLegin, s.bodyRatioLegout))}</td>
              <td className="px-3 py-2"><Badge variant={s.status === "FILLED" ? "default" : "secondary"}>{s.status}</Badge></td>
            </tr>); })}
        </tbody>
      </table>
    </div>
  );
}

function DeployTab({ files }: { files: Record<string, string> }) {
  const names = Object.keys(files);
  const [sel, setSel] = useState<string>(names[0]!);
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
