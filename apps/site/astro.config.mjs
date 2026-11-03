// gleator.com. A static Astro site: every page is pre-rendered, and the live demo
// is a few small TypeScript islands that talk to the Tidewater demo over HTTP and a
// WebSocket (PUBLIC_DEMO_ORIGIN, set per environment).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { defineConfig } from "astro/config";
import { loadEnv } from "vite";
import { astroCsp } from "./csp.ts";

// The demo origin decides the policy's connect-src, so read it the way the pages do.
const { PUBLIC_DEMO_ORIGIN } = loadEnv(process.env.NODE_ENV ?? "production", process.cwd(), "");
const demoOrigin = PUBLIC_DEMO_ORIGIN ?? "http://localhost:8787";

// Astro hashes the scripts it bundles, but not `is:inline` ones. Our only one is
// read from its own file by Folder.astro, so hashing that file here keeps the two in step.
const inlineHashes = ["./src/home/folder-preopen.js"].map(
  (f) =>
    `sha256-${createHash("sha256")
      .update(readFileSync(new URL(f, import.meta.url)))
      .digest("base64")}`,
);

export default defineConfig({
  site: "https://gleator.com",
  output: "static",
  // Pages build as /projects/lazaret.html, not /projects/lazaret/index.html: Workers
  // static assets then serve /projects/lazaret directly instead of 307-ing to a
  // trailing slash, so links and the canonical URL point at the page itself (M9 launch).
  build: { format: "file" },
  server: { port: 4321 },
  // Hashed script/style CSP in every page's <meta> (csp.mjs explains the policy).
  security: { csp: astroCsp(demoOrigin, inlineHashes) },
});
