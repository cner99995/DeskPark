import type { Rng } from '../../core/rng';
import type { Seat } from '../../core/types';
import {
  CAISHEN_KIND,
  HJ_KINDS,
  countKinds,
  isWinningShape,
  kindOf,
  kindRank,
  kindSuit,
  shanten,
  type HjTile,
} from '../../mahjong/honors';
import type { HzAction, HzView } from './index';

/**
 * 杭州麻将电脑玩家：
 * - 能胡就胡，能杠就杠；
 * - 吃碰只在不让向听变差时进行；
 * - 出牌选向听最小、有效进张最多的牌，财神除非别无选择不会打出。
 */

function bestAfterMeld(counts: number[], melds: number): number {
  const c = [...counts];
  let best = 99;
  for (let k = 0; k < HJ_KINDS; k++) {
    if (c[k] === 0) continue;
    c[k]--;
    best = Math.min(best, shanten(c, melds));
    c[k]++;
  }
  return best;
}

function tileOfHand(view: HzView, id: number): HjTile {
  return view.hand.find((t) => t.id === id)!;
}

export function hangzhouBot(view: HzView, seat: Seat, rng: Rng): HzAction {
  const L = view.legal;
  if (!L) return { type: 'pass' };
  if (L.ready) return { type: 'ready' };
  if (L.hu) return { type: 'hu' };

  const me = view.players[seat];
  const melds = me.melds.length;
  const counts = countKinds(view.hand);
  const now = shanten(counts, melds);

  if (view.window) {
    if (L.gang.length) return { type: 'gang' };
    if (L.peng) {
      const c = [...counts];
      c[kindOf(view.window.tile)] -= 2;
      if (bestAfterMeld(c, melds + 1) <= now) return { type: 'peng' };
    }
    if (L.chi.length) {
      let best: { tiles: number[]; s: number } | null = null;
      for (const o of L.chi) {
        const c = [...counts];
        for (const id of o.tiles) c[kindOf(tileOfHand(view, id))]--;
        const s = bestAfterMeld(c, melds + 1);
        if (!best || s < best.s) best = { tiles: o.tiles, s };
      }
      if (best && best.s <= now) return { type: 'chi', tiles: best.tiles };
    }
    return { type: 'pass' };
  }

  // 自己的回合：先考虑杠
  for (const g of L.gang) {
    const t = view.hand.find((x) => x.id === g.tile);
    if (!t) continue;
    const k = kindOf(t);
    const c = [...counts];
    if (g.type === 'an') {
      if (c[k] < 4) continue;
      c[k] -= 4;
      if (shanten(c, melds + 1) <= now) return { type: 'gang', tile: g.tile };
    } else {
      c[k] -= 1;
      if (shanten(c, melds) <= now) return { type: 'gang', tile: g.tile };
    }
  }

  let best: { tile: number; score: number } | null = null;
  const seen = new Set<number>();
  for (const id of L.discard) {
    const t = view.hand.find((x) => x.id === id)!;
    const k = kindOf(t);
    if (seen.has(k)) continue;
    seen.add(k);
    const c = [...counts];
    c[k]--;
    const s = shanten(c, melds);
    let ukeire = 0;
    if (s <= 2) {
      for (let d = 0; d < HJ_KINDS; d++) {
        if (c[d] >= 4) continue;
        const left = 4 - view.visible[d];
        if (left <= 0) continue;
        c[d]++;
        if (isWinningShape(c, melds) || shanten(c, melds) < s) ukeire += left;
        c[d]--;
      }
    }
    let score = s * 1000 - ukeire * 8;
    if (k === CAISHEN_KIND) score += 5000;
    if (kindSuit(k) === 'feng' || kindSuit(k) === 'jian') score += 3;
    const r = kindRank(k);
    if (r === 1 || r === 9) score += 2;
    score += rng.next();
    if (!best || score < best.score) best = { tile: id, score };
  }
  return { type: 'discard', tile: best?.tile ?? L.discard[0] };
}
