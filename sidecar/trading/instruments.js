/* sidecar/trading/instruments.js — the TRADE GOD instrument catalog.

   ONE source of truth for what the company can trade: the symbol, its asset class, how big one lot is, how
   small a price step is, and the regulatory leverage class it falls in. Everything that turns a price move
   into money (the risk engine, the paper broker, the backtester) reads contract sizes from HERE, so a gold
   lot is 100 oz and a silver lot is 5,000 oz in every module or in none.

   Pure data + pure functions. No clock, no network, no randomness — unit-tested in test/trading.instruments.test.js.

   Conventions
     symbol        canonical id, no separator: XAUUSD, EURUSD, US500, BTCUSD, AAPL
     contractSize  units of the underlying in ONE standard lot (gold 100 oz, FX 100,000 base units, a share 1)
     tick          the smallest price increment we quote to
     quote         the currency the price (and so the P&L) is expressed in
     minLot / lotStep   the smallest position and the granularity above it
     levClass      the leverage class used for the regulatory cap lookup (risk.js LEVERAGE_CAPS)
     hours         '24x5' (FX / metals / index CFDs), '24x7' (crypto) or 'exchange' (cash equities) */
'use strict';

const CLASSES = ['metals', 'forex', 'indices', 'equities', 'crypto', 'energy'];

function inst(symbol, name, assetClass, o) {
  return Object.freeze(Object.assign({
    symbol, name, assetClass,
    contractSize: 1, tick: 0.01, quote: 'USD', minLot: 0.01, lotStep: 0.01,
    levClass: assetClass, hours: '24x5', aliases: Object.freeze([])
  }, o, { aliases: Object.freeze((o && o.aliases) || []) }));
}

const LIST = [
  // ---------------- METALS (the flagship desk) ----------------
  inst('XAUUSD', 'Gold / US Dollar', 'metals', { contractSize: 100, tick: 0.01, levClass: 'gold', aliases: ['XAU_USD', 'XAU/USD', 'GOLD', 'OANDA:XAUUSD', 'TVC:GOLD'] }),
  inst('XAGUSD', 'Silver / US Dollar', 'metals', { contractSize: 5000, tick: 0.001, levClass: 'metals', aliases: ['XAG_USD', 'XAG/USD', 'SILVER', 'OANDA:XAGUSD', 'TVC:SILVER'] }),
  inst('XPTUSD', 'Platinum / US Dollar', 'metals', { contractSize: 50, tick: 0.01, levClass: 'metals', aliases: ['XPT_USD', 'XPT/USD', 'PLATINUM', 'OANDA:XPTUSD'] }),
  inst('XCUUSD', 'Copper / US Dollar', 'metals', { contractSize: 25000, tick: 0.0001, levClass: 'metals', aliases: ['XCU_USD', 'XCU/USD', 'COPPER', 'OANDA:XCUUSD'] }),
  // ---------------- FOREX majors ----------------
  inst('EURUSD', 'Euro / US Dollar', 'forex', { contractSize: 100000, tick: 0.00001, levClass: 'fx-major', aliases: ['EUR_USD', 'EUR/USD', 'OANDA:EURUSD', 'FX:EURUSD'] }),
  inst('GBPUSD', 'British Pound / US Dollar', 'forex', { contractSize: 100000, tick: 0.00001, levClass: 'fx-major', aliases: ['GBP_USD', 'GBP/USD', 'OANDA:GBPUSD', 'FX:GBPUSD'] }),
  inst('USDJPY', 'US Dollar / Japanese Yen', 'forex', { contractSize: 100000, tick: 0.001, quote: 'JPY', levClass: 'fx-major', aliases: ['USD_JPY', 'USD/JPY', 'OANDA:USDJPY', 'FX:USDJPY'] }),
  inst('USDCHF', 'US Dollar / Swiss Franc', 'forex', { contractSize: 100000, tick: 0.00001, quote: 'CHF', levClass: 'fx-major', aliases: ['USD_CHF', 'USD/CHF', 'OANDA:USDCHF', 'FX:USDCHF'] }),
  inst('AUDUSD', 'Australian Dollar / US Dollar', 'forex', { contractSize: 100000, tick: 0.00001, levClass: 'fx-major', aliases: ['AUD_USD', 'AUD/USD', 'OANDA:AUDUSD', 'FX:AUDUSD'] }),
  inst('USDCAD', 'US Dollar / Canadian Dollar', 'forex', { contractSize: 100000, tick: 0.00001, quote: 'CAD', levClass: 'fx-major', aliases: ['USD_CAD', 'USD/CAD', 'OANDA:USDCAD', 'FX:USDCAD'] }),
  inst('NZDUSD', 'New Zealand Dollar / US Dollar', 'forex', { contractSize: 100000, tick: 0.00001, levClass: 'fx-minor', aliases: ['NZD_USD', 'NZD/USD', 'OANDA:NZDUSD'] }),
  // ---------------- FOREX crosses ----------------
  inst('EURGBP', 'Euro / British Pound', 'forex', { contractSize: 100000, tick: 0.00001, quote: 'GBP', levClass: 'fx-minor', aliases: ['EUR_GBP', 'EUR/GBP', 'OANDA:EURGBP'] }),
  inst('EURJPY', 'Euro / Japanese Yen', 'forex', { contractSize: 100000, tick: 0.001, quote: 'JPY', levClass: 'fx-minor', aliases: ['EUR_JPY', 'EUR/JPY', 'OANDA:EURJPY'] }),
  inst('GBPJPY', 'British Pound / Japanese Yen', 'forex', { contractSize: 100000, tick: 0.001, quote: 'JPY', levClass: 'fx-minor', aliases: ['GBP_JPY', 'GBP/JPY', 'OANDA:GBPJPY'] }),
  inst('CADJPY', 'Canadian Dollar / Japanese Yen', 'forex', { contractSize: 100000, tick: 0.001, quote: 'JPY', levClass: 'fx-minor', aliases: ['CAD_JPY', 'CAD/JPY', 'OANDA:CADJPY'] }),
  // ---------------- INDICES (CFD-style: 1 lot = 1 x index) ----------------
  inst('US500', 'S&P 500', 'indices', { tick: 0.1, minLot: 0.1, lotStep: 0.1, levClass: 'index', aliases: ['SPX500_USD', 'SPX500', 'SPX', 'SP500', 'OANDA:SPX500USD', 'SP:SPX'] }),
  inst('NAS100', 'Nasdaq 100', 'indices', { tick: 0.1, minLot: 0.1, lotStep: 0.1, levClass: 'index', aliases: ['NAS100_USD', 'NDX', 'US100', 'OANDA:NAS100USD', 'NASDAQ:NDX'] }),
  inst('US30', 'Dow Jones 30', 'indices', { tick: 1, minLot: 0.1, lotStep: 0.1, levClass: 'index', aliases: ['US30_USD', 'DJI', 'DOW', 'OANDA:US30USD', 'DJ:DJI'] }),
  inst('GER40', 'DAX 40', 'indices', { tick: 0.1, quote: 'EUR', minLot: 0.1, lotStep: 0.1, levClass: 'index', aliases: ['DE30_EUR', 'DE40_EUR', 'DAX', 'DAX40', 'OANDA:DE30EUR', 'XETR:DAX'] }),
  inst('UK100', 'FTSE 100', 'indices', { tick: 0.1, quote: 'GBP', minLot: 0.1, lotStep: 0.1, levClass: 'index', aliases: ['UK100_GBP', 'FTSE', 'FTSE100', 'OANDA:UK100GBP'] }),
  inst('JP225', 'Nikkei 225', 'indices', { tick: 1, quote: 'JPY', minLot: 0.1, lotStep: 0.1, levClass: 'index', aliases: ['JP225_USD', 'NIKKEI', 'NI225', 'OANDA:JP225USD'] }),
  // ---------------- ENERGY ----------------
  inst('WTIUSD', 'WTI Crude Oil', 'energy', { contractSize: 1000, tick: 0.001, levClass: 'commodity', aliases: ['WTICO_USD', 'USOIL', 'WTI', 'CL', 'OANDA:WTICOUSD', 'TVC:USOIL'] }),
  inst('BRENTUSD', 'Brent Crude Oil', 'energy', { contractSize: 1000, tick: 0.001, levClass: 'commodity', aliases: ['BCO_USD', 'UKOIL', 'BRENT', 'OANDA:BCOUSD', 'TVC:UKOIL'] }),
  inst('NATGASUSD', 'Natural Gas', 'energy', { contractSize: 10000, tick: 0.001, levClass: 'commodity', aliases: ['NATGAS_USD', 'NATGAS', 'NG', 'OANDA:NATGASUSD'] }),
  // ---------------- CRYPTO (1 lot = 1 coin) ----------------
  inst('BTCUSD', 'Bitcoin', 'crypto', { tick: 0.01, minLot: 0.0001, lotStep: 0.0001, levClass: 'crypto', hours: '24x7', aliases: ['BTC_USD', 'BTC/USD', 'BTCUSDT', 'BTC/USDT', 'XBTUSD', 'COINBASE:BTCUSD', 'KRAKEN:XBTUSD', 'BINANCE:BTCUSDT'] }),
  inst('ETHUSD', 'Ethereum', 'crypto', { tick: 0.01, minLot: 0.001, lotStep: 0.001, levClass: 'crypto', hours: '24x7', aliases: ['ETH_USD', 'ETH/USD', 'ETHUSDT', 'ETH/USDT', 'COINBASE:ETHUSD', 'KRAKEN:ETHUSD', 'BINANCE:ETHUSDT'] }),
  inst('SOLUSD', 'Solana', 'crypto', { tick: 0.001, minLot: 0.01, lotStep: 0.01, levClass: 'crypto', hours: '24x7', aliases: ['SOL_USD', 'SOL/USD', 'SOLUSDT', 'SOL/USDT', 'COINBASE:SOLUSD', 'KRAKEN:SOLUSD'] }),
  // ---------------- EQUITIES & ETFs (1 lot = 1 share; a starter watchlist, any ticker can be added) ----------------
  inst('GLD', 'SPDR Gold Shares (ETF)', 'equities', { minLot: 1, lotStep: 1, levClass: 'equity', hours: 'exchange', aliases: ['AMEX:GLD'] }),
  inst('SLV', 'iShares Silver Trust (ETF)', 'equities', { minLot: 1, lotStep: 1, levClass: 'equity', hours: 'exchange', aliases: ['AMEX:SLV'] }),
  inst('SPY', 'SPDR S&P 500 (ETF)', 'equities', { minLot: 1, lotStep: 1, levClass: 'equity', hours: 'exchange', aliases: ['AMEX:SPY'] }),
  inst('QQQ', 'Invesco QQQ (ETF)', 'equities', { minLot: 1, lotStep: 1, levClass: 'equity', hours: 'exchange', aliases: ['NASDAQ:QQQ'] }),
  inst('AAPL', 'Apple', 'equities', { minLot: 1, lotStep: 1, levClass: 'equity', hours: 'exchange', aliases: ['NASDAQ:AAPL'] }),
  inst('MSFT', 'Microsoft', 'equities', { minLot: 1, lotStep: 1, levClass: 'equity', hours: 'exchange', aliases: ['NASDAQ:MSFT'] }),
  inst('NVDA', 'NVIDIA', 'equities', { minLot: 1, lotStep: 1, levClass: 'equity', hours: 'exchange', aliases: ['NASDAQ:NVDA'] }),
  inst('TSLA', 'Tesla', 'equities', { minLot: 1, lotStep: 1, levClass: 'equity', hours: 'exchange', aliases: ['NASDAQ:TSLA'] })
];

const BY_SYMBOL = new Map(LIST.map(i => [i.symbol, i]));
const BY_ALIAS = new Map();
function key(s) { return String(s == null ? '' : s).trim().toUpperCase(); }
for (const i of LIST) {
  for (const a of [i.symbol].concat(i.aliases)) {
    const k = key(a);
    if (BY_ALIAS.has(k) && BY_ALIAS.get(k) !== i.symbol) throw new Error('instrument alias collision: ' + a);
    BY_ALIAS.set(k, i.symbol);
  }
}

// resolve any spelling a broker, TradingView or a human might use to the canonical symbol; '' when unknown.
function normalize(raw) {
  const k = key(raw);
  if (!k) return '';
  if (BY_ALIAS.has(k)) return BY_ALIAS.get(k);
  const bare = k.replace(/^[A-Z0-9_]+:/, '');          // drop a TradingView exchange prefix (OANDA:, FX:, …)
  if (BY_ALIAS.has(bare)) return BY_ALIAS.get(bare);
  const squashed = bare.replace(/[\/_\-\s.]/g, '');    // EUR/USD, EUR_USD, EUR-USD -> EURUSD
  if (BY_ALIAS.has(squashed)) return BY_ALIAS.get(squashed);
  return '';
}
function get(raw) { const s = normalize(raw); return s ? BY_SYMBOL.get(s) : null; }
function list(filter) {
  const f = filter || {};
  return LIST.filter(i => (!f.assetClass || i.assetClass === f.assetClass));
}

// ---- money math: every module that turns price into money goes through these ----
// round a volume DOWN to the instrument's lot step (never up — rounding up would add risk nobody approved).
function roundLots(instrument, lots) {
  const step = instrument.lotStep;
  const n = Math.floor((Number(lots) + 1e-9) / step);
  return Math.max(0, Number((n * step).toFixed(8)));
}
// the notional value of a position in the QUOTE currency.
function notional(instrument, lots, price) { return Math.abs(lots) * instrument.contractSize * price; }
// P&L in the QUOTE currency for a move from `entry` to `exit`. side: 'buy' | 'sell'.
function pnl(instrument, side, lots, entry, exit) {
  const dir = side === 'sell' ? -1 : 1;
  return (exit - entry) * dir * Math.abs(lots) * instrument.contractSize;
}
// Convert an amount in the instrument's quote currency to the account currency.
// rates: { 'USDJPY': 150.2, 'USDCAD': 1.37, 'EURUSD': 1.08, … } keyed by canonical symbol (mid prices).
// Returns null when the needed rate is not known — callers must treat that as "cannot size this safely".
function toAccount(amount, quote, accountCcy, rates) {
  if (quote === accountCcy) return amount;
  const r = rates || {};
  const direct = r[quote + accountCcy];          // e.g. quote EUR, account USD -> EURUSD
  if (direct > 0) return amount * direct;
  const inverse = r[accountCcy + quote];         // e.g. quote JPY, account USD -> USDJPY
  if (inverse > 0) return amount / inverse;
  if (quote !== 'USD' && accountCcy !== 'USD') { // cross through USD
    const usd = toAccount(amount, quote, 'USD', r);
    return usd == null ? null : toAccount(usd, 'USD', accountCcy, r);
  }
  return null;
}

module.exports = { CLASSES, LIST, normalize, get, list, roundLots, notional, pnl, toAccount };
