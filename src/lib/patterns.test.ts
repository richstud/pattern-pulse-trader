import { describe, it, expect } from "vitest";
import { detectAt, orderLevels, type Candle } from "./patterns";

const flat = (n: number): Candle[] => Array.from({ length: n }, (_, i) => ({ t: i, o: 100, h: 101, l: 99, c: 100.2, v: 100 }));
const build = (leginUp: boolean, outUp: boolean, outVol = 400) => {
  const c = flat(20);
  c.push(leginUp ? { t: 20, o: 100, h: 104.2, l: 99.8, c: 104, v: 200 } : { t: 20, o: 100, h: 100.2, l: 95.8, c: 96, v: 200 });
  const b = c[20]!.c;
  c.push({ t: 21, o: b, h: b + 1, l: b - 1, c: b + 0.2, v: 120 });
  c.push(outUp ? { t: 22, o: b, h: b + 9.2, l: b - 0.2, c: b + 9, v: outVol } : { t: 22, o: b, h: b + 0.2, l: b - 9.2, c: b - 9, v: outVol });
  return c;
};

describe("Legin-Boring-Legout", () => {
  it("detects Rally-Base-Rally as BUY with limit=boring high, SL=boring low", () => {
    const r = detectAt(build(true, true), 20)!;
    expect(r.type).toBe("RBR");
    expect(r.side).toBe("BUY");
    expect(r.limit).toBe(105); expect(r.sl).toBe(103);
  });
  it("detects Drop-Base-Drop as SELL with limit=boring low, SL=boring high", () => {
    const r = detectAt(build(false, false), 20)!;
    expect(r.type).toBe("DBD");
    expect(r.limit).toBe(95); expect(r.sl).toBe(97);
  });
  it("detects DBR and RBD", () => {
    expect(detectAt(build(false, true), 20)!.type).toBe("DBR");
    expect(detectAt(build(true, false), 20)!.type).toBe("RBD");
  });
  it("rejects when legout volume is not above legin volume", () => {
    expect(detectAt(build(true, true, 150), 20)).toBeNull();
  });
  it("rejects legin with wick over 40%", () => {
    const c = build(true, true);
    c[20] = { ...c[20]!, h: 108 };
    expect(detectAt(c, 20)).toBeNull();
  });
  it("order levels for bearish", () => {
    expect(orderLevels("RBD", 10, 8, 2)).toMatchObject({ side: "SELL", limit: 8, sl: 10, tp: 4 });
  });
});
