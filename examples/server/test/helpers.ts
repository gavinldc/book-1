import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import type { ServerMessage } from "@game/shared";

export const BASE = "http://example.com";

export interface Session {
  playerId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  guestSecret?: string;
}

let ipCounter = 0;

/** 调用一个 POST 接口。每次调用默认用不同的来源地址，避免触发限流。 */
export function post(path: string, body: unknown, init: { token?: string; ip?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "CF-Connecting-IP": init.ip ?? `10.0.${Math.floor(ipCounter / 250)}.${ipCounter++ % 250}`,
  };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  return exports.default.fetch(new Request(BASE + path, { method: "POST", headers, body: JSON.stringify(body) }));
}

export function get(path: string, token?: string): Promise<Response> {
  return exports.default.fetch(
    new Request(BASE + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} }),
  );
}

/** 新建一个游客账号。 */
export async function guest(): Promise<Session> {
  const response = await post("/auth/guest", {});
  expect(response.status).toBe(200);
  return response.json();
}

/** 按 Telegram 的算法，用测试环境的机器人令牌签出一份 initData。 */
export async function telegramInitData(userId: number, authDate = Math.floor(Date.now() / 1000)): Promise<string> {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "AAF-test",
    user: JSON.stringify({ id: userId, username: `user${userId}` }),
  });
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = await hmac(new TextEncoder().encode("WebAppData"), env.TELEGRAM_BOT_TOKEN);
  const hash = await hmac(secretKey, dataCheckString);
  params.set("hash", Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""));
  return params.toString();
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data)));
}

export function openSocket(room: string, token: string | null, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { Upgrade: "websocket", ...extraHeaders };
  if (token) headers["Sec-WebSocket-Protocol"] = `game.v1, auth.${token}`;
  return exports.default.fetch(new Request(`${BASE}/room/${room}/ws`, { headers }));
}

/** 用一个新的游客账号连进房间，返回连接、玩家 ID 和一个按顺序读取消息的函数。 */
export async function connect(room: string, session?: Session) {
  const { playerId, accessToken } = session ?? (await guest());
  const response = await openSocket(room, accessToken);
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const queue: ServerMessage[] = [];
  const waiters: ((message: ServerMessage) => void)[] = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data as string) as ServerMessage;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  ws.accept();
  const next = () =>
    new Promise<ServerMessage>((resolve) => {
      const message = queue.shift();
      if (message) resolve(message);
      else waiters.push(resolve);
    });
  const closed = new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code)));
  return { ws, next, playerId, closed, session: session ?? null };
}

/** 两个新玩家进同一个房间并都准备好，返回双方的连接和开局时的状态。 */
export async function startGame(room: string) {
  const sa = await guest();
  const sb = await guest();
  const a = await connect(room, sa);
  await a.next();
  const b = await connect(room, sb);
  await a.next();
  await b.next();
  a.ws.send(JSON.stringify({ type: "ready" }));
  await a.next();
  await b.next();
  b.ws.send(JSON.stringify({ type: "ready" }));
  const started = await a.next();
  await b.next();
  if (started.type !== "state") throw new Error("应该收到状态");
  return { a, b, sa, sb, state: started.state, deadline: started.deadline };
}
