import { log } from "../obs/log";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** 令牌的最大长度。 */
const MAX_TOKEN_LENGTH = 2048;

/**
 * 校验客户端做完人机验证后拿到的令牌。
 * 页面上的验证组件本身不提供任何保护：令牌必须拿到服务端，向 Cloudflare 核实之后才算数。
 */
export async function verifyTurnstile(env: Env, token: unknown, ip: string): Promise<boolean> {
  // 本地开发和测试时可以关掉。线上的配置里要打开。
  if ((env.TURNSTILE_ENFORCE as string) !== "true") return true;
  if (typeof token !== "string" || token === "" || token.length > MAX_TOKEN_LENGTH) return false;

  try {
    const response = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET,
        response: token,
        remoteip: ip,
        // 带上它之后，这次核实因为超时而重试时不会被当成"令牌被用了第二次"。
        idempotency_key: crypto.randomUUID(),
      }),
    });
    const result = (await response.json()) as { success: boolean; "error-codes"?: string[] };
    if (!result.success) log.info("turnstile_rejected", { codes: result["error-codes"] ?? [] });
    return result.success === true;
  } catch (error) {
    // 核实不了就当作没通过。放行的话，验证服务一出故障，注册接口就对机器人敞开了。
    log.error("turnstile_unavailable", { error });
    return false;
  }
}
