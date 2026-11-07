# Double G monogram

Every curve is a true circular arc or straight line. Regenerate the SVGs with
`NODE_PATH=<folder containing paper> node source/export.js`; change geometry in `source/geometry.js`.

| Use | File |
| --- | --- |
| Primary (square) | `svg/gg-badge-square.svg` |
| Primary (round, for avatars and stickers) | `svg/gg-badge-round.svg` |
| Mark alone on light / dark backgrounds | `svg/gg-mark-dark.svg`, `svg/gg-mark-light.svg` |
| Displayed at 48–96px | `svg/gg-small.svg` (solid crossings, no keyline, larger star) |
| Favicon, under 48px | `gg-favicon-round.svg` (the site uses this), `gg-favicon.svg` (square) |

Colours, sampled from the original: ink `#222020`, paper `#fefafa`.
The woven gaps and keyline need at least 96px on screen, so switch to the small master below that.
Keep clear space around the mark equal to one stroke width of the G on every side.
