/**
 * 游戏规则：2 到 4 人的掷骰子竞速，先走到终点的人获胜。
 *
 * 这个文件是纯函数，不依赖任何平台接口：输入是当前状态和一个操作，
 * 输出是新状态。随机数（骰子点数）由调用方传入，时间也不出现在这里：
 * "回合超时了"由调用方判断，再作为一个操作交给规则处理。
 */

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const FINISH = 20;
/** 连续超时这么多次，按弃权处理。 */
export const MAX_MISSED_TURNS = 2;

export type Phase = "waiting" | "playing" | "finished";

export interface Player {
  id: string;
  ready: boolean;
  position: number;
  /** 当前有没有连接。断线不等于离开，位置会保留。 */
  connected: boolean;
  /** 连续超时的回合数，自己掷一次骰子就清零。 */
  missed: number;
}

export interface RoomState {
  /** 状态的版本号，每次变化加一。客户端用它丢弃过时的状态，服务端用它拒绝过时的操作。 */
  version: number;
  phase: Phase;
  players: Player[];
  /** 当前轮到的玩家在 players 里的下标。 */
  turn: number;
  winner: string | null;
  /** 对局中途离开或弃权的玩家。他们不再占位置，但这一局仍然要给他们记一场。 */
  forfeited: string[];
}

export type Action =
  | { type: "join"; playerId: string }
  | { type: "disconnect"; playerId: string }
  | { type: "leave"; playerId: string }
  | { type: "ready"; playerId: string }
  | { type: "roll"; playerId: string; dice: number }
  | { type: "timeout"; playerId: string };

export type RuleError =
  | "room_full"
  | "already_started"
  | "not_in_room"
  | "not_playing"
  | "not_your_turn"
  | "bad_dice";

export type Result = { ok: true; state: RoomState } | { ok: false; error: RuleError };

export function initialState(): RoomState {
  return { version: 0, phase: "waiting", players: [], turn: 0, winner: null, forfeited: [] };
}

/** 当前轮到的玩家。不在对局中时返回 null。 */
export function currentPlayer(state: RoomState): string | null {
  return state.phase === "playing" ? (state.players[state.turn]?.id ?? null) : null;
}

/** 应用一个操作。状态有变化时版本号加一，没有变化时原样返回。 */
export function applyAction(state: RoomState, action: Action): Result {
  const result = reduce(state, action);
  if (!result.ok || result.state === state) return result;
  return { ok: true, state: { ...result.state, version: state.version + 1 } };
}

function reduce(state: RoomState, action: Action): Result {
  switch (action.type) {
    case "join": {
      const existing = state.players.find((p) => p.id === action.playerId);
      if (existing) {
        // 已经在房间里：这是一次重连，任何阶段都允许。
        if (existing.connected) return { ok: true, state };
        return { ok: true, state: updatePlayer(state, action.playerId, { connected: true }) };
      }
      if (state.phase !== "waiting") return { ok: false, error: "already_started" };
      if (state.players.length >= MAX_PLAYERS) return { ok: false, error: "room_full" };
      const joined = { id: action.playerId, ready: false, position: 0, connected: true, missed: 0 };
      return { ok: true, state: { ...state, players: [...state.players, joined] } };
    }

    case "disconnect": {
      const player = state.players.find((p) => p.id === action.playerId);
      if (!player || !player.connected) return { ok: true, state };
      // 对局已经结束：谁在线已经不重要了，不必为此再改一次状态、再写一次存储。
      if (state.phase === "finished") return { ok: true, state };
      // 还没开局时，断线直接算离开，不占着位置。
      if (state.phase === "waiting") return { ok: true, state: removePlayer(state, action.playerId) };
      // 对局中保留位置，等他回来；回合超时由 timeout 处理。
      return { ok: true, state: updatePlayer(state, action.playerId, { connected: false }) };
    }

    case "leave": {
      if (!state.players.some((p) => p.id === action.playerId)) return { ok: true, state };
      return { ok: true, state: removePlayer(state, action.playerId) };
    }

    case "ready": {
      if (state.phase !== "waiting") return { ok: false, error: "already_started" };
      if (!state.players.some((p) => p.id === action.playerId)) return { ok: false, error: "not_in_room" };
      const next = updatePlayer(state, action.playerId, { ready: true });
      const canStart = next.players.length >= MIN_PLAYERS && next.players.every((p) => p.ready);
      return { ok: true, state: { ...next, phase: canStart ? "playing" : "waiting" } };
    }

    case "roll": {
      if (state.phase !== "playing") return { ok: false, error: "not_playing" };
      const current = state.players[state.turn];
      if (!current || current.id !== action.playerId) return { ok: false, error: "not_your_turn" };
      if (!Number.isInteger(action.dice) || action.dice < 1 || action.dice > 6) {
        return { ok: false, error: "bad_dice" };
      }
      const position = Math.min(FINISH, current.position + action.dice);
      const next = updatePlayer(state, current.id, { position, missed: 0 });
      if (position === FINISH) return { ok: true, state: { ...next, phase: "finished", winner: current.id } };
      return { ok: true, state: { ...next, turn: (state.turn + 1) % next.players.length } };
    }

    case "timeout": {
      if (state.phase !== "playing") return { ok: false, error: "not_playing" };
      const current = state.players[state.turn];
      if (!current || current.id !== action.playerId) return { ok: false, error: "not_your_turn" };
      const missed = current.missed + 1;
      // 连续超时达到上限，按弃权处理。
      if (missed >= MAX_MISSED_TURNS) return { ok: true, state: removePlayer(state, current.id) };
      // 否则这一回合轮空。
      const next = updatePlayer(state, current.id, { missed });
      return { ok: true, state: { ...next, turn: (state.turn + 1) % next.players.length } };
    }
  }
}

function updatePlayer(state: RoomState, playerId: string, patch: Partial<Player>): RoomState {
  return { ...state, players: state.players.map((p) => (p.id === playerId ? { ...p, ...patch } : p)) };
}

/** 把一个玩家移出房间。对局中只剩一人时直接判胜，否则把回合交给下一位。 */
function removePlayer(state: RoomState, playerId: string): RoomState {
  const index = state.players.findIndex((p) => p.id === playerId);
  const players = state.players.filter((p) => p.id !== playerId);
  if (state.phase !== "playing") return { ...state, players };
  const forfeited = [...state.forfeited, playerId];
  if (players.length === 1) {
    return { ...state, phase: "finished", players, turn: 0, winner: players[0]!.id, forfeited };
  }
  const turn = index < state.turn ? state.turn - 1 : state.turn % players.length;
  return { ...state, players, turn, forfeited };
}
