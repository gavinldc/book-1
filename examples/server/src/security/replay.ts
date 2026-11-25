import { applyAction, initialState, type Action, type RoomState } from "@game/shared";

import type { MatchRecord } from "../match/record";

export interface ReplayResult {
  /** 重放出来的结果和记录里的一致。 */
  ok: boolean;
  /** 不一致时，哪里对不上。 */
  reason?: string;
  winner: string | null;
}

/**
 * 把一局的操作日志从头重放一遍，看结果和当时记下的是否一致。
 *
 * 规则是确定性的，所以同样的座位顺序加上同样的操作序列，只会得到同一个结果。
 * 对不上只有两种可能：记录被改过，或者规则的代码在这一局之后变了。
 */
export function replayRecord(record: MatchRecord): ReplayResult {
  if (!record.seats) return { ok: false, reason: "no_seats", winner: null };

  let state: RoomState = initialState();
  const step = (action: Action): string | null => {
    const result = applyAction(state, action);
    if (!result.ok) return result.error;
    state = result.state;
    return null;
  };

  for (const playerId of record.seats) {
    const error = step({ type: "join", playerId }) ?? step({ type: "ready", playerId });
    if (error) return { ok: false, reason: `seat:${error}`, winner: null };
  }
  // 每一步之后重新读一次阶段。
  const phase = (): string => state.phase;
  if (phase() !== "playing") return { ok: false, reason: "not_started", winner: null };

  for (const [index, entry] of record.log.entries()) {
    // 日志里的三种记录：正数是掷出的点数，0 是超时，-1 是离开。
    const action: Action =
      entry.dice > 0
        ? { type: "roll", playerId: entry.playerId, dice: entry.dice }
        : entry.dice === 0
          ? { type: "timeout", playerId: entry.playerId }
          : { type: "leave", playerId: entry.playerId };
    const error = step(action);
    if (error) return { ok: false, reason: `step ${index}:${error}`, winner: null };
  }

  if (phase() !== "finished") return { ok: false, reason: "not_finished", winner: null };
  if (state.winner !== record.winner) return { ok: false, reason: "winner_mismatch", winner: state.winner };
  return { ok: true, winner: state.winner };
}
