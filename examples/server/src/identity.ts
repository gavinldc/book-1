import { DurableObject } from "cloudflare:workers";

const PLAYER_KEY = "player";

/**
 * 一个外部身份一个对象，名字形如 `guest:<凭证的哈希>` 或 `telegram:<用户 ID>`。
 * 它只保存一件事：这个身份属于哪个玩家。
 * 同名对象全球只有一个并且单线程执行，所以"一个身份只能归属一个玩家"不需要额外加锁。
 */
export class Identity extends DurableObject<Env> {
  /**
   * 认领这个身份。还没有归属时归 candidate 所有；已有归属时不做改动。
   * 返回值永远是最终的归属者，调用方通过比较返回值得知有没有认领成功。
   */
  async claim(candidate: string): Promise<string> {
    const owner = await this.ctx.storage.get<string>(PLAYER_KEY);
    if (owner) return owner;
    await this.ctx.storage.put(PLAYER_KEY, candidate);
    return candidate;
  }

  /** 解除归属。只有当前的归属者才能解除；之后这个身份可以被重新认领。重复调用没有影响。 */
  async release(playerId: string): Promise<void> {
    if ((await this.ctx.storage.get<string>(PLAYER_KEY)) === playerId) await this.ctx.storage.deleteAll();
  }

  async owner(): Promise<string | null> {
    return (await this.ctx.storage.get<string>(PLAYER_KEY)) ?? null;
  }
}
