/* sidecar/trading/paper.js — the PAPER BROKER: fake money, real rules.

   A complete simulated brokerage account that every strategy and every bot trades on first. It behaves the
   way a real CFD / margin account does where it matters for honesty:
     • you BUY at the ask and SELL at the bid (the spread is a real cost),
     • a position is marked to the price you could CLOSE at (long -> bid, short -> ask),
     • a stop-loss that is gapped through fills at the GAPPED price, not at the stop (slippage is real),
     • a take-profit fills at its own price (a limit order never fills worse),
     • commissions are charged per lot, per side, when configured,
     • P&L is converted to the account currency with the live FX rate; a position whose P&L cannot be
       converted is refused at the door instead of being carried at a made-up value.

   It is a pure state machine: no clock, no timers, no network, no randomness. The caller feeds prices in with
   onPrice() and timestamps with every call, so a backtest, a unit test and the live paper account all run the
   exact same code. State is plain JSON (snapshot() / the `state` passed to create()), so the service can persist
   it after every change.

   This module does NOT enforce the risk policy — that is risk.js, and the service (service.js) always calls
   risk.checkOrder() before it calls placeMarket()/placePending() here. The one rule the broker itself refuses to
   break is the stop-loss law: no position and no pending order can exist without a valid stop.

   Unit-tested in test/trading.paper.test.js. */
'use strict';
const I = require('./instruments.js');

const VERSION = 1;
function r2(n) { return Math.round(n * 100) / 100; }
function fresh(opts) {
  const o = opts || {};
  const bal = Number(o.startingBalance) > 0 ? Number(o.startingBalance) : 10000;
  return {
    version: VERSION, accountCcy: o.accountCcy || 'USD', startingBalance: bal, balance: bal,
    dayKey: '', dayStartEquity: bal, nextId: 1,
    positions: [], orders: [], trades: [], prices: {},
    commissionPerLot: Object.assign({}, o.commissionPerLot || {})   // { forex: 3.5, metals: 3.5, … } account ccy, per lot per side
  };
}

function create(opts) {
  const o = opts || {};
  const state = o.state && o.state.version === VERSION ? o.state : fresh(o);
  const dayOffsetMin = Number.isFinite(o.dayOffsetMinutes) ? o.dayOffsetMinutes : -300;   // the trading day rolls at midnight UTC-5 by default

  const id = prefix => prefix + (state.nextId++);
  function dayKeyOf(ts) { return new Date(Number(ts) + dayOffsetMin * 60000).toISOString().slice(0, 10); }

  // mid FX rates out of the price cache, keyed by canonical symbol — what instruments.toAccount() needs.
  function rates() {
    const out = {};
    for (const s of Object.keys(state.prices)) { const p = state.prices[s]; out[s] = (p.bid + p.ask) / 2; }
    return out;
  }
  function convertible(instrument) { return I.toAccount(1, instrument.quote, state.accountCcy, rates()) != null; }
  function closePriceFor(pos) { const p = state.prices[pos.symbol]; return p ? (pos.side === 'buy' ? p.bid : p.ask) : null; }
  function unrealizedOf(pos) {
    const px = closePriceFor(pos), instrument = I.get(pos.symbol);
    if (px == null || !instrument) return 0;
    const v = I.toAccount(I.pnl(instrument, pos.side, pos.lots, pos.entry, px), instrument.quote, state.accountCcy, rates());
    return v == null ? 0 : v;
  }
  function commission(instrument, lots) {
    const per = Number(state.commissionPerLot[instrument.assetClass]) || 0;
    return r2(per * Math.abs(lots));
  }
  function equity() { return r2(state.balance + state.positions.reduce((a, p) => a + unrealizedOf(p), 0)); }

  // called with every timestamped action: the first action of a new trading day re-bases the day's opening equity.
  function rollDay(ts) {
    const k = dayKeyOf(ts);
    if (k !== state.dayKey) { state.dayKey = k; state.dayStartEquity = equity(); return true; }
    return false;
  }

  function validStops(side, refPrice, stop, takeProfit) {
    if (!(Number(stop) > 0)) return 'no stop-loss — no trade';
    if (side === 'buy' && !(stop < refPrice)) return 'a buy needs its stop below the price';
    if (side === 'sell' && !(stop > refPrice)) return 'a sell needs its stop above the price';
    if (takeProfit != null) {
      if (!(Number(takeProfit) > 0)) return 'take-profit must be a positive price';
      if (side === 'buy' && !(takeProfit > refPrice)) return 'a buy needs its take-profit above the price';
      if (side === 'sell' && !(takeProfit < refPrice)) return 'a sell needs its take-profit below the price';
    }
    return '';
  }
  function checkBasics(req) {
    const instrument = I.get(req.symbol);
    if (!instrument) return { error: 'unknown instrument: ' + req.symbol };
    const side = req.side === 'buy' || req.side === 'sell' ? req.side : '';
    if (!side) return { error: 'side must be buy or sell' };
    const lots = Number(req.lots);
    if (!(lots > 0)) return { error: 'size must be greater than zero' };
    if (lots < instrument.minLot - 1e-12 || Math.abs(I.roundLots(instrument, lots) - lots) > 1e-9) return { error: 'size must be a multiple of ' + instrument.lotStep + ' and at least ' + instrument.minLot };
    return { instrument, side, lots };
  }

  function openPosition(instrument, side, lots, price, req, ts) {
    const fee = commission(instrument, lots);
    state.balance = r2(state.balance - fee);
    const pos = {
      id: id('P'), symbol: instrument.symbol, side, lots, entry: price,
      stop: Number(req.stop), initialStop: Number(req.stop), takeProfit: req.takeProfit == null ? null : Number(req.takeProfit),
      openedAt: ts, agentId: req.agentId || '', ticketId: req.ticketId || '', strategy: req.strategy || '', feesPaid: fee
    };
    state.positions.push(pos);
    return pos;
  }

  /* MARKET ORDER: fills now at the current ask (buy) or bid (sell). */
  function placeMarket(req, ts) {
    const b = checkBasics(req); if (b.error) return { ok: false, error: b.error };
    rollDay(ts);
    const px = state.prices[b.instrument.symbol];
    if (!px) return { ok: false, error: 'no price for ' + b.instrument.symbol + ' yet' };
    if (!convertible(b.instrument)) return { ok: false, error: 'no exchange rate to convert ' + b.instrument.quote + ' to ' + state.accountCcy };
    const fill = b.side === 'buy' ? px.ask : px.bid;
    const bad = validStops(b.side, fill, req.stop, req.takeProfit == null ? null : Number(req.takeProfit));
    if (bad) return { ok: false, error: bad };
    const pos = openPosition(b.instrument, b.side, b.lots, fill, req, ts);
    return { ok: true, position: Object.assign({}, pos), events: [{ type: 'position.opened', ts, position: Object.assign({}, pos) }] };
  }

  /* PENDING ORDER: type 'limit' (better price than now) or 'stop' (breakout entry). Fills inside onPrice(). */
  function placePending(req, ts) {
    const b = checkBasics(req); if (b.error) return { ok: false, error: b.error };
    rollDay(ts);
    const type = req.type === 'limit' || req.type === 'stop' ? req.type : '';
    if (!type) return { ok: false, error: 'pending order type must be limit or stop' };
    const price = Number(req.price);
    if (!(price > 0)) return { ok: false, error: 'pending order needs a price' };
    const bad = validStops(b.side, price, req.stop, req.takeProfit == null ? null : Number(req.takeProfit));
    if (bad) return { ok: false, error: bad };
    const order = {
      id: id('O'), symbol: b.instrument.symbol, side: b.side, type, lots: b.lots, price,
      stop: Number(req.stop), takeProfit: req.takeProfit == null ? null : Number(req.takeProfit),
      createdAt: ts, agentId: req.agentId || '', ticketId: req.ticketId || '', strategy: req.strategy || ''
    };
    state.orders.push(order);
    return { ok: true, order: Object.assign({}, order), events: [{ type: 'order.placed', ts, order: Object.assign({}, order) }] };
  }

  function settle(pos, exit, reason, ts) {
    const instrument = I.get(pos.symbol);
    const gross = I.toAccount(I.pnl(instrument, pos.side, pos.lots, pos.entry, exit), instrument.quote, state.accountCcy, rates());
    const fee = commission(instrument, pos.lots);
    const pnl = r2((gross == null ? 0 : gross) - fee);
    state.balance = r2(state.balance + pnl);
    const riskQuote = Math.abs(pos.entry - pos.initialStop);   // R is measured against the stop the trade was OPENED with
    const trade = {
      id: id('T'), positionId: pos.id, symbol: pos.symbol, side: pos.side, lots: pos.lots,
      entry: pos.entry, exit, stop: pos.stop, initialStop: pos.initialStop, takeProfit: pos.takeProfit,
      openedAt: pos.openedAt, closedAt: ts, reason,
      pnl: r2(pnl - pos.feesPaid),            // NET of both commissions — the number the scorecards use
      fees: r2(fee + pos.feesPaid),
      rMultiple: riskQuote > 0 ? Number(((exit - pos.entry) * (pos.side === 'buy' ? 1 : -1) / riskQuote).toFixed(2)) : null,
      agentId: pos.agentId, ticketId: pos.ticketId, strategy: pos.strategy
    };
    state.positions = state.positions.filter(p => p.id !== pos.id);
    state.trades.push(trade);
    return trade;
  }

  /* A new price. Updates the mark, fills triggered pending orders, then closes positions whose stop or take-profit was hit.
     Returns the list of events that happened on this tick (may be empty). */
  function onPrice(symbolRaw, bid, ask, ts) {
    const symbol = I.normalize(symbolRaw);
    bid = Number(bid); ask = Number(ask);
    if (!symbol || !(bid > 0) || !(ask > 0) || ask < bid) return [];
    rollDay(ts);
    state.prices[symbol] = { bid, ask, ts };
    const events = [];
    // 1. pending orders on this symbol
    for (const ord of state.orders.filter(x => x.symbol === symbol)) {
      let hit = false, fill = 0;
      if (ord.type === 'limit') {
        if (ord.side === 'buy' && ask <= ord.price) { hit = true; fill = ord.price; }        // a limit never fills worse than its price
        if (ord.side === 'sell' && bid >= ord.price) { hit = true; fill = ord.price; }
      } else {
        if (ord.side === 'buy' && ask >= ord.price) { hit = true; fill = ask; }              // a stop entry fills at the market — slippage included
        if (ord.side === 'sell' && bid <= ord.price) { hit = true; fill = bid; }
      }
      if (!hit) continue;
      state.orders = state.orders.filter(x => x.id !== ord.id);
      const instrument = I.get(symbol);
      // the stop and target must still be on the right sides of the ACTUAL fill; if the market jumped past either, the order is void
      if (!convertible(instrument) || validStops(ord.side, fill, ord.stop, ord.takeProfit)) {
        events.push({ type: 'order.cancelled', ts, order: Object.assign({}, ord), reason: 'price gapped past the stop or target before the order could fill' });
        continue;
      }
      const pos = openPosition(instrument, ord.side, ord.lots, fill, ord, ts);
      events.push({ type: 'order.filled', ts, order: Object.assign({}, ord), position: Object.assign({}, pos) });
    }
    // 2. stops and targets on this symbol
    for (const pos of state.positions.filter(x => x.symbol === symbol)) {
      let exit = null, reason = '';
      if (pos.side === 'buy') {
        if (bid <= pos.stop) { exit = Math.min(pos.stop, bid); reason = 'stop'; }
        else if (pos.takeProfit != null && bid >= pos.takeProfit) { exit = pos.takeProfit; reason = 'take-profit'; }
      } else {
        if (ask >= pos.stop) { exit = Math.max(pos.stop, ask); reason = 'stop'; }
        else if (pos.takeProfit != null && ask <= pos.takeProfit) { exit = pos.takeProfit; reason = 'take-profit'; }
      }
      if (exit == null) continue;
      events.push({ type: 'position.closed', ts, trade: settle(pos, exit, reason, ts) });
    }
    return events;
  }

  function closePosition(positionId, reason, ts) {
    const pos = state.positions.find(p => p.id === positionId);
    if (!pos) return { ok: false, error: 'no such position' };
    rollDay(ts);
    const px = closePriceFor(pos);
    if (px == null) return { ok: false, error: 'no price for ' + pos.symbol };
    const trade = settle(pos, px, reason || 'manual', ts);
    return { ok: true, trade, events: [{ type: 'position.closed', ts, trade }] };
  }
  // THE KILL SWITCH'S HANDS: cancel every pending order and close every position at the market, right now.
  function closeAll(reason, ts) {
    const events = [];
    for (const ord of state.orders.slice()) events.push({ type: 'order.cancelled', ts, order: Object.assign({}, ord), reason: reason || 'kill-switch' });
    state.orders = [];
    const stuck = [];
    for (const pos of state.positions.slice()) {
      const r = closePosition(pos.id, reason || 'kill-switch', ts);
      if (r.ok) events.push(r.events[0]); else stuck.push({ positionId: pos.id, symbol: pos.symbol, error: r.error });
    }
    return { ok: stuck.length === 0, events, stuck };
  }
  function cancelOrder(orderId, ts) {
    const ord = state.orders.find(x => x.id === orderId);
    if (!ord) return { ok: false, error: 'no such order' };
    state.orders = state.orders.filter(x => x.id !== orderId);
    return { ok: true, events: [{ type: 'order.cancelled', ts, order: Object.assign({}, ord), reason: 'cancelled' }] };
  }
  /* Move a stop / target. The stop can be moved but never removed, and must stay on the protective side of the
     CURRENT price (so a trailing stop above the entry on a winning long is fine). */
  function modifyPosition(positionId, patch, ts) {
    const pos = state.positions.find(p => p.id === positionId);
    if (!pos) return { ok: false, error: 'no such position' };
    const px = closePriceFor(pos);
    if (px == null) return { ok: false, error: 'no price for ' + pos.symbol };
    const stop = patch.stop === undefined ? pos.stop : Number(patch.stop);
    const tp = patch.takeProfit === undefined ? pos.takeProfit : (patch.takeProfit == null ? null : Number(patch.takeProfit));
    const bad = validStops(pos.side, px, stop, tp);
    if (bad) return { ok: false, error: bad };
    pos.stop = stop; pos.takeProfit = tp;
    return { ok: true, position: Object.assign({}, pos), events: [{ type: 'position.modified', ts, position: Object.assign({}, pos) }] };
  }

  function account() {
    const eq = equity();
    return {
      accountCcy: state.accountCcy, startingBalance: state.startingBalance, balance: state.balance, equity: eq,
      unrealized: r2(eq - state.balance), dayKey: state.dayKey, dayStartEquity: state.dayStartEquity,
      dayPnl: r2(eq - state.dayStartEquity), openPositions: state.positions.length, pendingOrders: state.orders.length,
      closedTrades: state.trades.length
    };
  }
  function positions() {
    return state.positions.map(p => Object.assign({}, p, { mark: closePriceFor(p), unrealized: r2(unrealizedOf(p)) }));
  }

  return {
    state, rates, equity, account, positions,
    orders: () => state.orders.map(x => Object.assign({}, x)),
    trades: () => state.trades.map(x => Object.assign({}, x)),
    price: s => { const p = state.prices[I.normalize(s)]; return p ? Object.assign({}, p) : null; },
    onPrice, placeMarket, placePending, closePosition, closeAll, cancelOrder, modifyPosition, rollDay,
    snapshot: () => JSON.parse(JSON.stringify(state))
  };
}

module.exports = { VERSION, create, fresh };
