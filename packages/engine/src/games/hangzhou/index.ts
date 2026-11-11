import { clone } from '../../core/clone';
import { Rng } from '../../core/rng';
import type { GameDefinition, Seat } from '../../core/types';
import {
  CAISHEN_KIND,
  HJ_KINDS,
  chiOptions,
  countKinds,
  createTiles,
  isAllMelds,
  isAllPairs,
  kindName,
  kindOf,
  sortTiles,
  type HjTile,
} from '../../mahjong/honors';
import { hangzhouBot } from './bot';
import type { HzHandValue, HzPayment, HzSettlement } from './scoring';
import { evaluateHand, settleWin } from './scoring';

export * from './scoring';

/**
 * 杭州麻将（白板财神）。
 *
 * 136 张（万 / 条 / 筒 / 东南西北 / 中发白），白板固定为财神；
 * 可吃（只吃上家）碰杠，碰杠优先于吃；财神不能用于吃碰杠，打出的财神也不能被鸣。
 * 默认只能自摸；三老庄时庄家与闲家之间可以点炮。牌墙剩 20 张时流局。
 * 爆头、财飘、杠开、七对 / 豪华七对 / 清七对 / 七客，倍数相乘；连庄影响庄闲倍数。
 */

export type HzAction =
  | { type: 'discard'; tile: number }
  | { type: 'hu' }
  | { type: 'peng' }
  | { type: 'gang'; tile?: number }
  | { type: 'chi'; tiles: number[] }
  | { type: 'pass' }
  | { type: 'ready' };

export type KongType = 'an' | 'zhi' | 'ba';

export interface HzOptions {
  baseScore: number;
  rounds: number;
  /** 起手做庄：平庄 1 老庄 / 笃二老庄 / 笃三老庄 */
  dealerStart: 'ping' | 'two' | 'three';
  /** 三老庄时庄闲之间可点炮 */
  dianpao: boolean;
}

export interface HzMeld {
  type: 'chi' | 'pung' | 'kong';
  kongType?: KongType;
  kind: number;
  tiles: HjTile[];
  from: Seat | null;
}

export interface HzRiverTile {
  tile: HjTile;
  claimedBy?: Seat[];
}

export interface HzWin {
  seat: Seat;
  selfDrawn: boolean;
  tile: HjTile;
  from: Seat | null;
  value: HzHandValue;
  settlement: HzSettlement;
}

export interface HzPlayer {
  hand: HjTile[];
  melds: HzMeld[];
  river: HzRiverTile[];
  won: HzWin | null;
  /** 连续打出财神的次数（财飘） */
  caishenStreak: number;
  /** 连续杠的次数（杠开） */
  kongChain: number;
}

export type ClaimOpt = 'hu' | 'gang' | 'peng' | 'chi' | 'pass';

export interface HzWindow {
  source: Seat;
  tile: HjTile;
  required: boolean[];
  decisions: (HzAction | null)[];
  options: (ClaimOpt[] | null)[];
  /** 每个座位可选的吃牌组合（两张手牌的种类） */
  chi: ([number, number][] | null)[];
}

export type HzEvent =
  | { seq: number; type: 'chi' | 'peng' | 'gang'; seat: Seat; from?: Seat | null }
  | { seq: number; type: 'hu' | 'zimo'; seat: Seat; from?: Seat | null };

export type HzPhase = 'play' | 'roundOver' | 'matchOver';

export interface HzRoundResult {
  round: number;
  reason: 'win' | 'wall';
  wins: HzWin[];
  payments: HzPayment[];
  deltas: number[];
  hands: HjTile[][];
  nextDealer: Seat;
  dealerStreak: number;
}

export interface HzState {
  options: HzOptions;
  rng: number;
  round: number;
  phase: HzPhase;
  dealer: Seat;
  dealerStreak: number;
  wall: HjTile[];
  players: HzPlayer[];
  turn: Seat;
  drawnThisTurn: number | null;
  afterKongDraw: boolean;
  canSelfHu: boolean;
  window: HzWindow | null;
  lastDiscard: { seat: Seat; id: number } | null;
  scores: number[];
  ready: boolean[];
  result: HzRoundResult | null;
  history: {
    round: number;
    deltas: number[];
    wins: { seat: Seat; name: string; exponent: number }[];
  }[];
  events: HzEvent[];
  eventSeq: number;
}

export interface HzLegal {
  discard: number[];
  hu: boolean;
  gang: { tile: number; type: KongType }[];
  peng: boolean;
  chi: { tiles: number[]; kinds: [number, number] }[];
  pass: boolean;
  ready: boolean;
}

export interface HzPlayerView {
  handCount: number;
  melds: HzMeld[];
  river: HzRiverTile[];
  won: HzWin | null;
  hand: HjTile[] | null;
}

export interface HzView {
  seat: Seat | null;
  phase: HzPhase;
  round: number;
  options: HzOptions;
  dealer: Seat;
  dealerStreak: number;
  wallCount: number;
  turn: Seat | null;
  players: HzPlayerView[];
  hand: HjTile[];
  drawn: number | null;
  legal: HzLegal | null;
  window: { kind: 'claims'; source: Seat; tile: HjTile } | null;
  lastDiscard: { seat: Seat; id: number } | null;
  scores: number[];
  roundDeltas: number[];
  visible: number[];
  events: HzEvent[];
  result: HzRoundResult | null;
  ready: boolean[];
  history: HzState['history'];
}

const N = 4;
const others = (s: Seat) => [1, 2, 3].map((d) => (s + d) % N);
const nextSeat = (s: Seat) => (s + 1) % N;
const kindCount = (tiles: readonly HjTile[], kind: number) =>
  tiles.filter((t) => kindOf(t) === kind).length;
const jokersOf = (tiles: readonly HjTile[]) =>
  tiles.filter((t) => kindOf(t) === CAISHEN_KIND).length;

type EventInput = HzEvent extends infer E ? (E extends unknown ? Omit<E, 'seq'> : never) : never;

function pushEvent(state: HzState, e: EventInput) {
  state.events.push({ ...e, seq: ++state.eventSeq } as HzEvent);
  if (state.events.length > 16) state.events.shift();
}

function windowDone(w: HzWindow): boolean {
  return w.required.every((r, s) => !r || w.decisions[s] !== null);
}

function waitingIn(w: HzWindow, seat: Seat): boolean {
  return w.required[seat] && w.decisions[seat] === null;
}

function newPlayer(): HzPlayer {
  return {
    hand: [],
    melds: [],
    river: [],
    won: null,
    caishenStreak: 0,
    kongChain: 0,
  };
}

// ---------------------------------------------------------------------------
// 发牌与回合推进

function beginRound(state: HzState): void {
  const rng = new Rng(state.rng);
  const wall = rng.shuffle(createTiles());
  state.rng = rng.state;
  state.players = [0, 1, 2, 3].map(() => newPlayer());
  for (let i = 0; i < 13; i++)
    for (let s = 0; s < N; s++) state.players[(state.dealer + s) % N].hand.push(wall.shift()!);
  state.players[state.dealer].hand.push(wall.shift()!);
  state.wall = wall;
  state.turn = state.dealer;
  state.drawnThisTurn = null;
  state.afterKongDraw = false;
  state.canSelfHu = true;
  state.window = null;
  state.lastDiscard = null;
  state.result = null;
  state.ready = [false, false, false, false];
  state.events = [];
  state.eventSeq = 0;
  state.phase = 'play';
}

/** 和牌评估：extra 表示别人打出的牌（点炮），否则为自摸 */
function winValue(state: HzState, seat: Seat, extra: HjTile | null): HzHandValue | null {
  const p = state.players[seat];
  const tiles = extra ? [...p.hand, extra] : p.hand;
  const counts = countKinds(tiles);
  const preCounts = extra
    ? countKinds(p.hand)
    : state.drawnThisTurn !== null
      ? countKinds(p.hand.filter((t) => t.id !== state.drawnThisTurn))
      : null;
  return evaluateHand({
    counts,
    melds: p.melds.length,
    preCounts,
    selfDrawn: !extra,
    afterKongDraw: !extra && state.afterKongDraw,
    kongChain: p.kongChain,
    caishenStreak: p.caishenStreak,
  });
}

function draw(state: HzState, seat: Seat, replacement: boolean): void {
  if (state.wall.length === 0) {
    endRound(state, 'wall');
    return;
  }
  if (!replacement && state.wall.length <= 20) {
    endRound(state, 'wall');
    return;
  }
  const p = state.players[seat];
  const tile = state.wall.shift()!;
  p.hand.push(tile);
  if (!replacement) p.kongChain = 0;
  state.turn = seat;
  state.drawnThisTurn = tile.id;
  state.afterKongDraw = replacement;
  state.canSelfHu = true;
  state.window = null;
}

function advanceAfterDiscard(state: HzState, discarder: Seat): void {
  if (state.wall.length <= 20) {
    endRound(state, 'wall');
    return;
  }
  draw(state, nextSeat(discarder), false);
}

/** 能否点炮：仅三老庄，且只在庄家与闲家之间，财神不能放铳 */
function canRon(state: HzState, seat: Seat, tile: HjTile): boolean {
  if (!state.options.dianpao || state.dealerStreak < 3) return false;
  const discarderIsDealer = state.lastDiscard?.seat === state.dealer;
  if ((seat === state.dealer) === discarderIsDealer) return false;
  if (kindOf(tile) === CAISHEN_KIND) return false;
  if (!winValue(state, seat, tile)) return false;
  // 爆头时不能放铳
  const p = state.players[seat];
  const pre = countKinds(p.hand);
  if (
    (pre[CAISHEN_KIND] ?? 0) === 1 &&
    (isAllMelds(pre, 4 - p.melds.length) || (p.melds.length === 0 && isAllPairs(pre, 6)))
  )
    return false;
  return true;
}

function openClaims(state: HzState, discarder: Seat, tile: HjTile): void {
  const w: HzWindow = {
    source: discarder,
    tile,
    required: [false, false, false, false],
    decisions: [null, null, null, null],
    options: [null, null, null, null],
    chi: [null, null, null, null],
  };
  let any = false;
  const kind = kindOf(tile);
  // 打出的财神不能吃碰杠胡
  if (kind !== CAISHEN_KIND) {
    for (const s of others(discarder)) {
      const p = state.players[s];
      if (p.won) continue;
      const opts: ClaimOpt[] = [];
      if (canRon(state, s, tile)) opts.push('hu');
      const n = kindCount(p.hand, kind);
      if (n >= 3 && state.wall.length > 0) opts.push('gang');
      if (n >= 2) opts.push('peng');
      const chis = s === nextSeat(discarder) ? chiOptions(countKinds(p.hand), kind) : [];
      if (chis.length) opts.push('chi');
      w.required[s] = true;
      if (!opts.length) {
        w.options[s] = ['pass'];
        w.decisions[s] = { type: 'pass' };
      } else {
        w.options[s] = [...opts, 'pass'];
        w.chi[s] = chis.length ? chis : null;
        any = true;
      }
    }
  }
  if (!any) {
    advanceAfterDiscard(state, discarder);
    return;
  }
  state.window = w;
}

function resolveWindow(state: HzState): void {
  const w = state.window!;
  const order = others(w.source);
  const dec = (s: Seat) => w.decisions[s];
  state.window = null;

  const huSeat = order.find((s) => dec(s)?.type === 'hu');
  if (huSeat !== undefined) {
    const discarder = state.players[w.source];
    const river = discarder.river[discarder.river.length - 1];
    if (river?.tile.id === w.tile.id) river.claimedBy = [huSeat];
    const p = state.players[huSeat];
    const value = winValue(state, huSeat, w.tile)!;
    const settlement = settleWin({
      value,
      baseScore: state.options.baseScore,
      dealer: state.dealer,
      dealerStreak: state.dealerStreak,
      winner: huSeat,
      selfDrawn: false,
      discarder: w.source,
    });
    p.won = {
      seat: huSeat,
      selfDrawn: false,
      tile: w.tile,
      from: w.source,
      value,
      settlement,
    };
    state.lastDiscard = null;
    pushEvent(state, { type: 'hu', seat: huSeat, from: w.source });
    endRound(state, 'win', huSeat);
    return;
  }

  const gangSeat = order.find((s) => dec(s)?.type === 'gang');
  if (gangSeat !== undefined) {
    takeDiscard(state, w);
    const p = state.players[gangSeat];
    const kind = kindOf(w.tile);
    const own = p.hand.filter((t) => kindOf(t) === kind).slice(0, 3);
    const ids = new Set(own.map((t) => t.id));
    p.hand = p.hand.filter((t) => !ids.has(t.id));
    p.melds.push({ type: 'kong', kongType: 'zhi', kind, tiles: [...own, w.tile], from: w.source });
    p.kongChain = 1;
    p.caishenStreak = 0;
    pushEvent(state, { type: 'gang', seat: gangSeat, from: w.source });
    draw(state, gangSeat, true);
    return;
  }

  const pengSeat = order.find((s) => dec(s)?.type === 'peng');
  if (pengSeat !== undefined) {
    takeDiscard(state, w);
    const p = state.players[pengSeat];
    const kind = kindOf(w.tile);
    const own = p.hand.filter((t) => kindOf(t) === kind).slice(0, 2);
    const ids = new Set(own.map((t) => t.id));
    p.hand = p.hand.filter((t) => !ids.has(t.id));
    p.melds.push({ type: 'pung', kind, tiles: [...own, w.tile], from: w.source });
    p.kongChain = 0;
    p.caishenStreak = 0;
    pushEvent(state, { type: 'peng', seat: pengSeat, from: w.source });
    state.turn = pengSeat;
    state.drawnThisTurn = null;
    state.afterKongDraw = false;
    state.canSelfHu = false;
    return;
  }

  const chiSeat = order.find((s) => dec(s)?.type === 'chi');
  if (chiSeat !== undefined) {
    const action = dec(chiSeat) as { type: 'chi'; tiles: number[] };
    takeDiscard(state, w);
    const p = state.players[chiSeat];
    const own = action.tiles.map((id) => p.hand.find((t) => t.id === id)!).filter(Boolean);
    const ids = new Set(own.map((t) => t.id));
    p.hand = p.hand.filter((t) => !ids.has(t.id));
    const kind = Math.min(kindOf(w.tile), ...own.map((t) => kindOf(t)));
    p.melds.push({
      type: 'chi',
      kind,
      tiles: [...own, w.tile].sort((a, b) => kindOf(a) - kindOf(b)),
      from: w.source,
    });
    p.kongChain = 0;
    p.caishenStreak = 0;
    pushEvent(state, { type: 'chi', seat: chiSeat, from: w.source });
    state.turn = chiSeat;
    state.drawnThisTurn = null;
    state.afterKongDraw = false;
    state.canSelfHu = false;
    return;
  }

  advanceAfterDiscard(state, w.source);
}

function takeDiscard(state: HzState, w: HzWindow): void {
  const p = state.players[w.source];
  if (p.river[p.river.length - 1]?.tile.id === w.tile.id) p.river.pop();
  state.lastDiscard = null;
}

function endRound(state: HzState, reason: 'win' | 'wall', winner?: Seat): void {
  state.window = null;
  const wins = state.players.map((p) => p.won).filter((w): w is HzWin => !!w);
  const payments = wins.flatMap((w) => w.settlement.payments);
  const deltas = [0, 0, 0, 0];
  for (const e of payments) {
    deltas[e.from] -= e.amount;
    deltas[e.to] += e.amount;
  }
  for (let s = 0; s < N; s++) state.scores[s] += deltas[s];

  const nextDealer = winner ?? state.dealer;
  state.dealerStreak =
    winner !== undefined
      ? winner === state.dealer
        ? Math.min(3, state.dealerStreak + 1)
        : 1
      : Math.min(3, state.dealerStreak + 1);

  state.result = {
    round: state.round,
    reason,
    wins,
    payments,
    deltas,
    hands: state.players.map((p) => sortTiles(p.hand)),
    nextDealer,
    dealerStreak: state.dealerStreak,
  };
  state.history.push({
    round: state.round,
    deltas,
    wins: wins.map((w) => ({ seat: w.seat, name: w.value.name, exponent: w.value.exponent })),
  });
  state.ready = [false, false, false, false];
  const roundsDone = state.options.rounds > 0 && state.round >= state.options.rounds;
  state.phase = roundsDone ? 'matchOver' : 'roundOver';
}

// ---------------------------------------------------------------------------
// 合法动作

export function legalActions(state: HzState, seat: Seat): HzLegal | null {
  const L: HzLegal = {
    discard: [],
    hu: false,
    gang: [],
    peng: false,
    chi: [],
    pass: false,
    ready: false,
  };
  if (state.phase === 'roundOver') {
    if (state.ready[seat]) return null;
    L.ready = true;
    return L;
  }
  if (state.phase !== 'play') return null;
  const p = state.players[seat];
  if (p.won) return null;

  const w = state.window;
  if (w) {
    if (!waitingIn(w, seat)) return null;
    const opts = w.options[seat] ?? [];
    L.hu = opts.includes('hu');
    L.peng = opts.includes('peng');
    L.pass = opts.includes('pass');
    if (opts.includes('gang')) L.gang = [{ tile: w.tile.id, type: 'zhi' }];
    if (opts.includes('chi') && w.chi[seat]) {
      for (const [a, b] of w.chi[seat]!) {
        const ta = p.hand.find((t) => kindOf(t) === a);
        const tb = p.hand.find((t) => kindOf(t) === b && t.id !== ta?.id);
        if (ta && tb) L.chi.push({ tiles: [ta.id, tb.id], kinds: [a, b] });
      }
    }
    return L;
  }
  if (state.turn !== seat) return null;

  L.hu = state.canSelfHu && !!winValue(state, seat, null);
  L.discard = p.hand.map((t) => t.id);
  if (state.wall.length > 0) {
    const counts = countKinds(p.hand);
    for (let k = 0; k < HJ_KINDS; k++) {
      if (counts[k] === 4)
        L.gang.push({ tile: p.hand.find((t) => kindOf(t) === k)!.id, type: 'an' });
    }
    for (const m of p.melds) {
      if (m.type !== 'pung') continue;
      const t = p.hand.find((x) => kindOf(x) === m.kind);
      if (t) L.gang.push({ tile: t.id, type: 'ba' });
    }
  }
  return L;
}

// ---------------------------------------------------------------------------

function cleanAction(a: HzAction): HzAction {
  switch (a.type) {
    case 'discard':
      return { type: 'discard', tile: Number(a.tile) };
    case 'gang':
      return typeof a.tile === 'number' ? { type: 'gang', tile: Number(a.tile) } : { type: 'gang' };
    case 'chi':
      return { type: 'chi', tiles: Array.isArray(a.tiles) ? a.tiles.map(Number) : [] };
    default:
      return { type: a.type };
  }
}

function visibleIds(state: HzState, viewer: Seat | null): Set<number> {
  const ids = new Set<number>();
  state.players.forEach((p, s) => {
    for (const m of p.melds) for (const t of m.tiles) ids.add(t.id);
    for (const r of p.river) ids.add(r.tile.id);
    if (p.won || s === viewer) for (const t of p.hand) ids.add(t.id);
  });
  return ids;
}

let tilesCache: HjTile[] | null = null;
function visibleCounts(state: HzState, viewer: Seat | null): number[] {
  if (!tilesCache) tilesCache = createTiles();
  const c = new Array<number>(HJ_KINDS).fill(0);
  for (const id of visibleIds(state, viewer)) c[kindOf(tilesCache[id])]++;
  return c;
}

export const hangzhou: GameDefinition<HzState, HzAction, HzView, HzOptions> = {
  meta: {
    id: 'hangzhou',
    category: 'mahjong',
    name: '杭州麻将',
    nameEn: 'Hangzhou Mahjong',
    tagline: '白板当财神，爆头、财飘、杠开，连庄翻倍',
    minPlayers: 4,
    maxPlayers: 4,
    defaultPlayers: 4,
    botDelayMs: [450, 950],
    rules: [
      '杭州麻将（白板财神）：万、条、筒、东南西北、中发白共 136 张。白板固定为财神，可代替任意牌参与和牌。',
      '可以吃（只吃上家）、碰、杠，碰杠优先于吃；财神不能用来吃碰杠，打出的财神只是白板，不能被鸣。',
      '默认只能自摸胡；三老庄时庄家与闲家之间可以点炮，闲家与闲家之间不能点炮。财神不能放铳。',
      '基本牌型为 4 面子 + 1 将，另有七对。财神可以补顺子、刻子或对子。',
      '爆头：手里只有 1 张财神且其余牌全是面子时，摸任意一张都能胡，×2。',
      '财飘：爆头前连续打出的都是财神，每飘一次再 ×2（财飘 ×4、双财飘 ×8、三财飘 ×16）。',
      '杠开：杠后补牌自摸，每连杠一次 ×2（杠开 ×2、二连杠 ×4、三连杠 ×8、四连杠 ×16）。',
      '七对 ×2，每个四张（豪华）再 ×2，清七对（无财神）×4 起；七对 + 爆头为七客 ×4 起。倍数相乘叠加。',
      '牌墙剩余 20 张时流局。庄家胡牌或流局则连庄（最多三老庄），庄闲倍数 1 老庄 ×2、2 老庄 ×4、3 老庄 ×8，闲家之间 ×1。',
    ],
  },
  defaultOptions: { baseScore: 1, rounds: 8, dealerStart: 'ping', dianpao: true },
  optionFields: [
    {
      key: 'baseScore',
      label: '底分',
      type: 'select',
      choices: [
        { value: 1, label: '1' },
        { value: 2, label: '2' },
        { value: 5, label: '5' },
      ],
    },
    {
      key: 'rounds',
      label: '盘数',
      type: 'select',
      choices: [
        { value: 4, label: '4 盘' },
        { value: 8, label: '8 盘' },
        { value: 16, label: '16 盘' },
        { value: 0, label: '不限' },
      ],
    },
    {
      key: 'dealerStart',
      label: '起手做庄',
      hint: '连庄倍数：1 老庄 ×2、2 老庄 ×4、3 老庄 ×8',
      type: 'select',
      choices: [
        { value: 'ping', label: '平庄（1 老庄）' },
        { value: 'two', label: '笃二老庄' },
        { value: 'three', label: '笃三老庄' },
      ],
    },
    {
      key: 'dianpao',
      label: '三老庄可点炮',
      hint: '关闭后只能自摸胡',
      type: 'toggle',
    },
  ],

  setup({ options, seed }) {
    const rng = new Rng(seed);
    const state: HzState = {
      options: { ...options },
      rng: rng.state,
      round: 1,
      phase: 'play',
      dealer: rng.int(N),
      dealerStreak: options.dealerStart === 'three' ? 3 : options.dealerStart === 'two' ? 2 : 1,
      wall: [],
      players: [],
      turn: 0,
      drawnThisTurn: null,
      afterKongDraw: false,
      canSelfHu: true,
      window: null,
      lastDiscard: null,
      scores: [0, 0, 0, 0],
      ready: [false, false, false, false],
      result: null,
      history: [],
      events: [],
      eventSeq: 0,
    };
    state.rng = rng.state;
    beginRound(state);
    return state;
  },

  activeSeats(state) {
    if (state.phase === 'roundOver') return [0, 1, 2, 3].filter((s) => !state.ready[s]);
    if (state.phase === 'matchOver') return [];
    if (state.window) return [0, 1, 2, 3].filter((s) => waitingIn(state.window!, s));
    return [state.turn];
  },

  validate(state, seat, action) {
    const L = legalActions(state, seat);
    if (!L) return '现在不是你的操作时机';
    const p = state.players[seat];
    switch (action.type) {
      case 'ready':
        return L.ready ? null : '本盘尚未结束';
      case 'discard':
        return L.discard.includes(action.tile) ? null : '不能打这张牌';
      case 'hu':
        return L.hu ? null : '还不能胡';
      case 'peng':
        return L.peng ? null : '不能碰';
      case 'chi': {
        if (!L.chi.length) return '不能吃';
        const ids = [...action.tiles].sort((a, b) => a - b).join(',');
        return L.chi.some((o) => [...o.tiles].sort((a, b) => a - b).join(',') === ids)
          ? null
          : '不能这样吃';
      }
      case 'gang': {
        if (!L.gang.length) return '不能杠';
        if (state.window) return null;
        const t = p.hand.find((x) => x.id === action.tile);
        if (!t) return '请选择要杠的牌';
        return L.gang.some((g) => kindOf(tilesCacheOrId(g.tile)) === kindOf(t)) ? null : '不能杠';
      }
      case 'pass':
        return L.pass ? null : '现在不能过';
      default:
        return '未知操作';
    }
  },

  apply(prev, seat, raw) {
    const action = cleanAction(raw);
    const state = clone(prev);
    const p = state.players[seat];
    switch (action.type) {
      case 'ready': {
        state.ready[seat] = true;
        if (state.ready.every(Boolean)) {
          state.dealer = state.result!.nextDealer;
          state.dealerStreak = state.result!.dealerStreak;
          state.round++;
          beginRound(state);
        }
        return state;
      }
      case 'discard': {
        const tile = p.hand.find((t) => t.id === action.tile)!;
        p.hand = p.hand.filter((t) => t.id !== tile.id);
        p.river.push({ tile });
        p.kongChain = 0;
        p.caishenStreak = kindOf(tile) === CAISHEN_KIND ? Math.min(3, p.caishenStreak + 1) : 0;
        state.lastDiscard = { seat, id: tile.id };
        state.drawnThisTurn = null;
        state.afterKongDraw = false;
        openClaims(state, seat, tile);
        return state;
      }
      case 'hu': {
        if (state.window) {
          state.window.decisions[seat] = action;
          if (windowDone(state.window)) resolveWindow(state);
          return state;
        }
        const value = winValue(state, seat, null)!;
        const settlement = settleWin({
          value,
          baseScore: state.options.baseScore,
          dealer: state.dealer,
          dealerStreak: state.dealerStreak,
          winner: seat,
          selfDrawn: true,
        });
        const tile =
          state.drawnThisTurn !== null
            ? (p.hand.find((t) => t.id === state.drawnThisTurn) ?? p.hand[p.hand.length - 1])
            : p.hand[p.hand.length - 1];
        p.won = { seat, selfDrawn: true, tile, from: null, value, settlement };
        pushEvent(state, { type: 'zimo', seat });
        endRound(state, 'win', seat);
        return state;
      }
      case 'peng': {
        state.window!.decisions[seat] = action;
        if (windowDone(state.window!)) resolveWindow(state);
        return state;
      }
      case 'pass': {
        state.window!.decisions[seat] = action;
        if (windowDone(state.window!)) resolveWindow(state);
        return state;
      }
      case 'chi': {
        state.window!.decisions[seat] = action;
        if (windowDone(state.window!)) resolveWindow(state);
        return state;
      }
      case 'gang': {
        if (state.window) {
          state.window.decisions[seat] = action;
          if (windowDone(state.window)) resolveWindow(state);
          return state;
        }
        const target = p.hand.find((t) => t.id === action.tile)!;
        const kind = kindOf(target);
        const pung = p.melds.find((m) => m.type === 'pung' && m.kind === kind);
        if (pung) {
          // 补杠
          p.hand = p.hand.filter((t) => t.id !== target.id);
          pung.type = 'kong';
          pung.kongType = 'ba';
          pung.tiles = [...pung.tiles, target];
          p.kongChain = Math.min(4, p.kongChain + 1);
          p.caishenStreak = 0;
          pushEvent(state, { type: 'gang', seat });
          state.drawnThisTurn = null;
          draw(state, seat, true);
          return state;
        }
        // 暗杠
        const four = p.hand.filter((t) => kindOf(t) === kind);
        p.hand = p.hand.filter((t) => kindOf(t) !== kind);
        p.melds.push({ type: 'kong', kongType: 'an', kind, tiles: four, from: null });
        p.kongChain = Math.min(4, p.kongChain + 1);
        p.caishenStreak = 0;
        pushEvent(state, { type: 'gang', seat });
        state.drawnThisTurn = null;
        draw(state, seat, true);
        return state;
      }
    }
    return state;
  },

  view(state, seat) {
    const over = state.phase === 'roundOver' || state.phase === 'matchOver';
    const w = state.window;
    const me = seat !== null ? state.players[seat] : null;
    return {
      seat,
      phase: state.phase,
      round: state.round,
      options: state.options,
      dealer: state.dealer,
      dealerStreak: state.dealerStreak,
      wallCount: state.wall.length,
      turn: state.phase === 'play' ? state.turn : null,
      players: state.players.map((p) => ({
        handCount: p.hand.length,
        melds: p.melds,
        river: p.river,
        won: p.won,
        hand: over || p.won ? sortTiles(p.hand) : null,
      })),
      hand: me ? sortTiles(me.hand) : [],
      drawn: seat !== null && state.turn === seat && !w ? state.drawnThisTurn : null,
      legal: seat !== null ? legalActions(state, seat) : null,
      window:
        w && seat !== null && w.required[seat]
          ? { kind: 'claims', source: w.source, tile: w.tile }
          : null,
      lastDiscard: state.lastDiscard,
      scores: state.scores,
      roundDeltas: state.result?.deltas ?? [0, 0, 0, 0],
      visible: visibleCounts(state, seat),
      events: state.events,
      result: state.result,
      ready: state.ready,
      history: state.history,
    };
  },

  isOver: (state) => state.phase === 'matchOver',
  bot: hangzhouBot,
};

let tileCache: HjTile[] | null = null;
function tilesCacheOrId(id: number): HjTile {
  if (!tileCache) tileCache = createTiles();
  return tileCache[id];
}

/** 测试用：直接结算与折算 */
export { endRound as _endRound, visibleCounts as _visibleCounts, winValue as _winValue };
export { kindName, jokersOf };
