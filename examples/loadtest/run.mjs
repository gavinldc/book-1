#!/usr/bin/env node
/**
 * 压测脚本：模拟一批玩家走完"登录 → 排队 → 进房 → 打完一局"的完整流程。
 *
 *   node loadtest/run.mjs --base http://localhost:8787 --players 20 --local
 *
 * 参数：
 *   --base     被测服务的地址。只对自己的预发环境或本地使用。
 *   --players  同时在线的虚拟玩家数。
 *   --rounds   每个玩家打几局，默认 1。
 *   --think    每次操作前的思考时间（毫秒），默认 300。真实玩家不会瞬间出手。
 *   --ramp     每秒新增多少个玩家，默认 10。一下子全部涌入测的是限流，不是系统。
 *   --local    本地模式：给每个玩家伪造一个不同的来源地址，绕开按地址的登录限流。
 *              线上的来源地址由 Cloudflare 填写，这个办法不起作用。
 *
 * 需要 Node.js 22 及以上（用到内置的 fetch 和 WebSocket）。
 */

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((arg, index, all) => {
    if (!arg.startsWith("--")) return [];
    const next = all[index + 1];
    return [[arg.slice(2), next && !next.startsWith("--") ? next : "true"]];
  }),
);
const BASE = (args.base ?? "http://localhost:8787").replace(/\/$/, "");
const PLAYERS = Number(args.players ?? 10);
const ROUNDS = Number(args.rounds ?? 1);
const THINK_MS = Number(args.think ?? 300);
const RAMP_PER_SECOND = Number(args.ramp ?? 10);
const LOCAL = args.local === "true";
const WS_BASE = BASE.replace(/^http/, "ws");
/** 一步等多久算超时。排队等机器人最长 10 秒，所以要比它长。 */
const STEP_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const samples = { login: [], match_wait: [], join: [], roll: [], match: [] };
const errors = new Map();
const counts = { matches: 0, vsBot: 0, closedCodes: new Map() };

function fail(step, detail) {
  const key = `${step}: ${detail}`;
  errors.set(key, (errors.get(key) ?? 0) + 1);
}

async function timed(name, fn) {
  const started = performance.now();
  const value = await fn();
  samples[name].push(performance.now() - started);
  return value;
}

/** 打开一条带令牌的连接，返回按顺序读取消息的函数。 */
function connect(path, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_BASE + path, ["game.v1", `auth.${token}`]);
    const queue = [];
    const waiters = [];
    let closed = null;
    const timer = setTimeout(() => reject(new Error("connect timeout")), STEP_TIMEOUT_MS);
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message);
      else queue.push(message);
    };
    ws.onclose = (event) => {
      closed = event.code;
      for (const waiter of waiters.splice(0)) waiter.reject(new Error(`closed ${event.code}`));
    };
    ws.onerror = () => reject(new Error("connect failed"));
    ws.onopen = () => {
      clearTimeout(timer);
      resolve({
        ws,
        next() {
          const message = queue.shift();
          if (message) return Promise.resolve(message);
          if (closed !== null) return Promise.reject(new Error(`closed ${closed}`));
          return new Promise((res, rej) => {
            const waiter = { resolve: res, reject: rej };
            waiters.push(waiter);
            setTimeout(() => {
              const at = waiters.indexOf(waiter);
              if (at >= 0) {
                waiters.splice(at, 1);
                rej(new Error("message timeout"));
              }
            }, STEP_TIMEOUT_MS);
          });
        },
      });
    };
  });
}

async function login(index) {
  const headers = { "Content-Type": "application/json" };
  if (LOCAL) headers["CF-Connecting-IP"] = `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`;
  const response = await fetch(`${BASE}/auth/guest`, { method: "POST", headers, body: "{}" });
  if (!response.ok) throw new Error(`status ${response.status}`);
  return response.json();
}

/** 排队直到拿到房间号。 */
async function findMatch(session) {
  const queue = await connect("/match/ws", session.accessToken);
  for (;;) {
    const message = await queue.next();
    if (message.type === "matched") return message.roomId;
  }
}

/** 进房、准备、轮到自己就掷，直到这一局结束。 */
async function playMatch(session, roomId) {
  const room = await timed("join", () => connect(`/room/${roomId}/ws`, session.accessToken));
  let readied = false;
  let pending = null;
  try {
    for (;;) {
      const message = await room.next();
      if (message.type === "error") {
        // 版本过时是正常的竞争：别人先走了一步。等下一个状态再决定。
        if (message.code !== "stale_version") fail("room", message.code);
        continue;
      }
      const state = message.state;
      if (pending && state.version > pending.version) {
        samples.roll.push(performance.now() - pending.at);
        pending = null;
      }
      if (state.phase === "finished") {
        if (state.players.some((p) => p.id.startsWith("bot:")) || state.forfeited.length > 0) counts.vsBot++;
        return;
      }
      if (state.phase === "waiting" && !readied) {
        readied = true;
        room.ws.send(JSON.stringify({ type: "ready" }));
      }
      if (state.phase === "playing" && state.players[state.turn]?.id === session.playerId && !pending) {
        await sleep(THINK_MS);
        pending = { version: state.version, at: performance.now() };
        room.ws.send(JSON.stringify({ type: "roll", version: state.version }));
      }
    }
  } finally {
    room.ws.close();
  }
}

async function player(index) {
  let session;
  try {
    session = await timed("login", () => login(index));
  } catch (error) {
    return fail("login", error.message);
  }
  for (let round = 0; round < ROUNDS; round++) {
    try {
      const started = performance.now();
      const roomId = await timed("match_wait", () => findMatch(session));
      await playMatch(session, roomId);
      samples.match.push(performance.now() - started);
      counts.matches++;
    } catch (error) {
      fail("match", error.message);
      return;
    }
  }
}

function percentile(values, p) {
  if (values.length === 0) return "-";
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
}

const startedAt = Date.now();
console.log(`目标 ${BASE}，${PLAYERS} 个玩家，每人 ${ROUNDS} 局，思考 ${THINK_MS} 毫秒，每秒进入 ${RAMP_PER_SECOND} 人`);
const running = [];
for (let i = 0; i < PLAYERS; i++) {
  running.push(player(i + 1));
  if ((i + 1) % RAMP_PER_SECOND === 0) await sleep(1000);
}
await Promise.all(running);

console.log(`\n用时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒，完成 ${counts.matches} 人次对局`);
console.log("\n步骤            次数    p50     p95     最大   （毫秒）");
for (const [name, values] of Object.entries(samples)) {
  const max = values.length ? Math.round(Math.max(...values)) : "-";
  console.log(
    `${name.padEnd(12)} ${String(values.length).padStart(7)} ${String(percentile(values, 50)).padStart(6)} ${String(percentile(values, 95)).padStart(7)} ${String(max).padStart(8)}`,
  );
}
if (errors.size > 0) {
  console.log("\n错误：");
  for (const [key, count] of errors) console.log(`  ${count} 次  ${key}`);
} else {
  console.log("\n没有错误。");
}
process.exitCode = errors.size > 0 ? 1 : 0;
