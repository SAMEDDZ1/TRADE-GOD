/* sidecar/trading/brokers.js — the broker registry and the jurisdiction gate.

   TRADE GOD knows about ten brokers plus its own paper account. This file says, for each one: what it trades,
   how the app talks to it, whether a connector is actually BUILT yet, and WHERE it may legally be used.
   The app only ever offers a broker that is (a) implemented and (b) allowed where the Commander lives; the rest
   are listed, greyed out, with the reason in plain words. A broker that does not serve your country is locked.

   HONESTY RULES for this table
     • `status` is the truth about the code, not the roadmap: 'ready' means a connector exists in this repo and
       its unit tests pass; 'untested-live' means the connector is written against the broker's documented API
       but has never been run against the real service from this codebase; 'planned' means no connector yet.
     • Jurisdiction notes describe the public picture as of late 2026 (Canada: CFDs only through CIRO-regulated
       dealers; Binance and Bybit withdrew from Canada in 2023; Pepperstone and IC Markets are not offered
       through a CIRO-regulated entity). Rules change — the Compliance Officer re-checks, and the
       broker's own onboarding is always the final word. This is not legal advice.

   Unit-tested in test/trading.brokers.test.js. */
'use strict';

const ALL = ['metals', 'forex', 'indices', 'equities', 'crypto', 'energy'];

function broker(id, name, o) {
  return Object.freeze(Object.assign({ id, name, kind: 'rest', status: 'planned', assetClasses: [], metals: '', blocked: {}, notes: '', paper: false, website: '' }, o));
}

const LIST = [
  broker('paper', 'TRADE GOD Paper Account', {
    kind: 'paper', status: 'ready', assetClasses: ALL.slice(), paper: true,
    metals: 'XAU/USD, XAG/USD, platinum, copper (simulated fills on real or simulated prices)',
    notes: 'Fake money, real rules. Every strategy and every bot starts here.'
  }),
  broker('oanda', 'OANDA', {
    kind: 'rest', status: 'untested-live', assetClasses: ['forex', 'metals', 'indices', 'energy'],
    metals: 'XAU_USD, XAG_USD and other metal CFDs', website: 'https://www.oanda.com',
    blocked: { 'CA-AB': 'OANDA Canada does not currently accept Alberta residents.' },
    notes: 'v20 REST API with a free practice (demo) environment. First live connector for forex, gold and silver. CIRO-regulated in Canada.'
  }),
  broker('ibkr', 'Interactive Brokers', {
    kind: 'rest', status: 'planned', assetClasses: ['equities', 'indices', 'forex', 'metals', 'energy'],
    metals: 'COMEX gold and silver futures (GC, SI, MGC), spot metals, GLD / SLV', website: 'https://www.interactivebrokers.com',
    notes: 'Stocks, ETFs, futures, options and forex worldwide (TWS / Client Portal API). CIRO-regulated in Canada.'
  }),
  broker('alpaca', 'Alpaca', {
    kind: 'rest', status: 'planned', assetClasses: ['equities', 'crypto'],
    metals: 'via the GLD and SLV ETFs', website: 'https://alpaca.markets',
    notes: 'US stocks, ETFs, options and crypto with a clean REST + WebSocket API and free paper trading.'
  }),
  broker('tastytrade', 'tastytrade', {
    kind: 'rest', status: 'planned', assetClasses: ['equities', 'indices', 'metals', 'energy'],
    metals: 'gold and silver futures', website: 'https://tastytrade.com',
    notes: 'US futures and options through an open REST API.'
  }),
  broker('pepperstone', 'Pepperstone', {
    kind: 'ctrader', status: 'planned', assetClasses: ['forex', 'metals', 'indices', 'energy', 'crypto'],
    metals: 'XAU/USD, XAG/USD CFDs', website: 'https://pepperstone.com',
    blocked: { CA: 'Locked for Canada: only CIRO-authorised brokers may offer CFDs to Canadian residents, and Pepperstone is not offered through a CIRO-regulated entity (as of late 2026).', US: 'CFDs are not available to US residents.' },
    notes: 'Forex and metals CFDs over cTrader Open API or MetaTrader 5.'
  }),
  broker('icmarkets', 'IC Markets', {
    kind: 'ctrader', status: 'planned', assetClasses: ['forex', 'metals', 'indices', 'energy', 'crypto'],
    metals: 'XAU/USD, XAG/USD CFDs', website: 'https://www.icmarkets.com',
    blocked: { CA: 'Locked for Canada: only CIRO-authorised brokers may offer CFDs to Canadian residents, and IC Markets is not offered through a CIRO-regulated entity (as of late 2026).', US: 'CFDs are not available to US residents.' },
    notes: 'Forex and metals CFDs over cTrader Open API or MetaTrader 5.'
  }),
  broker('binance', 'Binance', {
    kind: 'ccxt', status: 'planned', assetClasses: ['crypto'], metals: 'tokenised gold (PAXG)', website: 'https://www.binance.com',
    blocked: { CA: 'Binance withdrew from Canada in 2023.', US: 'Binance.com does not serve US residents.' },
    notes: 'Largest crypto exchange by volume; spot and perpetual futures.'
  }),
  broker('bybit', 'Bybit', {
    kind: 'ccxt', status: 'planned', assetClasses: ['crypto'], metals: '', website: 'https://www.bybit.com',
    blocked: { CA: 'Bybit withdrew from Canada in 2023.', US: 'Bybit does not serve US residents.' },
    notes: 'Crypto derivatives.'
  }),
  broker('coinbase', 'Coinbase', {
    kind: 'ccxt', status: 'planned', assetClasses: ['crypto'], metals: '', website: 'https://www.coinbase.com',
    notes: 'Regulated crypto exchange (Advanced Trade API). Operates in Canada.'
  }),
  broker('kraken', 'Kraken', {
    kind: 'ccxt', status: 'planned', assetClasses: ['crypto'], metals: 'tokenised gold (PAXG)', website: 'https://www.kraken.com',
    notes: 'Crypto spot and futures. Operates in Canada.'
  })
];
const BY_ID = new Map(LIST.map(b => [b.id, b]));

const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];

function get(id) { return BY_ID.get(String(id || '')) || null; }

/* Is this broker usable for someone living in `country` (ISO-2) and, optionally, `region` (province / state)?
   Returns { allowed, reason }. An unknown country is NOT treated as allowed-everywhere: with no country set we
   allow only the paper account, so the app never offers a real broker before it knows where the Commander lives. */
function allowedFor(brokerOrId, country, region) {
  const b = typeof brokerOrId === 'string' ? get(brokerOrId) : brokerOrId;
  if (!b) return { allowed: false, reason: 'unknown broker' };
  if (b.paper) return { allowed: true, reason: '' };
  const c = String(country || '').toUpperCase(), r = String(region || '').toUpperCase();
  if (!c) return { allowed: false, reason: 'Set your country first — brokers are only offered where they are legal.' };
  if (b.blocked[c]) return { allowed: false, reason: b.blocked[c] };
  if (r && b.blocked[c + '-' + r]) return { allowed: false, reason: b.blocked[c + '-' + r] };
  return { allowed: true, reason: '' };
}

// the list the UI shows: every broker, with what the Commander can actually do with it today.
function catalog(country, region) {
  return LIST.map(b => {
    const j = allowedFor(b, country, region);
    const built = b.status === 'ready' || b.status === 'untested-live';
    return {
      id: b.id, name: b.name, kind: b.kind, status: b.status, assetClasses: b.assetClasses.slice(), metals: b.metals,
      notes: b.notes, website: b.website, paper: b.paper,
      allowed: j.allowed, blockedReason: j.reason,
      usable: j.allowed && built,
      // one plain line for the card: why you can or cannot use it right now
      state: !j.allowed ? 'locked' : built ? (b.status === 'ready' ? 'ready' : 'experimental') : 'coming'
    };
  });
}

module.exports = { LIST, PROVINCES, get, allowedFor, catalog };
