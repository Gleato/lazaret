// Path normalisation is a security boundary, not a convenience. Route rules like
// `BLOCK /admin/*` are only as strong as our agreement with the origin about what
// path a request "really" targets. Attackers exploit disagreements:
//   /api/..%2fadmin/x   encoded slash the origin decodes but we might not
//   /api\admin          backslash that IIS-style origins treat as a separator
//   /%61dmin            percent-encoded letters
//   //admin             empty segments
// So we resolve the path as aggressively as any origin plausibly would, match on
// that, *forward that same normalised path*, and record every trick we undid as an
// anomaly the gate scores. (WHATWG URL has already resolved literal and %2e dot
// segments before we get here.)

export type PathAnomaly =
  | "encoded_separator"
  | "backslash"
  | "double_encoding"
  | "malformed_encoding"
  | "empty_segment"
  | "dot_segment"
  | "null_byte";

export interface NormalizedPath {
  /** Canonical, decoded, case-preserved path, always starting with `/`. */
  path: string;
  segments: string[];
  anomalies: PathAnomaly[];
}

export function normalizePath(pathname: string): NormalizedPath {
  const anomalies = new Set<PathAnomaly>();
  if (/%2f|%5c/i.test(pathname)) anomalies.add("encoded_separator");
  if (pathname.includes("\\")) anomalies.add("backslash");
  if (/\/\/|\\\\/.test(pathname)) anomalies.add("empty_segment");

  const unified = pathname.replace(/%2f|%5c/gi, "/").replaceAll("\\", "/");
  const segments: string[] = [];
  for (const raw of unified.split("/")) {
    if (raw === "") continue;
    let segment = raw;
    try {
      segment = decodeURIComponent(raw);
      // Still percent-encoded after one decode → it was encoded twice.
      if (/%[0-9a-f]{2}/i.test(segment)) anomalies.add("double_encoding");
    } catch {
      anomalies.add("malformed_encoding");
    }
    if (segment.includes("\0")) anomalies.add("null_byte");
    if (segment === "." || segment === "..") {
      anomalies.add("dot_segment");
      if (segment === "..") segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return { path: `/${segments.join("/")}`, segments, anomalies: [...anomalies] };
}

/** Re-encode a normalised path for forwarding, so origin sees exactly what we matched. */
export function encodePath(segments: string[]): string {
  return `/${segments.map(encodeURIComponent).join("/")}`;
}
