// Route patterns: "METHOD /path/:param/*".
//   METHOD   GET, GET|HEAD, or * (omitted → *)
//   :name    captures exactly one segment
//   *        mid-pattern: exactly one segment; final: zero or more segments, so
//            `/admin/*` also covers `/admin` itself (no bypass by dropping the tail)
// Literal segments match case-insensitively, because many origins do and a
// case-sensitive BLOCK rule is bypassed by `/Admin`. Params keep their case.
// First matching route wins, like firewall rules: order is the precedence.

export type PatternSegment =
  | { kind: "literal"; value: string }
  | { kind: "param"; name: string }
  | { kind: "any" }
  | { kind: "rest" };

export interface CompiledPattern {
  source: string;
  methods: Set<string> | null;
  segments: PatternSegment[];
  params: string[];
}

export function compilePattern(source: string): CompiledPattern {
  const trimmed = source.trim();
  const space = trimmed.indexOf(" ");
  const methodPart = space === -1 ? "*" : trimmed.slice(0, space);
  const pathPart = space === -1 ? trimmed : trimmed.slice(space + 1).trim();
  if (!pathPart.startsWith("/")) throw new Error(`route "${source}": path must start with /`);

  const methods =
    methodPart === "*" ? null : new Set(methodPart.split("|").map((m) => m.toUpperCase()));
  if (methods && [...methods].some((m) => !/^[A-Z]+$/.test(m))) {
    throw new Error(`route "${source}": invalid method list`);
  }

  const raw = pathPart.split("/").filter(Boolean);
  const params: string[] = [];
  const segments = raw.map((part, i): PatternSegment => {
    if (part === "*") return i === raw.length - 1 ? { kind: "rest" } : { kind: "any" };
    if (part.startsWith(":")) {
      const name = part.slice(1);
      if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error(`route "${source}": bad param ${part}`);
      if (params.includes(name)) throw new Error(`route "${source}": duplicate param ${part}`);
      params.push(name);
      return { kind: "param", name };
    }
    return { kind: "literal", value: part.toLowerCase() };
  });
  return { source, methods, segments, params };
}

export function matchPattern(
  pattern: CompiledPattern,
  method: string,
  segments: string[],
): Record<string, string> | null {
  if (pattern.methods && !pattern.methods.has(method.toUpperCase())) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.segments.length; i++) {
    const p = pattern.segments[i];
    if (p?.kind === "rest") return params;
    const s = segments[i];
    if (s === undefined || !p) return null;
    if (p.kind === "literal" && p.value !== s.toLowerCase()) return null;
    if (p.kind === "param") params[p.name] = s;
  }
  return segments.length === pattern.segments.length ? params : null;
}

/**
 * `{receipt}` in a resource template stands for the write's own Ledger entry id.
 * The gateway can't fill it (the id doesn't exist yet), so it passes through
 * untouched and the Ledger substitutes it inside `append`. With an origin that uses
 * the receipt as the created resource's id, `ticket:{receipt}` on create and
 * `ticket:{id}` on reply name the same resource, so taint can link them before
 * the ticket ever reaches origin (tasks/todo.md, M6 step B).
 */
export const RECEIPT_PLACEHOLDER = "{receipt}";

/** Fill a resource template like `ticket:{id}` from route params. */
export function fillTemplate(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    m === RECEIPT_PLACEHOLDER ? m : (params[name] ?? ""),
  );
}

/** Route params a template refers to (`{receipt}` is not a route param). */
export function templateParams(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)]
    .filter((m) => m[0] !== RECEIPT_PLACEHOLDER)
    .map((m) => m[1] ?? "");
}
