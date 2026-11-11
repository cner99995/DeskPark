/**
 * 含字牌的麻将牌（136 张）与财神百搭的牌型分析，供杭州麻将等玩法共用。
 *
 * 牌 id 0..135：
 * - 0..107 为万 / 条 / 筒，每种 4 张（与 108 张玩法一致）；
 * - 108..123 为风牌（东、南、西、北），124..135 为箭牌（中、发、白）。
 *
 * 「种类」kind 0..33：万 0..8、条 9..17、筒 18..26、风 27..30、箭 31..33。
 * 财神为白板（kind 33），可代替任意牌参与和牌，但不能用于吃 / 碰 / 杠。
 */

export type HjSuit = 'wan' | 'tiao' | 'tong' | 'feng' | 'jian';

export interface HjTile {
  id: number;
  suit: HjSuit;
  rank: number;
}

export const HJ_SUITS: readonly HjSuit[] = ['wan', 'tiao', 'tong', 'feng', 'jian'];
export const HJ_KINDS = 34;
/** 财神：白板 */
export const CAISHEN_KIND = 33;
export const CAISHEN_NAME = '白板';

const SUIT_LABEL: Record<HjSuit, string> = {
  wan: '万',
  tiao: '条',
  tong: '筒',
  feng: '风',
  jian: '箭',
};

const FENG = ['东', '南', '西', '北'];
const JIAN = ['中', '发', '白'];

export function tileOf(id: number): HjTile {
  if (id >= 108) {
    const h = id - 108;
    const kind = 27 + Math.floor(h / 4);
    return {
      id,
      suit: kind < 31 ? 'feng' : 'jian',
      rank: (kind < 31 ? kind - 27 : kind - 31) + 1,
    };
  }
  const s = Math.floor(id / 36);
  return { id, suit: HJ_SUITS[s], rank: Math.floor((id % 36) / 4) + 1 };
}

/** 136 张牌（万、条、筒、东南西北、中发白） */
export function createTiles(): HjTile[] {
  return Array.from({ length: 136 }, (_, id) => tileOf(id));
}

export function kindOf(t: Pick<HjTile, 'suit' | 'rank'>): number {
  if (t.suit === 'feng') return 27 + t.rank - 1;
  if (t.suit === 'jian') return 31 + t.rank - 1;
  return HJ_SUITS.indexOf(t.suit) * 9 + t.rank - 1;
}

export function kindSuit(kind: number): HjSuit {
  if (kind >= 31) return 'jian';
  if (kind >= 27) return 'feng';
  return HJ_SUITS[Math.floor(kind / 9)];
}

export function kindRank(kind: number): number {
  if (kind >= 31) return kind - 31 + 1;
  if (kind >= 27) return kind - 27 + 1;
  return (kind % 9) + 1;
}

export function kindName(kind: number): string {
  if (kind >= 31) return JIAN[kind - 31];
  if (kind >= 27) return FENG[kind - 27];
  return `${kindRank(kind)}${SUIT_LABEL[kindSuit(kind)]}`;
}

export function tileName(t: Pick<HjTile, 'suit' | 'rank'>): string {
  return kindName(kindOf(t));
}

export function countKinds(tiles: readonly Pick<HjTile, 'suit' | 'rank'>[]): number[] {
  const c = new Array<number>(HJ_KINDS).fill(0);
  for (const t of tiles) c[kindOf(t)]++;
  return c;
}

/** 手牌排序：万、条、筒、风、箭，同门按点数 */
export function sortTiles(tiles: readonly HjTile[]): HjTile[] {
  return [...tiles].sort(
    (a, b) => HJ_SUITS.indexOf(a.suit) - HJ_SUITS.indexOf(b.suit) || a.rank - b.rank || a.id - b.id,
  );
}

const total = (c: readonly number[]) => c.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// 和牌（含财神百搭）

/**
 * 能否把 counts 全部组成 setsNeeded 个面子（可选再要一个将）。
 * jokers 为可任意补位的财神数；counts[33] 必须已作为财神扣除。
 */
function canForm(
  counts: readonly number[],
  setsNeeded: number,
  jokers: number,
  needPair: boolean,
): boolean {
  const c = [...counts];
  const rec = (sets: number, usedPair: boolean, jk: number): boolean => {
    if (sets > setsNeeded) return false;
    let i = 0;
    while (i < HJ_KINDS && c[i] === 0) i++;
    if (i === HJ_KINDS) {
      const needSets = setsNeeded - sets;
      const pairCost = usedPair || !needPair ? 0 : 2;
      return jk === needSets * 3 + pairCost;
    }

    // 将
    if (needPair && !usedPair) {
      if (c[i] >= 2) {
        c[i] -= 2;
        if (rec(sets, true, jk)) {
          c[i] += 2;
          return true;
        }
        c[i] += 2;
      }
      if (jk >= 1) {
        c[i] -= 1;
        if (rec(sets, true, jk - 1)) {
          c[i] += 1;
          return true;
        }
        c[i] += 1;
      }
    }

    // 刻子：3 张实牌 / 2 张 + 财神 / 1 张 + 两张财神
    if (c[i] >= 3) {
      c[i] -= 3;
      if (rec(sets + 1, usedPair, jk)) {
        c[i] += 3;
        return true;
      }
      c[i] += 3;
    }
    if (c[i] >= 2 && jk >= 1) {
      c[i] -= 2;
      if (rec(sets + 1, usedPair, jk - 1)) {
        c[i] += 2;
        return true;
      }
      c[i] += 2;
    }
    if (c[i] >= 1 && jk >= 2) {
      c[i] -= 1;
      if (rec(sets + 1, usedPair, jk - 2)) {
        c[i] += 1;
        return true;
      }
      c[i] += 1;
    }

    // 顺子（只有序数牌能组成，字牌不行）
    if (i < 27) {
      const base = i - (i % 9);
      for (let s = Math.max(base, i - 2); s <= Math.min(i, base + 6); s++) {
        let need = 0;
        const take: number[] = [];
        for (let t = s; t <= s + 2; t++) {
          if (t === i) take.push(t);
          else if (c[t] > 0) take.push(t);
          else need++;
        }
        if (need > jk) continue;
        for (const t of take) c[t]--;
        const ok = rec(sets + 1, usedPair, jk - need);
        for (const t of take) c[t]++;
        if (ok) return true;
      }
    }
    return false;
  };
  return rec(0, false, jokers);
}

/** 七对是否成立（财神可补单张，也可两张财神凑一对） */
export function isSevenPairs(counts: readonly number[], jokers: number): boolean {
  const real = counts.filter((_, k) => k !== CAISHEN_KIND);
  const pairs = real.reduce((a, n) => a + Math.floor(n / 2), 0);
  const singles = real.filter((n) => n % 2 === 1).length;
  for (let x = 0; x <= Math.min(singles, jokers); x++) {
    const rest = jokers - x;
    if (rest % 2 === 0 && pairs + x + rest / 2 === 7) return true;
  }
  return false;
}

/** 14 张（或含副露的等价张数）是否和牌；counts 含财神（白板） */
export function isWinningShape(counts: readonly number[], melds: number): boolean {
  const jokers = counts[CAISHEN_KIND] ?? 0;
  const real = [...counts];
  real[CAISHEN_KIND] = 0;
  const setsNeeded = 4 - melds;
  if (setsNeeded < 0) return false;
  const n = total(real) + jokers;
  if (n !== setsNeeded * 3 + 2) return false;
  if (melds === 0 && isSevenPairs(counts, jokers)) return true;
  return canForm(real, setsNeeded, jokers, true);
}

/** 暗手全部组成面子、没有将（用于判断爆头 / 七客的前一手牌） */
export function isAllMelds(counts: readonly number[], setsNeeded: number): boolean {
  const real = [...counts];
  real[CAISHEN_KIND] = 0;
  return total(real) === setsNeeded * 3 && canForm(real, setsNeeded, 0, false);
}

/** 暗手全部组成对子（用于判断七客） */
export function isAllPairs(counts: readonly number[], pairs: number): boolean {
  const real = counts.filter((_, k) => k !== CAISHEN_KIND);
  return total(real) === pairs * 2 && real.every((n) => n % 2 === 0);
}

/** 听牌：13 张（或等价张数）的暗手加入哪些牌种可以和牌 */
export function waitingKinds(counts: readonly number[], melds: number): number[] {
  const out: number[] = [];
  const c = [...counts];
  for (let k = 0; k < HJ_KINDS; k++) {
    if (c[k] >= 4) continue;
    c[k]++;
    if (isWinningShape(c, melds)) out.push(k);
    c[k]--;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 向听数（电脑出牌用；财神按「每张可减一向听」近似）

type Partial = [mentsu: number, taatsu: number, pair: number];
const partialCache = new Map<string, Partial[]>();

function groupPartials(cs: number[], allowChow: boolean): Partial[] {
  const key = `${allowChow ? 'c' : 'h'}${cs.join('')}`;
  const hit = partialCache.get(key);
  if (hit) return hit;
  const c = [...cs];
  const len = cs.length;
  const found = new Map<string, Partial>();
  const rec = (i: number, m: number, t: number, p: number) => {
    while (i < len && c[i] === 0) i++;
    if (i === len) {
      found.set(`${m},${t},${p}`, [m, t, p]);
      return;
    }
    if (c[i] >= 3) {
      c[i] -= 3;
      rec(i, m + 1, t, p);
      c[i] += 3;
    }
    if (allowChow && i <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
      c[i]--;
      c[i + 1]--;
      c[i + 2]--;
      rec(i, m + 1, t, p);
      c[i]++;
      c[i + 1]++;
      c[i + 2]++;
    }
    if (c[i] >= 2) {
      c[i] -= 2;
      if (p === 0) rec(i, m, t, 1);
      rec(i, m, t + 1, p);
      c[i] += 2;
    }
    if (allowChow && i <= 7 && c[i + 1] > 0) {
      c[i]--;
      c[i + 1]--;
      rec(i, m, t + 1, p);
      c[i]++;
      c[i + 1]++;
    }
    if (allowChow && i <= 6 && c[i + 2] > 0) {
      c[i]--;
      c[i + 2]--;
      rec(i, m, t + 1, p);
      c[i]++;
      c[i + 2]++;
    }
    c[i]--;
    rec(i, m, t, p);
    c[i]++;
  };
  rec(0, 0, 0, 0);
  const all = [...found.values()];
  const front = all.filter(
    (a) =>
      !all.some(
        (b) =>
          b !== a &&
          b[0] >= a[0] &&
          b[1] >= a[1] &&
          b[2] >= a[2] &&
          (b[0] > a[0] || b[1] > a[1] || b[2] > a[2]),
      ),
  );
  partialCache.set(key, front);
  return front;
}

/** 不含财神的 34 种牌向听数 */
export function shantenStandard(counts: readonly number[], melds: number): number {
  const groups = [
    counts.slice(0, 9),
    counts.slice(9, 18),
    counts.slice(18, 27),
    counts.slice(27, 31),
    counts.slice(31, 34),
  ];
  const parts = groups.map((g, i) => groupPartials(g, i < 3));
  let best = 8;
  const rec = (idx: number, m: number, t: number, p: number) => {
    if (idx === parts.length) {
      const mm = m + melds;
      const tt = Math.min(t, Math.max(0, 4 - mm));
      const pp = p > 0 ? 1 : 0;
      best = Math.min(best, 8 - 2 * mm - tt - pp);
      return;
    }
    for (const [gm, gt, gp] of parts[idx]) rec(idx + 1, m + gm, t + gt, p + gp);
  };
  rec(0, 0, 0, 0);
  return best;
}

/** 含财神（counts[33]）的向听数近似值，-1 表示已和 */
export function shanten(counts: readonly number[], melds: number): number {
  const jokers = counts[CAISHEN_KIND] ?? 0;
  const real = [...counts];
  real[CAISHEN_KIND] = 0;
  const std = Math.max(-1, shantenStandard(real, melds) - jokers);
  let seven = 8;
  if (melds === 0) {
    let pairs = 0;
    for (const n of real) pairs += Math.floor(n / 2);
    seven = Math.max(-1, 6 - Math.min(7, pairs + jokers));
  }
  return Math.min(std, seven);
}

/** 吃牌可选的两张手牌种类组合（不含财神，只吃上家） */
export function chiOptions(handCounts: readonly number[], tileKind: number): [number, number][] {
  if (tileKind >= 27) return [];
  const base = tileKind - (tileKind % 9);
  const out: [number, number][] = [];
  for (let s = Math.max(base, tileKind - 2); s <= Math.min(tileKind, base + 6); s++) {
    const need = [s, s + 1, s + 2].filter((k) => k !== tileKind);
    if (need.every((k) => (handCounts[k] ?? 0) > 0)) out.push([need[0], need[1]]);
  }
  return out;
}

export function isCaishenKind(kind: number): boolean {
  return kind === CAISHEN_KIND;
}
