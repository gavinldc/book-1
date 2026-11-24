/**
 * 匹配规则：给定一批正在等待的玩家，决定谁和谁一局。
 *
 * 和游戏规则一样是纯函数：当前时间由调用方传入，这里不读时钟，
 * 所以"等了 6 秒之后会怎样"可以直接用测试写出来。
 */

/** 新玩家的初始分数。 */
export const INITIAL_RATING = 1000;
/** 排位赛一局结束后，赢家加多少分、输家扣多少分。 */
export const RATING_STEP = 16;

/** 刚开始排队时，能接受的分数差。 */
export const BASE_WINDOW = 100;
/** 每等这么久，能接受的分数差放宽一次。 */
export const WIDEN_EVERY_MS = 3_000;
/** 每次放宽多少。 */
export const WIDEN_STEP = 100;
/** 等了这么久还没有对手，就安排一个机器人。 */
export const BOT_AFTER_MS = 10_000;

/** 一个正在排队的玩家。 */
export interface Ticket {
  playerId: string;
  rating: number;
  /** 开始排队的时间（Unix 毫秒）。 */
  since: number;
}

export interface MatchPlan {
  /** 配成对的玩家。 */
  pairs: [Ticket, Ticket][];
  /** 等得太久、要用机器人补位的玩家。 */
  solo: Ticket[];
  /** 下一次需要重新计算的时间；没有人在等时为 null。 */
  nextCheck: number | null;
}

/** 等了 waitedMs 之后，能接受多大的分数差。 */
export function ratingWindow(waitedMs: number): number {
  return BASE_WINDOW + Math.floor(Math.max(0, waitedMs) / WIDEN_EVERY_MS) * WIDEN_STEP;
}

/** 一局结束后分数的变化。 */
export function ratingDelta(won: boolean): number {
  return won ? RATING_STEP : -RATING_STEP;
}

/**
 * 计算这一刻的匹配结果。
 *
 * 等得最久的人先挑：在双方都能接受的范围内，选分数最接近的那一个。
 * 人数多时这是平方级的计算量，一个队列里同时等待的人数以百计时没有问题；
 * 再多就应该把队列拆开，而不是优化这个函数。
 */
export function planMatches(tickets: Ticket[], now: number): MatchPlan {
  const order = [...tickets].sort((a, b) => a.since - b.since || (a.playerId < b.playerId ? -1 : 1));
  const taken = new Set<string>();
  const pairs: [Ticket, Ticket][] = [];

  for (const ticket of order) {
    if (taken.has(ticket.playerId)) continue;
    let best: Ticket | null = null;
    let bestGap = Infinity;
    for (const other of order) {
      if (other === ticket || taken.has(other.playerId) || other.playerId === ticket.playerId) continue;
      const gap = Math.abs(ticket.rating - other.rating);
      // 双方都要能接受这个分数差。刚进来的人不会被立刻配给一个差距很大的对手。
      if (gap > ratingWindow(now - ticket.since) || gap > ratingWindow(now - other.since)) continue;
      if (gap < bestGap) {
        best = other;
        bestGap = gap;
      }
    }
    if (best) {
      pairs.push([ticket, best]);
      taken.add(ticket.playerId).add(best.playerId);
    }
  }

  const solo: Ticket[] = [];
  let nextCheck: number | null = null;
  for (const ticket of order) {
    if (taken.has(ticket.playerId)) continue;
    const waited = now - ticket.since;
    if (waited >= BOT_AFTER_MS) {
      solo.push(ticket);
      continue;
    }
    // 这个人的处境下一次发生变化的时间：范围放宽，或者等到了补位的时间。
    const nextWiden = ticket.since + (Math.floor(Math.max(0, waited) / WIDEN_EVERY_MS) + 1) * WIDEN_EVERY_MS;
    const at = Math.min(nextWiden, ticket.since + BOT_AFTER_MS);
    nextCheck = nextCheck === null ? at : Math.min(nextCheck, at);
  }
  return { pairs, solo, nextCheck };
}
