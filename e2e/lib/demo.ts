import { readFileSync } from "node:fs";
import type { APIRequestContext } from "@playwright/test";
import { buildExhibits, type Exhibit } from "../../apps/site/src/projects/lazaret/data/exhibits";
import { operatorToken } from "./env";

// A client for the deployed demo that behaves like the gleator.com console
// (apps/site/src/lib/demo.ts): a demo pass, persona logins, the same canned exhibits
// from the eval corpus, receipts followed until they settle.

const corpus = (name: string) =>
  readFileSync(new URL(`../../evals/corpus/${name}`, import.meta.url), "utf8");
export const EXHIBITS: Exhibit[] = buildExhibits([corpus("attacks.jsonl"), corpus("benign.jsonl")]);
export const exhibit = (id: string): Exhibit => {
  const x = EXHIBITS.find((e) => e.id === id);
  if (!x) throw new Error(`no exhibit ${id}`);
  return x;
};

const PERSONAS = { theo: "theo@tidewater.test", sam: "sam@tidewater.test" } as const;
/** The seeded accounts' public demo password (apps/demo-origin/migrations/0002_seed.sql). */
const DEMO_PASSWORD = "tidewater-demo";

export interface Sent {
  status: number;
  receipt: string | null;
  requestId: string | null;
  review: string | null;
  error: string | null;
}

export type Final = "COMMITTED" | "DROPPED" | "QUARANTINED";

export class Demo {
  #pass = "";
  readonly #tokens = new Map<string, string>();
  constructor(private readonly api: APIRequestContext) {}

  async start(): Promise<void> {
    const res = await this.api.post("/demo/pass", {
      headers: { authorization: `Bearer ${operatorToken()}` },
    });
    if (res.status() !== 200) throw new Error(`demo pass: HTTP ${res.status()}`);
    this.#pass = ((await res.json()) as { pass: string }).pass;
  }

  async login(persona: keyof typeof PERSONAS): Promise<string> {
    const cached = this.#tokens.get(persona);
    if (cached) return cached;
    const res = await this.send("POST", "/api/login", {
      body: JSON.stringify({ email: PERSONAS[persona], password: DEMO_PASSWORD }),
    });
    const token = (res.json as { token?: string } | null)?.token;
    if (res.status !== 200 || !token) throw new Error(`login ${persona}: HTTP ${res.status}`);
    this.#tokens.set(persona, token);
    return token;
  }

  async send(
    method: string,
    path: string,
    { token, body }: { token?: string; body?: string } = {},
  ): Promise<Sent & { json: unknown }> {
    const res = await this.api.fetch(path, {
      method,
      headers: {
        "x-demo-pass": this.#pass,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { data: body } : {}),
    });
    const json = await res.json().catch(() => null);
    const h = res.headers();
    return {
      status: res.status(),
      receipt: h["x-lazaret-receipt"] ?? null,
      requestId: h["x-lazaret-request-id"] ?? null,
      review: h["x-lazaret-review"] ?? null,
      error: (json as { error?: string } | null)?.error ?? null,
      json,
    };
  }

  /** Fire an exhibit the way the console does, filling `{receipt:N}` and `{n}`. */
  async fire(x: Exhibit): Promise<Sent[]> {
    const token = await this.login(x.persona);
    const receipts: string[] = [];
    const out: Sent[] = [];
    for (const step of x.steps) {
      for (let n = 1; n <= (step.repeat ?? 1); n++) {
        const path = step.path.replace(
          /\{receipt:(\d+)\}/g,
          (_, i) => receipts[Number(i)] ?? "missing",
        );
        const sent = await this.send(step.method, path, {
          ...(path === "/api/login" ? {} : { token }),
          ...(step.bodyText !== undefined
            ? { body: step.bodyText.replaceAll("{n}", String(n)) }
            : {}),
        });
        if (sent.receipt) receipts.push(sent.receipt);
        out.push(sent);
      }
    }
    return out;
  }

  /** Follow an escrow receipt (as its author) until the Ledger settles it. */
  async settle(
    receipt: string,
    persona: keyof typeof PERSONAS,
    timeoutMs = 180_000,
  ): Promise<Final> {
    const token = await this.login(persona);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await this.api.get(`/__lazaret/receipts/${receipt}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.ok()) {
        const { status } = (await res.json()) as { status: string };
        if (status === "COMMITTED" || status === "DROPPED" || status === "QUARANTINED")
          return status;
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
    throw new Error(`receipt ${receipt} did not settle in ${timeoutMs / 1000} s`);
  }
}
