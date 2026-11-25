import { authenticate, fail, json } from "../auth/routes";
import { log } from "../obs/log";

/** 玩家对自己数据的两项权利：拿到一份副本，要求删除。 */
export async function handleAccount(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (pathname !== "/account/export" && pathname !== "/account/delete") return null;
  const claims = await authenticate(request, env);
  if (!claims) return fail(401, "unauthorized");
  const player = env.PLAYER.getByName(claims.sub);

  if (pathname === "/account/export" && request.method === "GET") {
    return json(await player.exportData(Date.now()));
  }
  if (pathname === "/account/delete" && request.method === "POST") {
    await player.requestErase(Date.now());
    log.info("account_erase_requested", { playerId: claims.sub });
    // 202：已经受理，清除在后台进行。
    return json({ ok: true }, 202);
  }
  return fail(405, "method_not_allowed");
}

/**
 * 把一个玩家从系统的各个地方清掉。由队列的消费者调用，每一步都可以重复执行：
 * 中途失败时整条通知会被重新投递，从头再来一遍。
 */
export async function eraseEverywhere(env: Env, playerId: string, identities: string[]): Promise<void> {
  // 一、解除身份的归属。之后同一个平台账号再登录，得到的是一个全新的玩家。
  for (const name of identities) {
    await env.IDENTITY.getByName(name).release(playerId);
  }

  // 二、D1 里按玩家存的各份副本。
  await env.DB.batch([
    env.DB.prepare("DELETE FROM leaderboard WHERE player_id = ?").bind(playerId),
    env.DB.prepare("DELETE FROM replay WHERE player_id = ?").bind(playerId),
    env.DB.prepare("DELETE FROM invite WHERE invitee = ?").bind(playerId),
    // 他邀请过的人还在，只是不再指向他。
    env.DB.prepare("UPDATE invite SET inviter = 'deleted' WHERE inviter = ?").bind(playerId),
    env.DB.prepare("DELETE FROM player WHERE player_id = ?").bind(playerId),
    // 支付记录不删：财务和税务上有保存期限的要求。它里面只有一个已经不对应任何人的玩家 ID。
  ]);

  // 三、最后清空玩家对象。放在最后，是因为前两步失败重来时还需要它存在。
  await env.PLAYER.getByName(playerId).finishErase();
  log.info("account_erased", { playerId });
}
