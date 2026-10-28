// Results travel from the in-worker eval test to the Node reporter as task meta.
// A module file (it imports), so this augments vitest's types instead of replacing them.
import "vitest";

declare module "vitest" {
  interface TaskMeta {
    evalResult?: unknown;
  }
}
