import type { GateSignal } from "./signals";
import { SIGNATURES } from "./signatures";

// Request inspection: turn untrusted bytes into canonical text + signals.
//
// Canonicalisation undoes the encodings attackers use to slip past naive filters
// (double URL-encoding, HTML entities, full-width Unicode, SQL comment padding).
// Signatures then run on both the raw and the canonical form. Every stage has a
// budget, so a hostile payload can't make the gate slow: oversized input is
// truncated and *flagged*, never scanned in full.

const MAX_STRING_SCAN = 16 * 1024;
const MAX_TOTAL_SCAN = 256 * 1024;
const MAX_JSON_DEPTH = 20;
const MAX_JSON_NODES = 10_000;

export interface InspectInput {
  path: string;
  query: string;
  contentType: string;
  /** UTF-8 body text, or null for no/binary body. */
  bodyText: string | null;
  headers: Record<string, string>;
  sensitiveFields: string[];
}

export interface Inspection {
  signals: GateSignal[];
  /** Parsed JSON body, if any. */
  json: unknown;
  canonical: { path: string; query: string; body: string };
}

export function canonicalize(input: string): string {
  let s = input.length > MAX_STRING_SCAN ? input.slice(0, MAX_STRING_SCAN) : input;
  s = urlDecode(urlDecode(s));
  s = htmlDecode(s);
  s = s.normalize("NFKC");
  s = s.replace(/\/\*[^*]{0,200}\*\//g, " ").replaceAll("\0", "");
  return s.toLowerCase();
}

function urlDecode(s: string): string {
  if (!s.includes("%")) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  amp: "&",
  colon: ":",
  tab: "\t",
  newline: "\n",
  lpar: "(",
  rpar: ")",
  sol: "/",
};

function htmlDecode(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});?/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number(body.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function inspect(input: InspectInput): Inspection {
  const signals: GateSignal[] = [];
  const seen = new Set<string>();
  let budget = MAX_TOTAL_SCAN;
  let truncated = false;

  const scan = (raw: string, where: string) => {
    if (budget <= 0) {
      truncated = true;
      return;
    }
    if (raw.length > MAX_STRING_SCAN) truncated = true;
    const text = raw.slice(0, Math.min(MAX_STRING_SCAN, budget));
    budget -= text.length;
    const forms = [text.toLowerCase(), canonicalize(text)];
    for (const sig of SIGNATURES) {
      if (seen.has(sig.id)) continue;
      for (const form of forms) {
        const m = sig.pattern.exec(form);
        if (m) {
          seen.add(sig.id);
          signals.push({
            source: "signature",
            id: sig.id,
            category: sig.category,
            weight: sig.weight,
            evidence: `${where}: ${excerpt(form, m.index, m[0].length)}`,
          });
          break;
        }
      }
    }
  };

  const queryText = input.query.replaceAll("+", " ");
  scan(input.path, "path");
  if (queryText) scan(queryText, "query");
  for (const h of ["user-agent", "referer", "x-forwarded-host"]) {
    const v = input.headers[h];
    if (v) scan(v, `header ${h}`);
  }

  let json: unknown;
  const body = input.bodyText;
  if (body !== null && body.length > 0) {
    if (/\bjson\b/i.test(input.contentType)) {
      try {
        json = JSON.parse(body);
      } catch {
        signals.push({
          source: "request",
          id: "body.malformed_json",
          category: "malformed",
          weight: 0.3,
        });
      }
    }
    if (json !== undefined) {
      walkJson(json, input.sensitiveFields, signals, (s, where) => scan(s, where));
    } else {
      scan(body, "body");
    }
  }

  if (truncated) {
    signals.push({
      source: "request",
      id: "body.scan_truncated",
      category: "evasion",
      weight: 0.2,
    });
  }

  return {
    signals,
    json,
    canonical: {
      path: canonicalize(input.path),
      query: canonicalize(queryText),
      body: canonicalize(body ?? ""),
    },
  };
}

function walkJson(
  root: unknown,
  sensitiveFields: string[],
  signals: GateSignal[],
  scan: (s: string, where: string) => void,
): void {
  const sensitive = new Set(sensitiveFields);
  const flagged = new Set<string>();
  const flag = (signal: GateSignal) => {
    if (flagged.has(signal.id)) return;
    flagged.add(signal.id);
    signals.push(signal);
  };
  let nodes = 0;
  const stack: { value: unknown; depth: number; path: string }[] = [
    { value: root, depth: 0, path: "$" },
  ];
  while (stack.length) {
    const { value, depth, path } = stack.pop() as (typeof stack)[number];
    if (++nodes > MAX_JSON_NODES) {
      flag({ source: "request", id: "body.json_too_large", category: "evasion", weight: 0.3 });
      return;
    }
    if (depth > MAX_JSON_DEPTH) {
      flag({ source: "request", id: "body.json_too_deep", category: "evasion", weight: 0.3 });
      continue;
    }
    if (typeof value === "string") scan(value, path);
    else if (Array.isArray(value)) {
      for (const [i, v] of value.entries())
        stack.push({ value: v, depth: depth + 1, path: `${path}[${i}]` });
    } else if (value !== null && typeof value === "object") {
      for (const [key, v] of Object.entries(value)) {
        const lower = key.toLowerCase();
        if (sensitive.has(lower)) {
          flag({
            source: "request",
            id: "body.mass_assignment",
            category: "mass_assignment",
            weight: 0.5,
            evidence: `${path}.${key}`,
          });
        }
        if (key.startsWith("$")) {
          flag({
            source: "request",
            id: "body.operator_injection",
            category: "nosql_injection",
            weight: 0.6,
            evidence: `${path}.${key}`,
          });
        }
        if (lower === "__proto__" || lower === "constructor" || lower === "prototype") {
          flag({
            source: "request",
            id: "body.prototype_pollution",
            category: "prototype_pollution",
            weight: 0.8,
            evidence: `${path}.${key}`,
          });
        }
        scan(key, `${path} key`);
        stack.push({ value: v, depth: depth + 1, path: `${path}.${key}` });
      }
    }
  }
}

function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 20);
  const out = text.slice(start, Math.min(text.length, index + length + 20)).replace(/\s+/g, " ");
  return out.length > 80 ? `${out.slice(0, 77)}...` : out;
}
