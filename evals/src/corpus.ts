import { readFileSync } from "node:fs";
import type { EvalCase } from "./types";

// Loads and validates the JSONL corpus (Node side). A malformed case fails the run
// loudly, with the file and line, rather than silently skewing the numbers.

const FILES = ["attacks.jsonl", "benign.jsonl"];

export function loadCorpus(dir: string): EvalCase[] {
  const cases: EvalCase[] = [];
  const ids = new Set<string>();
  for (const file of FILES) {
    const lines = readFileSync(`${dir}/${file}`, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      const where = `${file}:${i + 1}`;
      let c: EvalCase;
      try {
        c = JSON.parse(line);
      } catch {
        throw new Error(`${where}: not valid JSON`);
      }
      if (!c.id || ids.has(c.id)) throw new Error(`${where}: missing or duplicate id`);
      if (c.label !== "attack" && c.label !== "benign") throw new Error(`${where}: bad label`);
      if (!c.class || !Array.isArray(c.requests) || !c.requests.length)
        throw new Error(`${where}: needs a class and at least one request`);
      for (const r of c.requests) {
        if (!/^[A-Z]+$/.test(r.method) || !r.path?.startsWith("/"))
          throw new Error(`${where}: each request needs a METHOD and a /path`);
      }
      ids.add(c.id);
      cases.push(c);
    });
  }
  return cases;
}
