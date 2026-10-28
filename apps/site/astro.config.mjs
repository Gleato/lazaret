// gleator.com. A static Astro site: every page is pre-rendered, and the live demo
// is a few small TypeScript islands that talk to the Tidewater demo over HTTP and a
// WebSocket (PUBLIC_DEMO_ORIGIN, set per environment).
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://gleator.com",
  output: "static",
  server: { port: 4321 },
});
