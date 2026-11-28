export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
export type PatternType = "RBR" | "DBR" | "DBD" | "RBD";
export type Signal = {
  id: string; symbol: string; tf: string; type: PatternType; side: "BUY" | "SELL";
  boringHigh: number; boringLow: number; limit: number; sl: number; tp: number; rr: number;
  bodyRatioLegin: number; bodyRatioLegout: number; legoutIndex: 1 | 2 | 3; time: number;
  status: "PENDING" | "PLACED" | "FILLED" | "REJECTED";
};

export const trueRange = (c: Candle, prev?: Candle) =>
  prev ? Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c)) : c.h - c.l;

/** Average True Range of the `period` candles ending before index `i`. */
export function atrAt(candles: Candle[], i: number, period = 14): number {
  const start = Math.max(1, i - period);
  let sum = 0, n = 0;
  for (let k = start; k < i; k++) { sum += trueRange(candles[k]!, candles[k - 1]); n++; }
  return n ? sum / n : trueRange(candles[i]!);
}

/** Body share of the full range (0..1). 0.6 => body:wick 60:40. */
export const bodyRatio = (c: Candle) => (c.h - c.l === 0 ? 0 : Math.abs(c.c - c.o) / (c.h - c.l));
export const MIN_BODY_RATIO = 0.6;
export const gradeBody = (r: number) => (r >= 0.8 ? "Perfect" : r >= 0.7 ? "Average" : r >= 0.6 ? "Normal" : "Weak");

export const ATR_PERIODS = [14, 100] as const;
export const MAX_BORING = 3;
export const BORING_MAX_BODY = 0.5;

/** Candle size = wick to wick (high - low). */
export const candleSize = (c: Candle) => c.h - c.l;
export const MAX_LEGOUT = 3;
export const LEGOUT_GAP = 0.001; // next legout open within 0.1% of previous legout close

export type Rejection = {
  reason: string; boringCount: number; legoutCount: number; leginTime: number; time: number; endIndex: number;
  trLegin: number; atrLegin: number;
};

/** Full Legin–Boring–Legout evaluation for a legin at index i.
 *  null = no legin + boring candidate; otherwise a passed signal or a rejection with its reason.
 *  Base = 1..3 small-body candles, each TR < ATR. Legout = 1..3 candles, each TR > ATR, same direction,
 *  opening within 0.1% of the previous close; cumulative size must reach 2x legin size. */
export function evaluateAt(candles: Candle[], i: number, rrMultiple = 2, period = 14) {
  const legin = candles[i];
  if (!legin || i < 1) return null;
  const trIn = trueRange(legin, candles[i - 1]!), atrIn = atrAt(candles, i, period);
  if (!(trIn > atrIn) || bodyRatio(legin) < MIN_BODY_RATIO) return null;
  const sizeIn = candleSize(legin);
  let n = 0;
  while (candles[i + n + 1] && bodyRatio(candles[i + n + 1]!) < BORING_MAX_BODY) n++;
  if (n === 0) return null;
  const fail = (reason: string, endIndex: number, legoutCount = 0) => ({ ok: false as const, rejection: {
    reason, boringCount: Math.min(n, MAX_BORING), legoutCount, leginTime: legin.t, time: candles[endIndex]!.t, endIndex, trLegin: trIn, atrLegin: atrIn } });
  if (!candles[i + n + 1]) return null; // base still forming
  if (n > MAX_BORING) return fail(`${n} boring candles (max ${MAX_BORING})`, i + MAX_BORING + 1);
  let zoneH = -Infinity, zoneL = Infinity;
  for (let k = 1; k <= n; k++) {
    const bi = i + k, b = candles[bi]!;
    const tr = trueRange(b, candles[bi - 1]!), atr = atrAt(candles, bi, period);
    if (!(tr < atr)) return fail(`Boring #${k} TR ${tr.toFixed(5)} ≥ ATR ${atr.toFixed(5)}`, bi);
    if (!(legin.v > b.v)) return fail(`Boring #${k} volume not below legin volume`, bi);
    if (sizeIn < 2 * candleSize(b)) return fail(`Legin size not 2× boring #${k} size`, bi);
    zoneH = Math.max(zoneH, b.h); zoneL = Math.min(zoneL, b.l);
  }
  const start = i + n + 1;
  const up = candles[start]!.c > candles[start]!.o;
  let total = 0;
  for (let k = 1; k <= MAX_LEGOUT; k++) {
    const oi = start + k - 1, out = candles[oi];
    if (!out) return null; // legout still forming
    if (k > 1) {
      const prev = candles[oi - 1]!;
      if ((out.c > out.o) !== up || Math.abs(out.o - prev.c) > LEGOUT_GAP * prev.c)
        return fail(`Legout size ${total.toFixed(5)} < 2× legin ${sizeIn.toFixed(5)} (legout #${k} not a continuation)`, oi, k - 1);
    }
    const tr = trueRange(out, candles[oi - 1]!), atr = atrAt(candles, oi, period);
    if (!(tr > atr)) return fail(`Legout #${k} TR ${tr.toFixed(5)} < ATR ${atr.toFixed(5)}`, oi, k);
    if (bodyRatio(out) < MIN_BODY_RATIO) return fail(`Legout #${k} body ${(bodyRatio(out) * 100).toFixed(0)}% < 60%`, oi, k);
    if (!(out.v > legin.v)) return fail(`Legout #${k} volume not above legin volume`, oi, k);
    total += candleSize(out);
    if (total >= 2 * sizeIn) {
      const inUp = legin.c > legin.o;
      const type: PatternType = up ? (inUp ? "RBR" : "DBR") : inUp ? "RBD" : "DBD";
      return { ok: true as const, signal: { ...orderLevels(type, zoneH, zoneL, rrMultiple), type, boringHigh: zoneH, boringLow: zoneL, boringCount: n,
        bodyRatioLegin: bodyRatio(legin), bodyRatioLegout: bodyRatio(candles[start]!), legoutIndex: k as 1 | 2 | 3, time: out.t, endIndex: oi } };
    }
  }
  return fail(`Legout size ${total.toFixed(5)} < 2× legin ${sizeIn.toFixed(5)} after ${MAX_LEGOUT} candles`, start + MAX_LEGOUT - 1, MAX_LEGOUT);
}

export function detectAt(candles: Candle[], i: number, rrMultiple = 2, period = 14) {
  const r = evaluateAt(candles, i, rrMultiple, period);
  return r?.ok ? r.signal : null;
}

/** Rejections decided on the newest candle (so each is reported once as candles arrive). */
export function rejectionsLatest(candles: Candle[], rrMultiple = 2, period = 14): Rejection[] {
  const last = candles.length - 1, out: Rejection[] = [];
  for (let i = last - 1; i >= Math.max(1, last - MAX_BORING - MAX_LEGOUT - 1); i--) {
    const r = evaluateAt(candles, i, rrMultiple, period);
    if (r && !r.ok && r.rejection.endIndex === last) out.push(r.rejection);
  }
  return out;
}

export function orderLevels(type: PatternType, boringHigh: number, boringLow: number, rrMultiple = 2) {
  const bull = type === "RBR" || type === "DBR";
  const limit = bull ? boringHigh : boringLow;
  const sl = bull ? boringLow : boringHigh;
  const risk = Math.abs(limit - sl);
  const tp = bull ? limit + risk * rrMultiple : limit - risk * rrMultiple;
  return { side: (bull ? "BUY" : "SELL") as "BUY" | "SELL", limit, sl, tp, rr: rrMultiple };
}

/** Scan the most recent candles; returns the latest completed pattern if any. */
export function scanLatest(candles: Candle[], rrMultiple = 2, period = 14) {
  for (let i = candles.length - 3; i >= Math.max(1, candles.length - 10); i--) {
    const r = detectAt(candles, i, rrMultiple, period);
    if (r) return r;
  }
  return null;
}
