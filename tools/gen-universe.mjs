/** Emits src/app/js/02-universe.js from the single source of truth in src/universe.mjs. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS, DEFAULT_WATCHLIST } from '../src/universe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = `/* AUTO-GENERATED from src/universe.mjs by tools/gen-universe.mjs — do not edit. */
(function (PT) {
  'use strict';

  /*
   * The curated list is a STARTING POINT, not a whitelist. It seeds the default
   * watchlist, the movers board and the AI trader's candidate pool. Anything the
   * data providers can price — any listed US equity or ETF, including penny
   * stocks, and any Coinbase-listed coin — becomes tradable the moment it is
   * discovered through search, via registerAsset() below.
   */
  PT.seedAssets = ${JSON.stringify(ASSETS)};
  PT.assets = PT.seedAssets.slice();
  PT.byId = Object.fromEntries(PT.assets.map(function (a) { return [a.id, a]; }));
  PT.defaultWatchlist = ${JSON.stringify(DEFAULT_WATCHLIST)};

  /** Was this symbol in the curated seed list (vs discovered at runtime)? */
  PT.isSeed = function (id) { var a = PT.byId[id]; return !!(a && !a.discovered); };

  /**
   * Add (or update) an asset so the rest of the app can price, chart and trade
   * it. Safe to call repeatedly; later calls fill in missing fields.
   */
  PT.registerAsset = function (a) {
    if (!a || !a.id) return null;
    var id = String(a.id).toUpperCase();
    var existing = PT.byId[id];
    if (existing) {
      for (var k in a) if (a[k] != null && existing[k] == null) existing[k] = a[k];
      return existing;
    }
    var entry = {
      id: id,
      symbol: id,
      name: a.name || id,
      kind: a.kind || 'stock',
      sector: a.sector || (a.kind === 'crypto' ? 'Crypto' : 'Equity'),
      exchange: a.exchange || null,
      yh: a.yh || (a.kind === 'crypto' ? id + '-USD' : id),
      /*
       * A coin that only CoinGecko carries has no Coinbase product, so it must
       * not be handed to the live socket or the REST ticker — both would 404 on
       * it forever. \`cg\` marks it as the delayed tier instead.
       */
      cb: a.cg ? null : (a.cb || (a.kind === 'crypto' ? id + '-USD' : null)),
      cg: a.cg || null,
      delayed: a.delayed === true || !!a.cg,
      discovered: true,
    };
    PT.byId[id] = entry;
    PT.assets.push(entry);
    return entry;
  };

  PT.assetKind = function (id) { var a = PT.byId[id]; return a ? a.kind : 'stock'; };
  PT.isCrypto = function (id) { return PT.assetKind(id) === 'crypto'; };
  /**
   * A coin priced by CoinGecko snapshots rather than the live Coinbase feed.
   *
   * The test is the absence of a Coinbase product, NOT the presence of a
   * CoinGecko id: every curated coin carries a CoinGecko id already — it is what
   * the market-cap panel looks up — so keying off that demotes BTC and friends
   * to the delayed tier and stops the live socket from ever pricing them.
   */
  PT.isDelayedCoin = function (id) { var a = PT.byId[id]; return !!(a && a.cg && !a.cb); };
})(window.PT);
`;
fs.writeFileSync(path.join(ROOT, 'src/app/js/02-universe.js'), out);
console.log(`generated 02-universe.js (${ASSETS.length} assets, ${(out.length / 1024).toFixed(1)}kb)`);
