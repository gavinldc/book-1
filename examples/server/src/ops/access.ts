import { fromBase64Url } from "../auth/crypto";

/** 公钥缓存多久。Access 每 6 周轮换一次签名密钥，旧密钥在轮换后还有 7 天有效。 */
const KEYS_TTL_MS = 60 * 60 * 1000;

interface Jwk extends JsonWebKey {
  kid: string;
}

// 公钥是公开的、所有请求共用的数据，可以放在模块级的变量里。
let cachedKeys: { fetchedAt: number; team: string; keys: Map<string, CryptoKey> } | null = null;

async function accessKeys(team: string, now: number): Promise<Map<string, CryptoKey>> {
  if (cachedKeys && cachedKeys.team === team && now - cachedKeys.fetchedAt < KEYS_TTL_MS) return cachedKeys.keys;
  const response = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`拉取 Access 公钥失败：${response.status}`);
  const body = (await response.json()) as { keys: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys) {
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
    );
  }
  cachedKeys = { fetchedAt: now, team, keys };
  return keys;
}

/** 仅供测试使用：清掉缓存的公钥。 */
export function resetAccessKeysForTest(): void {
  cachedKeys = null;
}

export interface Admin {
  email: string;
}

/**
 * 校验 Cloudflare Access 签发的令牌，确认这个请求确实经过了 Access 的登录。
 * 管理后台的登录、单点登录、谁能进，都在 Access 里配置；这里只负责核实结果。
 */
export async function verifyAccess(request: Request, env: Env, now = Date.now()): Promise<Admin | null> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  // 没有配置 Access 时，管理接口一律不可用，而不是一律放行。
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decode<{ alg?: string; kid?: string }>(headerPart);
  const payload = decode<{ iss?: string; aud?: string | string[]; exp?: number; nbf?: number; email?: string }>(
    payloadPart,
  );
  const signature = fromBase64Url(signaturePart);
  if (!header || !payload || !signature || header.alg !== "RS256" || !header.kid) return null;

  // 按令牌里的密钥编号找公钥。轮换期间新旧两把都在列表里。
  const key = (await accessKeys(env.ACCESS_TEAM_DOMAIN, now)).get(header.kid);
  if (!key) return null;
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) return null;

  // 签名是真的还不够：必须是签给这个应用的，并且在有效期内。
  const seconds = Math.floor(now / 1000);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  if (!audiences.includes(env.ACCESS_AUD)) return null;
  if (typeof payload.exp !== "number" || payload.exp <= seconds) return null;
  if (typeof payload.nbf === "number" && payload.nbf > seconds) return null;
  if (typeof payload.email !== "string" || payload.email === "") return null;
  return { email: payload.email };
}

function decode<T>(part: string): T | null {
  const bytes = fromBase64Url(part);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}
