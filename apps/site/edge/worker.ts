// gleator.com's only server code. The site is static (Astro, ./dist); this worker
// exists so www.gleator.com answers with one canonical host instead of a duplicate
// site (canonical links and the demo's CORS allow-list both name the apex).

// Typed structurally (not with workers-types' Fetcher) so the site's own tsconfig,
// which is DOM-based, checks this file through its test.
export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export const CANONICAL_HOST = "gleator.com";

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const url = new URL(request.url);
    if (url.hostname === `www.${CANONICAL_HOST}`) {
      url.hostname = CANONICAL_HOST;
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
