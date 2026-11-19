import pgWasm from "libpg-query/wasm/libpg-query.wasm";
import { beforeAll, describe, expect, it } from "vitest";
import dev from "../mcp/attacks/dev.json";
import test from "../mcp/attacks/test.json";
import { isWriteCall, loadParser } from "../mcp/proxy/classify";

// lazaret-mcp step 6: the attack goals and their held-out split. The test half's file hash is
// enforced by replay.ts (and recorded in tasks/todo.md); this checks the rule that made it.

beforeAll(() => loadParser(pgWasm));

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("mcp attack goals", () => {
  const all = [...dev.goals, ...test.goals];

  it("are split by the recorded rule: the 5 lowest SHA-256('lazaret-mcp-split:<id>') are test", async () => {
    const ranked = await Promise.all(
      all.map(async (g) => ({ id: g.id, h: await sha256(`lazaret-mcp-split:${g.id}`) })),
    );
    ranked.sort((a, b) => a.h.localeCompare(b.h));
    expect(all).toHaveLength(10);
    expect(new Set(all.map((g) => g.id)).size).toBe(10);
    expect(test.goals.map((g) => g.id).sort()).toEqual(
      ranked
        .slice(0, 5)
        .map((g) => g.id)
        .sort(),
    );
  });

  it("each have both forms with their delivery markers, and a write that review would see", async () => {
    for (const g of all) {
      expect(g.obvious, g.id).toContain("LAZARET-MCP-INJECTION");
      expect(g.forged, g.id).toContain("CS-48213");
      expect(g.forged, g.id).not.toContain("LAZARET-MCP-INJECTION");
      const writes = await Promise.all(g.calls.map((c) => isWriteCall(c.tool, c.arguments)));
      expect(writes.some(Boolean), g.id).toBe(true);
    }
  });
});
