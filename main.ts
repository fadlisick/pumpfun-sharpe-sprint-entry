// Steady crowd sniper for the Pump.fun Sharpe Sprint.
//
// Idea in one line: only buy a launch a real crowd is already piling into, pay a
// modest flat stake, then bank small steady wins and cut the ride the moment the
// crowd's story breaks. The ranking is hourly Sharpe, so the bot is tuned for
// consistency across many coins, not for one lucky moonshot: small wins, quick
// exits, no doubling down, no hero holds.
//
// Entry (all must hold on the deciding batch):
//   - the coin was created at most 3 slots ago;
//   - at least 6 distinct wallets other than the creator have bought it;
//   - the creator has not sold any of it yet;
//   - the curve holds real SOL between 0.3 and 30 SOL and the price has not run
//     more than 2x off its create price (no chasing a launch that already flew);
//   - one buy per coin, at most 5 open positions, flat 0.3 SOL stake (capped by
//     the harness 1%-of-real-reserve order cap, and skipped when that cap is
//     under the 0.01 SOL round-trip minimum).
//
// Exit (first trigger wins, whole position, no partials, no adds):
//   - take profit at +8% over all-in cost;
//   - trailing stop: once the position is +1% over cost, sell when it falls 6%
//     from its best value since entry;
//   - hold cap of 600 slots;
//   - the creator sells while we hold.
//   There is deliberately no hard stop-loss: a crowded launch that dips early
//   and recovers still pays the take-profit, and the trailing stop plus the
//   hold cap bound the downside instead.
//
// Fully deterministic: every decision is a pure function of the batches the
// harness feeds in. No clock, no randomness, no environment, no I/O.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- tuning

const STAKE = 300_000_000n; // 0.3 SOL per coin
const MIN_ROUND_TRIP = 10_000_000n; // 0.01 SOL: the guardrail's round-trip floor
const ENTRY_AGE_SLOTS = 3; // decide only inside the first 3 slots of a launch
const MIN_CROWD_BUYERS = 6; // distinct non-creator buyers before entry
const MIN_REAL_SOL = 300_000_000n; // 0.3 SOL of real reserve at decision time
const MAX_REAL_SOL = 30_000_000_000n; // 30 SOL
const MAX_RUNUP_BPS = 10_000n; // price at most 2x its create price (10_000 bps = 100%)
const TAKE_PROFIT_BPS = 800; // +8% over all-in cost
const TRAIL_ARM_BPS = 100; // trailing stop arms at +1%
const TRAIL_DROP_BPS = 600; // ... then exits on a 6% fall from the best value
const HOLD_CAP_SLOTS = 600; // never hold longer than this
const WIDE_SLIPPAGE_BPS = 10_000; // never refuse a fill over a latency move
const CURVE_FEE_BPS = 125n; // protocol 95 + creator 30 bps, charged on the curve

// ---------------------------------------------------------------- launch tape

interface Launch {
  mint: Pubkey;
  creator: Pubkey;
  bornSlot: number;
  startVq: bigint;
  startVt: bigint;
  crowd: Set<Pubkey>;
  creatorSold: boolean;
  creatorSoldSlot: number;
  bought: boolean;
  finished: boolean;
}

interface OpenTrade {
  openedSlot: number;
  paidTx: bigint;
  bestValue: bigint;
  creatorSoldBeforeOpen: boolean;
}

const launches = new Map<Pubkey, Launch>();
const trades = new Map<Pubkey, OpenTrade>();
const exiting = new Set<Pubkey>();

// ---------------------------------------------------------------- pricing

/** What selling `tokens` against (virtualQuote, virtualToken) pays after curve fees. */
function exitValue(tokens: bigint, virtualQuote: bigint, virtualToken: bigint): bigint {
  if (tokens <= 0n || virtualToken <= 0n) return 0n;
  const gross = (tokens * virtualQuote) / (virtualToken + tokens);
  return gross - (gross * CURVE_FEE_BPS + 9999n) / 10_000n;
}

/** Price of one token as (virtualQuote / virtualToken), compared via cross-multiplication. */
function runupBps(nowVq: bigint, nowVt: bigint, atVq: bigint, atVt: bigint): bigint {
  if (nowVt <= 0n || atVq <= 0n || atVt <= 0n) return 0n;
  // (nowVq / nowVt) / (atVq / atVt) - 1, in bps
  const ratio = (nowVq * atVt * 10_000n) / (nowVt * atVq);
  return ratio - 10_000n;
}

// ---------------------------------------------------------------- tape update

function absorb(batch: Batch): void {
  for (const event of batch.events) {
    if (event.event === 'CreateEvent') {
      launches.set(event.mint, {
        mint: event.mint,
        creator: event.creator,
        bornSlot: event.slot,
        startVq: BigInt(event.virtual_quote_reserves),
        startVt: BigInt(event.virtual_token_reserves),
        crowd: new Set(),
        creatorSold: false,
        creatorSoldSlot: 0,
        bought: false,
        finished: false,
      });
    } else if (event.event === 'TradeEvent') {
      const launch = launches.get(event.mint);
      if (launch === undefined) continue;
      if (event.is_buy) {
        if (event.user !== launch.creator) launch.crowd.add(event.user);
      } else if (event.user === launch.creator && !launch.creatorSold) {
        launch.creatorSold = true;
        launch.creatorSoldSlot = event.slot;
      }
    } else {
      const launch = launches.get(event.mint);
      if (launch !== undefined) launch.finished = true;
    }
  }
}

function foldFills(state: BotState, batch: Batch): void {
  for (const fill of batch.fills) {
    if (fill.client_id.startsWith('_')) {
      // Harness close (curve completed, replay ended, write-off): forget the trade.
      trades.delete(fill.mint);
      exiting.delete(fill.mint);
      continue;
    }
    if (fill.side === 'buy' && fill.status === 'filled') {
      const launch = launches.get(fill.mint);
      trades.set(fill.mint, {
        openedSlot: fill.slot,
        paidTx: BigInt(fill.tx_fee_lamports),
        bestValue: 0n,
        creatorSoldBeforeOpen: launch?.creatorSold ?? false,
      });
    }
    if (fill.side === 'sell' && fill.status === 'filled') {
      trades.delete(fill.mint);
      exiting.delete(fill.mint);
    }
    if (fill.status === 'rejected' || fill.status === 'failed') {
      if (fill.side === 'sell') exiting.delete(fill.mint);
    }
  }
  // A position the account no longer holds (closed by the harness without a
  // sell fill we saw) is not an open trade any more.
  for (const mint of [...trades.keys()]) {
    if (!state.positions.has(mint)) trades.delete(mint);
  }
}

// ---------------------------------------------------------------- exits

function exitOrders(state: BotState, batch: Batch): OrderInput[] {
  const out: OrderInput[] = [];
  const cap = state.hello.caps.max_orders_per_batch;
  const tx = state.txFeeLamports();
  const latest = new Map<Pubkey, { vq: bigint; vt: bigint }>();
  for (const mark of batch.marks) {
    latest.set(mark.mint, {
      vq: BigInt(mark.virtual_quote_reserves),
      vt: BigInt(mark.virtual_token_reserves),
    });
  }

  for (const [mint, holding] of state.positions) {
    if (out.length >= cap) break;
    if (exiting.has(mint)) continue;
    let trade = trades.get(mint);
    if (trade === undefined) {
      trade = { openedSlot: state.slot, paidTx: tx, bestValue: 0n, creatorSoldBeforeOpen: false };
      trades.set(mint, trade);
    }
    let reserves = latest.get(mint);
    if (reserves === undefined) {
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      reserves = { vq: curve.virtual_quote_reserves, vt: curve.virtual_token_reserves };
    }
    const value = exitValue(holding.token_amount, reserves.vq, reserves.vt) - tx;
    const basis = holding.cost_lamports + trade.paidTx;
    if (value > trade.bestValue) trade.bestValue = value;

    let leave = false;
    if (basis > 0n) {
      if (value * 10_000n >= basis * (10_000n + BigInt(TAKE_PROFIT_BPS))) leave = true;
      if (
        trade.bestValue * 10_000n >= basis * (10_000n + BigInt(TRAIL_ARM_BPS)) &&
        value * 10_000n <= trade.bestValue * (10_000n - BigInt(TRAIL_DROP_BPS))
      ) {
        leave = true;
      }
    }
    if (state.slot - trade.openedSlot >= HOLD_CAP_SLOTS) leave = true;
    const launch = launches.get(mint);
    if (
      launch !== undefined &&
      launch.creatorSold &&
      !trade.creatorSoldBeforeOpen &&
      launch.creatorSoldSlot > trade.openedSlot
    ) {
      leave = true;
    }
    if (!leave) continue;
    out.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: WIDE_SLIPPAGE_BPS });
    exiting.add(mint);
    if (launch !== undefined) launch.bought = true;
  }
  return out;
}

// ---------------------------------------------------------------- entries

function entryOrders(state: BotState, ordersSoFar: number): OrderInput[] {
  const out: OrderInput[] = [];
  const caps = state.hello.caps;
  const tx = state.txFeeLamports();
  let free = state.freeCashLamports() - tx * BigInt(ordersSoFar);
  let open = state.committedPositionCount();

  for (const launch of launches.values()) {
    if (ordersSoFar + out.length >= caps.max_orders_per_batch) break;
    if (launch.bought || launch.finished) continue;
    if (open >= caps.max_open_positions) break;
    const age = state.slot - launch.bornSlot;
    if (age > ENTRY_AGE_SLOTS) {
      // The launch window has passed without a buy: never chase it later.
      launch.finished = true;
      continue;
    }
    if (age < 0) continue;
    if (launch.crowd.size < MIN_CROWD_BUYERS) continue;
    if (launch.creatorSold) {
      launch.finished = true;
      continue;
    }
    const curve = state.curves.get(launch.mint);
    if (curve === undefined || curve.complete) continue;
    const realSol = curve.real_quote_reserves;
    if (realSol < MIN_REAL_SOL || realSol > MAX_REAL_SOL) continue;
    if (runupBps(curve.virtual_quote_reserves, curve.virtual_token_reserves, launch.startVq, launch.startVt) > MAX_RUNUP_BPS) {
      continue;
    }
    const sizeCap = state.maxBuyLamports(launch.mint);
    if (sizeCap < MIN_ROUND_TRIP) continue;
    const amount = STAKE < sizeCap ? STAKE : sizeCap;
    if (amount < MIN_ROUND_TRIP) continue;
    if (free < amount + tx) continue;
    out.push({ side: 'buy', mint: launch.mint, quote_lamports: amount, max_slippage_bps: WIDE_SLIPPAGE_BPS });
    launch.bought = true;
    free -= amount + tx;
    open += 1;
  }
  return out;
}

// ---------------------------------------------------------------- wiring

await runBot({
  onBatch(state, batch) {
    absorb(batch);
    foldFills(state, batch);
    const exits = exitOrders(state, batch);
    const entries = entryOrders(state, exits.length);
    return [...exits, ...entries];
  },
});
