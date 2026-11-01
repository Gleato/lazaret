#!/usr/bin/env bash
# Packs the built package and checks it the way a stranger would use it (M8): install
# the tarball into an empty Worker project, typecheck it under both Bundler and
# NodeNext resolution with lib checking on (so the published .d.ts files resolve),
# and bundle it with wrangler. Run after `npm run build`: npm run smoke:pack
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

(cd "$here/dist" && npm pack --silent --pack-destination "$tmp" >/dev/null)
cd "$tmp"
echo '{ "name": "consumer-smoke", "private": true, "type": "module" }' > package.json
npm install --silent --no-audit --no-fund --prefer-offline ./gleator-lazaret-*.tgz
cp "$here/scripts/smoke-consumer.ts" worker.ts
for mode in Bundler NodeNext; do
  module=$([ "$mode" = Bundler ] && echo ESNext || echo NodeNext)
  cat > "tsconfig.$mode.json" <<JSON
{ "compilerOptions": { "target": "ES2023", "lib": ["ES2023"], "module": "$module",
  "moduleResolution": "$mode", "strict": true, "noEmit": true, "skipLibCheck": false,
  "types": [] },
  "files": ["worker.ts", "$repo/node_modules/@cloudflare/workers-types/index.d.ts"] }
JSON
  "$repo/node_modules/.bin/tsc" -p "tsconfig.$mode.json"
  echo "typecheck ($mode): ok"
done
echo '{ "name": "consumer-smoke", "main": "worker.ts", "compatibility_date": "2026-10-01" }' > wrangler.jsonc
"$repo/node_modules/.bin/wrangler" deploy --dry-run --outdir out >/dev/null
echo "wrangler bundle: ok"
