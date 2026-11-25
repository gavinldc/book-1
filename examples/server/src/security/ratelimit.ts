import { authenticate, fail } from "../auth/routes";
import { authenticateWebSocket } from "../auth/websocket";
import { log } from "../obs/log";
import { metric } from "../obs/metrics";

type Tier = "sensitive" | "api" | "webhook";

/** 每一档用哪个限流器，按什么来计数。 */
const TIERS: Record<Tier, { limiter: "SENSITIVE_LIMITER" | "API_LIMITER" | "WEBHOOK_LIMITER"; by: "player" | "ip" }> = {
  // 能让服务端替你做一件有成本的事的接口：下单、开房、发申请、按短码查房间。
  sensitive: { limiter: "SENSITIVE_LIMITER", by: "player" },
  // 其余会改动数据的接口。
  api: { limiter: "API_LIMITER", by: "player" },
  // 第三方平台的回调。没有玩家身份，按来源地址计数。
  webhook: { limiter: "WEBHOOK_LIMITER", by: "ip" },
};

const SENSITIVE = new Set([
  "POST /friends/request",
  "POST /invite/accept",
  "POST /pay/orders",
  "POST /pay/orders/sync",
  "POST /rooms",
  "POST /mirror",
  "POST /account/delete",
  "GET /account/export",
]);

/**
 * 一个请求属于哪一档。返回 null 表示这一层不限：
 * 登录接口在自己的处理函数里按来源地址限流（第 4 章），管理接口在 Access 后面，普通的读取很便宜。
 */
export function tierOf(method: string, pathname: string): Tier | null {
  if (pathname.startsWith("/webhooks/")) return "webhook";
  if (pathname.startsWith("/auth/") || pathname.startsWith("/admin/") || pathname === "/health") return null;
  if (SENSITIVE.has(`${method} ${pathname}`)) return "sensitive";
  // 短码空间不大，不限流的话可以一个个试出来。
  if (method === "GET" && pathname.startsWith("/rooms/code/")) return "sensitive";
  if (method !== "GET") return "api";
  // 建立连接也要限：排队和进房都会唤醒对象。
  if (pathname === "/match/ws" || pathname.endsWith("/ws")) return "api";
  return null;
}

/** 检查这个请求有没有超过它那一档的频率。超过时返回 429，否则返回 null。 */
export async function enforceRateLimit(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const tier = tierOf(request.method, pathname);
  if (!tier) return null;
  const rule = TIERS[tier];

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  let key = `ip:${ip}`;
  if (rule.by === "player") {
    // 按玩家计数：换网络、换地址都绕不过去。没有合法令牌的请求退回到按地址计数。
    // WebSocket 的令牌在子协议里，不在 Authorization 请求头里，要用对应的办法取。
    const playerId =
      request.headers.get("Upgrade") === "websocket"
        ? await authenticateWebSocket(request, env)
        : ((await authenticate(request, env))?.sub ?? null);
    if (playerId) key = `player:${playerId}`;
  }

  const { success } = await env[rule.limiter].limit({ key: `${tier}:${key}` });
  if (success) return null;
  log.warn("rate_limited", { tier, key, path: pathname });
  metric(env, "rate_limited", [tier], [1]);
  const response = fail(429, "too_many_requests");
  response.headers.set("Retry-After", "60");
  return response;
}
