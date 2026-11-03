// gleator.com's Content Security Policy (M9 launch), in one place.
//
// Two halves, because a policy delivered in a <meta> tag can't carry every directive:
//   - astroCsp(): Astro's built-in CSP (astro.config.mjs `security.csp`). At build time
//     Astro hashes every <script> and <style> it emits, including the inline ones, and
//     writes the policy into each page's <meta http-equiv>. So no inline script runs
//     unless it is one we shipped.
//   - EDGE_HEADERS: what only a response header can say (frame-ancestors: no one may
//     frame the site), plus the usual hardening headers. edge/worker.ts adds them.
//
// Deliberate allowance: inline style *attributes* (style-src-attr 'unsafe-inline').
// Several components set CSS custom properties per element (bar widths, tab colours,
// logo heights), and the long page's ledger sets a risk bar's width. A style attribute
// can't run script; and every string from the network goes in through textContent
// (src/lib/dom.ts), so an attacker can't write one. <style> elements stay hashed.
//
// Imported by astro.config.mjs (Vite loads the config, so .ts is fine), the edge worker
// and the tests.

/** Cloudflare Turnstile: its script and its challenge iframe. */
export const TURNSTILE = "https://challenges.cloudflare.com";

/**
 * Cloudflare Web Analytics. In production Cloudflare injects its beacon script into every
 * page, and the beacon reports to cloudflareinsights.com (the demo's CSP allows the same,
 * M8). Found at the M9 launch: it never runs locally, only on gleator.com.
 */
export const ANALYTICS = {
  script: "https://static.cloudflareinsights.com",
  report: "https://cloudflareinsights.com",
};

/**
 * @param demoOrigin The Tidewater demo (PUBLIC_DEMO_ORIGIN): fetched over HTTP for the
 *   console and status, and over a WebSocket for the live ledger.
 * @param inlineScriptHashes Hashes of our own `is:inline` scripts, which Astro doesn't
 *   hash for us (computed from their files in astro.config.mjs).
 */
export function astroCsp(demoOrigin: string, inlineScriptHashes: `sha256-${string}`[] = []) {
  const demo = new URL(demoOrigin);
  const socket = `${demo.protocol === "https:" ? "wss:" : "ws:"}//${demo.host}`;
  return {
    algorithm: "SHA-256" as const,
    directives: [
      "default-src 'self'",
      `connect-src 'self' ${demo.origin} ${socket} ${ANALYTICS.report}`,
      // data: is the paper grain, an inline SVG used as a CSS background.
      "img-src 'self' data:",
      "font-src 'self'",
      `frame-src ${TURNSTILE}`,
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ],
    scriptDirective: {
      resources: ["'self'", TURNSTILE, ANALYTICS.script],
      hashes: inlineScriptHashes,
    },
    styleDirective: {
      resources: ["'self'", { resource: "'unsafe-inline'", kind: "attribute" as const }],
    },
  };
}

/** Response headers the edge worker adds to every page and asset. */
export const EDGE_HEADERS: Record<string, string> = {
  // The one CSP directive a <meta> policy ignores; it combines with the page's own.
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};
