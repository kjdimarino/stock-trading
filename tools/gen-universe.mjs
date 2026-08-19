/** Emits src/app/js/02-universe.js from the single source of truth in src/universe.mjs. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS, DEFAULT_WATCHLIST } from '../src/universe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = `/* AUTO-GENERATED from src/universe.mjs by tools/gen-universe.mjs — do not edit. */
(function (PT) {
  'use strict';
  PT.assets = ${JSON.stringify(ASSETS)};
  PT.byId = Object.fromEntries(PT.assets.map(function (a) { return [a.id, a]; }));
  PT.defaultWatchlist = ${JSON.stringify(DEFAULT_WATCHLIST)};
  PT.assetKind = function (id) { var a = PT.byId[id]; return a ? a.kind : 'stock'; };
  PT.isCrypto = function (id) { return PT.assetKind(id) === 'crypto'; };
})(window.PT);
`;
fs.writeFileSync(path.join(ROOT, 'src/app/js/02-universe.js'), out);
console.log(`generated 02-universe.js (${ASSETS.length} assets, ${(out.length / 1024).toFixed(1)}kb)`);
