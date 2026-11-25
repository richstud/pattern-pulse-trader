import { z } from "zod";
import type { Signal } from "./patterns";

const heartbeatSchema = z.object({
  connected: z.boolean(), updated_at: z.string().optional(), env: z.enum(["demo", "live"]).optional(),
  account_id: z.union([z.string(), z.number()]).optional(), detail: z.string(),
});
const configSchema = z.object({ watchlist: z.record(z.array(z.string())), reward_risk: z.number().optional() });
const signalSchema = z.object({
  id: z.number(), created_at: z.string(), symbol: z.string(), timeframe: z.string(),
  code: z.enum(["RBR", "DBR", "DBD", "RBD"]), side: z.enum(["BUY", "SELL"]),
  boring_high: z.coerce.number(), boring_low: z.coerce.number(), limit_price: z.coerce.number(),
  sl: z.coerce.number(), tp: z.coerce.number(), status: z.string(), note: z.string().nullable(),
});
export type Heartbeat = z.infer<typeof heartbeatSchema>;
export type DisplaySignal = Omit<Signal, "status" | "legoutIndex" | "bodyRatioLegin" | "bodyRatioLegout"> & {
  status: string; legoutIndex?: 1 | 2 | 3; bodyRatioLegin?: number; bodyRatioLegout?: number; note?: string;
};
export function timeframeLabel(tf: string): string {
  const match = /^([SMHDW])(\d+)$/.exec(tf);
  if (!match) return tf;
  const units: Record<string, string> = { S: "SEC", M: "MIN", H: "HR", D: "D", W: "WK" };
  return `${match[2]} ${units[match[1] ?? ""] ?? tf}`;
}
export function heartbeatFresh(heartbeat: Heartbeat, now = Date.now()) {
  const timestamp = Date.parse(heartbeat.updated_at ?? "");
  return heartbeat.connected && Number.isFinite(timestamp) && now - timestamp < 90_000 && timestamp <= now + 10_000;
}
export function apiBase(value: string, origin: string) {
  const url = new URL(value.replace(/\/$/, "") + "/", origin);
  if (url.username || url.password || url.search || url.hash) throw new Error("Use an API URL without passwords, queries, or fragments.");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Use an HTTPS API URL.");
  if (origin.startsWith("https:") && url.protocol === "http:") throw new Error("HTTPS cannot connect directly to the HTTP VPS. Use /api on Netlify, or an HTTPS VPS address.");
  return url.href;
}
export async function readVps(base: string, key: string, signal: AbortSignal) {
  if (!key.trim()) throw new Error("Enter your VPS API key.");
  const root = apiBase(base, window.location.origin);
  async function read(path: string) {
    const response = await fetch(root + path, { headers: { "X-API-Key": key.trim() }, signal, cache: "no-store", credentials: "omit", redirect: "error" });
    if (response.status === 401) throw new Error("API key rejected. Check the VPS API key and recreate the API container after changing it.");
    if (response.status === 404) throw new Error("VPS API not found. /api works on the Netlify site only; this preview needs an HTTPS VPS address.");
    if (!response.ok) throw new Error(`VPS request failed (${response.status}).`);
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("application/json")) throw new Error("No VPS API at this address. /api works on Netlify only; this preview needs an HTTPS VPS address.");
    return response.json();
  }
  const [status, config, rows] = await Promise.all([read("status"), read("config"), read("signals?limit=100")]);
  const heartbeat = heartbeatSchema.parse(status);
  const watchlist = configSchema.parse(config).watchlist;
  const signals: DisplaySignal[] = z.array(signalSchema).parse(rows).map(row => ({
    id: `vps-${row.id}`, symbol: row.symbol, tf: timeframeLabel(row.timeframe), type: row.code, side: row.side,
    boringHigh: row.boring_high, boringLow: row.boring_low, limit: row.limit_price, sl: row.sl, tp: row.tp,
    rr: Math.abs(row.limit_price - row.sl) ? Number((Math.abs(row.tp - row.limit_price) / Math.abs(row.limit_price - row.sl)).toFixed(2)) : 0,
    time: Date.parse(row.created_at), status: row.status.toUpperCase(), note: row.note ?? "",
  }));
  return { heartbeat, watchlist, signals };
}