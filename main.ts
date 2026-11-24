// Pump.fun Paper Sprint — disciplined momentum paper bot.
//
// Strategy in one paragraph: buy young bonding curves whose recent order
// flow is strong, broad and accelerating while price sits near its
// short-window high and the curve's real SOL reserve is mid-sized and
// rising. Size each position at 0.50 SOL, capped by the harness rule of
// 1% of the mint's real reserve. Exit asymmetrically: a fixed stop-loss
// caps the downside, a trailing stop (never a hard take-profit) lets
// winners run, a 900-slot max hold recycles capital out of stalled
// positions, and a flow-fade exit cuts positions whose tape turns
// against them. A tiny late-window probe backstop (added below) guards
// the 20-coin breadth minimum on the short 6-hour final window.
//
// Deterministic by construction: no clock, no randomness, no I/O — every
// decision is a pure function of the event stream seen so far.

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000; // lamports per SOL, as a float for signal math

// ---- entry parameters ----
const STAKE_LAMPORTS = 500_000_000n; // 0.50 SOL target size per position
const MIN_STAKE_LAMPORTS = 50_000_000n; // skip entries the reserve cap shrinks below 0.05 SOL
const MIN_AGE_SLOTS = 200; // a curve must be at least this old before we buy
const WINDOW_SLOTS = 300; // signal window: only trades inside it count
const MIN_NET_SOL = 2; // net inflow (buys - sells) inside the window
const MIN_BUYS = 12; // buy trades inside the window
const MIN_BUYERS = 10; // distinct buyers inside the window
const MIN_UP = 0.05; // price gain across the window: at least +5%
const MAX_UP = 1.2; // ... and at most +120% (do not chase vertical tops)
const NEAR_HIGH = 0.97; // current price at least 97% of the window high
const MAX_TOP_SHARE = 0.3; // biggest single buyer at most 30% of buy volume
const ACCEL = 1.5; // second-half net flow at least 1.5x the first half
const MIN_RQ_SOL = 30; // real quote reserve band, in SOL
const MAX_RQ_SOL = 85;
const COOLDOWN_SLOTS = 300; // no re-entry into a mint this soon after exiting it

// ---- exit parameters ----
const STOP_LOSS = -0.08; // hard stop at -8% from entry
const TRAIL_ARM = 0.1; // trailing stop arms once the peak return reaches +10%
const TRAIL_DROP = 0.1; // ... and fires after a 10% fall from that peak
const MAX_HOLD_SLOTS = 900; // recycle capital out of positions held this long
const HOLD_KEEP_RET = 0.1; // ... unless they are up at least +10%: let them ride the trail
const FADE_WINDOW_SLOTS = 150; // recent-flow window for the fade exit
const FADE_NET_SOL = -1.0; // exit a loser when recent net flow is under -1 SOL

const BUY_SLIPPAGE_BPS = 700;
const SELL_SLIPPAGE_BPS = 1500;
const MAX_ORDERS = 16; // hello.caps.max_orders_per_batch

// ---- probe backstop parameters ----
// The final window is only 6 hours, so if the main gates have not
// produced 20 distinct traded coins late in the tape, tiny probe buys on
// the most active remaining curves protect the breadth guardrail.
const PROBE_STAKE_LAMPORTS = 20_000_000n; // 0.02 SOL
const PROBE_MIN_LAMPORTS = 10_000_000n; // the 0.01 SOL round-trip minimum
const PROBE_AFTER_SLOTS = 45_000; // only late in the tape (~92% of a 6h window)
const PROBE_EVERY_SLOTS = 600; // at most one probe per 600 slots
let lastProbeSlot = -1;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number; // trade size in SOL (float; signal math only)
  user: string;
  price: number; // post-trade virtual price, quote lamports per token unit
}

interface Tape {
  firstSlot: number;
  firstRealQuote: bigint | null; // real quote reserve at first sight
  trades: TapeTrade[];
}

interface Held {
  entrySlot: number;
  entryPrice: number; // cost per token unit, fees included (from the account)
  peakPrice: number;
}

const tapes = new Map<string, Tape>();
const held = new Map<string, Held>();
const tradedMints = new Set<string>();
const lastExitSlot = new Map<string, number>();
let firstSlot = -1;

function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n) return 0;
  return Number(vq) / Number(vt);
}

function tapeFor(mint: string, slot: number): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { firstSlot: slot, firstRealQuote: null, trades: [] };
    tapes.set(mint, t);
  }
  return t;
}

/** Fold this batch's events into the per-mint tapes and the traded set. */
function ingest(state: BotState, batch: Batch): void {
  if (firstSlot < 0) firstSlot = batch.slot;
  for (const f of batch.fills) {
    if (f.status === 'filled' && f.side === 'buy' && !f.client_id.startsWith('_')) {
      tradedMints.add(f.mint);
    }
  }
  const cutoff = batch.slot - WINDOW_SLOTS;
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      tapeFor(e.mint, e.slot);
    } else if (e.event === 'TradeEvent') {
      const t = tapeFor(e.mint, e.slot);
      if (t.firstRealQuote === null) t.firstRealQuote = BigInt(e.real_quote_reserves);
      t.trades.push({
        slot: e.slot,
        buy: e.is_buy,
        sol: Number(e.quote_amount) / SOL,
        user: e.user,
        price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
      });
      while (t.trades.length > 0 && t.trades[0].slot < cutoff) t.trades.shift();
    }
  }
}

/** Keep our position book in step with the account the harness reports. */
function syncHeld(state: BotState, batch: Batch): void {
  for (const [mint, pos] of state.positions) {
    if (!held.has(mint)) {
      const entryPrice = priceOf(pos.cost_lamports, pos.token_amount);
      held.set(mint, { entrySlot: batch.slot, entryPrice, peakPrice: entryPrice });
      tradedMints.add(mint);
    }
  }
  for (const mint of [...held.keys()]) {
    if (!state.positions.has(mint)) {
      held.delete(mint);
      lastExitSlot.set(mint, batch.slot);
    }
  }
}

function hasPending(state: BotState, mint: string, side: 'buy' | 'sell'): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === side) return true;
  }
  return false;
}

/** Net flow (buys - sells, SOL) of a tape over the last `span` slots. */
function recentNet(t: Tape, now: number, span: number): number {
  let net = 0;
  for (const tr of t.trades) {
    if (tr.slot > now - span) net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

/** Decide sells for every held position. Returns the orders and their count. */
function planExits(state: BotState, batch: Batch, orders: OrderInput[]): void {
  for (const [mint, h] of held) {
    if (orders.length >= MAX_ORDERS) return;
    if (hasPending(state, mint, 'sell')) continue;
    const curve = state.curves.get(mint);
    const pos = state.positions.get(mint);
    if (curve === undefined || pos === undefined || curve.complete) continue;
    const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (price <= 0 || h.entryPrice <= 0) continue;
    if (price > h.peakPrice) h.peakPrice = price;
    const ret = price / h.entryPrice - 1;
    const peakRet = h.peakPrice / h.entryPrice - 1;
    let sell = false;
    if (ret <= STOP_LOSS) {
      sell = true;
    } else if (peakRet >= TRAIL_ARM && ret <= peakRet - TRAIL_DROP) {
      sell = true;
    } else if (batch.slot - h.entrySlot >= MAX_HOLD_SLOTS && ret < HOLD_KEEP_RET) {
      sell = true;
    } else if (ret < 0) {
      const t = tapes.get(mint);
      if (t !== undefined && recentNet(t, batch.slot, FADE_WINDOW_SLOTS) < FADE_NET_SOL) sell = true;
    }
    if (sell) {
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
    }
  }
}

interface WindowStats {
  buys: number;
  buyers: number;
  net: number;
  up: number;
  nearHigh: number;
  topShare: number;
  accelOk: boolean;
}

function windowStats(t: Tape, now: number): WindowStats | null {
  const trades = t.trades;
  if (trades.length === 0) return null;
  const mid = now - WINDOW_SLOTS / 2;
  let buys = 0;
  let buySum = 0;
  let sellSum = 0;
  let netFirst = 0;
  let netSecond = 0;
  let high = 0;
  const buyerVol = new Map<string, number>();
  for (const tr of trades) {
    if (tr.price > high) high = tr.price;
    if (tr.buy) {
      buys++;
      buySum += tr.sol;
      buyerVol.set(tr.user, (buyerVol.get(tr.user) ?? 0) + tr.sol);
      if (tr.slot <= mid) netFirst += tr.sol;
      else netSecond += tr.sol;
    } else {
      sellSum += tr.sol;
      if (tr.slot <= mid) netFirst -= tr.sol;
      else netSecond -= tr.sol;
    }
  }
  if (buys === 0 || buySum <= 0) return null;
  let top = 0;
  for (const v of buyerVol.values()) if (v > top) top = v;
  const firstPrice = trades[0].price;
  const lastPrice = trades[trades.length - 1].price;
  if (firstPrice <= 0 || high <= 0) return null;
  return {
    buys,
    buyers: buyerVol.size,
    net: buySum - sellSum,
    up: lastPrice / firstPrice - 1,
    nearHigh: lastPrice / high,
    topShare: top / buySum,
    accelOk: netFirst > 0 ? netSecond >= ACCEL * netFirst : netSecond >= 1,
  };
}

/** Decide buys for mints that traded in this batch and pass every gate. */
function planEntries(state: BotState, batch: Batch, orders: OrderInput[]): void {
  let committed = state.committedPositionCount();
  let freeCash = state.freeCashLamports();
  const txFee = state.txFeeLamports();
  const seen = new Set<string>();
  for (const e of batch.events) {
    if (orders.length >= MAX_ORDERS) return;
    if (e.event !== 'TradeEvent') continue;
    const mint = e.mint;
    if (seen.has(mint)) continue;
    seen.add(mint);
    if (committed >= state.hello.caps.max_open_positions) return;
    if (held.has(mint) || hasPending(state, mint, 'buy')) continue;
    const exitAt = lastExitSlot.get(mint);
    if (exitAt !== undefined && batch.slot - exitAt < COOLDOWN_SLOTS) continue;
    const curve = state.curves.get(mint);
    const t = tapes.get(mint);
    if (curve === undefined || t === undefined || curve.complete) continue;
    const created = curve.created_slot ?? t.firstSlot;
    if (batch.slot - created < MIN_AGE_SLOTS) continue;
    const rq = Number(curve.real_quote_reserves) / SOL;
    if (rq < MIN_RQ_SOL || rq > MAX_RQ_SOL) continue;
    if (t.firstRealQuote === null) continue;
    const first = t.firstRealQuote;
    const nowRq = curve.real_quote_reserves;
    const rising = nowRq * 5n >= first * 6n || nowRq >= first + BigInt(SOL);
    if (!rising) continue;
    const s = windowStats(t, batch.slot);
    if (s === null) continue;
    if (s.net < MIN_NET_SOL || s.buys < MIN_BUYS || s.buyers < MIN_BUYERS) continue;
    if (s.up < MIN_UP || s.up > MAX_UP) continue;
    if (s.nearHigh < NEAR_HIGH || s.topShare > MAX_TOP_SHARE) continue;
    if (!s.accelOk) continue;
    let stake = state.maxBuyLamports(mint);
    if (stake > STAKE_LAMPORTS) stake = STAKE_LAMPORTS;
    if (stake < MIN_STAKE_LAMPORTS) continue;
    if (freeCash - txFee < stake) continue;
    orders.push({ side: 'buy', mint, quote_lamports: stake, max_slippage_bps: BUY_SLIPPAGE_BPS });
    committed++;
    freeCash -= stake + txFee;
  }
}

/**
 * Breadth backstop: late in the tape, if fewer than 20 distinct coins
 * have traded, place one tiny probe buy on the most active curve we have
 * not touched yet. Probes are managed by the normal exit rules.
 */
function planProbe(state: BotState, batch: Batch, orders: OrderInput[]): void {
  if (orders.length >= MAX_ORDERS) return;
  if (tradedMints.size >= 20) return;
  if (firstSlot < 0 || batch.slot - firstSlot < PROBE_AFTER_SLOTS) return;
  if (lastProbeSlot >= 0 && batch.slot - lastProbeSlot < PROBE_EVERY_SLOTS) return;
  let committed = state.committedPositionCount();
  let freeCash = state.freeCashLamports();
  const txFee = state.txFeeLamports();
  for (const o of orders) {
    if (o.side === 'buy') {
      committed++;
      freeCash -= BigInt(o.quote_lamports) + txFee;
    }
  }
  if (committed >= state.hello.caps.max_open_positions) return;
  let bestMint: string | null = null;
  let bestActivity = 2; // require at least 3 trades in the signal window
  for (const [mint, curve] of state.curves) {
    if (curve.complete || held.has(mint) || tradedMints.has(mint)) continue;
    if (hasPending(state, mint, 'buy')) continue;
    const t = tapes.get(mint);
    if (t === undefined) continue;
    if (t.trades.length > bestActivity) {
      bestActivity = t.trades.length;
      bestMint = mint;
    }
  }
  if (bestMint === null) return;
  let stake = state.maxBuyLamports(bestMint);
  if (stake > PROBE_STAKE_LAMPORTS) stake = PROBE_STAKE_LAMPORTS;
  if (stake < PROBE_MIN_LAMPORTS) return;
  if (freeCash - txFee < stake) return;
  orders.push({ side: 'buy', mint: bestMint, quote_lamports: stake, max_slippage_bps: BUY_SLIPPAGE_BPS });
  lastProbeSlot = batch.slot;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    ingest(state, batch);
    syncHeld(state, batch);
    const orders: OrderInput[] = [];
    planExits(state, batch, orders);
    planEntries(state, batch, orders);
    planProbe(state, batch, orders);
    return orders;
  },
});
