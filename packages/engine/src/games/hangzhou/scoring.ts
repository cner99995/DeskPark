import {
  CAISHEN_KIND,
  isAllMelds,
  isAllPairs,
  isSevenPairs,
  isWinningShape,
} from '../../mahjong/honors';

/**
 * 杭州麻将（白板财神）番型与结算。
 *
 * 倍数均为 2 的幂：
 * - 平胡 ×1；爆头 ×2；财飘 / 双财飘 / 三财飘 分别 ×2、×4、×8（在爆头基础上再乘）。
 * - 杠开每连杠一次再 ×2（杠开 ×2、二连杠 ×4、三连杠 ×8、四连杠 ×16）。
 * - 七对 ×2；豪华七对（每个四张 +1 次幂）最高 ×16；清七对 ×4 起；七客 ×4 起。
 * 财飘只对「摸什么都能胡」的爆头 / 七客生效。
 */

export type HzPattern = 'pinghu' | 'baotou' | 'qidui' | 'qingqidui' | 'qike';

export const PATTERN_NAME: Record<HzPattern, string> = {
  pinghu: '平胡',
  baotou: '爆头',
  qidui: '七对',
  qingqidui: '清七对',
  qike: '七客',
};

export interface HzHandValue {
  pattern: HzPattern;
  name: string;
  /** 2 的指数：倍数 = 2^exponent */
  exponent: number;
  multiplier: number;
  /** 七对中的四张组数（豪华数） */
  quads: number;
  /** 和牌时手中的财神数 */
  caishen: number;
  /** 财飘次数（0..3） */
  piao: number;
  /** 连杠次数（0..4） */
  kongs: number;
}

export interface HzWinContext {
  /** 暗手计数（已包含和进的那张牌） */
  counts: number[];
  /** 副露组数（吃 / 碰 / 杠各算一组） */
  melds: number;
  /** 和牌前（未含和进那张）的暗手计数；自摸时可传入 */
  preCounts: number[] | null;
  selfDrawn: boolean;
  afterKongDraw: boolean;
  /** 连续杠次数 */
  kongChain: number;
  /** 连续打出财神的次数 */
  caishenStreak: number;
}

const total = (c: readonly number[]) => c.reduce((a, b) => a + b, 0);

/** 七对里的豪华数：四张相同算两组对子 */
function quadCount(counts: readonly number[]): number {
  let n = 0;
  for (let k = 0; k < counts.length; k++) if (k !== CAISHEN_KIND && counts[k] === 4) n++;
  return n;
}

function preJokers(pre: readonly number[] | null): number {
  return pre ? (pre[CAISHEN_KIND] ?? 0) : 0;
}

/** 和牌前是否已经处于「摸什么都能胡」的爆头状态：1 张财神 + 若干完整面子 */
function isBaotouReady(pre: readonly number[] | null, melds: number): boolean {
  if (!pre) return false;
  const setsNeeded = 4 - melds;
  if (setsNeeded < 0) return false;
  const j = preJokers(pre);
  if (j !== 1) return false;
  return isAllMelds(pre, setsNeeded);
}

/** 和牌前是否处于七客状态：1 张财神 + 六对 */
function isQikeReady(pre: readonly number[] | null): boolean {
  if (!pre) return false;
  if (preJokers(pre) !== 1) return false;
  return isAllPairs(pre, 6);
}

/** 评估一手和牌；不成和返回 null */
export function evaluateHand(ctx: HzWinContext): HzHandValue | null {
  const { counts, melds, preCounts, selfDrawn } = ctx;
  if (!isWinningShape(counts, melds)) return null;

  const caishen = counts[CAISHEN_KIND] ?? 0;
  const quads = quadCount(counts);
  let pattern: HzPattern;
  let exponent: number;
  let piao = 0;
  let kongs = 0;

  if (melds === 0 && isSevenPairs(counts, caishen)) {
    if (selfDrawn && isQikeReady(preCounts)) {
      pattern = 'qike';
      exponent = 2 + quads;
      piao = Math.min(3, ctx.caishenStreak);
      exponent += piao;
    } else if (caishen === 0) {
      pattern = 'qingqidui';
      exponent = 2 + quads;
    } else {
      pattern = 'qidui';
      exponent = 1 + quads;
    }
  } else if (selfDrawn && isBaotouReady(preCounts, melds)) {
    pattern = 'baotou';
    piao = Math.min(3, ctx.caishenStreak);
    exponent = 1 + piao;
  } else {
    pattern = 'pinghu';
    exponent = 0;
  }

  if (selfDrawn && ctx.afterKongDraw) {
    kongs = Math.min(4, Math.max(0, ctx.kongChain));
    exponent += kongs;
  }

  return {
    pattern,
    name: PATTERN_NAME[pattern],
    exponent,
    multiplier: 2 ** exponent,
    quads,
    caishen,
    piao,
    kongs,
  };
}

export interface HzPayment {
  from: number;
  to: number;
  amount: number;
  reason: string;
}

export interface HzSettlement {
  value: HzHandValue;
  /** 庄闲倍数：1 老庄 ×2、2 老庄 ×4、3 老庄 ×8 */
  dealerMult: number;
  /** 自摸 / 点炮 */
  selfDrawn: boolean;
  payments: HzPayment[];
  /** 和牌者总收入 */
  total: number;
}

export function dealerMultiplier(dealerStreak: number): number {
  return 2 ** Math.min(3, Math.max(1, dealerStreak));
}

/**
 * 结算一手和牌。自摸由每家分别付；点炮由放铳者付清所有份额。
 * 庄家与闲家之间的倍数由连庄数决定，闲家之间恒为 1 倍。
 */
export function settleWin(params: {
  value: HzHandValue;
  baseScore: number;
  dealer: number;
  dealerStreak: number;
  winner: number;
  selfDrawn: boolean;
  discarder?: number | null;
}): HzSettlement {
  const { value, baseScore, dealer, dealerStreak, winner, selfDrawn } = params;
  const dealerMult = dealerMultiplier(dealerStreak);
  const each = baseScore * value.multiplier;
  const payers: { seat: number; amount: number }[] = [];
  for (let s = 0; s < 4; s++) {
    if (s === winner) continue;
    if (winner === dealer) payers.push({ seat: s, amount: each * dealerMult });
    else if (s === dealer) payers.push({ seat: s, amount: each * dealerMult });
    else payers.push({ seat: s, amount: each });
  }
  const total = payers.reduce((a, p) => a + p.amount, 0);
  if (selfDrawn) {
    return {
      value,
      dealerMult,
      selfDrawn: true,
      payments: payers.map((p) => ({
        from: p.seat,
        to: winner,
        amount: p.amount,
        reason: '自摸',
      })),
      total,
    };
  }
  const from = params.discarder ?? -1;
  return {
    value,
    dealerMult,
    selfDrawn: false,
    payments: from >= 0 ? [{ from, to: winner, amount: total, reason: '点炮' }] : [],
    total,
  };
}

export function describeValue(v: HzHandValue): string {
  const parts = [v.name];
  if (v.piao > 0) parts.push(v.piao === 1 ? '财飘' : `${v.piao} 财飘`);
  if (v.kongs > 0) parts.push(v.kongs === 1 ? '杠开' : `${v.kongs} 连杠`);
  if (v.quads > 0 && (v.pattern === 'qidui' || v.pattern === 'qingqidui'))
    parts.push(v.quads === 1 ? '豪华' : `${v.quads} 豪华`);
  parts.push(`×${v.multiplier}`);
  return parts.join(' · ');
}

/** 供测试与界面使用：总和是否与暗手张数一致 */
export function countsTotal(counts: readonly number[]): number {
  return total(counts);
}
