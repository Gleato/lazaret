// gleator.com. A static Astro site: every page is pre-rendered, and the live demo
// is a few small TypeScript islands that talk to the Tidewater demo over HTTP and a
// WebSocket (PUBLIC_DEMO_ORIGIN, set per environment).
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://gleator.com",
  output: "static",
  // Pages build as /projects/lazaret.html, not /projects/lazaret/index.html: Workers
  // static assets then serve /projects/lazaret directly instead of 307-ing to a
  // trailing slash, so links and the canonical URL point at the page itself (M9 launch).
  build: { format: "file" },
  server: { port: 4321 },
});
