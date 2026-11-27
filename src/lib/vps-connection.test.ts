import { afterEach, describe, expect, it, vi } from "vitest";
import { SIGNAL_MAX_AGE_MS, CONNECTION_STORAGE_KEY, rememberConnection, restoreConnection, reportFailure, scannerState, startVpsPolling } from "./vps-connection";
import { heartbeatFresh } from "./vps-feed";

afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

describe("remembered VPS connection", () => {
  it("restores the API key and address for reconnecting without another prompt", () => {
    rememberConnection(localStorage, { url: "/api", key: "test-only-key" });
    expect(restoreConnection(localStorage)).toEqual({ url: "/api", key: "test-only-key" });
  });
  it("forgets the key on disconnect", () => {
    rememberConnection(localStorage, { url: "/api", key: "test-only-key" });
    localStorage.removeItem(CONNECTION_STORAGE_KEY);
    expect(restoreConnection(localStorage)).toBeNull();
  });
  it("does not reconnect with corrupted or empty stored credentials", () => {
    localStorage.setItem(CONNECTION_STORAGE_KEY, "bad json");
    expect(restoreConnection(localStorage)).toBeNull();
    localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify({ url: "/api", key: " " }));
    expect(restoreConnection(localStorage)).toBeNull();
  });
});

describe("continuous VPS polling", () => {
  it("retries after a 12-second timeout with a fresh non-aborted request", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const read = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      if (signals.length === 1) return new Promise<string>((_, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("", "AbortError")));
      });
      return Promise.resolve("recovered");
    });
    const onResult = vi.fn(); const onError = vi.fn();
    const stop = startVpsPolling({ read, onResult, onError });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(onResult).toHaveBeenCalledWith("recovered");
    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("cancels a pending request without publishing an error or retrying after disconnect", async () => {
    vi.useFakeTimers();
    const read = vi.fn((signal: AbortSignal) => new Promise<string>((_, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("", "AbortError")));
    }));
    const onError = vi.fn();
    const stop = startVpsPolling({ read, onResult: vi.fn(), onError });
    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onError).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("ignores one transient failure while healthy, but reports repeated failures or a stale engine", () => {
    const now = Date.parse("2026-11-27T08:00:00Z");
    const heartbeat = { connected: true, updated_at: "2026-11-27T07:59:45Z", detail: "ready" };
    expect(reportFailure(heartbeat, 1, now)).toBe(false);
    expect(reportFailure(heartbeat, 2, now)).toBe(true);
    expect(reportFailure(heartbeat, 1, now + 90_000)).toBe(true);
    expect(reportFailure(null, 1, now)).toBe(true);
  });
});

describe("scanner health", () => {
  it("scans or shows a found pattern only when the VPS is healthy", () => {
    expect(scannerState(true, true)).toBe("SCANNING");
    expect(scannerState(true, true, "DBR")).toBe("DBR");
    expect(scannerState(false, true, "DBR")).toBe("OFFLINE");
    expect(scannerState(true, false, "DBR")).toBe("PAUSED");
  });
  it("turns an expired heartbeat offline at 90 seconds", () => {
    const start = Date.parse("2026-11-27T08:00:00Z");
    const heartbeat = { connected: true, updated_at: "2026-11-27T08:00:00Z", detail: "ready" };
    expect(scannerState(heartbeatFresh(heartbeat, start + 89_999), true)).toBe("SCANNING");
    expect(scannerState(heartbeatFresh(heartbeat, start + 90_000), true)).toBe("OFFLINE");
  });
});

describe("signal aging", () => {
  it("shows a pattern until it is 2 hours old, then reverts to SCANNING", () => {
    const t = Date.parse("2026-11-26T16:21:00Z");
    expect(scannerState(true, true, "RBR", t, t + SIGNAL_MAX_AGE_MS - 1)).toBe("RBR");
    expect(scannerState(true, true, "RBR", t, t + SIGNAL_MAX_AGE_MS)).toBe("SCANNING");
  });
});
