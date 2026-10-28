// A minimal method + path router. Tidewater deliberately doesn't import Lazaret's
// matcher: the point of the demo is that an ordinary app only needs
// `@gleator/lazaret/origin` to sit behind Lazaret.

export interface Route<C> {
  method: string;
  /** Literal segments and `:param` segments, e.g. `/api/tickets/:id/replies`. */
  path: string;
  handler: (ctx: C, params: Record<string, string>) => Promise<Response>;
}

export function matchRoute<C>(
  routes: Route<C>[],
  method: string,
  pathname: string,
): { route: Route<C>; params: Record<string, string> } | { allowed: string[] } | null {
  const segments = pathname.split("/").filter(Boolean);
  const allowed: string[] = [];
  for (const route of routes) {
    const parts = route.path.split("/").filter(Boolean);
    if (parts.length !== segments.length) continue;
    const params: Record<string, string> = {};
    const ok = parts.every((p, i) => {
      const seg = segments[i] as string;
      if (p.startsWith(":")) {
        params[p.slice(1)] = decodeURIComponent(seg);
        return true;
      }
      return p === seg;
    });
    if (!ok) continue;
    if (route.method === method) return { route, params };
    allowed.push(route.method);
  }
  return allowed.length ? { allowed } : null;
}
