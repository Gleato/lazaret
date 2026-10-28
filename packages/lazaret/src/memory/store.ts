import { DurableObject } from "cloudflare:workers";
import { compileRule, type Rule } from "../gate/rules";
import { backtest, statusAfterBacktest, statusAfterLiveEvidence } from "./lifecycle";
import {
  ACTIVE_STATUSES,
  type ActiveRuleSpec,
  type ArchivedVerdict,
  DEFAULT_MEMORY_THRESHOLDS,
  type MemoryRule,
  type MemoryThresholds,
  type RuleProposal,
  type RuleSample,
  type RuleStatus,
} from "./types";

// The Memory is a Durable Object holding the verdict archive and the learned
// rules (principle 5). It is deliberately separate from the Ledger: the Ledger is
// the hot path for every write, while the Memory is consulted by the gate on a
// cache and updated by the Review Workflow after the fact.
//
// Memory is advisory. Every consumer treats it as optional, so an outage here
// can make Lazaret less smart but never less safe or less available.
//
// Subclass to configure, like the Ledger:
//   export class Memory extends LazaretMemory {
//     protected override thresholds() { return { ...DEFAULT_MEMORY_THRESHOLDS, minCleanSamples: 50 }; }
//   }

const MAX_ARCHIVE_PER_VERDICT = 5000;

export interface ArchiveInput extends ArchivedVerdict {
  /** Ids of memory rules that fired on this request at the gate. */
  memoryHits: string[];
}

export interface DistillInput {
  drops: {
    entryId: string;
    route: string;
    category: string;
    rationale: string;
    sample: RuleSample;
  }[];
  allows: { route: string; sample: RuleSample }[];
  existing: { description: string; category: string; status: RuleStatus }[];
}

export interface RuleEvent {
  seq: number;
  ruleId: string;
  from: RuleStatus | null;
  to: RuleStatus;
  reason: string;
  at: number;
}

// A type alias (not an interface) so it satisfies SqlStorage's row constraint.
type RuleRow = {
  id: string;
  rule: string;
  status: RuleStatus;
  category: string;
  description: string;
  support: number;
  clean_samples: number;
  live_tp: number;
  live_fp: number;
  created_at: number;
  updated_at: number;
  last_hit_at: number | null;
  reason: string;
};

export class LazaretMemory<Env = unknown> extends DurableObject<Env> {
  readonly #t: MemoryThresholds;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#t = this.thresholds();
    ctx.blockConcurrencyWhile(async () => this.#migrate());
  }

  protected thresholds(): MemoryThresholds {
    return DEFAULT_MEMORY_THRESHOLDS;
  }

  protected now(): number {
    return Date.now();
  }

  // ── Archive & live feedback ───────────────────────────────────────────────────

  /**
   * Archive reviewed writes and score the memory rules that fired on them. The
   * reviewer never saw those hits (see prompt.ts), so its verdict is an
   * independent label: a hit on a dropped write is a true positive, a hit on an
   * allowed one is a false positive.
   */
  archive(records: ArchiveInput[]): { archived: number; transitions: RuleEvent[] } {
    const sql = this.ctx.storage.sql;
    let archived = 0;
    const touched = new Set<string>();
    this.ctx.storage.transactionSync(() => {
      for (const r of records) {
        const inserted = sql.exec(
          `INSERT OR IGNORE INTO verdicts
             (entry_id, at, route, session, verdict, category, confidence, rationale, source, sample, covered)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          r.entryId,
          r.at,
          r.route,
          r.sessionId,
          r.verdict,
          r.category,
          r.confidence,
          r.rationale.slice(0, 400),
          r.source,
          JSON.stringify(r.sample),
          r.memoryHits.length ? 1 : 0,
        ).rowsWritten;
        if (!inserted) continue; // a replayed archive step must not double-count
        archived += 1;
        if (r.verdict === "quarantine") continue;
        for (const ruleId of r.memoryHits) {
          const column = r.verdict === "drop" ? "live_tp" : "live_fp";
          sql.exec(
            `UPDATE rules SET ${column} = ${column} + 1, last_hit_at = ? WHERE id = ?`,
            r.at,
            ruleId,
          );
          touched.add(ruleId);
        }
      }
      for (const verdict of ["allow", "drop"]) {
        sql.exec(
          `DELETE FROM verdicts WHERE verdict = ? AND entry_id NOT IN
             (SELECT entry_id FROM verdicts WHERE verdict = ? ORDER BY at DESC LIMIT ?)`,
          verdict,
          verdict,
          MAX_ARCHIVE_PER_VERDICT,
        );
      }
    });

    const transitions = [...this.#applyLiveEvidence([...touched]), ...this.#rebacktestPending()];
    return { archived, transitions };
  }

  /**
   * A human's label replaces whatever the archive holds for that entry (M6.7). This is
   * how the Memory learns from the reviewer's mistakes: an operator drop of a write
   * the reviewer allowed or held becomes distillation input like any other drop, and
   * an operator release becomes clean traffic for backtests. Rule hits on the entry
   * are re-scored against the human label, moving a hit from false to true positive
   * (or back) if the label disagrees with what was archived.
   */
  label(record: ArchiveInput): { labelled: boolean; transitions: RuleEvent[] } {
    const sql = this.ctx.storage.sql;
    const touched = new Set<string>();
    this.ctx.storage.transactionSync(() => {
      const previous = sql
        .exec<{ verdict: string }>(
          "SELECT verdict FROM verdicts WHERE entry_id = ?",
          record.entryId,
        )
        .toArray()[0]?.verdict;
      sql.exec(
        `INSERT INTO verdicts
           (entry_id, at, route, session, verdict, category, confidence, rationale, source, sample, covered)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(entry_id) DO UPDATE SET
           at = excluded.at, verdict = excluded.verdict, category = excluded.category,
           confidence = excluded.confidence, rationale = excluded.rationale,
           source = excluded.source, distilled = 0`,
        record.entryId,
        record.at,
        record.route,
        record.sessionId,
        record.verdict,
        record.category,
        record.confidence,
        record.rationale.slice(0, 400),
        record.source,
        JSON.stringify(record.sample),
        record.memoryHits.length ? 1 : 0,
      );
      const column = (v: string | undefined) =>
        v === "drop" ? "live_tp" : v === "allow" ? "live_fp" : null;
      const before = column(previous);
      const after = column(record.verdict);
      if (before !== after) {
        for (const ruleId of record.memoryHits) {
          if (before)
            sql.exec(`UPDATE rules SET ${before} = MAX(${before} - 1, 0) WHERE id = ?`, ruleId);
          if (after) {
            sql.exec(
              `UPDATE rules SET ${after} = ${after} + 1, last_hit_at = ? WHERE id = ?`,
              record.at,
              ruleId,
            );
          }
          touched.add(ruleId);
        }
      }
    });
    return { labelled: true, transitions: this.#applyLiveEvidence([...touched]) };
  }

  // ── Gate ─────────────────────────────────────────────────────────────────────

  /** Rules the gate should evaluate. Cached by the gateway, so keep it cheap. */
  getActiveRules(): ActiveRuleSpec[] {
    return this.#rules(ACTIVE_STATUSES).map((r) => ({
      id: r.id,
      mode: r.status as ActiveRuleSpec["mode"],
      weight: this.#t.flagWeight,
      category: r.category,
      rule: r.rule,
    }));
  }

  // ── Distillation ─────────────────────────────────────────────────────────────

  /**
   * Drops not yet explained by any rule, with recent clean traffic from the same
   * routes as counter-examples, and existing rules so the distiller doesn't
   * repeat itself.
   */
  getDistillInput(limit = 20): DistillInput {
    this.#retireStale();
    const sql = this.ctx.storage.sql;
    const drops = sql
      .exec<{
        entry_id: string;
        route: string;
        category: string;
        rationale: string;
        sample: string;
      }>(
        `SELECT entry_id, route, category, rationale, sample FROM verdicts
         WHERE verdict = 'drop' AND covered = 0 AND distilled = 0 AND category != 'tainted'
         ORDER BY at DESC LIMIT ?`,
        limit,
      )
      .toArray()
      .map((r) => ({
        entryId: r.entry_id,
        route: r.route,
        category: r.category,
        rationale: r.rationale,
        sample: JSON.parse(r.sample) as RuleSample,
      }));
    const routes = [...new Set(drops.map((d) => d.route))];
    const allows = routes.length
      ? sql
          .exec<{ route: string; sample: string }>(
            `SELECT route, sample FROM verdicts WHERE verdict = 'allow'
             AND route IN (${routes.map(() => "?").join(",")}) ORDER BY at DESC LIMIT 10`,
            ...routes,
          )
          .toArray()
          .map((r) => ({ route: r.route, sample: JSON.parse(r.sample) as RuleSample }))
      : [];
    const existing = this.#rules(["pending", "shadow", "flag", "block"]).map((r) => ({
      description: r.description,
      category: r.category,
      status: r.status,
    }));
    return { drops, allows, existing };
  }

  /**
   * Compile, deduplicate and backtest the distiller's proposals. Proposals are
   * untrusted (an LLM wrote them after reading attacker data), so nothing goes
   * live without passing the DSL's safety checks and a backtest against real
   * clean traffic, and even then it starts in shadow mode.
   */
  submitCandidates(proposals: RuleProposal[], sourceEntryIds: string[]): MemoryRule[] {
    const now = this.now();
    const { drops, allows } = this.#samples();
    const known = new Set(
      this.#rules(["pending", "shadow", "flag", "block", "rejected"]).map((r) =>
        JSON.stringify(r.rule.when),
      ),
    );
    const created: MemoryRule[] = [];

    for (const p of proposals.slice(0, 5)) {
      const fingerprint = JSON.stringify(p.when);
      if (known.has(fingerprint)) continue;
      known.add(fingerprint);
      const id = this.#nextRuleId();
      const rule: Rule = {
        id,
        description: p.description.slice(0, 200),
        category: p.category,
        action: "flag",
        weight: this.#t.flagWeight,
        when: p.when,
      };
      let status: RuleStatus;
      let reason: string;
      let result = { support: 0, falsePositives: 0, cleanSamples: allows.length };
      try {
        result = backtest(compileRule(rule), drops, allows);
        ({ status, reason } = statusAfterBacktest(result, this.#t));
      } catch (err) {
        status = "rejected";
        reason = `unsafe or invalid rule: ${(err as Error).message}`;
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO rules (id, rule, status, category, description, support, clean_samples, created_at, updated_at, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        JSON.stringify(rule),
        status,
        p.category,
        rule.description ?? "",
        result.support,
        result.cleanSamples,
        now,
        now,
        reason,
      );
      this.#logEvent(id, null, status, reason, now);
      created.push(this.#rule(id) as MemoryRule);
    }
    this.markDistilled(sourceEntryIds);
    return created;
  }

  markDistilled(entryIds: string[]): void {
    for (const id of entryIds) {
      this.ctx.storage.sql.exec("UPDATE verdicts SET distilled = 1 WHERE entry_id = ?", id);
    }
  }

  // ── Reviewer context ─────────────────────────────────────────────────────────

  /**
   * Recent drop patterns per route, for the reviewer's context. These are
   * aggregates of the reviewer's *own* past verdicts, not per-entry rule hits, so
   * they inform without biasing the labels that score memory rules.
   */
  getReviewerContext(
    routes: string[],
  ): { route: string; category: string; count: number; example: string }[] {
    if (!routes.length) return [];
    return this.ctx.storage.sql
      .exec<{ route: string; category: string; count: number; example: string }>(
        `SELECT route, category, COUNT(*) AS count, MAX(rationale) AS example FROM verdicts
         WHERE verdict = 'drop' AND category != 'tainted' AND route IN (${routes.map(() => "?").join(",")})
         GROUP BY route, category ORDER BY count DESC LIMIT 8`,
        ...routes,
      )
      .toArray();
  }

  // ── Operator & visualiser ────────────────────────────────────────────────────

  listRules(): MemoryRule[] {
    return this.#rules(["pending", "shadow", "flag", "block", "rejected", "retired"]);
  }

  getRuleEvents(afterSeq = 0, limit = 200): RuleEvent[] {
    return this.ctx.storage.sql
      .exec<{
        seq: number;
        rule_id: string;
        from_status: RuleStatus | null;
        to_status: RuleStatus;
        reason: string;
        at: number;
      }>(
        "SELECT * FROM rule_events WHERE seq > ? ORDER BY seq LIMIT ?",
        afterSeq,
        Math.min(Math.max(limit, 1), 1000),
      )
      .toArray()
      .map((r) => ({
        seq: r.seq,
        ruleId: r.rule_id,
        from: r.from_status,
        to: r.to_status,
        reason: r.reason,
        at: r.at,
      }));
  }

  /** Manual override, e.g. an operator retiring a rule or fast-tracking one. */
  setRuleStatus(id: string, status: RuleStatus, reason: string): MemoryRule | null {
    const rule = this.#rule(id);
    if (!rule) return null;
    this.#transition(rule, status, `operator: ${reason}`);
    return this.#rule(id);
  }

  getStats(): { archived: Record<string, number>; rules: Record<string, number> } {
    const count = (sql: string) =>
      Object.fromEntries(
        this.ctx.storage.sql
          .exec<{ k: string; n: number }>(sql)
          .toArray()
          .map((r) => [r.k, r.n]),
      );
    return {
      archived: count("SELECT verdict AS k, COUNT(*) AS n FROM verdicts GROUP BY verdict"),
      rules: count("SELECT status AS k, COUNT(*) AS n FROM rules GROUP BY status"),
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  #applyLiveEvidence(ids: string[]): RuleEvent[] {
    const events: RuleEvent[] = [];
    const now = this.now();
    for (const id of ids) {
      const rule = this.#rule(id);
      const next = rule && statusAfterLiveEvidence(rule, this.#t, now);
      if (rule && next) events.push(this.#transition(rule, next.status, next.reason));
    }
    return events;
  }

  /** Pending rules were waiting for clean traffic; re-judge them as it arrives. */
  #rebacktestPending(): RuleEvent[] {
    const pending = this.#rules(["pending"]);
    if (!pending.length) return [];
    const { drops, allows } = this.#samples();
    const events: RuleEvent[] = [];
    for (const rule of pending) {
      const result = backtest(compileRule(rule.rule), drops, allows);
      const next = statusAfterBacktest(result, this.#t);
      this.ctx.storage.sql.exec(
        "UPDATE rules SET support = ?, clean_samples = ? WHERE id = ?",
        result.support,
        result.cleanSamples,
        rule.id,
      );
      if (next.status !== "pending") events.push(this.#transition(rule, next.status, next.reason));
    }
    return events;
  }

  #retireStale(): void {
    const now = this.now();
    for (const rule of this.#rules(ACTIVE_STATUSES)) {
      const next = statusAfterLiveEvidence(rule, this.#t, now);
      if (next?.status === "retired") this.#transition(rule, "retired", next.reason);
    }
  }

  #transition(rule: MemoryRule, to: RuleStatus, reason: string): RuleEvent {
    const now = this.now();
    // Promotion to block flips the rule's action so the gate rejects outright.
    const updated: Rule = { ...rule.rule, action: to === "block" ? "block" : "flag" };
    this.ctx.storage.sql.exec(
      "UPDATE rules SET status = ?, reason = ?, updated_at = ?, rule = ? WHERE id = ?",
      to,
      reason,
      now,
      JSON.stringify(updated),
      rule.id,
    );
    return this.#logEvent(rule.id, rule.status, to, reason, now);
  }

  #logEvent(
    ruleId: string,
    from: RuleStatus | null,
    to: RuleStatus,
    reason: string,
    at: number,
  ): RuleEvent {
    const row = this.ctx.storage.sql
      .exec<{ seq: number }>(
        "INSERT INTO rule_events (rule_id, from_status, to_status, reason, at) VALUES (?, ?, ?, ?, ?) RETURNING seq",
        ruleId,
        from,
        to,
        reason,
        at,
      )
      .one();
    return { seq: row.seq, ruleId, from, to, reason, at };
  }

  #samples(): { drops: RuleSample[]; allows: RuleSample[] } {
    const load = (verdict: string) =>
      this.ctx.storage.sql
        .exec<{ sample: string }>(
          "SELECT sample FROM verdicts WHERE verdict = ? AND category != 'tainted'",
          verdict,
        )
        .toArray()
        .map((r) => JSON.parse(r.sample) as RuleSample);
    return { drops: load("drop"), allows: load("allow") };
  }

  #rules(statuses: readonly RuleStatus[]): MemoryRule[] {
    return this.ctx.storage.sql
      .exec<RuleRow>(
        `SELECT * FROM rules WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at, id`,
        ...statuses,
      )
      .toArray()
      .map(toMemoryRule);
  }

  #rule(id: string): MemoryRule | null {
    const rows = this.ctx.storage.sql
      .exec<RuleRow>("SELECT * FROM rules WHERE id = ?", id)
      .toArray();
    return rows[0] ? toMemoryRule(rows[0]) : null;
  }

  #nextRuleId(): string {
    const row = this.ctx.storage.sql
      .exec<{ value: number }>(
        "INSERT INTO meta (key, value) VALUES ('rule_seq', 1) ON CONFLICT(key) DO UPDATE SET value = value + 1 RETURNING value",
      )
      .one();
    return `mem-${row.value}`;
  }

  #migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS verdicts (
        entry_id   TEXT PRIMARY KEY,
        at         INTEGER NOT NULL,
        route      TEXT    NOT NULL,
        session    TEXT    NOT NULL,
        verdict    TEXT    NOT NULL,
        category   TEXT    NOT NULL,
        confidence REAL    NOT NULL,
        rationale  TEXT    NOT NULL,
        source     TEXT    NOT NULL,
        sample     TEXT    NOT NULL,
        covered    INTEGER NOT NULL DEFAULT 0,
        distilled  INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS verdicts_by_verdict ON verdicts (verdict, at);
      CREATE TABLE IF NOT EXISTS rules (
        id            TEXT PRIMARY KEY,
        rule          TEXT    NOT NULL,
        status        TEXT    NOT NULL,
        category      TEXT    NOT NULL,
        description   TEXT    NOT NULL,
        support       INTEGER NOT NULL DEFAULT 0,
        clean_samples INTEGER NOT NULL DEFAULT 0,
        live_tp       INTEGER NOT NULL DEFAULT 0,
        live_fp       INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        last_hit_at   INTEGER,
        reason        TEXT    NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS rule_events (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id     TEXT    NOT NULL,
        from_status TEXT,
        to_status   TEXT    NOT NULL,
        reason      TEXT    NOT NULL,
        at          INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    `);
  }
}

function toMemoryRule(r: RuleRow): MemoryRule {
  return {
    id: r.id,
    rule: JSON.parse(r.rule) as Rule,
    status: r.status,
    category: r.category,
    description: r.description,
    support: r.support,
    cleanSamples: r.clean_samples,
    liveTruePositives: r.live_tp,
    liveFalsePositives: r.live_fp,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastHitAt: r.last_hit_at,
    reason: r.reason,
  };
}
