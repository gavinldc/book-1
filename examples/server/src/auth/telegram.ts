import { fromHex, hmacSign, hmacVerify } from "./crypto";

/** 登录数据的最长有效时间。超过这个时间的数据即使签名正确也拒绝。 */
export const TELEGRAM_MAX_AGE_SECONDS = 60 * 60;

export interface TelegramUser {
  id: number;
  username?: string;
  language_code?: string;
}

/**
 * 校验 Telegram Mini App 传来的 initData。
 * 算法见 https://core.telegram.org/bots/webapps 的 "Validating data received via the Mini App"。
 */
export async function verifyTelegramInitData(
  initData: string,
  botToken: string,
  nowSeconds: number,
): Promise<TelegramUser | null> {
  const params = new URLSearchParams(initData);
  const hash = fromHex(params.get("hash") ?? "");
  if (!hash) return null;
  params.delete("hash");

  // 除 hash 以外的所有字段，按键名排序，用换行拼接。
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  // 密钥是用固定字符串 WebAppData 对机器人令牌做一次 HMAC 得到的。
  const secretKey = await hmacSign("WebAppData", botToken);
  if (!(await hmacVerify(secretKey, dataCheckString, hash))) return null;

  const authDate = Number(params.get("auth_date"));
  if (!Number.isInteger(authDate) || nowSeconds - authDate > TELEGRAM_MAX_AGE_SECONDS) return null;

  try {
    const user = JSON.parse(params.get("user") ?? "") as TelegramUser;
    return Number.isSafeInteger(user.id) ? user : null;
  } catch {
    return null;
  }
}
