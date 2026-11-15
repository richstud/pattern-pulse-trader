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
  for (let k = start; k < i; k++) { sum += trueRange(candles[k], candles[k - 1]); n++; }
  return n ? sum / n : trueRange(candles[i]);
}

/** Body share of the full range (0..1). 0.6 => body:wick 60:40. */
export const bodyRatio = (c: Candle) => (c.h - c.l === 0 ? 0 : Math.abs(c.c - c.o) / (c.h - c.l));
export const MIN_BODY_RATIO = 0.6;
export const gradeBody = (r: number) => (r >= 0.8 ? "Perfect" : r >= 0.7 ? "Average" : r >= 0.6 ? "Normal" : "Weak");

/** Legin–Boring–Legout check for a pattern whose legin is at index i. */
export function detectAt(candles: Candle[], i: number, rrMultiple = 2, period = 14) {
  const legin = candles[i], base = candles[i + 1];
  if (!legin || !base || i < 1) return null;
  const trIn = trueRange(legin, candles[i - 1]);
  const trBase = trueRange(base, legin);
  if (!(trIn > atrAt(candles, i, period)) || bodyRatio(legin) < MIN_BODY_RATIO) return null;
  if (!(trBase < atrAt(candles, i + 1, period))) return null;
  if (bodyRatio(base) >= 0.5) return null; // boring body must be small
  if (trIn < 2 * trBase) return null;
  if (!(legin.v > base.v)) return null;
  for (let k = 1 as 1 | 2 | 3; k <= 3; k = (k + 1) as 1 | 2 | 3) {
    const out = candles[i + 1 + k];
    if (!out) break;
    const trOut = trueRange(out, candles[i + k]);
    if (trOut > atrAt(candles, i + 1 + k, period) && bodyRatio(out) >= MIN_BODY_RATIO && trOut >= 2 * trIn && out.v > legin.v) {
      const inUp = legin.c > legin.o, outUp = out.c > out.o;
      const type: PatternType = outUp ? (inUp ? "RBR" : "DBR") : inUp ? "RBD" : "DBD";
      return { ...orderLevels(type, base.h, base.l, rrMultiple), type, boringHigh: base.h, boringLow: base.l,
        bodyRatioLegin: bodyRatio(legin), bodyRatioLegout: bodyRatio(out), legoutIndex: k, time: out.t };
    }
    if (k === 3) break;
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
export function scanLatest(candles: Candle[], rrMultiple = 2) {
  for (let i = candles.length - 3; i >= Math.max(1, candles.length - 8); i--) {
    const r = detectAt(candles, i, rrMultiple);
    if (r) return r;
  }
  return null;
}
