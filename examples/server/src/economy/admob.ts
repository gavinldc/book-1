import { fromBase64Url } from "../auth/crypto";

const KEYS_URL = "https://www.gstatic.com/admob/reward/verifier-keys.json";
/** 公钥缓存多久。官方要求不超过 24 小时。 */
const KEYS_TTL_MS = 60 * 60 * 1000;

// 公钥是公开的、所有请求共用的数据，可以放在模块级的变量里。运行环境被回收后重新拉取即可。
let cachedKeys: { fetchedAt: number; keys: Map<string, CryptoKey> } | null = null;

async function publicKeys(now: number): Promise<Map<string, CryptoKey>> {
  if (cachedKeys && now - cachedKeys.fetchedAt < KEYS_TTL_MS) return cachedKeys.keys;
  const response = await fetch(KEYS_URL);
  if (!response.ok) throw new Error(`拉取广告校验公钥失败：${response.status}`);
  const body = (await response.json()) as { keys: { keyId: number; base64: string }[] };
  const keys = new Map<string, CryptoKey>();
  for (const key of body.keys) {
    const der = Uint8Array.from(atob(key.base64), (char) => char.charCodeAt(0));
    keys.set(
      String(key.keyId),
      await crypto.subtle.importKey("spki", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]),
    );
  }
  cachedKeys = { fetchedAt: now, keys };
  return keys;
}

/** 仅供测试使用：清掉缓存的公钥。 */
export function resetAdKeysForTest(): void {
  cachedKeys = null;
}

/**
 * 校验 AdMob 的服务端回调。
 * 回调是一个 GET 请求，最后两个参数固定是 signature 和 key_id；被签名的内容是它们之前的整段查询串原文。
 * 校验通过时返回查询参数，否则返回 null。
 */
export async function verifyAdCallback(url: URL, now: number): Promise<URLSearchParams | null> {
  const query = url.search.slice(1);
  const at = query.indexOf("&signature=");
  if (at <= 0) return null;
  const signed = query.slice(0, at);
  const tail = new URLSearchParams(query.slice(at + 1));
  const signature = fromBase64Url(tail.get("signature") ?? "");
  const keyId = tail.get("key_id");
  if (!signature || !keyId) return null;

  const key = (await publicKeys(now)).get(keyId);
  // 签名是 DER 编码的，平台的校验接口要的是 r 和 s 直接拼起来的 64 个字节。
  const raw = derToRaw(signature);
  if (!key || !raw) return null;
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    raw,
    new TextEncoder().encode(signed),
  );
  return valid ? new URLSearchParams(signed) : null;
}

/** 把 DER 编码的 ECDSA 签名（SEQUENCE { INTEGER r, INTEGER s }）转成定长的 r‖s。 */
export function derToRaw(der: Uint8Array): Uint8Array | null {
  if (der[0] !== 0x30) return null;
  let offset = 2;
  const out = new Uint8Array(64);
  for (let i = 0; i < 2; i++) {
    if (der[offset] !== 0x02) return null;
    const length = der[offset + 1]!;
    let value = der.subarray(offset + 2, offset + 2 + length);
    // 最高位为 1 的整数前面会多一个 0 字节，去掉。
    while (value.length > 32 && value[0] === 0) value = value.subarray(1);
    if (value.length > 32) return null;
    out.set(value, 32 * (i + 1) - value.length);
    offset += 2 + length;
  }
  return out;
}
