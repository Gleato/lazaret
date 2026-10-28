import type { CompiledOverlay } from "../config/define";
import type { EntryState } from "../ledger/types";
import { matchPattern } from "../routing/matcher";
import type { PendingWrite } from "./merge";

// Applying the overlay to a live response. Safety rules:
//   - Only 200 JSON responses up to 2 MB are touched; anything else passes through.
//   - The Ledger is consulted only when some overlay targets this read route.
//   - A merger that throws leaves origin's response untouched. The overlay is a
//     convenience for reads, never a reason to fail one.
//   - A modified response is marked `Cache-Control: private, no-store`. It contains
//     one user's unvetted data, and a shared cache must never serve it to anyone else.

const MAX_OVERLAY_BODY = 2 * 1024 * 1024;

export async function overlayResponse(
  res: Response,
  overlays: CompiledOverlay[],
  segments: string[],
  fetchPending: (writeRoutes: string[]) => Promise<EntryState[]>,
): Promise<Response> {
  const matching = overlays.flatMap((overlay) => {
    const params = matchPattern(overlay.on, "GET", segments);
    return params ? [{ overlay, params }] : [];
  });
  if (!matching.length) return res;
  if (res.status !== 200 || !/\bjson\b/i.test(res.headers.get("content-type") ?? "")) return res;
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_OVERLAY_BODY) return res;

  const pending = await fetchPending([...new Set(matching.map((m) => m.overlay.writeRoute))]);
  if (!pending.length) return res;

  const text = await res.text();
  const passThrough = () => new Response(text, res);
  if (text.length > MAX_OVERLAY_BODY) return passThrough();

  let body: unknown;
  let applied = 0;
  try {
    body = JSON.parse(text);
    for (const { overlay, params } of matching) {
      const writes = pending
        .filter(
          (e) =>
            e.route === overlay.writeRoute &&
            sharedParamsAgree(overlay.writePattern.params, params, e.params ?? {}),
        )
        .map(toPendingWrite);
      if (!writes.length) continue;
      body = overlay.merge(body, writes, { params });
      applied += writes.length;
    }
  } catch (err) {
    console.error(JSON.stringify({ lazaret: "overlay_failed", error: String(err) }));
    return passThrough();
  }
  if (!applied) return passThrough();

  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.delete("etag");
  headers.set("content-type", "application/json");
  headers.set("cache-control", "private, no-store");
  headers.set("x-lazaret-overlay", String(applied));
  return new Response(JSON.stringify(body), { status: res.status, headers });
}

/** Params both patterns name must agree, e.g. a pending reply to ticket 42 only shows on ticket 42. */
function sharedParamsAgree(
  writeParamNames: string[],
  readParams: Record<string, string>,
  writeParams: Record<string, string>,
) {
  return writeParamNames.every(
    (name) => !(name in readParams) || readParams[name] === writeParams[name],
  );
}

function toPendingWrite(entry: EntryState): PendingWrite {
  let json: unknown;
  if (entry.request.body !== null && entry.request.bodyEncoding === "utf8") {
    try {
      json = JSON.parse(entry.request.body);
    } catch {
      json = undefined;
    }
  }
  return { receipt: entry.id, json, params: entry.params ?? {}, receivedAt: entry.receivedAt };
}
