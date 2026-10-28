// Built-in attack signatures. They run on *canonicalised* text (see inspect.ts:
// URL/HTML-decoded, NFKC-normalised, lowercased), so they're written in lowercase
// and don't need to handle encodings themselves.
//
// Two design rules:
//   1. Every regex is linear-time: no nested quantifiers, no backreferences, and
//      bounded repeats where a quantifier follows a broad class. A ReDoS test
//      (test/signatures.test.ts) runs them all against 100 KB adversarial inputs.
//   2. Weights encode confidence, not severity. A single strong hit (≥ 0.8) trips
//      the Ledger's risk-spike seal and goes to the reviewer. Only stacked evidence
//      crosses the 0.95 hard-block line, because the gate's job is to block the
//      near-certain cases and leave ambiguous ones to the reviewer.

export interface Signature {
  id: string;
  category: string;
  weight: number;
  pattern: RegExp;
}

export const SIGNATURES: readonly Signature[] = [
  // SQL injection
  {
    id: "sqli.union_select",
    category: "sqli",
    weight: 0.8,
    pattern: /\bunion\b[\s(]{1,20}(?:all[\s(]{1,20})?select\b/,
  },
  {
    id: "sqli.tautology",
    category: "sqli",
    weight: 0.75,
    pattern: /['"]\s{0,10}(?:or|and)\s{1,10}['"]?\w{1,20}['"]?\s{0,10}=\s{0,10}['"]?\w{1,20}/,
  },
  {
    id: "sqli.stacked_ddl",
    category: "sqli",
    weight: 0.85,
    pattern: /;\s{0,10}(?:drop|truncate|alter)\s{1,10}(?:table|database)\b/,
  },
  {
    id: "sqli.time_based",
    category: "sqli",
    weight: 0.75,
    pattern: /\b(?:sleep|pg_sleep|benchmark)\s{0,5}\(\s{0,5}\d|waitfor\s{1,10}delay\s{1,10}'/,
  },
  {
    id: "sqli.comment_terminator",
    category: "sqli",
    weight: 0.45,
    pattern: /['"]\s{0,10}(?:--|#|\/\*)/,
  },
  {
    id: "sqli.schema_probe",
    category: "sqli",
    weight: 0.7,
    pattern: /\b(?:information_schema|sqlite_master|pg_catalog)\b/,
  },

  // Cross-site scripting
  { id: "xss.script_tag", category: "xss", weight: 0.85, pattern: /<\s{0,5}script\b/ },
  {
    id: "xss.event_handler",
    category: "xss",
    weight: 0.75,
    pattern: /<[a-z][^>]{0,200}\bon[a-z]{3,20}\s{0,5}=/,
  },
  {
    id: "xss.js_uri_call",
    category: "xss",
    weight: 0.75,
    pattern: /javascript:\s{0,10}[\w$.]{1,40}\s{0,5}\(/,
  },
  {
    id: "xss.embedding_tag",
    category: "xss",
    weight: 0.6,
    pattern: /<\s{0,5}(?:iframe|object|embed)\b|\bsrcdoc\s{0,5}=|data:text\/html/,
  },

  // Path traversal / local file access
  { id: "traversal.dot_dot", category: "path_traversal", weight: 0.7, pattern: /(?:\.\.[/\\]){2}/ },
  {
    id: "traversal.sensitive_file",
    category: "path_traversal",
    weight: 0.8,
    pattern: /\/etc\/(?:passwd|shadow)|\bwin\.ini\b|\/proc\/self\//,
  },

  // Command injection
  {
    id: "cmdi.shell_chain",
    category: "command_injection",
    weight: 0.7,
    pattern:
      /(?:;|&&|\|\|?|\$\(|`)\s{0,5}(?:cat|ls|id|whoami|curl|wget|nc|bash|sh|powershell|rm)\b/,
  },

  // Server-side request forgery
  {
    id: "ssrf.metadata",
    category: "ssrf",
    weight: 0.8,
    pattern: /\b169\.254\.169\.254\b|metadata\.google\.internal/,
  },
  { id: "ssrf.scheme", category: "ssrf", weight: 0.75, pattern: /\b(?:file|gopher|dict):\/\// },
  {
    id: "ssrf.loopback",
    category: "ssrf",
    weight: 0.5,
    pattern: /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/,
  },

  // Template / expression injection
  {
    id: "ssti.template_probe",
    category: "template_injection",
    weight: 0.7,
    pattern: /\{\{\s{0,5}[\w.]{0,40}(?:constructor|__class__|__globals__|config|self\.)/,
  },
  { id: "ssti.jndi", category: "template_injection", weight: 0.95, pattern: /\$\{\s{0,5}jndi:/ },

  // Prompt injection aimed at downstream AI (and at our own reviewer)
  {
    id: "prompt.ignore_instructions",
    category: "prompt_injection",
    weight: 0.8,
    pattern:
      /\bignore\s{1,5}(?:all\s{1,5}|any\s{1,5}|the\s{1,5})?(?:previous|prior|above|earlier|your)\s{1,5}(?:instructions|rules|prompts?|directions)/,
  },
  {
    id: "prompt.override",
    category: "prompt_injection",
    weight: 0.75,
    pattern:
      /\b(?:disregard|forget|override)\s{1,5}(?:all\s{1,5}|your\s{1,5}|the\s{1,5})?(?:previous\s{1,5}|prior\s{1,5})?(?:instructions|rules|guidelines|system\s{1,5}prompt)/,
  },
  {
    id: "prompt.role_tag",
    category: "prompt_injection",
    weight: 0.6,
    pattern:
      /<\/?\s{0,5}(?:system|assistant|instructions?)\s{0,5}>|\[\s{0,5}(?:system|inst)\s{0,5}\]/,
  },
  {
    id: "prompt.persona_switch",
    category: "prompt_injection",
    weight: 0.45,
    pattern:
      /\byou\s{1,5}are\s{1,5}now\s{1,5}(?:in\s{1,5})?(?:a|an|the|developer|dan|unrestricted)\b/,
  },
  {
    id: "prompt.jailbreak_terms",
    category: "prompt_injection",
    weight: 0.4,
    pattern: /\b(?:system\s{1,5}prompt|developer\s{1,5}mode|jailbreak)\b/,
  },
  {
    id: "prompt.money_instruction",
    category: "prompt_injection",
    weight: 0.25,
    pattern: /\b(?:refund|transfer|credit|send|wire)\b[^.\n]{0,60}\$\s{0,2}\d[\d,]{3,12}/,
  },
];
