// Parametric rebuild of the double-G monogram.
// Why parametric: the original was hand-traced, so every curve here is a true
// circular arc or straight line, unioned into one compound path (no live strokes).
// Coordinates are the ORIGINAL image's pixels so the mark can be overlaid on it to
// check fidelity; the export script re-centres it afterwards.
const paper = require('paper/dist/paper-core');
paper.setup(new paper.Size(1016, 1014));
const { Path, Point } = paper;

const P = {
  w: 72,                       // one stroke weight for the whole line (original drifted 65-76)
  c1: [585, 427], r1: 216,     // upper G centre-line
  c2: [478, 607], r2: 190,     // lower G centre-line
  barY: 457.5,                 // upper G crossbar centre-line
  fillet: 130,                 // S-curve radius replacing the original's kink at crossbar/lower G
  termAngle: -39.5,              // upper G terminal, degrees from +x
  gap: 11,                     // over/under gap at the two crossings
  flatY: 595,                  // flat counter edge kept from the original (lower G's crossbar)
  star: { c: [785, 373], R: 41 },   // re-seated so its gaps to terminal and crossbar match
};

const pol = (c, r, deg) => new Point(c[0] + r * Math.cos(deg * Math.PI / 180), c[1] + r * Math.sin(deg * Math.PI / 180));
const disc = (c, r) => new Path.Circle(new Point(c), r);
const ring = (c, r, w) => disc(c, r + w).subtract(disc(c, r - w), { insert: false });
const poly = (pts) => { const p = new Path({ segments: pts, closed: true, insert: false }); return p; };

// Pie slice from a0 to a1 (clockwise in screen space); radius well beyond any ring it cuts.
function wedge(c, a0, a1, R = 1400) {
  const pts = [new Point(c)];
  const n = Math.ceil((a1 - a0) / 20);
  for (let i = 0; i <= n; i++) pts.push(pol(c, R, a0 + (a1 - a0) * i / n));
  return poly(pts);
}
const sector = (c, r, w, a0, a1) => ring(c, r, w).intersect(wedge(c, a0, a1), { insert: false });

function star(c, R, rot = -90) {
  const r = R * 0.382; // regular pentagram ratio: the original's was slightly lopsided
  const pts = [];
  for (let i = 0; i < 10; i++) pts.push(pol(c, i % 2 ? r : R, rot + i * 36));
  return poly(pts);
}

function build({ weave = true, flat = true, gap = P.gap, starR = P.star.R } = {}) {
  const { w, c1, r1, c2, r2, barY, fillet } = P;
  const hw = w / 2;

  // Upper G: ring from the terminal, counter-clockwise, round to the crossbar's top edge.
  const barTop = barY - hw;
  const barBot = barY + hw;
  const rightAt = Math.asin((barTop - c1[1]) / (r1 + hw)) * 180 / Math.PI;
  let g1 = sector(c1, r1, hw, rightAt, 360 + P.termAngle);
  g1 = g1.unite(disc(pol(c1, r1, P.termAngle), hw), { insert: false });

  // S-curve: tangent to the lower G's ring and to the crossbar, so the line never kinks.
  const dy = c2[1] - (barY - fillet);
  const fx = c2[0] + Math.sqrt((r2 + fillet) ** 2 - dy ** 2);
  const f = [fx, barY - fillet];
  const tanDeg = Math.atan2(f[1] - c2[1], f[0] - c2[0]) * 180 / Math.PI;       // on lower ring
  const bar = poly([[fx, barTop], [c1[0] + r1 + hw + 5, barTop], [c1[0] + r1 + hw + 5, barBot], [fx, barBot]])
    .intersect(disc(c1, r1 + hw), { insert: false });
  const s = sector(f, fillet, hw, 90, 180 + tanDeg);

  // Lower G: ring from the S-curve, counter-clockwise, round to where it meets the upper G.
  const endDeg = 0;                        // must finish inside the upper G's bottom stroke, or a butt end shows
  let g2top = sector(c2, r2, hw, 180, 360 + tanDeg);
  let g2bot = sector(c2, r2, hw, endDeg, 180);

  // Flat counter edge: the lower G's crossbar, surfacing inside the upper G's bowl.
  let upper = g1;
  if (flat) {
    const chord = poly([[c1[0] - 140, P.flatY], [c1[0] + 140, P.flatY], [c1[0] + 140, c1[1] + r1 + 10], [c1[0] - 140, c1[1] + r1 + 10]])
      .intersect(disc(c1, r1 + 5), { insert: false });
    upper = upper.unite(chord, { insert: false });
  }

  if (weave) {
    // Over/under: lower G passes OVER the upper at top-left, UNDER at bottom-right.
    const halo = ring(c2, r2, hw + gap).intersect(poly([[250, 330], [470, 330], [470, 560], [250, 560]]), { insert: false });
    upper = upper.subtract(halo, { insert: false });
    g2bot = g2bot.subtract(disc(c1, r1 + hw + gap), { insert: false });
  }

  let line = upper.unite(bar, { insert: false }).unite(s, { insert: false })
    .unite(g2top, { insert: false }).unite(g2bot, { insert: false });
  return { line, star: star(P.star.c, starR) };
}
module.exports = { P, build, paper, disc, ring };
