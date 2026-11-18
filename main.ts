// Calm-dip swing bot for cbBTC on 1-minute bars.
//
// The idea: a full-size round trip costs about 26 bps in fees, slippage and
// pool impact, while 1-minute noise is only ~7 bps a bar, so trading every
// wiggle bleeds money (the EMA-cross baseline loses heavily on the dev
// window). This bot trades rarely, only for a real swing, and only once the
// drop has paused:
//
//   - Entry: the close sits at least 50 bps below its 64-bar EMA, and the
//     last 5 bars are no longer plunging (their return is -30 bps or
//     better). Buying a dip while the price is still falling fast is how a
//     dip bot gets stopped out over and over; the calm check waits for the
//     fall to stall first.
//   - Exit in two stages: when the position is worth 100 bps over its cost,
//     sell half and bank it. The other half rides a trailing stop: once the
//     close has fallen 40 bps from the highest close seen while holding,
//     sell the rest. There is no fixed full take-profit, so a runner can
//     keep running, and no fixed exit level the price has to reach exactly.
//   - Hard stop: the whole position is cut if it falls 120 bps under its
//     cost. Two stop-outs in a row pause entries for 180 bars, so a
//     downtrend day cannot stop the bot out repeatedly, and any exit starts
//     a 5-bar cooldown before a new entry.
//   - No new entry is taken in the last 60 bars: a trade that fills one bar
//     before the end would pay the full round-trip cost for a one-bar hold.
//
// On the published dev window this makes 9 trades (3 round trips plus the
// partial takes) for about +$23 of net PnL with a ~1.1% maximum drawdown,
// against -$32 for buy-and-hold. Verified with the kit's local grader
// (grade-local, process driver): net PnL +$22.90, 9 trades, max drawdown
// 1.09%, 0 rejected orders, two runs byte-identical. The two big swings it
// catches are the recovery from the early drop and the mid-day rally; in
// the quiet second half, where no 50 bps dip ever forms, it simply does not
// trade.
//
// The bot speaks agent-fun/bars-replay/v1 through the kit shim: the harness
// sends hello once, then one batch per minute (each batch carries the bar
// that just closed, the fills of the orders decided on the previous batch,
// and the account), and the bot answers every batch with exactly one orders
// reply. Orders decided on the batch of the bar closing at minute t fill at
// the next bar's open, so every decision here is made on closes only.
// Everything is deterministic: the EMA runs in float64 on + - * / alone,
// and no clock, network, file or environment value is ever read.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** The EMA span the dip is measured against (about an hour of bars). */
const EMA_BARS = 64;
/** Entry: the close must sit this far below the EMA, in bps. */
const DIP_BPS = 50;
/** Entry calm check: the return over this many bars must be no worse than CALM_MIN_BPS. */
const CALM_BARS = 5;
/** Entry calm check: the 5-bar return must be at or above this, in bps. */
const CALM_MIN_BPS = -30;
/** First exit: sell this share of the position once it is worth TAKE1_BPS over its cost. */
const TAKE1_BPS = 100;
/** First exit: the share sold at the partial take (numerator / denominator). */
const TAKE1_NUM = 1n;
const TAKE1_DEN = 2n;
/** Trailing stop: once the partial take has happened, sell the rest once the close has fallen this far from the peak close seen while holding, in bps. */
const TRAIL_BPS = 40;
/** Hard stop: cut the whole position once it is worth this much under its cost, in bps. */
const STOP_BPS = 120;
/** Bars to wait after any exit before a new entry. */
const COOLDOWN_BARS = 5;
/** Consecutive stop-outs that pause entries. */
const STOPS_TO_PAUSE = 2;
/** Bars entries stay paused after that many consecutive stop-outs. */
const PAUSE_BARS = 180;
/** No new entry once this many bars of the window have been seen. */
const NO_ENTRY_TAIL_BARS = 60;
/** Bars in a window of this competition (dev and race alike). */
const WINDOW_BARS = 1440;
/** Slippage cap on every order, in bps past the latest close it was decided on. */
const MAX_SLIPPAGE_BPS = 100;

const SYMBOL = 'CBBTC';

/** One EMA over closes: the mean of its first span of closes, then 2 / (span + 1) of the way to each new close. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

const ema: Ema = { span: EMA_BARS, warm: [], value: null };
/** Closes seen so far, in order (for the calm check). */
const closes: number[] = [];
/** Scored bars seen so far (warm-up batches, if any, do not count). */
let barsSeen = 0;
/** The highest close seen while the current position has been held. */
let peakClose = 0;
/** Whether the partial take has already been sold on the current position. */
let tookPartial = false;
/** Bars-seen count at the last exit this bot decided, for the cooldown. */
let lastExitSeen = -1_000_000;
/** Stop-outs in a row; a trailing exit resets it. */
let stopsInRow = 0;
/** Entries are paused while barsSeen is below this. */
let pauseUntilSeen = -1;

/** Feed one bar's close into the EMA and the close history. */
function push(bar: Bar): void {
  const close = Number(bar.c);
  stepEma(ema, close);
  closes.push(close);
}

/** Whether the position's value at this close has reached the partial take. */
function atTake(state: BarsState, held: { qty: bigint; cost: bigint }): boolean {
  const value = state.value(SYMBOL, held.qty);
  return value * 10_000n >= held.cost * BigInt(10_000 + TAKE1_BPS);
}

/** Whether the position's value at this close has hit the hard stop. */
function atStop(state: BarsState, held: { qty: bigint; cost: bigint }): boolean {
  const value = state.value(SYMBOL, held.qty);
  return value * 10_000n <= held.cost * BigInt(10_000 - STOP_BPS);
}

/** Whether the trailing stop has fired: the partial take happened, and the close has fallen TRAIL_BPS from its peak while holding. */
function atTrail(close: number): boolean {
  if (!tookPartial || peakClose <= 0) return false;
  return (peakClose - close) / peakClose >= TRAIL_BPS / 10_000;
}

/** Whether the recent fall has stalled: the return over the last CALM_BARS bars is no worse than CALM_MIN_BPS. */
function isCalm(): boolean {
  if (closes.length <= CALM_BARS) return false;
  const now = closes[closes.length - 1]!;
  const then = closes[closes.length - 1 - CALM_BARS]!;
  return ((now - then) / then) * 10_000 >= CALM_MIN_BPS;
}

await runBars({
  onBatch(state, batch) {
    for (const bar of batch.bars) push(bar);
    if (state.warmingUp) return [];
    barsSeen++;
    const held = state.positions.get(SYMBOL);
    const { caps, fees } = state.hello;
    const minNotional = BigInt(fees.min_notional_quote_units);
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);

    if (held !== undefined) {
      // Holding: track the peak close and check the exits, in order:
      // hard stop first, then the partial take, then the trailing stop.
      if (bar !== undefined) {
        const close = Number(bar.c);
        if (close > peakClose) peakClose = close;
      }
      if (atStop(state, held)) {
        lastExitSeen = barsSeen;
        stopsInRow++;
        if (stopsInRow >= STOPS_TO_PAUSE) pauseUntilSeen = barsSeen + PAUSE_BARS;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      if (!tookPartial && atTake(state, held)) {
        tookPartial = true;
        const qty = (held.qty * TAKE1_NUM) / TAKE1_DEN;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      if (bar !== undefined && atTrail(Number(bar.c))) {
        lastExitSeen = barsSeen;
        stopsInRow = 0;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // Flat: a fresh position starts with a clean peak and no partial taken.
    peakClose = 0;
    tookPartial = false;
    if (ema.value === null) return [];
    if (barsSeen > WINDOW_BARS - NO_ENTRY_TAIL_BARS) return [];
    if (barsSeen < pauseUntilSeen) return [];
    if (barsSeen - lastExitSeen < COOLDOWN_BARS) return [];
    if (bar === undefined) return [];
    const close = Number(bar.c);
    // The dip: the close sits DIP_BPS or more below the EMA, and the fall has stalled.
    if (close >= ema.value * (1 - DIP_BPS / 10_000)) return [];
    if (!isCalm()) return [];
    let stake = state.cash;
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / 10_000n;
    if (stake > byWeight) stake = byWeight;
    if (stake < minNotional) return [];
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: stake, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
