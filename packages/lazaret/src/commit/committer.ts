import type { EntryState } from "../ledger/types";
import { signRequest } from "./sign";

// The Committer is the "hands" (principle 2): it replays approved entries to origin
// exactly as the client sent them, plus a signature. It makes no decisions; the
// verdict was already recorded in the Ledger before any commit starts.

export class TransientCommitError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransientCommitError";
  }
}

export interface CommitterOptions {
  origin: URL;
  secret: string;
  fetchOrigin?: (request: Request) => Promise<Response>;
  now?: () => number;
}

/** Join origin's base path with a request path, keeping origin's own prefix. */
export function originUrl(origin: URL, encodedPath: string, search: string): URL {
  const url = new URL(origin);
  url.pathname = url.pathname.replace(/\/$/, "") + encodedPath;
  url.search = search;
  return url;
}

export function decodeBody(entry: EntryState): Uint8Array | null {
  const { body, bodyEncoding } = entry.request;
  if (body === null) return null;
  if (bodyEncoding === "utf8") return new TextEncoder().encode(body);
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

export function createCommitter(options: CommitterOptions) {
  const fetchOrigin = options.fetchOrigin ?? ((r: Request) => fetch(r));
  const now = options.now ?? Date.now;

  return {
    /**
     * Send one entry to origin. Returns origin's status for any definitive answer
     * (2xx-4xx: origin decided). Throws TransientCommitError on 5xx and network
     * failure, so the Workflow step retries with backoff.
     */
    async commit(entry: EntryState): Promise<number> {
      const { request } = entry;
      const encodedPath = request.path
        .split("/")
        .map((s) => encodeURIComponent(s))
        .join("/");
      const url = originUrl(options.origin, encodedPath, request.query ? `?${request.query}` : "");
      const body = decodeBody(entry);
      const signature = await signRequest(
        {
          id: entry.id,
          method: request.method,
          target: url.pathname + url.search,
          body,
          timestamp: Math.floor(now() / 1000),
        },
        options.secret,
      );
      let res: Response;
      try {
        res = await fetchOrigin(
          new Request(url, {
            method: request.method,
            headers: { ...request.headers, ...signature, "idempotency-key": entry.id },
            body,
            redirect: "manual",
          }),
        );
      } catch (err) {
        throw new TransientCommitError(`origin unreachable: ${(err as Error).message}`, {
          cause: err,
        });
      }
      await res.body?.cancel();
      if (res.status >= 500) throw new TransientCommitError(`origin returned ${res.status}`);
      return res.status;
    },
  };
}

export type Committer = ReturnType<typeof createCommitter>;
