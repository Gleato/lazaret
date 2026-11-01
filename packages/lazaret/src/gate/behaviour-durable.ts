import { DurableObject } from "cloudflare:workers";
import { type BehaviourSample, type BehaviourStore, MemoryBehaviourStore } from "./behaviour.ts";

// Behaviour samples shared through Durable Objects (M8, decision-log #4).
//
// The per-isolate store under-counts whenever Cloudflare spreads one client over
// several isolates, and a credential-stuffing swarm is exactly the client that gets
// spread. Here every key (`s:<session>`, `ip:<ip>`) also has a Durable Object holding
// the window that all isolates, in every location, record into.
//
// The gate never waits for it. Measured on the deployed demo (2026-11-01), awaiting
// the Durable Object behind a 25 ms deadline hit the deadline at p50 *and* p95: the
// lookup added 25 ms to every request and still fell back to the local view. So:
//
//   - the gate scores from the isolate's own samples merged with the last window the
//     Durable Object returned for that key (`#shared`), which costs no I/O;
//   - the sync runs in the background (`waitUntil`), and its answer becomes the
//     shared view for the key's next request in this isolate.
//
// The cross-isolate view therefore lags by one request per isolate. A swarm is many
// requests, so it is still counted; what it buys is a gate with no added latency.
//
// The Durable Object keeps its window in memory, not SQLite. A key under active
// traffic stays resident (eviction follows idleness), so persistence would only
// protect a window that is already going quiet, at the price of a storage write on
// every request.
//
// Status (origin's 401, Lazaret's 403) is known only after the response. `settle`
// sends it fire-and-forget, and the key's unsent statuses also ride along with its
// next sync (`setStatus` is idempotent), so a lost send is repaired.

const WINDOW_MS = 60_000;
const MAX_SAMPLES = 200;
/** Keys whose shared window or owed statuses this isolate remembers; LRU-bounded. */
const MAX_KEYS = 10_000;

interface StatusUpdate {
  id: string;
  status: number;
}

export class LazaretBehaviour<Env = unknown> extends DurableObject<Env> {
  #window: BehaviourSample[] = [];

  /**
   * Record one sample (plus any statuses the caller still owes) and return the
   * window. Ages samples out on the caller's clock (`sample.at`), the one the gate
   * scores with.
   */
  record(sample: BehaviourSample, statuses: StatusUpdate[] = []): BehaviourSample[] {
    if (typeof sample?.id !== "string" || !Number.isFinite(sample.at)) {
      throw new TypeError("behaviour sample needs an id and a time");
    }
    for (const u of statuses.slice(0, 50)) this.setStatus(u);
    if (!this.#window.some((s) => s.id === sample.id)) {
      this.#window.push({
        id: sample.id,
        at: sample.at,
        method: String(sample.method).slice(0, 16),
        path: String(sample.path).slice(0, 512),
        ...(sample.route === undefined ? {} : { route: String(sample.route).slice(0, 200) }),
        ...(sample.status === undefined ? {} : { status: sample.status }),
      });
    }
    const cutoff = sample.at - WINDOW_MS;
    this.#window = this.#window.filter((s) => s.at > cutoff).slice(-MAX_SAMPLES);
    return this.#window;
  }

  setStatus({ id, status }: StatusUpdate): void {
    if (typeof id !== "string" || !Number.isInteger(status)) return;
    const s = this.#window.find((x) => x.id === id);
    if (s) s.status = status;
  }
}

type BehaviourStub = Pick<LazaretBehaviour, "record" | "setStatus">;

export interface DurableBehaviourOptions {
  binding: string;
}

export class DurableBehaviourStore implements BehaviourStore {
  readonly #local = new MemoryBehaviourStore(WINDOW_MS, MAX_KEYS, MAX_SAMPLES);
  /** The last window each key's Durable Object returned to this isolate. */
  readonly #shared = new Map<string, BehaviourSample[]>();
  readonly #owed = new Map<string, StatusUpdate[]>();
  #warned = false;

  constructor(private readonly options: DurableBehaviourOptions) {}

  record(
    key: string,
    sample: BehaviourSample,
    env?: object,
    background?: (work: Promise<unknown>) => void,
  ): BehaviourSample[] {
    sample.id ??= crypto.randomUUID();
    const local = this.#local.record(key, sample);
    const view = merge(local, this.#shared.get(key) ?? [], sample.at);

    const stub = this.#stub(key, env);
    if (stub) {
      const owed = this.#owed.get(key) ?? [];
      const sync = Promise.resolve(stub.record(sample, owed)).then(
        (window) => {
          remember(this.#shared, key, window);
          // Only clear what was sent; statuses added meanwhile wait for the next sync.
          const left = (this.#owed.get(key) ?? []).filter((u) => !owed.includes(u));
          if (left.length) this.#owed.set(key, left);
          else this.#owed.delete(key);
        },
        (err: unknown) =>
          console.error(JSON.stringify({ lazaret: "behaviour_unavailable", error: String(err) })),
      );
      background?.(sync);
    }
    return view;
  }

  async settle(keys: string[], sample: BehaviourSample, env?: object): Promise<void> {
    if (sample.id === undefined || sample.status === undefined) return;
    const update = { id: sample.id, status: sample.status };
    await Promise.all(
      keys.map(async (key) => {
        const list = this.#owed.get(key) ?? [];
        list.push(update);
        remember(this.#owed, key, list.slice(-50));
        try {
          await this.#stub(key, env)?.setStatus(update);
        } catch {
          // Still owed: it rides along with this key's next sync.
        }
      }),
    );
  }

  #stub(key: string, env?: object): BehaviourStub | null {
    const ns = (env as Record<string, unknown> | undefined)?.[this.options.binding] as
      | DurableObjectNamespace<LazaretBehaviour>
      | undefined;
    if (!ns) {
      if (!this.#warned) {
        this.#warned = true;
        console.error(
          JSON.stringify({ lazaret: "behaviour_binding_missing", binding: this.options.binding }),
        );
      }
      return null;
    }
    return ns.get(ns.idFromName(key)) as unknown as BehaviourStub;
  }
}

/** Map insertion order doubles as an LRU: delete and reinsert, evict the oldest. */
function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_KEYS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/**
 * This isolate's samples plus the shared window, one copy per sample id, in time
 * order, inside the window. A sample in both is this isolate's own, and its object
 * is the one whose `status` the gateway sets, so the local copy wins.
 */
function merge(
  local: BehaviourSample[],
  shared: BehaviourSample[],
  now: number,
): BehaviourSample[] {
  const localIds = new Set(local.map((s) => s.id));
  const out = [...local];
  for (const s of shared) {
    if (s.id && !localIds.has(s.id) && s.at > now - WINDOW_MS) out.push(s);
  }
  return out.sort((a, b) => a.at - b.at).slice(-MAX_SAMPLES);
}
