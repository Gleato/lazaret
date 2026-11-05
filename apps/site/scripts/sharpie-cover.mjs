// Bakes the lettering on the folder's front cover into src/home/parts/cover-sharpie*.svg.
// Run it after changing the copy: node apps/site/scripts/sharpie-cover.mjs
//
// The cover is meant to look written by hand with a marker (the user's request, 2026-11-05).
// A live handwriting font gives it away, because every "e" is the same "e". So each letter
// here is its own shape: the outline of Covered By Your Grace (SIL OFL 1.1, Kimberly
// Geswein) is bent by a little seeded noise per letter, then tilted and nudged. The output
// is plain paths: no web font on the page, and no SVG filter for the cover to re-rasterise
// as it swings open. The seeds are fixed, so a re-run gives the same writing.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, "..");
const FONT = resolve(
  site,
  "../../node_modules/@fontsource/covered-by-your-grace/files/covered-by-your-grace-latin-400-normal.woff",
);

/* One pen, so one line weight. A font thins as it shrinks; a marker doesn't, so the small
   lines take a heavier outline than the name to end up nearly as thick.
   Two layouts, because the cover changes shape: a phone's is taller than it is wide, and one
   long line there left the name small and the card mostly empty. */
const LAYOUTS = [
  {
    file: "cover-sharpie.svg",
    width: 1500,
    height: 560,
    lines: [
      { text: "Ridge Gleaton", size: 262, x: 16, y: 226, slope: 0.028, seed: 7, pen: 3 },
      {
        text: "Software engineer, Charleston, SC",
        size: 112,
        x: 30,
        y: 398,
        slope: 0.02,
        seed: 21,
        pen: 3.5,
      },
      { text: "File no. 001", size: 112, x: 44, y: 530, slope: 0.012, seed: 33, pen: 3.5 },
    ],
  },
  {
    file: "cover-sharpie-tall.svg",
    width: 800,
    height: 880,
    lines: [
      { text: "Ridge", size: 262, x: 14, y: 196, slope: 0.03, seed: 7, pen: 2.5 },
      { text: "Gleaton", size: 262, x: 30, y: 460, slope: 0.024, seed: 12, pen: 2.5 },
      { text: "Software engineer,", size: 100, x: 34, y: 616, slope: 0.02, seed: 21, pen: 3 },
      { text: "Charleston, SC", size: 100, x: 46, y: 730, slope: 0.018, seed: 26, pen: 3 },
      { text: "File no. 001", size: 100, x: 40, y: 850, slope: 0.012, seed: 33, pen: 3 },
    ],
  },
];
/* Keeps the file small. Half a unit here is well under a pixel on the cover. */
const TOLERANCE = 1;

function mulberry(seed) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Curves to points, one list per closed contour. */
function contours(commands) {
  const all = [];
  let cur = [];
  let last = [0, 0];
  const curve = (at) => {
    for (let i = 1; i <= 6; i++) cur.push(at(i / 6));
  };
  for (const c of commands) {
    if (c.type === "M") {
      if (cur.length) all.push(cur);
      cur = [[c.x, c.y]];
    } else if (c.type === "L") {
      cur.push([c.x, c.y]);
    } else if (c.type === "Q") {
      const [a, b] = last;
      curve((t) => [
        (1 - t) ** 2 * a + 2 * t * (1 - t) * c.x1 + t ** 2 * c.x,
        (1 - t) ** 2 * b + 2 * t * (1 - t) * c.y1 + t ** 2 * c.y,
      ]);
    } else if (c.type === "C") {
      const [a, b] = last;
      curve((t) => [
        (1 - t) ** 3 * a + 3 * t * (1 - t) ** 2 * c.x1 + 3 * t ** 2 * (1 - t) * c.x2 + t ** 3 * c.x,
        (1 - t) ** 3 * b + 3 * t * (1 - t) ** 2 * c.y1 + 3 * t ** 2 * (1 - t) * c.y2 + t ** 3 * c.y,
      ]);
    }
    if (c.type !== "Z") last = [c.x, c.y];
  }
  if (cur.length) all.push(cur);
  return all;
}

/** Douglas-Peucker. */
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  const len = Math.hypot(bx - ax, by - ay) || 1;
  let far = 0;
  let at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((pts[i][0] - ax) * (by - ay) - (pts[i][1] - ay) * (bx - ax)) / len;
    if (d > far) {
      far = d;
      at = i;
    }
  }
  if (far <= tol) return [pts[0], pts[pts.length - 1]];
  return [...simplify(pts.slice(0, at + 1), tol).slice(0, -1), ...simplify(pts.slice(at), tol)];
}

function toPath(points) {
  const pts = points.map(([x, y]) => [Math.round(x), Math.round(y)]);
  let d = `M${pts[0][0]} ${pts[0][1]}l`;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dy = pts[i][1] - pts[i - 1][1];
    if (dx === 0 && dy === 0) continue;
    d += `${i > 1 && dx >= 0 ? " " : ""}${dx}${dy >= 0 ? " " : ""}${dy}`;
  }
  return `${d}z`;
}

function writeLine(font, { text, size, x, y, slope, seed }) {
  const r = mulberry(seed);
  const rise = -Math.atan(slope);
  const glyphs = font.stringToGlyphs(text);
  let pen = x;
  let d = "";
  glyphs.forEach((glyph, i) => {
    const phase = [r() * 6.3, r() * 6.3, r() * 6.3, r() * 6.3];
    const freq = (2 + r() * 2) / size;
    const amp = size * 0.012;
    const tilt = (r() - 0.5) * 0.07 + rise;
    const sx = 1 + (r() - 0.5) * 0.1;
    const sy = 1 + (r() - 0.5) * 0.1;
    const drop = (r() - 0.5) * size * 0.035;
    const advance = (glyph.advanceWidth / font.unitsPerEm) * size;
    const cx = pen + advance / 2;
    const cy = y - (pen - x) * slope + drop;
    const place = ([gx, gy]) => {
      let lx = (gx - advance / 2) * sx;
      let ly = gy * sy;
      lx +=
        amp * Math.sin(lx * freq + ly * freq * 0.7 + phase[0]) +
        amp * 0.5 * Math.sin(ly * freq * 2.1 + phase[1]);
      ly +=
        amp * Math.sin(lx * freq * 1.3 - ly * freq * 0.6 + phase[2]) +
        amp * 0.5 * Math.sin(lx * freq * 2.3 + phase[3]);
      return [
        cx + lx * Math.cos(tilt) - ly * Math.sin(tilt),
        cy + lx * Math.sin(tilt) + ly * Math.cos(tilt),
      ];
    };
    for (const contour of contours(glyph.getPath(0, 0, size).commands)) {
      // A contour ends where it starts, which Douglas-Peucker can't take, so do two halves.
      const placed = contour.map(place);
      const mid = placed.length >> 1;
      d += toPath([
        ...simplify(placed.slice(0, mid + 1), TOLERANCE).slice(0, -1),
        ...simplify(placed.slice(mid), TOLERANCE),
      ]);
    }
    const next = glyphs[i + 1];
    const kern = next ? (font.getKerningValue(glyph, next) / font.unitsPerEm) * size : 0;
    // The font's word space is wide for fast writing.
    const space = glyph.unicode === 32 ? -advance * 0.38 : 0;
    pen += advance + kern + space + (r() - 0.5) * size * 0.012;
  });
  return d;
}

const buffer = readFileSync(FONT);
const font = opentype.parse(
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
);
for (const { file, width, height, lines } of LAYOUTS) {
  const paths = lines
    .map((line) => `<path stroke-width="${line.pen}" d="${writeLine(font, line)}"/>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" fill="currentColor" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${paths}</svg>\n`;
  const out = resolve(site, "src/home/parts", file);
  writeFileSync(out, svg);
  console.log(`${out}: ${svg.length} bytes`);
}
