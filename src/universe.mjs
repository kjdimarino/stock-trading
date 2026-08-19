/**
 * The tradable asset universe.
 *
 * Crypto entries carry a Coinbase product id (verified present and online on
 * the Coinbase Exchange product list) so the browser can stream real ticks over
 * the public WebSocket feed, plus Kraken/CoinGecko ids for REST failover.
 */

export const STOCKS = [
  // --- Mega-cap tech ---
  { symbol: 'AAPL', name: 'Apple Inc.', sector: 'Technology' },
  { symbol: 'MSFT', name: 'Microsoft Corporation', sector: 'Technology' },
  { symbol: 'NVDA', name: 'NVIDIA Corporation', sector: 'Technology' },
  { symbol: 'GOOGL', name: 'Alphabet Inc. Class A', sector: 'Communication Services' },
  { symbol: 'AMZN', name: 'Amazon.com, Inc.', sector: 'Consumer Discretionary' },
  { symbol: 'META', name: 'Meta Platforms, Inc.', sector: 'Communication Services' },
  { symbol: 'TSLA', name: 'Tesla, Inc.', sector: 'Consumer Discretionary' },
  { symbol: 'AVGO', name: 'Broadcom Inc.', sector: 'Technology' },
  { symbol: 'ORCL', name: 'Oracle Corporation', sector: 'Technology' },
  { symbol: 'CRM', name: 'Salesforce, Inc.', sector: 'Technology' },
  { symbol: 'AMD', name: 'Advanced Micro Devices, Inc.', sector: 'Technology' },
  { symbol: 'INTC', name: 'Intel Corporation', sector: 'Technology' },
  { symbol: 'MU', name: 'Micron Technology, Inc.', sector: 'Technology' },
  { symbol: 'QCOM', name: 'QUALCOMM Incorporated', sector: 'Technology' },
  { symbol: 'ADBE', name: 'Adobe Inc.', sector: 'Technology' },
  { symbol: 'NFLX', name: 'Netflix, Inc.', sector: 'Communication Services' },
  { symbol: 'CSCO', name: 'Cisco Systems, Inc.', sector: 'Technology' },
  { symbol: 'TXN', name: 'Texas Instruments Incorporated', sector: 'Technology' },
  { symbol: 'NOW', name: 'ServiceNow, Inc.', sector: 'Technology' },
  { symbol: 'PLTR', name: 'Palantir Technologies Inc.', sector: 'Technology' },
  { symbol: 'ARM', name: 'Arm Holdings plc', sector: 'Technology' },
  { symbol: 'SMCI', name: 'Super Micro Computer, Inc.', sector: 'Technology' },

  // --- Financials ---
  { symbol: 'BRK-B', name: 'Berkshire Hathaway Inc. Class B', sector: 'Financials' },
  { symbol: 'JPM', name: 'JPMorgan Chase & Co.', sector: 'Financials' },
  { symbol: 'V', name: 'Visa Inc.', sector: 'Financials' },
  { symbol: 'MA', name: 'Mastercard Incorporated', sector: 'Financials' },
  { symbol: 'BAC', name: 'Bank of America Corporation', sector: 'Financials' },
  { symbol: 'GS', name: 'The Goldman Sachs Group, Inc.', sector: 'Financials' },
  { symbol: 'WFC', name: 'Wells Fargo & Company', sector: 'Financials' },
  { symbol: 'AXP', name: 'American Express Company', sector: 'Financials' },
  { symbol: 'COIN', name: 'Coinbase Global, Inc.', sector: 'Financials' },
  { symbol: 'HOOD', name: 'Robinhood Markets, Inc.', sector: 'Financials' },
  { symbol: 'PYPL', name: 'PayPal Holdings, Inc.', sector: 'Financials' },

  // --- Healthcare ---
  { symbol: 'LLY', name: 'Eli Lilly and Company', sector: 'Healthcare' },
  { symbol: 'UNH', name: 'UnitedHealth Group Incorporated', sector: 'Healthcare' },
  { symbol: 'JNJ', name: 'Johnson & Johnson', sector: 'Healthcare' },
  { symbol: 'ABBV', name: 'AbbVie Inc.', sector: 'Healthcare' },
  { symbol: 'MRK', name: 'Merck & Co., Inc.', sector: 'Healthcare' },
  { symbol: 'PFE', name: 'Pfizer Inc.', sector: 'Healthcare' },

  // --- Consumer / Industrial / Energy ---
  { symbol: 'WMT', name: 'Walmart Inc.', sector: 'Consumer Staples' },
  { symbol: 'COST', name: 'Costco Wholesale Corporation', sector: 'Consumer Staples' },
  { symbol: 'HD', name: 'The Home Depot, Inc.', sector: 'Consumer Discretionary' },
  { symbol: 'NKE', name: 'NIKE, Inc.', sector: 'Consumer Discretionary' },
  { symbol: 'SBUX', name: 'Starbucks Corporation', sector: 'Consumer Discretionary' },
  { symbol: 'MCD', name: "McDonald's Corporation", sector: 'Consumer Discretionary' },
  { symbol: 'KO', name: 'The Coca-Cola Company', sector: 'Consumer Staples' },
  { symbol: 'PEP', name: 'PepsiCo, Inc.', sector: 'Consumer Staples' },
  { symbol: 'DIS', name: 'The Walt Disney Company', sector: 'Communication Services' },
  { symbol: 'UBER', name: 'Uber Technologies, Inc.', sector: 'Industrials' },
  { symbol: 'ABNB', name: 'Airbnb, Inc.', sector: 'Consumer Discretionary' },
  { symbol: 'BA', name: 'The Boeing Company', sector: 'Industrials' },
  { symbol: 'CAT', name: 'Caterpillar Inc.', sector: 'Industrials' },
  { symbol: 'GE', name: 'GE Aerospace', sector: 'Industrials' },
  { symbol: 'XOM', name: 'Exxon Mobil Corporation', sector: 'Energy' },
  { symbol: 'CVX', name: 'Chevron Corporation', sector: 'Energy' },
  { symbol: 'RIVN', name: 'Rivian Automotive, Inc.', sector: 'Consumer Discretionary' },
  { symbol: 'LCID', name: 'Lucid Group, Inc.', sector: 'Consumer Discretionary' },
  { symbol: 'MSTR', name: 'MicroStrategy Incorporated', sector: 'Technology' },
  { symbol: 'GME', name: 'GameStop Corp.', sector: 'Consumer Discretionary' },
];

export const ETFS = [
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', sector: 'ETF' },
  { symbol: 'QQQ', name: 'Invesco QQQ Trust', sector: 'ETF' },
  { symbol: 'IWM', name: 'iShares Russell 2000 ETF', sector: 'ETF' },
  { symbol: 'DIA', name: 'SPDR Dow Jones Industrial Average ETF', sector: 'ETF' },
  { symbol: 'VTI', name: 'Vanguard Total Stock Market ETF', sector: 'ETF' },
  { symbol: 'VOO', name: 'Vanguard S&P 500 ETF', sector: 'ETF' },
  { symbol: 'ARKK', name: 'ARK Innovation ETF', sector: 'ETF' },
  { symbol: 'SOXL', name: 'Direxion Daily Semiconductor Bull 3X', sector: 'ETF' },
  { symbol: 'TQQQ', name: 'ProShares UltraPro QQQ', sector: 'ETF' },
  { symbol: 'GLD', name: 'SPDR Gold Shares', sector: 'ETF' },
  { symbol: 'SLV', name: 'iShares Silver Trust', sector: 'ETF' },
  { symbol: 'USO', name: 'United States Oil Fund', sector: 'ETF' },
  { symbol: 'TLT', name: 'iShares 20+ Year Treasury Bond ETF', sector: 'ETF' },
  { symbol: 'XLE', name: 'Energy Select Sector SPDR Fund', sector: 'ETF' },
  { symbol: 'XLF', name: 'Financial Select Sector SPDR Fund', sector: 'ETF' },
  { symbol: 'IBIT', name: 'iShares Bitcoin Trust ETF', sector: 'ETF' },
];

/**
 * cb  = Coinbase Exchange product id (drives the realtime WebSocket feed)
 * kr  = Kraken REST pair name
 * cg  = CoinGecko id
 * yh  = Yahoo Finance symbol
 */
export const CRYPTO = [
  { symbol: 'BTC', name: 'Bitcoin', cb: 'BTC-USD', kr: 'XBTUSD', cg: 'bitcoin', yh: 'BTC-USD', tag: 'major' },
  { symbol: 'ETH', name: 'Ethereum', cb: 'ETH-USD', kr: 'ETHUSD', cg: 'ethereum', yh: 'ETH-USD', tag: 'major' },
  { symbol: 'SOL', name: 'Solana', cb: 'SOL-USD', kr: 'SOLUSD', cg: 'solana', yh: 'SOL-USD', tag: 'major' },
  { symbol: 'XRP', name: 'XRP', cb: 'XRP-USD', kr: 'XRPUSD', cg: 'ripple', yh: 'XRP-USD', tag: 'major' },
  { symbol: 'ADA', name: 'Cardano', cb: 'ADA-USD', kr: 'ADAUSD', cg: 'cardano', yh: 'ADA-USD', tag: 'major' },
  { symbol: 'AVAX', name: 'Avalanche', cb: 'AVAX-USD', kr: 'AVAXUSD', cg: 'avalanche-2', yh: 'AVAX-USD', tag: 'major' },
  { symbol: 'LINK', name: 'Chainlink', cb: 'LINK-USD', kr: 'LINKUSD', cg: 'chainlink', yh: 'LINK-USD', tag: 'major' },
  { symbol: 'DOT', name: 'Polkadot', cb: 'DOT-USD', kr: 'DOTUSD', cg: 'polkadot', yh: 'DOT-USD', tag: 'major' },
  { symbol: 'LTC', name: 'Litecoin', cb: 'LTC-USD', kr: 'LTCUSD', cg: 'litecoin', yh: 'LTC-USD', tag: 'major' },
  { symbol: 'BCH', name: 'Bitcoin Cash', cb: 'BCH-USD', kr: 'BCHUSD', cg: 'bitcoin-cash', yh: 'BCH-USD', tag: 'major' },
  { symbol: 'TON', name: 'Toncoin', cb: 'TON-USD', kr: null, cg: 'the-open-network', yh: 'TON11419-USD', tag: 'major' },
  { symbol: 'UNI', name: 'Uniswap', cb: 'UNI-USD', kr: 'UNIUSD', cg: 'uniswap', yh: 'UNI7083-USD', tag: 'defi' },
  { symbol: 'AAVE', name: 'Aave', cb: 'AAVE-USD', kr: 'AAVEUSD', cg: 'aave', yh: 'AAVE-USD', tag: 'defi' },
  { symbol: 'CRV', name: 'Curve DAO', cb: 'CRV-USD', kr: 'CRVUSD', cg: 'curve-dao-token', yh: 'CRV-USD', tag: 'defi' },
  { symbol: 'LDO', name: 'Lido DAO', cb: 'LDO-USD', kr: 'LDOUSD', cg: 'lido-dao', yh: 'LDO-USD', tag: 'defi' },
  { symbol: 'ENA', name: 'Ethena', cb: 'ENA-USD', kr: 'ENAUSD', cg: 'ethena', yh: 'ENA-USD', tag: 'defi' },
  { symbol: 'ATOM', name: 'Cosmos', cb: 'ATOM-USD', kr: 'ATOMUSD', cg: 'cosmos', yh: 'ATOM-USD', tag: 'layer1' },
  { symbol: 'NEAR', name: 'NEAR Protocol', cb: 'NEAR-USD', kr: 'NEARUSD', cg: 'near', yh: 'NEAR-USD', tag: 'layer1' },
  { symbol: 'APT', name: 'Aptos', cb: 'APT-USD', kr: 'APTUSD', cg: 'aptos', yh: 'APT21794-USD', tag: 'layer1' },
  { symbol: 'SUI', name: 'Sui', cb: 'SUI-USD', kr: 'SUIUSD', cg: 'sui', yh: 'SUI20947-USD', tag: 'layer1' },
  { symbol: 'SEI', name: 'Sei', cb: 'SEI-USD', kr: 'SEIUSD', cg: 'sei-network', yh: 'SEI-USD', tag: 'layer1' },
  { symbol: 'ICP', name: 'Internet Computer', cb: 'ICP-USD', kr: 'ICPUSD', cg: 'internet-computer', yh: 'ICP-USD', tag: 'layer1' },
  { symbol: 'ETC', name: 'Ethereum Classic', cb: 'ETC-USD', kr: 'ETCUSD', cg: 'ethereum-classic', yh: 'ETC-USD', tag: 'layer1' },
  { symbol: 'XLM', name: 'Stellar', cb: 'XLM-USD', kr: 'XLMUSD', cg: 'stellar', yh: 'XLM-USD', tag: 'layer1' },
  { symbol: 'ALGO', name: 'Algorand', cb: 'ALGO-USD', kr: 'ALGOUSD', cg: 'algorand', yh: 'ALGO-USD', tag: 'layer1' },
  { symbol: 'HBAR', name: 'Hedera', cb: 'HBAR-USD', kr: 'HBARUSD', cg: 'hedera-hashgraph', yh: 'HBAR-USD', tag: 'layer1' },
  { symbol: 'ARB', name: 'Arbitrum', cb: 'ARB-USD', kr: 'ARBUSD', cg: 'arbitrum', yh: 'ARB11841-USD', tag: 'layer2' },
  { symbol: 'OP', name: 'Optimism', cb: 'OP-USD', kr: 'OPUSD', cg: 'optimism', yh: 'OP-USD', tag: 'layer2' },
  { symbol: 'STRK', name: 'Starknet', cb: 'STRK-USD', kr: 'STRKUSD', cg: 'starknet', yh: 'STRK-USD', tag: 'layer2' },
  { symbol: 'IMX', name: 'Immutable', cb: 'IMX-USD', kr: 'IMXUSD', cg: 'immutable-x', yh: 'IMX10603-USD', tag: 'layer2' },
  { symbol: 'INJ', name: 'Injective', cb: 'INJ-USD', kr: 'INJUSD', cg: 'injective-protocol', yh: 'INJ-USD', tag: 'layer1' },
  { symbol: 'TIA', name: 'Celestia', cb: 'TIA-USD', kr: 'TIAUSD', cg: 'celestia', yh: 'TIA22861-USD', tag: 'layer1' },
  { symbol: 'FIL', name: 'Filecoin', cb: 'FIL-USD', kr: 'FILUSD', cg: 'filecoin', yh: 'FIL-USD', tag: 'infra' },
  { symbol: 'RENDER', name: 'Render', cb: 'RENDER-USD', kr: 'RENDERUSD', cg: 'render-token', yh: 'RENDER-USD', tag: 'ai' },
  { symbol: 'FET', name: 'Artificial Superintelligence Alliance', cb: 'FET-USD', kr: 'FETUSD', cg: 'fetch-ai', yh: 'FET-USD', tag: 'ai' },
  { symbol: 'GRT', name: 'The Graph', cb: 'GRT-USD', kr: 'GRTUSD', cg: 'the-graph', yh: 'GRT6719-USD', tag: 'infra' },
  { symbol: 'PYTH', name: 'Pyth Network', cb: 'PYTH-USD', kr: 'PYTHUSD', cg: 'pyth-network', yh: 'PYTH-USD', tag: 'infra' },
  { symbol: 'CRO', name: 'Cronos', cb: 'CRO-USD', kr: null, cg: 'crypto-com-chain', yh: 'CRO-USD', tag: 'infra' },

  // --- Meme coins ---
  { symbol: 'DOGE', name: 'Dogecoin', cb: 'DOGE-USD', kr: 'DOGEUSD', cg: 'dogecoin', yh: 'DOGE-USD', tag: 'meme' },
  { symbol: 'SHIB', name: 'Shiba Inu', cb: 'SHIB-USD', kr: 'SHIBUSD', cg: 'shiba-inu', yh: 'SHIB-USD', tag: 'meme' },
  { symbol: 'PEPE', name: 'Pepe', cb: 'PEPE-USD', kr: 'PEPEUSD', cg: 'pepe', yh: 'PEPE24478-USD', tag: 'meme' },
  { symbol: 'WIF', name: 'dogwifhat', cb: 'WIF-USD', kr: 'WIFUSD', cg: 'dogwifcoin', yh: 'WIF-USD', tag: 'meme' },
  { symbol: 'BONK', name: 'Bonk', cb: 'BONK-USD', kr: 'BONKUSD', cg: 'bonk', yh: 'BONK-USD', tag: 'meme' },
  { symbol: 'FLOKI', name: 'FLOKI', cb: 'FLOKI-USD', kr: 'FLOKIUSD', cg: 'floki', yh: 'FLOKI-USD', tag: 'meme' },
  { symbol: 'POPCAT', name: 'Popcat', cb: 'POPCAT-USD', kr: 'POPCATUSD', cg: 'popcat', yh: 'POPCAT-USD', tag: 'meme' },
  { symbol: 'MOG', name: 'Mog Coin', cb: 'MOG-USD', kr: null, cg: 'mog-coin', yh: 'MOG-USD', tag: 'meme' },
  { symbol: 'TURBO', name: 'Turbo', cb: 'TURBO-USD', kr: null, cg: 'turbo', yh: 'TURBO-USD', tag: 'meme' },
  { symbol: 'TRUMP', name: 'Official Trump', cb: 'TRUMP-USD', kr: 'TRUMPUSD', cg: 'official-trump', yh: 'TRUMP-USD', tag: 'meme' },
  { symbol: 'APE', name: 'ApeCoin', cb: 'APE-USD', kr: 'APEUSD', cg: 'apecoin', yh: 'APE18876-USD', tag: 'meme' },
  { symbol: 'SAND', name: 'The Sandbox', cb: 'SAND-USD', kr: 'SANDUSD', cg: 'the-sandbox', yh: 'SAND-USD', tag: 'gaming' },
  { symbol: 'MANA', name: 'Decentraland', cb: 'MANA-USD', kr: 'MANAUSD', cg: 'decentraland', yh: 'MANA-USD', tag: 'gaming' },
  { symbol: 'BLUR', name: 'Blur', cb: 'BLUR-USD', kr: 'BLURUSD', cg: 'blur', yh: 'BLUR-USD', tag: 'nft' },
];

/** Flat, UI-ready asset list. `id` is the canonical key used everywhere. */
export const ASSETS = [
  ...STOCKS.map((s) => ({ ...s, id: s.symbol, kind: 'stock', yh: s.symbol })),
  ...ETFS.map((s) => ({ ...s, id: s.symbol, kind: 'etf', yh: s.symbol })),
  ...CRYPTO.map((c) => ({ ...c, id: c.symbol, kind: 'crypto', sector: 'Crypto' })),
];

export const BY_ID = Object.fromEntries(ASSETS.map((a) => [a.id, a]));

/** Default watchlist on a fresh install: a spread of large caps, indices, crypto. */
export const DEFAULT_WATCHLIST = [
  'AAPL', 'NVDA', 'TSLA', 'MSFT', 'AMZN', 'SPY', 'QQQ',
  'BTC', 'ETH', 'SOL', 'XRP', 'DOGE',
];
