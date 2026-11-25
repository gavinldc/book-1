import { randomSecret, sha256Hex } from "./crypto";
import { verifyTelegramInitData } from "./telegram";
import { ACCESS_TTL_SECONDS, signAccessToken, verifyAccessToken, type AccessClaims } from "./token";
import { registerPlayer } from "../security/directory";
import { verifyTurnstile } from "../security/turnstile";

const SECRET_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const REFRESH_FORMAT = /^([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9_-]{43})$/;
const MAX_BODY_BYTES = 8 * 1024;

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function fail(status: number, error: string): Response {
  return json({ error }, status);
}

/** 从 Authorization 头里取出并校验访问令牌。 */
export async function authenticate(request: Request, env: Env): Promise<AccessClaims | null> {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  return verifyAccessToken(env.SESSION_SECRET, header.slice(7), nowSeconds());
}

/** 处理 /auth/ 下的所有接口。 */
export async function handleAuth(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== "POST") return fail(405, "method_not_allowed");

  // 登录接口不需要令牌就能调用，按来源地址限流。
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.AUTH_LIMITER.limit({ key: ip });
  if (!success) return fail(429, "too_many_requests");

  const body = await readBody(request);
  if (!body) return fail(400, "bad_request");

  switch (path) {
    case "/auth/guest":
      return guestLogin(env, body, ip);
    case "/auth/telegram":
      return telegramLogin(env, body);
    case "/auth/refresh":
      return refresh(env, body);
    case "/auth/logout":
      return logout(request, env);
    case "/auth/bind/telegram":
      return bindTelegram(request, env, body);
    default:
      return fail(404, "not_found");
  }
}

async function guestLogin(env: Env, body: Record<string, unknown>, ip: string): Promise<Response> {
  // 没带凭证是新设备，由服务端生成；带了凭证是老玩家回来。
  const provided = body.secret;
  if (provided !== undefined && (typeof provided !== "string" || !SECRET_FORMAT.test(provided))) {
    return fail(400, "bad_request");
  }
  // 创建新账号是整个系统里成本最低的"拿到一个身份"的办法，所以只在这里要求人机验证。
  // 老玩家带着凭证回来不需要。
  if (provided === undefined && !(await verifyTurnstile(env, body.turnstileToken, ip))) {
    return fail(403, "verification_required");
  }
  const secret = provided ?? randomSecret();
  const identityName = `guest:${await sha256Hex(secret)}`;
  const session = await login(env, "guest", identityName);
  if (!session) return fail(403, "banned");
  // 凭证只在生成的那一次返回，客户端要自己保存。
  return json(provided === undefined ? { ...session, guestSecret: secret } : session);
}

async function telegramLogin(env: Env, body: Record<string, unknown>): Promise<Response> {
  if (typeof body.initData !== "string") return fail(400, "bad_request");
  const user = await verifyTelegramInitData(body.initData, env.TELEGRAM_BOT_TOKEN, nowSeconds());
  if (!user) return fail(401, "invalid_signature");
  const session = await login(env, "telegram", `telegram:${user.id}`);
  return session ? json(session) : fail(403, "banned");
}

async function bindTelegram(request: Request, env: Env, body: Record<string, unknown>): Promise<Response> {
  const claims = await authenticate(request, env);
  if (!claims) return fail(401, "unauthorized");
  if (typeof body.initData !== "string") return fail(400, "bad_request");
  const user = await verifyTelegramInitData(body.initData, env.TELEGRAM_BOT_TOKEN, nowSeconds());
  if (!user) return fail(401, "invalid_signature");

  const identityName = `telegram:${user.id}`;
  const player = env.PLAYER.getByName(claims.sub);

  // 这个玩家已经绑过另一个 Telegram 账号。
  const linked = (await player.getAccount()).identities.telegram;
  if (linked && linked !== identityName) return fail(409, "already_linked");

  // 认领身份。返回的不是自己，说明它已经属于另一个玩家。
  const owner = await env.IDENTITY.getByName(identityName).claim(claims.sub);
  if (owner !== claims.sub) return fail(409, "identity_taken");

  // 这一步失败时客户端重试即可：上面的认领对同一个玩家是幂等的。
  await player.linkIdentity("telegram", identityName, Date.now());
  return json({ ok: true });
}

async function refresh(env: Env, body: Record<string, unknown>): Promise<Response> {
  const parsed = typeof body.refreshToken === "string" ? REFRESH_FORMAT.exec(body.refreshToken) : null;
  if (!parsed) return fail(401, "invalid_session");
  const [, playerId, sessionId, secret] = parsed as unknown as [string, string, string, string];

  const nextSecret = randomSecret();
  const result = await env.PLAYER.getByName(playerId).rotateSession(
    sessionId,
    await sha256Hex(secret),
    await sha256Hex(nextSecret),
    Date.now(),
  );
  if (result === "banned") return fail(403, "banned");
  if (result !== "ok") return fail(401, "invalid_session");
  return json(await issue(env, playerId, sessionId, nextSecret));
}

async function logout(request: Request, env: Env): Promise<Response> {
  const claims = await authenticate(request, env);
  if (!claims) return fail(401, "unauthorized");
  await env.PLAYER.getByName(claims.sub).closeSession(claims.sid);
  return json({ ok: true });
}

/** 找到（或创建）身份对应的玩家，并为它开一个会话。被封禁时返回 null。 */
async function login(env: Env, provider: string, identityName: string) {
  // 玩家 ID 由服务端生成，和任何外部身份都无关。身份已有归属时，这个候选 ID 直接丢弃。
  const candidate = newId("p_");
  const playerId = await env.IDENTITY.getByName(identityName).claim(candidate);
  const player = env.PLAYER.getByName(playerId);
  if (playerId === candidate) await player.linkIdentity(provider, identityName, Date.now());

  const sessionId = newId("s_");
  const refreshSecret = randomSecret();
  const opened = await player.openSession(sessionId, await sha256Hex(refreshSecret), Date.now());
  if (opened !== "ok") return null;
  // 记进名录。每次登录都写一次，重复的会被忽略。
  await registerPlayer(env.DB, playerId, Date.now());
  return issue(env, playerId, sessionId, refreshSecret);
}

async function issue(env: Env, playerId: string, sessionId: string, refreshSecret: string) {
  const exp = nowSeconds() + ACCESS_TTL_SECONDS;
  return {
    playerId,
    accessToken: await signAccessToken(env.SESSION_SECRET, { sub: playerId, sid: sessionId, exp }),
    expiresAt: exp,
    refreshToken: `${playerId}.${sessionId}.${refreshSecret}`,
  };
}

export async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  if (text === "") return {};
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function newId(prefix: string): string {
  return prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
