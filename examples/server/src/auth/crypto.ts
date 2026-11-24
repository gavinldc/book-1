const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

export function fromHex(text: string): Uint8Array | null {
  if (!/^([0-9a-f]{2})+$/.test(text)) return null;
  return Uint8Array.from(text.match(/../g)!, (pair) => parseInt(pair, 16));
}

/** 生成一个 256 位的随机字符串，用作游客凭证和刷新凭证。 */
export function randomSecret(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hmacKey(secret: string | Uint8Array, usage: "sign" | "verify"): Promise<CryptoKey> {
  const raw = typeof secret === "string" ? encoder.encode(secret) : secret;
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export async function hmacSign(secret: string | Uint8Array, data: string): Promise<Uint8Array> {
  const key = await hmacKey(secret, "sign");
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

/** 校验签名。比较过程由平台完成，耗时不随内容变化。 */
export async function hmacVerify(secret: string | Uint8Array, data: string, signature: Uint8Array): Promise<boolean> {
  const key = await hmacKey(secret, "verify");
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(data));
}

/** 比较两个字符串是否相等，耗时不随内容变化。用于比较密钥这类不能被逐位试出来的值。 */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  // 先各自做一次哈希，得到等长的两段数据，再交给平台比较。
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(x, y);
}
