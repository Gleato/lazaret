import attacksJsonl from "../../../../../../evals/corpus/attacks.jsonl?raw";
import benignJsonl from "../../../../../../evals/corpus/benign.jsonl?raw";
import { buildExhibits, type Exhibit } from "./exhibits";

export type { Exhibit, ExhibitStep } from "./exhibits";

// The console's exhibits, built from the eval corpus at build time (see exhibits.ts).
export function loadExhibits(): Exhibit[] {
  return buildExhibits([attacksJsonl, benignJsonl]);
}
