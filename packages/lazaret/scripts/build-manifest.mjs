// Writes dist/package.json, the manifest that is actually published (M8).
//
// In the repo, this package's `exports` point at src/*.ts, so the demo, site, evals
// and tests run straight from source with no build step. The published package must
// point at compiled JS and declarations instead. Rather than teach every tool here a
// custom export condition, the build emits dist/ (tsconfig.build.json) and this
// script derives dist/'s manifest from the repo one, so `npm publish ./dist` ships
// only built files. Same name, version and dependencies: one source of truth.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

const exports = {};
for (const [subpath, source] of Object.entries(pkg.exports)) {
  const base = source.replace(/^\.\/src\//, "./").replace(/\.ts$/, "");
  exports[subpath] = { types: `${base}.d.ts`, import: `${base}.js` };
}

const published = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  author: pkg.author,
  homepage: pkg.homepage,
  repository: pkg.repository,
  bugs: pkg.bugs,
  keywords: pkg.keywords,
  type: "module",
  sideEffects: false,
  exports,
  types: exports["."].types,
  engines: pkg.engines,
  dependencies: pkg.dependencies,
};
writeFileSync("dist/package.json", `${JSON.stringify(published, null, 2)}\n`);
copyFileSync("README.md", "dist/README.md");
copyFileSync("LICENSE", "dist/LICENSE");
copyFileSync("CHANGELOG.md", "dist/CHANGELOG.md");
console.log(
  `dist/package.json: ${pkg.name}@${pkg.version}, ${Object.keys(exports).length} entry points`,
);
