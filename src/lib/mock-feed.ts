import type { Candle } from "./patterns";

export const SYMBOLS = ["US100", "EURUSD", "GBPUSD", "XAUUSD", "US500", "BTCUSD", "USDJPY", "AUDUSD", "US30", "GER40", "ETHUSD", "XAGUSD"];
export const TIMEFRAMES = ["15 SEC", "30 SEC", "45 SEC", "1 MIN", "3 MIN", "5 MIN", "15 MIN", "30 MIN", "45 MIN", "75 MIN", "125 MIN", "1 HR", "2 HR", "4 HR", "1 D"];
export const MAX_SYMBOLS = 6;
export const MAX_TIMEFRAMES = 13;

const BASE: Record<string, number> = { US100: 20850, EURUSD: 1.0842, GBPUSD: 1.2715, XAUUSD: 2385, US500: 5820, BTCUSD: 91250, USDJPY: 151.2, AUDUSD: 0.6612, US30: 43100, GER40: 19200, ETHUSD: 3150, XAGUSD: 29.4 };
export const digits = (s: string) => (["EURUSD", "GBPUSD", "AUDUSD"].includes(s) ? 5 : s === "USDJPY" ? 3 : 2);

export function seedCandles(symbol: string, n = 40): Candle[] {
  const p = BASE[symbol] ?? 100;
  const out: Candle[] = [];
  let last = p;
  for (let i = 0; i < n; i++) { const c = randomCandle(last, p * 0.0008, i); out.push(c); last = c.c; }
  return out;
}

function randomCandle(prev: number, vol: number, t: number): Candle {
  const o = prev, c = o + (Math.random() - 0.5) * vol * 1.4;
  return { t, o, c, h: Math.max(o, c) + Math.random() * vol * 0.6, l: Math.min(o, c) - Math.random() * vol * 0.6, v: 80 + Math.random() * 60 };
}

/** Advance a series by one tick; occasionally injects a Legin-Boring-Legout sequence. */
export function advance(series: Candle[], symbol: string, injectChance = 0.03): Candle[] {
  const p = BASE[symbol] ?? 100, vol = p * 0.0008;
  const last = series[series.length - 1]!;
  let t = last.t + 1;
  const add: Candle[] = [];
  if (Math.random() < injectChance) {
    const inUp = Math.random() > 0.5, outUp = Math.random() > 0.5, u = vol * 1.1;
    const o1 = last.c, c1 = o1 + (inUp ? 1 : -1) * u * 2.6;
    add.push({ t: t++, o: o1, c: c1, h: Math.max(o1, c1) + u * 0.1, l: Math.min(o1, c1) - u * 0.1, v: 220 });
    add.push({ t: t++, o: c1, c: c1 + u * 0.15, h: c1 + u * 0.6, l: c1 - u * 0.6, v: 130 });
    const o3 = c1, c3 = o3 + (outUp ? 1 : -1) * u * 6;
    add.push({ t: t++, o: o3, c: c3, h: Math.max(o3, c3) + u * 0.1, l: Math.min(o3, c3) - u * 0.1, v: 420 });
  } else add.push(randomCandle(last.c, vol, t));
  return [...series, ...add].slice(-60);
}
