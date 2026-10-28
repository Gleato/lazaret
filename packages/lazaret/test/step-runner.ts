import type { StepOptions, StepRunner } from "../src";

/** Thrown to simulate the Worker dying between a step's work and its checkpoint. */
export class Crash extends Error {}

/**
 * In-memory stand-in for Cloudflare Workflows' step semantics: completed steps
 * are memoised by name and never re-run, failed steps retry up to `retries`, and
 * a "crash" can be injected after a step's work but *before* it checkpoints, which
 * is the window where at-least-once execution bites.
 */
export class MemoryStepRunner implements StepRunner {
  readonly memo = new Map<string, unknown>();
  readonly completed: string[] = [];
  readonly sleeps: [string, number][] = [];
  readonly crashBeforeCheckpoint = new Set<string>();

  async do<T>(name: string, fn: () => Promise<T>, options?: StepOptions): Promise<T> {
    if (this.memo.has(name)) return structuredClone(this.memo.get(name)) as T;
    let failures = 0;
    for (;;) {
      try {
        const result = await fn();
        if (this.crashBeforeCheckpoint.delete(name)) throw new Crash(`crashed in ${name}`);
        this.memo.set(name, structuredClone(result));
        this.completed.push(name);
        return result;
      } catch (err) {
        if (err instanceof Crash || failures++ >= (options?.retries ?? 0)) throw err;
      }
    }
  }

  async sleep(name: string, ms: number): Promise<void> {
    if (this.memo.has(name)) return;
    this.sleeps.push([name, ms]);
    this.memo.set(name, null);
  }
}
