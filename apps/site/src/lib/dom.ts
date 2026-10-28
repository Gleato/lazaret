// Tiny DOM helpers for the live islands. Everything the demo shows from the network
// (ticket bodies, paths, model rationales) can be attacker text, so it only ever goes
// in through `textContent`: there is no innerHTML anywhere in the live code.

type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | undefined | null> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(
      typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c,
    );
  }
}

const SVG = "http://www.w3.org/2000/svg";

function svg(name: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export type FlagKind = "Q" | "B" | "C" | "none";

/** What each signal flag stands for on this site (International Code of Signals). */
export const FLAG_MEANING: Record<FlagKind, string> = {
  Q: "Held for a human (Q, the quarantine flag)",
  B: "Dropped (B, dangerous cargo)",
  C: "Admitted (C, affirmative)",
  none: "Waiting",
};

/**
 * A small signal flag on a staff. Shapes match the real flags, so the meaning never
 * rests on colour alone: Q is a plain square, B a swallowtail, C has five stripes.
 */
export function flag(kind: FlagKind, size = 18): SVGElement {
  const root = svg("svg", {
    viewBox: "0 0 24 20",
    width: size * 1.2,
    height: size,
    class: `flag flag-${kind}`,
    role: "img",
    "aria-label": FLAG_MEANING[kind],
  });
  root.append(svg("rect", { x: 1, y: 1, width: 1.4, height: 18, fill: "currentColor" }));
  if (kind === "Q") {
    root.append(svg("rect", { x: 3, y: 2, width: 18, height: 12, fill: "var(--q)" }));
  } else if (kind === "B") {
    root.append(svg("path", { d: "M3 2h18l-5 6 5 6H3z", fill: "var(--b)" }));
  } else if (kind === "C") {
    const stripes = ["var(--c)", "#fff", "var(--b)", "#fff", "var(--c)"];
    stripes.forEach((fill, i) => {
      root.append(svg("rect", { x: 3, y: 2 + i * 2.4, width: 18, height: 2.4, fill }));
    });
  } else {
    root.append(
      svg("path", {
        d: "M3 2h18v12H3z",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": 1,
        "stroke-dasharray": "2 2",
      }),
    );
  }
  return root;
}
