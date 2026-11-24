import { fromBase64Url, hmacSign, hmacVerify, toBase64Url } from "./crypto";

/** 访问令牌的有效期。到期后客户端用刷新凭证换新的。 */
export const ACCESS_TTL_SECONDS = 15 * 60;

export interface AccessClaims {
  /** 玩家 ID。 */
  sub: string;
  /** 会话 ID，对应玩家对象里的一条会话记录。 */
  sid: string;
  /** 过期时间，Unix 秒。 */
  exp: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * 签发访问令牌。格式是"载荷.签名"，两段都是 base64url。
 * 算法固定为 HMAC-SHA256，令牌里不携带算法字段，也就不存在被篡改算法的问题。
 */
export async function signAccessToken(secret: string, claims: AccessClaims): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = await hmacSign(secret, payload);
  return `${payload}.${toBase64Url(signature)}`;
}

/** 校验访问令牌。签名不对、格式不对或已过期都返回 null。 */
export async function verifyAccessToken(secret: string, token: string, nowSeconds: number): Promise<AccessClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signatureText] = parts as [string, string];
  const signature = fromBase64Url(signatureText);
  const body = fromBase64Url(payload);
  if (!signature || !body) return null;

  // 先验签名，通过之后才解析内容。
  if (!(await hmacVerify(secret, payload, signature))) return null;

  let claims: Partial<AccessClaims>;
  try {
    claims = JSON.parse(decoder.decode(body)) as Partial<AccessClaims>;
  } catch {
    return null;
  }
  if (typeof claims.sub !== "string" || typeof claims.sid !== "string" || typeof claims.exp !== "number") {
    return null;
  }
  if (claims.exp <= nowSeconds) return null;
  return { sub: claims.sub, sid: claims.sid, exp: claims.exp };
}
