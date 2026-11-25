import { DEFAULT_CONFIG, validateConfig, type GameConfig } from "@game/shared";

const CURRENT_KEY = "config:current";
/** 读取配置时在当地缓存多久（秒）。平台允许的最小值是 30。 */
const CACHE_TTL_SECONDS = 60;

/** 读当前的配置。还没发布过时用代码里的默认值。 */
export async function loadConfig(env: Env): Promise<GameConfig> {
  const stored = await env.CONFIG.get<GameConfig>(CURRENT_KEY, { type: "json", cacheTtl: CACHE_TTL_SECONDS });
  return stored ?? DEFAULT_CONFIG;
}

/**
 * 发布一份新配置。版本号必须正好是当前版本加一：
 * 两个人同时在改时，后提交的那个会被拒绝，而不是悄悄盖掉前一个人的修改。
 */
export async function publishConfig(env: Env, input: unknown): Promise<GameConfig | string> {
  const next = validateConfig(input);
  if (typeof next === "string") return next;
  const current = await loadConfig(env);
  if (next.version !== current.version + 1) {
    return `版本号应该是 ${current.version + 1}，收到的是 ${next.version}`;
  }
  const text = JSON.stringify(next);
  // 每个版本单独留一份，出问题时可以找回任何一个历史版本。
  await env.CONFIG.put(`config:v${next.version}`, text);
  await env.CONFIG.put(CURRENT_KEY, text);
  return next;
}

/** 取某个历史版本，用于回滚。 */
export async function loadConfigVersion(env: Env, version: number): Promise<GameConfig | null> {
  return env.CONFIG.get<GameConfig>(`config:v${version}`, { type: "json" });
}
