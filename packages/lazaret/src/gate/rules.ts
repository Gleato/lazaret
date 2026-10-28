import type { GateSignal } from "./signals";

// The rule DSL. Rules are *data*, not code, so they can be written by users, and
// later (M5) promoted automatically from what the reviewer learns, without ever
// running untrusted logic. Safety properties, enforced at compile time:
//   - bounded size: depth ≤ 8, ≤ 64 nodes per rule
//   - `matches` only accepts regexes without backreferences, lookarounds or nested
//     quantifiers (the usual ReDoS shapes), ≤ 256 chars. Input is capped at 4 KB.
// Evaluation is a straight walk over the condition tree: cost is linear in rule size.

export type FieldRef =
  | "method"
  | "path"
  | "query"
  | "body"
  | `header:${string}`
  | `json:${string}`
  | `signal:${string}`;

export type Op =
  | "eq"
  | "neq"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "in"
  | "matches"
  | "exists"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { field: FieldRef; op: Op; value?: string | number | string[]; ci?: boolean };

export interface Rule {
  id: string;
  description?: string;
  when: Condition;
  /** `block` rejects at the edge; `flag` adds `weight` to the risk score. */
  action: "block" | "flag";
  weight?: number;
  category?: string;
}

/** Everything a rule can look at for one request. Strings are already canonicalised. */
export interface RuleContext {
  method: string;
  path: string;
  query: string;
  body: string;
  headers: Record<string, string>;
  json: unknown;
  signals: GateSignal[];
}

export interface CompiledRule {
  rule: Rule;
  test(ctx: RuleContext): boolean;
}

const MAX_DEPTH = 8;
const MAX_NODES = 64;
const MAX_REGEX_SOURCE = 256;
const MAX_MATCH_INPUT = 4096;

export class RuleError extends Error {
  constructor(ruleId: string, reason: string) {
    super(`rule "${ruleId}": ${reason}`);
    this.name = "RuleError";
  }
}

export function compileRule(rule: Rule): CompiledRule {
  if (!rule.id) throw new RuleError("?", "id is required");
  if (rule.action !== "block" && rule.action !== "flag") {
    throw new RuleError(rule.id, "action must be block or flag");
  }
  if (
    rule.action === "flag" &&
    !(rule.weight !== undefined && rule.weight > 0 && rule.weight <= 1)
  ) {
    throw new RuleError(rule.id, "flag rules need a weight in (0, 1]");
  }
  let nodes = 0;
  const compile = (c: Condition, depth: number): ((ctx: RuleContext) => boolean) => {
    if (++nodes > MAX_NODES) throw new RuleError(rule.id, `more than ${MAX_NODES} conditions`);
    if (depth > MAX_DEPTH) throw new RuleError(rule.id, `nested deeper than ${MAX_DEPTH}`);
    if ("all" in c) {
      const parts = c.all.map((x) => compile(x, depth + 1));
      return (ctx) => parts.every((p) => p(ctx));
    }
    if ("any" in c) {
      const parts = c.any.map((x) => compile(x, depth + 1));
      return (ctx) => parts.some((p) => p(ctx));
    }
    if ("not" in c) {
      const inner = compile(c.not, depth + 1);
      return (ctx) => !inner(ctx);
    }
    return compileLeaf(rule.id, c);
  };
  const test = compile(rule.when, 1);
  return { rule, test };
}

function compileLeaf(
  ruleId: string,
  c: Extract<Condition, { field: FieldRef }>,
): (ctx: RuleContext) => boolean {
  const read = fieldReader(ruleId, c.field);
  const norm = (v: string) => (c.ci ? v.toLowerCase() : v);
  const str = (): string => {
    if (typeof c.value !== "string") throw new RuleError(ruleId, `${c.op} needs a string value`);
    return norm(c.value);
  };
  const num = (): number => {
    if (typeof c.value !== "number") throw new RuleError(ruleId, `${c.op} needs a numeric value`);
    return c.value;
  };
  const asString = (v: unknown) => (v === undefined || v === null ? undefined : norm(String(v)));

  switch (c.op) {
    case "exists":
      return (ctx) => read(ctx) !== undefined;
    case "eq": {
      const v = c.value;
      if (typeof v === "number") return (ctx) => Number(read(ctx)) === v;
      const s = str();
      return (ctx) => asString(read(ctx)) === s;
    }
    case "neq": {
      const eq = compileLeaf(ruleId, { ...c, op: "eq" });
      return (ctx) => !eq(ctx);
    }
    case "contains": {
      const s = str();
      return (ctx) => asString(read(ctx))?.includes(s) ?? false;
    }
    case "startsWith": {
      const s = str();
      return (ctx) => asString(read(ctx))?.startsWith(s) ?? false;
    }
    case "endsWith": {
      const s = str();
      return (ctx) => asString(read(ctx))?.endsWith(s) ?? false;
    }
    case "in": {
      if (!Array.isArray(c.value)) throw new RuleError(ruleId, "in needs an array value");
      const set = new Set(c.value.map(norm));
      return (ctx) => {
        const v = asString(read(ctx));
        return v !== undefined && set.has(v);
      };
    }
    case "matches": {
      const re = compileSafeRegex(ruleId, str(), c.ci);
      return (ctx) => {
        const v = read(ctx);
        return v !== undefined && re.test(String(v).slice(0, MAX_MATCH_INPUT));
      };
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const n = num();
      const cmp = {
        gt: (a: number) => a > n,
        gte: (a: number) => a >= n,
        lt: (a: number) => a < n,
        lte: (a: number) => a <= n,
      }[c.op];
      return (ctx) => {
        const v = read(ctx);
        const a = typeof v === "number" ? v : Number(v);
        return v !== undefined && Number.isFinite(a) && cmp(a);
      };
    }
    default: {
      const unknownOp: never = c.op;
      throw new RuleError(ruleId, `unknown op ${String(unknownOp)}`);
    }
  }
}

function fieldReader(ruleId: string, field: FieldRef): (ctx: RuleContext) => unknown {
  switch (field) {
    case "method":
    case "path":
    case "query":
    case "body":
      return (ctx) => ctx[field];
  }
  if (field.startsWith("header:")) {
    const name = field.slice(7).toLowerCase();
    return (ctx) => ctx.headers[name];
  }
  if (field.startsWith("json:")) {
    const path = field.slice(5).split(".");
    if (
      path.some((p) => p === "" || p === "__proto__" || p === "constructor" || p === "prototype")
    ) {
      throw new RuleError(ruleId, `bad json path ${field}`);
    }
    return (ctx) => {
      let node: unknown = ctx.json;
      for (const key of path) {
        if (node === null || typeof node !== "object" || !Object.hasOwn(node, key))
          return undefined;
        node = (node as Record<string, unknown>)[key];
      }
      return node;
    };
  }
  if (field.startsWith("signal:")) {
    const id = field.slice(7);
    // Value is the signal's weight, so rules can say "signal:x gte 0.5" or "exists".
    return (ctx) => ctx.signals.find((s) => s.id === id || s.category === id)?.weight;
  }
  throw new RuleError(ruleId, `unknown field ${field}`);
}

/**
 * Reject regex shapes that can backtrack catastrophically. This is deliberately
 * conservative: rules that need more power should be split into simpler conditions.
 */
export function compileSafeRegex(ruleId: string, source: string, ci = false): RegExp {
  if (source.length > MAX_REGEX_SOURCE) throw new RuleError(ruleId, "regex too long");
  if (/\\[1-9]|\\k</.test(source)) throw new RuleError(ruleId, "regex backreferences not allowed");
  if (/\(\?<?[=!]/.test(source)) throw new RuleError(ruleId, "regex lookarounds not allowed");
  if (hasNestedQuantifier(source))
    throw new RuleError(ruleId, "regex nested quantifiers not allowed");
  try {
    return new RegExp(source, ci ? "iu" : "u");
  } catch (err) {
    throw new RuleError(ruleId, `invalid regex: ${(err as Error).message}`);
  }
}

/**
 * True if a quantified group contains a quantifier or an alternation, e.g. `(a+)+`
 * or `(a|a)*`. These are the shapes that backtrack exponentially. A trailing `?` is
 * fine: it can only match zero or one time.
 */
function hasNestedQuantifier(source: string): boolean {
  const stack: { quantifier: boolean; alternation: boolean }[] = [];
  const markParent = () => {
    const top = stack[stack.length - 1];
    if (top) top.quantifier = true;
  };
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "(") stack.push({ quantifier: false, alternation: false });
    else if (ch === "|") {
      const top = stack[stack.length - 1];
      if (top) top.alternation = true;
    } else if (ch === ")") {
      const inner = stack.pop();
      const next = source[i + 1];
      const repeated = next === "*" || next === "+" || next === "{";
      if (inner && repeated && (inner.quantifier || inner.alternation)) return true;
      if (inner?.quantifier || repeated || next === "?") markParent();
    } else if (ch === "*" || ch === "+" || ch === "{") markParent();
    else if (ch === "?" && source[i - 1] !== "(") markParent();
  }
  return false;
}
