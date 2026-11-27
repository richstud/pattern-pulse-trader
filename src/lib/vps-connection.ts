import { heartbeatFresh, type Heartbeat } from "./vps-feed";

export type VpsConnection = { url: string; key: string };
export const CONNECTION_STORAGE_KEY = "lbl-vps-connection";

export function restoreConnection(storage: Storage): VpsConnection | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(CONNECTION_STORAGE_KEY) ?? "null");
    if (!value || typeof value !== "object" || !("url" in value) || !("key" in value)) return null;
    if (typeof value.url !== "string" || typeof value.key !== "string" || !value.key.trim()) return null;
    return { url: value.url, key: value.key };
  } catch { return null; }
}

export function rememberConnection(storage: Storage, connection: VpsConnection) {
  storage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(connection));
}

export function connectionIssue(error: unknown, aborted: boolean): string {
  if (aborted || (error instanceof Error && error.name === "AbortError")) return "VPS response timed out. Reconnecting automatically…";
  if (error instanceof TypeError) return "Cannot reach the VPS. Check its network connection. Reconnecting automatically…";
  if (error instanceof Error && error.name !== "ZodError") return `${error.message} Retrying automatically…`;
  return "Unexpected VPS response. Check the API address and server version. Retrying automatically…";
}

export function scannerState(healthy: boolean, running: boolean, pattern?: string): string {
  return !healthy ? "OFFLINE" : !running ? "PAUSED" : pattern ?? "SCANNING";
}

/** A single timeout must not invalidate a still-fresh heartbeat. */
export function reportFailure(heartbeat: Heartbeat | null, failures: number, now = Date.now()) {
  return !heartbeat || !heartbeatFresh(heartbeat, now) || failures >= 2;
}

export function startVpsPolling<T>(options: {
  read: (signal: AbortSignal) => Promise<T>;
  onResult: (result: T) => void;
  onError: (error: unknown, aborted: boolean) => void;
}) {
  let disposed = false;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function poll() {
    const request = new AbortController();
    controller = request;
    const timeout = setTimeout(() => request.abort(), 12_000);
    try {
      const result = await options.read(request.signal);
      if (!disposed) options.onResult(result);
    } catch (error) {
      if (!disposed) options.onError(error, request.signal.aborted);
    } finally {
      clearTimeout(timeout);
      if (!disposed) timer = setTimeout(poll, 5_000);
    }
  }
  void poll();
  return () => { disposed = true; controller?.abort(); clearTimeout(timer); };
}