import { describe, expect, it } from 'vitest';
import { hj, hz, hangzhou, simulate } from '../src';

type Tile = hj.HjTile;

const SUIT_KIND: Record<string, number> = { m: 0, s: 9, p: 18 };
const HONOR_KIND: Record<string, number> = { E: 27, S: 28, W: 29, N: 30, Z: 31, F: 32, B: 33 };

class Pool {
  used = new Map<number, number>();
  one(kind: number): Tile {
    const copy = this.used.get(kind) ?? 0;
    if (copy >= 4) throw new Error(`more than 4 of kind ${kind}`);
    this.used.set(kind, copy + 1);
    const id = kind < 27 ? kind * 4 + copy : 108 + (kind - 27) * 4 + copy;
    return hj.tileOf(id);
  }
  tiles(spec: string): Tile[] {
    const out: Tile[] = [];
    let digits: number[] = [];
    for (const ch of spec.replace(/\s+/g, '')) {
      if (/\d/.test(ch)) {
        digits.push(Number(ch));
        continue;
      }
      if (SUIT_KIND[ch] !== undefined) {
        for (const r of digits) out.push(this.one(SUIT_KIND[ch] + r - 1));
        digits = [];
        continue;
      }
      const kind = HONOR_KIND[ch];
      if (kind === undefined) throw new Error(`bad tile spec: ${ch}`);
      out.push(this.one(kind));
    }
    return out;
  }
}

const counts = (spec: string) => hj.countKinds(new Pool().tiles(spec));
const ctx = (patch: Partial<hz.HzWinContext> & { counts: number[] }): hz.HzWinContext => ({
  melds: 0,
  preCounts: null,
  selfDrawn: true,
  afterKongDraw: false,
  kongChain: 0,
  caishenStreak: 0,
  ...patch,
});

describe('杭州麻将牌与牌型', () => {
  it('136 张、34 种，字牌名称正确', () => {
    expect(hj.createTiles()).toHaveLength(136);
    expect(new Set(hj.createTiles().map((t) => hj.kindOf(t))).size).toBe(34);
    expect(hj.kindName(27)).toBe('东');
    expect(hj.kindName(33)).toBe('白');
    expect(hj.kindName(0)).toBe('1万');
  });

  it('平胡与财神补将', () => {
    const hand = counts('123m456m789m123s55p');
    const v = hz.evaluateHand(ctx({ counts: hand }));
    expect(v?.pattern).toBe('pinghu');
    expect(v?.multiplier).toBe(1);

    const withJoker = counts('123m456m789m123s B 5p');
    expect(hz.evaluateHand(ctx({ counts: withJoker }))).not.toBeNull();
  });

  it('爆头与财飘', () => {
    const pre = counts('123m456m789m111s B');
    const hand = counts('123m456m789m111s B 5p');
    const v = hz.evaluateHand(ctx({ counts: hand, preCounts: pre }));
    expect(v?.pattern).toBe('baotou');
    expect(v?.multiplier).toBe(2);

    const piao = hz.evaluateHand(ctx({ counts: hand, preCounts: pre, caishenStreak: 2 }));
    expect(piao?.pattern).toBe('baotou');
    expect(piao?.multiplier).toBe(8);
  });

  it('杠开每连杠翻倍', () => {
    const hand = counts('123m456m789m123s55p');
    const v = hz.evaluateHand(ctx({ counts: hand, afterKongDraw: true, kongChain: 2 }));
    expect(v?.pattern).toBe('pinghu');
    expect(v?.multiplier).toBe(4);
  });

  it('七对、清七对、七客', () => {
    const qidui = hz.evaluateHand(ctx({ counts: counts('11m22m33m44m55m66m77m') }));
    expect(qidui?.pattern).toBe('qingqidui');
    expect(qidui?.multiplier).toBe(4);

    const withJoker = hz.evaluateHand(ctx({ counts: counts('11m22m33m44m55m66m B B') }));
    expect(withJoker?.pattern).toBe('qidui');
    expect(withJoker?.multiplier).toBe(2);

    const pre = counts('11m22m33m44m55m66m B');
    const qike = hz.evaluateHand(
      ctx({ counts: counts('11m22m33m44m55m66m B 9p'), preCounts: pre }),
    );
    expect(qike?.pattern).toBe('qike');
    expect(qike?.multiplier).toBe(4);
  });

  it('向听数能识别财神带来的提升', () => {
    const plain = counts('123m456m789m11s23s');
    const withJoker = counts('123m456m789m11s23s B');
    expect(hj.shanten(withJoker, 0)).toBeLessThan(hj.shanten(plain, 0));
  });
});

describe('杭州麻将整局', () => {
  it('电脑可以打完整盘且分数守恒', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { state } = simulate(
        hangzhou,
        4,
        { baseScore: 1, rounds: 1, dealerStart: 'ping', dianpao: true },
        seed,
      );
      expect(state.phase).toBe('matchOver');
      expect(state.scores.reduce((a, b) => a + b, 0)).toBe(0);
      expect(state.result?.hands.every((h) => h.length <= 14)).toBe(true);
    }
  });
});
