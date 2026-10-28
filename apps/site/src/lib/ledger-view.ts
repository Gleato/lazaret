import type {
  BatchStatus,
  EntryStatus,
  LiveFrame,
  PublicObservation,
  SealReason,
  VerdictRecord,
} from "@gleator/lazaret/public";

// The visualiser's model: a fold over the Ledger's public frames (the same idea as the
// Ledger's own projection, principle 3, on the viewer's side). Pure and DOM-free, so
// it is unit-tested in Node and drives both the live socket and the recorded replay.
//
// Frames arrive in order with no gaps (the Ledger guarantees that per connection), and
// a reconnect resumes from `head`, so a frame at or below `head` is a duplicate and
// is skipped.

export interface EntryView {
  id: string;
  batchId: string;
  route: string;
  method: string;
  path: string;
  session: string;
  risk: number;
  signals: string[];
  resources: string[];
  body: string | null;
  bodyTruncated: boolean;
  status: EntryStatus;
  verdict: VerdictRecord | null;
  originStatus: number | null;
  /** The dropped write this one depended on, when taint took it down. */
  taintedBy: string | null;
  /** A human's decision on a held write. */
  resolution: "release" | "drop" | "report" | null;
  at: number;
}

export interface BatchView {
  id: string;
  status: BatchStatus;
  sealReason: SealReason | null;
  attempt: number;
  openedAt: number;
  updatedAt: number;
  entryIds: string[];
  note: string | null;
}

export interface ViewState {
  shard: string;
  head: number;
  batches: Map<string, BatchView>;
  entries: Map<string, EntryView>;
  observations: PublicObservation[];
  flaggedSessions: Set<string>;
}

/** Batches kept on screen; older ones scroll off (the Ledger keeps them all). */
export const MAX_BATCHES = 24;
export const MAX_OBSERVATIONS = 40;

/** The batch lifecycle as drawn on each ledger row. Side states hang off it. */
export const TRACK: readonly BatchStatus[] = [
  "OPEN",
  "SEALED",
  "REVIEWING",
  "COMMITTING",
  "SETTLED",
];

export function emptyView(): ViewState {
  return {
    shard: "",
    head: 0,
    batches: new Map(),
    entries: new Map(),
    observations: [],
    flaggedSessions: new Set(),
  };
}

const VERDICT_STATUS: Record<VerdictRecord["verdict"], EntryStatus> = {
  allow: "APPROVED",
  drop: "DROPPED",
  quarantine: "QUARANTINED",
};

/** Apply one frame. Returns true if anything visible changed. */
export function applyFrame(state: ViewState, frame: LiveFrame): boolean {
  switch (frame.type) {
    case "HELLO":
      state.shard = frame.shard;
      return true;
    case "RESET":
      Object.assign(state, emptyView());
      return true;
    case "OBSERVED":
      state.observations.push(frame);
      if (state.observations.length > MAX_OBSERVATIONS) state.observations.shift();
      return true;
  }

  if (frame.seq <= state.head) return false;
  state.head = frame.seq;
  const batch = (id: string) => state.batches.get(id);
  const touch = (b: BatchView | undefined, status?: BatchStatus) => {
    if (!b) return;
    if (status) b.status = status;
    b.updatedAt = frame.at;
  };

  switch (frame.type) {
    case "BATCH_OPENED":
      state.batches.set(frame.batchId, {
        id: frame.batchId,
        status: "OPEN",
        sealReason: null,
        attempt: 0,
        openedAt: frame.at,
        updatedAt: frame.at,
        entryIds: [],
        note: null,
      });
      trim(state);
      break;
    case "ENTRY_APPENDED": {
      const e = frame.entry;
      state.entries.set(e.entryId, {
        id: e.entryId,
        batchId: e.batchId,
        route: e.route,
        method: e.method,
        path: e.path,
        session: e.session,
        risk: e.risk,
        signals: e.signals.map((s) => s.id),
        resources: e.resources,
        body: e.body,
        bodyTruncated: e.bodyTruncated,
        status: "PENDING",
        verdict: null,
        originStatus: null,
        taintedBy: null,
        resolution: null,
        at: frame.at,
      });
      const b = batch(e.batchId);
      b?.entryIds.push(e.entryId);
      touch(b);
      break;
    }
    case "BATCH_SEALED": {
      const b = batch(frame.batchId);
      if (b) b.sealReason = frame.reason;
      touch(b, "SEALED");
      break;
    }
    case "REVIEW_STARTED": {
      const b = batch(frame.batchId);
      if (b) b.attempt = frame.attempt;
      touch(b, "REVIEWING");
      break;
    }
    case "REVIEW_FAILED": {
      const b = batch(frame.batchId);
      if (b) b.note = `Attempt ${frame.attempt} failed: ${frame.error}`;
      touch(b, "REVIEW_FAILED");
      break;
    }
    case "ENTRY_VERDICT": {
      const e = state.entries.get(frame.entryId);
      if (!e) break;
      e.verdict = frame.verdict;
      e.status = VERDICT_STATUS[frame.verdict.verdict];
      if (frame.verdict.category === "tainted") e.taintedBy = taintParent(state, e);
      break;
    }
    case "COMMIT_STARTED":
      touch(batch(frame.batchId), "COMMITTING");
      break;
    case "ENTRY_COMMITTED": {
      const e = state.entries.get(frame.entryId);
      if (e) {
        e.status = "COMMITTED";
        e.originStatus = frame.originStatus;
      }
      break;
    }
    case "BATCH_SETTLED":
      touch(batch(frame.batchId), "SETTLED");
      break;
    case "BATCH_QUARANTINED": {
      const b = batch(frame.batchId);
      if (b) {
        b.note = frame.reason;
        for (const id of b.entryIds) {
          const e = state.entries.get(id);
          if (e && e.status === "PENDING") e.status = "QUARANTINED";
        }
      }
      touch(b, "QUARANTINED");
      break;
    }
    case "SESSION_FLAGGED":
      state.flaggedSessions.add(frame.session);
      break;
    case "ENTRY_RESOLVED": {
      const e = state.entries.get(frame.entryId);
      if (e) {
        e.resolution = frame.decision;
        e.status = frame.decision === "release" ? "APPROVED" : "DROPPED";
      }
      break;
    }
    case "ENTRY_REPORTED": {
      const e = state.entries.get(frame.entryId);
      if (e) e.resolution = "report";
      break;
    }
  }
  return true;
}

/**
 * Taint's link, as the Ledger draws it (ledger/taint.ts): same session, a shared
 * resource that isn't a creation marker, and the parent was dropped or held earlier.
 */
function taintParent(state: ViewState, child: EntryView): string | null {
  let parent: EntryView | null = null;
  for (const e of state.entries.values()) {
    if (e.id === child.id) break;
    if (
      e.session === child.session &&
      (e.status === "DROPPED" || e.status === "QUARANTINED") &&
      e.resources.some((r) => !r.endsWith(":new") && child.resources.includes(r))
    ) {
      parent = e;
    }
  }
  return parent?.id ?? null;
}

function trim(state: ViewState): void {
  while (state.batches.size > MAX_BATCHES) {
    const [oldest] = state.batches.values();
    if (!oldest) return;
    for (const id of oldest.entryIds) state.entries.delete(id);
    state.batches.delete(oldest.id);
  }
}

/** Newest first, for drawing. */
export function batchesNewestFirst(state: ViewState): BatchView[] {
  return [...state.batches.values()].reverse();
}

/** Where a batch is on the track; side states sit at the step they branched from. */
export function trackIndex(status: BatchStatus): number {
  if (status === "REVIEW_FAILED") return TRACK.indexOf("REVIEWING");
  if (status === "QUARANTINED") return TRACK.indexOf("REVIEWING");
  return TRACK.indexOf(status);
}
