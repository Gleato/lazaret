// Records the live ledger stream into public/recording.json, which the site plays
// when the live demo can't serve (budget spent, or offline). Run it against a demo
// while firing the console's exhibits, then stop it:
//
//   npm run record -w @gleator/site -- --origin http://localhost:8787 --seconds 120 \
//     --source "offline stack, scripted reviewer"
//
// The recording is the redacted public stream (what any visitor sees), so it holds
// nothing private. `source` is shown next to it on the page, so say honestly what
// produced it.
import { writeFileSync } from "node:fs";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(String(process.argv[i]).replace(/^--/, ""), String(process.argv[i + 1]));
}
const origin = args.get("origin") ?? "http://localhost:8787";
const seconds = Number(args.get("seconds") ?? "120");
const source = args.get("source") ?? "offline stack, scripted reviewer";

const url = new URL("/__lazaret/live?after=0", origin);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
const started = Date.now();
const frames: { t: number; frames: unknown[] }[] = [];
const ws = new WebSocket(url);
ws.addEventListener("message", (m) => {
  const batch = JSON.parse(String(m.data)) as { type: string }[];
  // HELLO names the live shard; a recording replays into an empty view instead.
  const kept = batch.filter((f) => f.type !== "HELLO");
  if (kept.length) frames.push({ t: Date.now() - started, frames: kept });
});
ws.addEventListener("open", () => console.log(`recording ${url} for ${seconds} s…`));
setTimeout(() => {
  ws.close();
  // Squash the replayed backlog at the start so playback opens with it, not a wait.
  const out = {
    recordedAt: `${new Date(started).toISOString().slice(0, 16).replace("T", " ")} UTC`,
    source,
    frames,
  };
  writeFileSync(new URL("../public/recording.json", import.meta.url), `${JSON.stringify(out)}\n`);
  console.log(`wrote ${frames.length} frame groups`);
}, seconds * 1000);
