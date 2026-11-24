/**
 * 游戏规则：2 到 4 人的掷骰子竞速，先走到终点的人获胜。
 *
 * 这个文件是纯函数，不依赖任何平台接口：输入是当前状态和一个操作，
 * 输出是新状态。随机数（骰子点数）由调用方传入。
 */

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const FINISH = 20;

export type Phase = "waiting" | "playing" | "finished";

export interface Player {
  id: string;
  ready: boolean;
  position: number;
}

export interface RoomState {
  phase: Phase;
  players: Player[];
  /** 当前轮到的玩家在 players 里的下标。 */
  turn: number;
  winner: string | null;
}

export type Action =
  | { type: "join"; playerId: string }
  | { type: "leave"; playerId: string }
  | { type: "ready"; playerId: string }
  | { type: "roll"; playerId: string; dice: number };

export type RuleError =
  | "room_full"
  | "already_started"
  | "not_in_room"
  | "not_playing"
  | "not_your_turn"
  | "bad_dice";

export type Result = { ok: true; state: RoomState } | { ok: false; error: RuleError };

export function initialState(): RoomState {
  return { phase: "waiting", players: [], turn: 0, winner: null };
}

export function applyAction(state: RoomState, action: Action): Result {
  switch (action.type) {
    case "join": {
      if (state.players.some((p) => p.id === action.playerId)) return { ok: true, state };
      if (state.phase !== "waiting") return { ok: false, error: "already_started" };
      if (state.players.length >= MAX_PLAYERS) return { ok: false, error: "room_full" };
      const players = [...state.players, { id: action.playerId, ready: false, position: 0 }];
      return { ok: true, state: { ...state, players } };
    }

    case "leave": {
      const index = state.players.findIndex((p) => p.id === action.playerId);
      if (index === -1) return { ok: true, state };
      const players = state.players.filter((p) => p.id !== action.playerId);
      if (state.phase !== "playing") return { ok: true, state: { ...state, players } };
      // 对局中有人离开：只剩一人时直接判胜，否则把回合交给下一位。
      if (players.length === 1) {
        return { ok: true, state: { phase: "finished", players, turn: 0, winner: players[0]!.id } };
      }
      const turn = index < state.turn ? state.turn - 1 : state.turn % players.length;
      return { ok: true, state: { ...state, players, turn } };
    }

    case "ready": {
      if (state.phase !== "waiting") return { ok: false, error: "already_started" };
      if (!state.players.some((p) => p.id === action.playerId)) return { ok: false, error: "not_in_room" };
      const players = state.players.map((p) => (p.id === action.playerId ? { ...p, ready: true } : p));
      const canStart = players.length >= MIN_PLAYERS && players.every((p) => p.ready);
      return { ok: true, state: { ...state, players, phase: canStart ? "playing" : "waiting" } };
    }

    case "roll": {
      if (state.phase !== "playing") return { ok: false, error: "not_playing" };
      const current = state.players[state.turn];
      if (!current || current.id !== action.playerId) return { ok: false, error: "not_your_turn" };
      if (!Number.isInteger(action.dice) || action.dice < 1 || action.dice > 6) {
        return { ok: false, error: "bad_dice" };
      }
      const position = Math.min(FINISH, current.position + action.dice);
      const players = state.players.map((p, i) => (i === state.turn ? { ...p, position } : p));
      if (position === FINISH) {
        return { ok: true, state: { ...state, players, phase: "finished", winner: current.id } };
      }
      return { ok: true, state: { ...state, players, turn: (state.turn + 1) % players.length } };
    }
  }
}
