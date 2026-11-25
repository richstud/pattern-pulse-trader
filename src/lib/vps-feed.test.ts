import { describe, expect, it } from "vitest";
import { apiBase, heartbeatFresh, timeframeLabel } from "./vps-feed";

describe("VPS connection safety", () => {
  it("rejects HTTP VPS credentials from an HTTPS dashboard", () => {
    expect(() => apiBase("http://103.77.155.79:8000", "https://scanner.netlify.app")).toThrow("HTTPS");
  });
  it("resolves the Netlify proxy without a function", () => {
    expect(apiBase("/api", "https://scanner.netlify.app")).toBe("https://scanner.netlify.app/api/");
  });
  it("never calls a stale heartbeat connected", () => {
    const now = Date.parse("2026-11-25T19:25:00Z");
    expect(heartbeatFresh({ connected: true, updated_at: "2026-11-25T19:23:00Z", detail: "ready" }, now)).toBe(false);
    expect(heartbeatFresh({ connected: true, updated_at: "2026-11-25T19:24:45Z", detail: "ready" }, now)).toBe(true);
  });
  it("maps second and custom periods without dropping them", () => {
    expect(timeframeLabel("S15")).toBe("15 SEC");
    expect(timeframeLabel("M125")).toBe("125 MIN");
    expect(timeframeLabel("H2")).toBe("2 HR");
  });
});
import { timeframeCode } from "./vps-feed";
describe("timeframeCode", () => {
  it("maps dashboard labels to VPS engine codes", () => {
    expect(timeframeCode("15 SEC")).toBe("S15");
    expect(timeframeCode("125 MIN")).toBe("M125");
    expect(timeframeCode("2 HR")).toBe("H2");
    expect(timeframeCode("1 D")).toBe("D1");
  });
  it("rejects timeframes the engine cannot scan", () => {
    expect(timeframeCode("1 MN")).toBeNull();
  });
});
