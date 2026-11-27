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

/** Legin–Boring–Legout check for a pattern whose legin is at index i.
 *  Base = 1..3 consecutive boring candles; zone = highest high / lowest low of the base. */
export function detectAt(candles: Candle[], i: number, rrMultiple = 2, period = 14) {
  const legin = candles[i];
  if (!legin || i < 1) return null;
  const trIn = trueRange(legin, candles[i - 1]!);
  if (!(trIn > atrAt(candles, i, period)) || bodyRatio(legin) < MIN_BODY_RATIO) return null;
  let zoneH = -Infinity, zoneL = Infinity, maxTrBase = 0;
  for (let n = 1; n <= MAX_BORING; n++) {
    const bi = i + n, base = candles[bi];
    if (!base) return null;
    const trBase = trueRange(base, candles[bi - 1]!);
    if (!(trBase < atrAt(candles, bi, period)) || bodyRatio(base) >= BORING_MAX_BODY || !(legin.v > base.v)) return null;
    zoneH = Math.max(zoneH, base.h); zoneL = Math.min(zoneL, base.l); maxTrBase = Math.max(maxTrBase, trBase);
    if (trIn < 2 * maxTrBase) return null;
    {
      const k = n as 1 | 2 | 3; // legout comes right after the base: 1st, 2nd or 3rd candle after the legin's base start
      const oi = bi + 1, out = candles[oi];
      if (!out) return null;
      const trOut = trueRange(out, candles[oi - 1]!);
      if (trOut > atrAt(candles, oi, period) && bodyRatio(out) >= MIN_BODY_RATIO && trOut >= 2 * trIn && out.v > legin.v) {
        const inUp = legin.c > legin.o, outUp = out.c > out.o;
        const type: PatternType = outUp ? (inUp ? "RBR" : "DBR") : inUp ? "RBD" : "DBD";
        return { ...orderLevels(type, zoneH, zoneL, rrMultiple), type, boringHigh: zoneH, boringLow: zoneL, boringCount: n,
          bodyRatioLegin: bodyRatio(legin), bodyRatioLegout: bodyRatio(out), legoutIndex: k, time: out.t };
      }
    }
  }
  return null;
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
