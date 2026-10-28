import type { LiveFrame } from "@gleator/lazaret/public";

// How the site talks to the Tidewater demo (apps/demo-lazaret): plain HTTP for the
// console and the read-only views, one WebSocket for the live ledger. The demo's
// address is a build-time setting, so moving it (M8) is configuration, not code.

export const DEMO_ORIGIN: string =
  (import.meta.env.PUBLIC_DEMO_ORIGIN as string | undefined) ?? "http://localhost:8787";

export interface DemoStatus {
  shard: string;
  budget: { spentUsd: number; capUsd: number; exhausted: boolean; resetsAt: number };
  inline: {
    total: number;
    degraded: number;
    unavailable: number;
    p50LatencyMs: number | null;
    timeoutMs: number;
  };
  head: number;
}

export interface DemoResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  json: Record<string, unknown> | null;
  ms: number;
}

let pass: string | null = null;
export const hasPass = () => pass !== null;

/** Exchange a Turnstile token for a 30-minute demo pass (apps/demo-lazaret guard.ts). */
export async function getPass(turnstileToken: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${DEMO_ORIGIN}/demo/pass`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: turnstileToken }),
  });
  const body = (await res.json().catch(() => ({}))) as { pass?: string; error?: string };
  if (res.ok && body.pass) {
    pass = body.pass;
    return { ok: true };
  }
  return { ok: false, error: body.error ?? `HTTP ${res.status}` };
}

export async function call(
  method: string,
  path: string,
  { token, body }: { token?: string | undefined; body?: string | undefined } = {},
): Promise<DemoResponse> {
  const started = performance.now();
  const res = await fetch(`${DEMO_ORIGIN}${path}`, {
    method,
    credentials: "include",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(pass ? { "x-demo-pass": pass } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });
  const ms = Math.round(performance.now() - started);
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {}
  if (res.status === 401 && json?.error === "demo_pass_required") pass = null;
  return { status: res.status, ok: res.ok, headers: res.headers, json, ms };
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${DEMO_ORIGIN}${path}`, { credentials: "omit" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * The live ledger. Reconnects with backoff, resuming after the last seq it saw; a
 * RESET frame (the hourly rollover) starts over from zero.
 */
export function connectLive(
  onFrames: (frames: LiveFrame[]) => void,
  onState: (state: "connecting" | "open" | "closed") => void,
  headSeq: () => number,
): () => void {
  let socket: WebSocket | null = null;
  let stopped = false;
  let delay = 1_000;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    if (stopped) return;
    onState("connecting");
    const url = new URL("/__lazaret/live", DEMO_ORIGIN);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("after", String(headSeq()));
    socket = new WebSocket(url);
    socket.addEventListener("open", () => {
      delay = 1_000;
      onState("open");
    });
    socket.addEventListener("message", (m) => {
      try {
        onFrames(JSON.parse(String(m.data)) as LiveFrame[]);
      } catch {
        // A frame we can't parse is skipped; the next reconnect replays from head.
      }
    });
    socket.addEventListener("close", () => {
      onState("closed");
      if (stopped) return;
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, 30_000);
    });
  };
  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    socket?.close();
  };
}
