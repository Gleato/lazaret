import { stableHash } from "./split";
import type { CaseRequest, EvalCase } from "./types";

// The campaign mutator (M7.1 C). Real attackers don't send one payload; they send many
// variants of it until one gets through. This turns a corpus case into such variants,
// deterministically (a seeded PRNG, no model), so a campaign replay is reproducible
// to the byte: same seed, same traffic, fake or live.
//
// Every transform is one a real filter-evasion kit uses, and every one is undone by the
// gate's canonicaliser (gate/inspect.ts: double URL-decoding, HTML entities, NFKC, SQL
// comments), so a variant means the same thing to the application as its original. That
// is the point: a learned rule judges the decoded request and should catch the variant;
// a rule (or reviewer) keyed on the raw bytes would not.
//
//   url       percent-encode the characters payloads are made of: < > ' " = ( ) ;
//   entity    HTML-entity encode them, named or numeric
//   unicode   full-width look-alikes (＜ ＞ ＇ ＂), which NFKC folds back
//   case      flip the case of letters at random (HTML tags, SQL keywords, everything)
//   space     double spaces and tabs between words
//   comment   SQL comment padding between keywords (UNION/**/SELECT)
//   move      move the payload to the other text field, or behind a polite preamble
//
// Benign traffic gets only what real clients do to text: a form or rich-text editor
// percent- or entity-encodes it, an IME types full-width punctuation, a customer puts
// the request in the subject line or opens with a pleasantry (url, entity, unicode,
// move). A rule or reviewer that fires on those alone is a false positive. `case`,
// `space` and `comment` are evasion signatures no customer produces: the first live
// campaign (M7.1) applied them to benign traffic too, and the reviewer rightly held
// "DuPliCATe charGe" and tab-stuffed tickets as suspicious, which measured the mutator,
// not Lazaret.
//
// Only the target request (the last one, the one that's scored) is mutated; setup
// requests stay as written. Rate-based and multi-step cases (credential bursts, taint
// chains) test other mechanisms, so the campaign leaves them out (see campaign.ts).

export type Transform = "url" | "entity" | "unicode" | "case" | "space" | "comment" | "move";
/** What real clients do to benign text (see above). */
export const BENIGN_TRANSFORMS: readonly Transform[] = ["url", "entity", "unicode", "move"];
export const TRANSFORMS: readonly Transform[] = [
  "url",
  "entity",
  "unicode",
  "case",
  "space",
  "comment",
  "move",
];

/** mulberry32: tiny, fast, and identical on Node and workerd. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SPECIAL = /[<>'"=();]/g;
const PERCENT: Record<string, string> = {
  "<": "%3C",
  ">": "%3E",
  "'": "%27",
  '"': "%22",
  "=": "%3D",
  "(": "%28",
  ")": "%29",
  ";": "%3B",
};
const ENTITY: Record<string, string[]> = {
  "<": ["&lt;", "&#60;", "&#x3c;"],
  ">": ["&gt;", "&#62;", "&#x3e;"],
  "'": ["&apos;", "&#39;", "&#x27;"],
  '"': ["&quot;", "&#34;"],
  "=": ["&#61;"],
  "(": ["&lpar;", "&#40;"],
  ")": ["&rpar;", "&#41;"],
  ";": ["&#59;"],
};
const FULLWIDTH: Record<string, string> = { "<": "＜", ">": "＞", "'": "＇", '"': "＂", "=": "＝" };
const SQL_WORD =
  /\b(select|union|from|where|and|or|drop|table|insert|into|values|case|when|then|else|end)\b/i;
const PREAMBLES = [
  "Hi team, quick question. ",
  "Following up on my last message: ",
  "Thanks in advance! ",
  "Sorry to bother you again. ",
];

function applyToString(s: string, t: Transform, rand: () => number): string {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)] as T;
  switch (t) {
    case "url":
      return s.replace(SPECIAL, (c) => PERCENT[c] ?? c);
    case "entity":
      return s.replace(SPECIAL, (c) => pick(ENTITY[c] ?? [c]));
    case "unicode":
      return s.replace(/[<>'"=]/g, (c) => (rand() < 0.7 ? (FULLWIDTH[c] ?? c) : c));
    case "case":
      return s.replace(/[a-z]/gi, (c) =>
        rand() < 0.4 ? (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()) : c,
      );
    case "space":
      return s.replace(/ /g, () => (rand() < 0.5 ? pick(["  ", "\t", " \t "]) : " "));
    case "comment":
      // Only between SQL keywords and their neighbours, where a database ignores it.
      return s
        .split(" ")
        .map((w, i, ws) =>
          i < ws.length - 1 && (SQL_WORD.test(w) || SQL_WORD.test(ws[i + 1] ?? ""))
            ? `${w}/**/`
            : `${w} `,
        )
        .join("")
        .trimEnd();
    case "move":
      return s; // handled on the whole body, below
  }
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Text leaves worth mutating: not emails, ids or one-word tokens. */
function isText(key: string, v: Json): v is string {
  return (
    typeof v === "string" &&
    !/email|password|token|_id$|^id$|currency/i.test(key) &&
    !/^[\w.@+-]*$/.test(v)
  );
}

function mapText(v: Json, key: string, f: (s: string) => string): Json {
  if (isText(key, v)) return f(v);
  if (Array.isArray(v)) return v.map((x) => mapText(x, key, f));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapText(x, k, f)]));
  }
  return v;
}

/** Swap the two text fields of an object (subject ↔ body), or prepend a preamble. */
function move(v: Json, rand: () => number): Json {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  const texts = Object.entries(v).filter(([k, x]) => isText(k, x));
  if (texts.length >= 2) {
    const [[ka, va], [kb, vb]] = texts as [[string, Json], [string, Json]];
    return { ...v, [ka]: vb, [kb]: va };
  }
  const [only] = texts;
  if (!only) return v;
  return { ...v, [only[0]]: PREAMBLES[Math.floor(rand() * PREAMBLES.length)] + String(only[1]) };
}

function mutateBody(bodyText: string, transforms: Transform[], rand: () => number): string {
  let parsed: Json;
  try {
    parsed = JSON.parse(bodyText) as Json;
  } catch {
    // Not JSON: treat the whole body as one text field.
    return transforms.reduce((s, t) => applyToString(s, t, rand), bodyText);
  }
  let out = parsed;
  for (const t of transforms) {
    out = t === "move" ? move(out, rand) : mapText(out, "", (s) => applyToString(s, t, rand));
  }
  return JSON.stringify(out);
}

export interface Variant extends EvalCase {
  /** The corpus case this variant came from: its family. */
  family: string;
  transforms: Transform[];
}

/**
 * Variant `n` of a case. Variant 0 is the case as written. Others apply one or two
 * transforms, chosen by a PRNG seeded from (seed, case id, n), so the same call always
 * returns the same variant. `comment` is only offered for bodies with SQL keywords;
 * benign traffic gets BENIGN_TRANSFORMS only.
 */
export function variantOf(c: EvalCase, n: number, seed: number): Variant {
  const id = `${c.id}~v${n}`;
  if (n === 0) return { ...c, id, family: c.id, transforms: [] };
  const rand = prng(stableHash(`${seed}:${c.id}:${n}`));
  const last = c.requests.at(-1) as CaseRequest;
  const sqlish = SQL_WORD.test(last.bodyText ?? "") && c.label === "attack";
  const pool =
    c.label === "benign" ? BENIGN_TRANSFORMS : TRANSFORMS.filter((t) => t !== "comment" || sqlish);
  const count = rand() < 0.5 ? 1 : 2;
  const transforms: Transform[] = [];
  while (transforms.length < count) {
    const t = pool[Math.floor(rand() * pool.length)] as Transform;
    if (!transforms.includes(t)) transforms.push(t);
  }
  const target: CaseRequest =
    last.bodyText === undefined
      ? last
      : { ...last, bodyText: mutateBody(last.bodyText, transforms, rand) };
  return {
    ...c,
    id,
    family: c.id,
    transforms,
    // Each variant is its own client (own IP and token in the harness), as a campaign
    // rotating through proxies would be. Keeps rate scoring out of what's measured.
    ip: undefined,
    requests: [...c.requests.slice(0, -1), target],
  };
}
