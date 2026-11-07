// Writes every SVG master. Run: NODE_PATH=<dir with paper> node export.js
// Every mark is baked to plain filled paths, so files open identically in any tool.
const fs = require('fs'), path = require('path');
const { build, paper } = require('./geometry.js');
const { Matrix, Point } = paper;
const INK = '#222020', PAPER = '#fefafa'; // sampled from the original artwork
const OUT = path.resolve(__dirname, '..', 'svg');
fs.mkdirSync(OUT, { recursive: true });

const clean = (d) => d.replace(/-?\d*\.\d+(e-?\d+)?/g, (n) => String(+(+n).toFixed(3)));

// Bake a variant so its bounding box is centred on (cx, cy) at the given height.
function mark({ variant = {}, height, cx = 500, cy = 500, fill = INK }) {
  const m = build(variant);
  const b = m.line.bounds.unite(m.star.bounds);
  const s = height / b.height;
  const mat = new Matrix().translate(cx, cy).scale(s).translate(-b.center.x, -b.center.y);
  m.line.transform(mat); m.star.transform(mat);
  return `<path fill="${fill}" fill-rule="evenodd" d="${clean(m.line.pathData)}"/><path fill="${fill}" d="${clean(m.star.pathData)}"/>`;
}
const svg = (name, body) => fs.writeFileSync(path.join(OUT, name),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" role="img"><title>Double G monogram with star</title>${body}</svg>\n`);

const SMALL = { weave: false, starR: 47 };  // gaps and hairlines fill in below ~96px, so drop them
const seal = (fg, bg) => `<circle cx="500" cy="500" r="454" fill="none" stroke="${fg}" stroke-width="5"/><circle cx="500" cy="500" r="432" fill="${fg}"/>`;

svg('gg-badge-square.svg', `<rect width="1000" height="1000" fill="${INK}"/>${seal(PAPER, INK)}${mark({ height: 620 })}`);
svg('gg-badge-round.svg', `<circle cx="500" cy="500" r="500" fill="${INK}"/>${seal(PAPER, INK)}${mark({ height: 620 })}`);
svg('gg-mark-dark.svg', mark({ height: 800 }));
svg('gg-mark-light.svg', mark({ height: 800, fill: PAPER }));
svg('gg-small.svg', `<rect width="1000" height="1000" fill="${INK}"/><circle cx="500" cy="500" r="470" fill="${PAPER}"/>${mark({ variant: SMALL, height: 690 })}`);

// Favicon: no disc, because at 16-32px every pixel has to go to the letters themselves.
svg('gg-favicon.svg', `<rect width="1000" height="1000" fill="${PAPER}"/>${mark({ variant: SMALL, height: 920 })}`);

// Review sheet: primary, reversal, one-colour, and the small master at real sizes.
const inner = (f) => fs.readFileSync(path.join(OUT, f), 'utf8').replace(/<title>.*?<\/title>/, '');
const place = (f, x, y, s) => inner(f).trim().replace('<svg ', `<svg x="${x}" y="${y}" width="${s}" height="${s}" `);
fs.writeFileSync(path.resolve(__dirname, '..', 'review-sheet.svg'),
`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">
<rect width="1600" height="1000" fill="#e9e7e6"/>
${place('gg-badge-square.svg', 60, 60, 880)}
<rect x="1000" y="60" width="260" height="430" fill="${PAPER}"/>${place('gg-mark-dark.svg', 1010, 155, 240)}
<rect x="1280" y="60" width="260" height="430" fill="${INK}"/>${place('gg-mark-light.svg', 1290, 155, 240)}
<rect x="1000" y="510" width="540" height="430" fill="${PAPER}"/>
${place('gg-small.svg', 1040, 640, 128)}${place('gg-small.svg', 1208, 668, 96)}${place('gg-small.svg', 1344, 684, 64)}${place('gg-small.svg', 1448, 700, 32)}${place('gg-small.svg', 1500, 708, 16)}
</svg>\n`);
