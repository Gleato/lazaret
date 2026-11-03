// "How is this different from what's out there?" on the Projects sheet.
//
// Researched 2026-11-02 from each vendor's own docs (sources below), and kept to rows
// a sceptical engineer can check. Two rows were left out on purpose:
//   - "an LLM judges each request": NeMo's self-check rail does too, and Lakera's model
//     type isn't documented, so it wouldn't single Lazaret out;
//   - LLM Guard: archived and unmaintained, so not a fair column.
// The footnote says where the others win (latency, scale, maturity).

export type Mark = "yes" | "no" | "partial";

export interface Cell {
  mark: Mark;
  /** Shown on hover / to screen readers: why this cell says what it says. */
  why: string;
}

export interface Product {
  name: string;
  short: string;
  source: string;
}

export const PRODUCTS: Product[] = [
  {
    name: "Cloudflare WAF and Firewall for AI",
    short: "Cloudflare",
    source: "https://developers.cloudflare.com/waf/detections/firewall-for-ai/",
  },
  { name: "Lakera Guard", short: "Lakera Guard", source: "https://docs.lakera.ai/docs/api/guard" },
  {
    name: "NVIDIA NeMo Guardrails",
    short: "NeMo Guardrails",
    source: "https://github.com/NVIDIA/NeMo-Guardrails",
  },
];

export interface Row {
  label: string;
  lazaret: Cell;
  others: [Cell, Cell, Cell];
}

export const ROWS: Row[] = [
  {
    label: "Guards writes to an ordinary API, not only LLM prompts",
    lazaret: { mark: "yes", why: "Sits in front of any HTTP origin." },
    others: [
      { mark: "yes", why: "The WAF does; Firewall for AI only scans endpoints labelled as LLM." },
      { mark: "no", why: "Screens LLM chat messages." },
      { mark: "no", why: "Built for LLM-based conversational systems." },
    ],
  },
  {
    label: "Holds a write and reviews it before it reaches your database",
    lazaret: {
      mark: "yes",
      why: "Writes wait in the ledger until a verdict; the client gets a receipt.",
    },
    others: [
      { mark: "no", why: "Blocks or allows inline." },
      { mark: "no", why: "Screens inline." },
      { mark: "no", why: "Rails run inline." },
    ],
  },
  {
    label: "Judges a request in context of the ones around it",
    lazaret: {
      mark: "yes",
      why: "Batch review, per-session behaviour, and taint for follow-up writes.",
    },
    others: [
      { mark: "partial", why: "Rate limits and leaked-credential checks." },
      { mark: "partial", why: "Uses earlier chat history as context." },
      { mark: "partial", why: "Dialogue state." },
    ],
  },
  {
    label: "Stops prompt injection planted in data for a later AI agent",
    lazaret: { mark: "yes", why: "Caught when it is written, before it lands in the data." },
    others: [
      { mark: "no", why: "Targets direct prompt injection." },
      { mark: "partial", why: "Can screen documents, when they are read." },
      { mark: "partial", why: "Retrieval rails check chunks when they are read." },
    ],
  },
  {
    label: "Learns new rules from its own confirmed verdicts",
    lazaret: { mark: "yes", why: "Verdicts are distilled into rules, backtested, then promoted." },
    others: [
      { mark: "no", why: "Rulesets are maintained by Cloudflare." },
      { mark: "no", why: "No documented rule learning." },
      { mark: "no", why: "Rails are configured by hand." },
    ],
  },
  {
    label: "Open source and self-hostable",
    lazaret: { mark: "yes", why: "MIT licence, on GitHub and npm." },
    others: [
      { mark: "no", why: "Managed service." },
      { mark: "partial", why: "Self-hosting needs an enterprise licence." },
      { mark: "yes", why: "Apache-2.0." },
    ],
  },
];

export const FOOTNOTE =
  "Where they win: each of these answers in milliseconds and runs at far larger scale. Holding a write for review adds seconds before it commits, by design. Checked against each vendor’s docs, November 2026.";
