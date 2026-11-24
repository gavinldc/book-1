import { verifyAccessToken } from "./token";

/** 客户端建立 WebSocket 时必须声明的子协议。 */
export const WS_PROTOCOL = "game.v1";
/** 访问令牌放在以这个前缀开头的子协议里。 */
const WS_AUTH_PREFIX = "auth.";
/** 入口校验通过后，用这个请求头把玩家 ID 传给房间对象。 */
export const PLAYER_HEADER = "X-Player-Id";

/**
 * 浏览器的 WebSocket 不能设置自定义请求头，所以令牌放在子协议里：
 * new WebSocket(url, ["game.v1", "auth.<令牌>"])
 */
export async function authenticateWebSocket(request: Request, env: Env): Promise<string | null> {
  const protocols = (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((item) => item.trim());
  if (!protocols.includes(WS_PROTOCOL)) return null;
  const token = protocols.find((item) => item.startsWith(WS_AUTH_PREFIX))?.slice(WS_AUTH_PREFIX.length);
  if (!token) return null;
  const claims = await verifyAccessToken(env.SESSION_SECRET, token, Math.floor(Date.now() / 1000));
  return claims?.sub ?? null;
}
