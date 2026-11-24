import { env } from "cloudflare:workers";
import { createMessageBatch } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  INVITE_REWARD_CAP,
  INVITE_REWARD_COINS,
  INVITE_WINDOW_MS,
  INVITE_WINS_REQUIRED,
  type Friend,
} from "../src/player";
import type { PlayerEvent } from "../src/social/events";
import { RATING_BOARD, saveScores, scoresOf, standingOf, topOf } from "../src/social/leaderboard";
import { get, guest, post, type Session } from "./helpers";

const player = (session: Session) => env.PLAYER.getByName(session.playerId);

/** 两个账号的注册时间要分得出先后。 */
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

async function friendsOf(session: Session): Promise<Friend[]> {
  const response = await get("/friends", session.accessToken);
  return ((await response.json()) as { friends: Friend[] }).friends;
}

/** 让一个玩家赢一局计分的对局。 */
function win(session: Session, matchId: string) {
  return player(session).applyMatchResult(matchId, { won: true, coins: 0, rating: 16 });
}

describe("排行榜", () => {
  it("计分的对局结束后，分数经过队列进入排行榜", async () => {
    const session = await guest();
    await win(session, "lb-1");
    await expect.poll(() => standingOf(env.DB, RATING_BOARD, session.playerId)).toMatchObject({ score: 1016 });
  });

  it("不计分的对局不产生更新", async () => {
    const session = await guest();
    await player(session).applyMatchResult("lb-private", { won: true, coins: 10 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await standingOf(env.DB, RATING_BOARD, session.playerId)).toBeNull();
  });

  it("迟到的旧更新不会盖掉新分数，重复的更新没有影响", async () => {
    const update = (rating: number, seq: number) => saveScores(env.DB, [{ playerId: "p_seq", rating, seq, at: seq }]);
    await update(1100, 5);
    await update(1000, 3);
    await update(1100, 5);
    expect(await scoresOf(env.DB, RATING_BOARD, ["p_seq"])).toEqual([{ playerId: "p_seq", score: 1100 }]);
  });

  it("名次按分数排，同分时先到的在前", async () => {
    await saveScores(env.DB, [
      { playerId: "p_rank_a", rating: 9000, seq: 1, at: 10 },
      { playerId: "p_rank_b", rating: 9500, seq: 1, at: 20 },
      { playerId: "p_rank_c", rating: 9000, seq: 1, at: 5 },
    ]);
    expect((await topOf(env.DB, RATING_BOARD, 3)).map((e) => e.playerId)).toEqual(["p_rank_b", "p_rank_c", "p_rank_a"]);
    expect(await standingOf(env.DB, RATING_BOARD, "p_rank_b")).toEqual({ score: 9500, rank: 1 });
    expect(await standingOf(env.DB, RATING_BOARD, "p_rank_c")).toEqual({ score: 9000, rank: 2 });
    expect(await standingOf(env.DB, RATING_BOARD, "p_rank_a")).toEqual({ score: 9000, rank: 3 });
    expect(await standingOf(env.DB, RATING_BOARD, "p_nobody")).toBeNull();
  });

  it("接口返回榜单和自己的名次", async () => {
    const session = await guest();
    await win(session, "lb-http");
    await expect.poll(() => standingOf(env.DB, RATING_BOARD, session.playerId)).not.toBeNull();
    const response = await get("/leaderboard", session.accessToken);
    const body = (await response.json()) as { top: unknown[]; me: { score: number; rank: number } };
    expect(Array.isArray(body.top)).toBe(true);
    expect(body.me.score).toBe(1016);
    expect(body.me.rank).toBeGreaterThan(0);
    expect((await get("/leaderboard")).status).toBe(401);
  });
});

describe("好友", () => {
  it("申请、接受、删除，两边的列表最终一致", async () => {
    const a = await guest();
    const b = await guest();

    expect((await post("/friends/request", { playerId: b.playerId }, { token: a.accessToken })).status).toBe(200);
    expect(await friendsOf(a)).toEqual([{ playerId: b.playerId, status: "outgoing" }]);
    await expect.poll(() => friendsOf(b)).toEqual([{ playerId: a.playerId, status: "incoming" }]);

    expect((await post("/friends/accept", { playerId: a.playerId }, { token: b.accessToken })).status).toBe(200);
    expect(await friendsOf(b)).toEqual([{ playerId: a.playerId, status: "friend" }]);
    await expect.poll(() => friendsOf(a)).toEqual([{ playerId: b.playerId, status: "friend" }]);

    expect((await post("/friends/remove", { playerId: b.playerId }, { token: a.accessToken })).status).toBe(200);
    expect(await friendsOf(a)).toEqual([]);
    await expect.poll(() => friendsOf(b)).toEqual([]);
  });

  it("两个人互相申请，直接成为好友", async () => {
    const a = await guest();
    const b = await guest();
    await post("/friends/request", { playerId: b.playerId }, { token: a.accessToken });
    await post("/friends/request", { playerId: a.playerId }, { token: b.accessToken });
    await expect.poll(() => friendsOf(a)).toEqual([{ playerId: b.playerId, status: "friend" }]);
    await expect.poll(() => friendsOf(b)).toEqual([{ playerId: a.playerId, status: "friend" }]);
  });

  it("不能加自己，不能加不存在的玩家，不能接受没有的申请", async () => {
    const a = await guest();
    const token = { token: a.accessToken };
    expect((await post("/friends/request", { playerId: a.playerId }, token)).status).toBe(409);
    expect((await post("/friends/request", { playerId: "p_" + "0".repeat(24) }, token)).status).toBe(404);
    expect((await post("/friends/request", { playerId: "someone" }, token)).status).toBe(400);
    expect((await post("/friends/accept", { playerId: (await guest()).playerId }, token)).status).toBe(404);
    expect(await friendsOf(a)).toEqual([]);
  });

  it("同一条通知处理两次，结果不变", async () => {
    const a = await guest();
    const b = await guest();
    await post("/friends/request", { playerId: b.playerId }, { token: a.accessToken });
    const event: PlayerEvent = { type: "friend_accept", from: b.playerId, to: a.playerId, at: 1, seq: 1 };
    for (let i = 0; i < 2; i++) {
      const batch = createMessageBatch<PlayerEvent>("player-events", [
        { id: `dup-${i}`, timestamp: new Date(), body: event, attempts: 1 },
      ]);
      await worker.queue(batch, env);
    }
    expect(await friendsOf(a)).toEqual([{ playerId: b.playerId, status: "friend" }]);
  });

  it("好友榜只有自己和好友", async () => {
    const a = await guest();
    const b = await guest();
    const stranger = await guest();
    await post("/friends/request", { playerId: b.playerId }, { token: a.accessToken });
    await post("/friends/request", { playerId: a.playerId }, { token: b.accessToken });
    await expect.poll(() => friendsOf(a)).toEqual([{ playerId: b.playerId, status: "friend" }]);
    await win(b, "fl-b");
    await win(stranger, "fl-s");
    await player(a).applyMatchResult("fl-a", { won: false, coins: 0, rating: -16 });

    await expect
      .poll(async () => {
        const response = await get("/leaderboard/friends", a.accessToken);
        return ((await response.json()) as { entries: unknown[] }).entries;
      })
      .toEqual([
        { playerId: b.playerId, score: 1016 },
        { playerId: a.playerId, score: 984 },
      ]);
  });
});

describe("邀请", () => {
  async function invitedPair() {
    const inviter = await guest();
    await pause();
    const invitee = await guest();
    const response = await post("/invite/accept", { playerId: inviter.playerId }, { token: invitee.accessToken });
    expect(response.status).toBe(200);
    return { inviter, invitee };
  }

  it("填了邀请人之后，关系进入可查询的表", async () => {
    const { inviter, invitee } = await invitedPair();
    await expect
      .poll(async () => {
        const response = await get("/invites", inviter.accessToken);
        return ((await response.json()) as { invites: unknown[] }).invites;
      })
      .toEqual([{ playerId: invitee.playerId, rewarded: false }]);
  });

  it("邀请人只能填一次，不能填自己，不能填比自己注册得晚的人", async () => {
    const { inviter, invitee } = await invitedPair();
    const token = { token: invitee.accessToken };
    // 重复提交同一个邀请人不算错。
    expect((await post("/invite/accept", { playerId: inviter.playerId }, token)).status).toBe(200);
    const other = await guest();
    expect((await post("/invite/accept", { playerId: other.playerId }, token)).status).toBe(409);
    expect((await post("/invite/accept", { playerId: invitee.playerId }, token)).status).toBe(400);
    // 反过来填：邀请人想把被邀请的人填成自己的邀请人。
    const reversed = await post("/invite/accept", { playerId: invitee.playerId }, { token: inviter.accessToken });
    expect(await reversed.json()).toEqual({ error: "invalid" });
  });

  it("注册太久之后不能再填邀请人", async () => {
    const inviter = await guest();
    await pause();
    const late = await guest();
    const created = (await player(inviter).getPublic()).createdAt;
    const outcome = await player(late).setInviter(inviter.playerId, created, Date.now() + INVITE_WINDOW_MS + 60_000);
    expect(outcome).toBe("too_late");
  });

  it("被邀请的人赢够局数，邀请人拿到一次奖励", async () => {
    const { inviter, invitee } = await invitedPair();
    for (let i = 0; i < INVITE_WINS_REQUIRED; i++) {
      // 还没达到门槛时没有奖励。
      expect((await player(inviter).getProfile()).coins).toBe(0);
      await win(invitee, `inv-${invitee.playerId}-${i}`);
    }
    await expect.poll(() => player(inviter).getProfile()).toMatchObject({ coins: INVITE_REWARD_COINS });
    // 之后再赢多少局都不会再发。
    await win(invitee, `inv-${invitee.playerId}-more`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await player(inviter).getProfile()).coins).toBe(INVITE_REWARD_COINS);
    await expect
      .poll(async () => {
        const response = await get("/invites", inviter.accessToken);
        return ((await response.json()) as { invites: unknown[] }).invites;
      })
      .toEqual([{ playerId: invitee.playerId, rewarded: true }]);
  });

  it("不计分的对局不算数", async () => {
    const { inviter, invitee } = await invitedPair();
    for (let i = 0; i < INVITE_WINS_REQUIRED + 1; i++) {
      await player(invitee).applyMatchResult(`inv-private-${invitee.playerId}-${i}`, { won: true, coins: 10 });
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await player(inviter).getProfile()).coins).toBe(0);
  });

  it("同一个被邀请人只发一次，总次数有上限", async () => {
    const inviter = await guest();
    const stub = player(inviter);
    expect(await stub.grantInviteReward("p_first")).toBe("granted");
    expect(await stub.grantInviteReward("p_first")).toBe("duplicate");
    for (let i = 1; i < INVITE_REWARD_CAP; i++) {
      expect(await stub.grantInviteReward(`p_n${i}`)).toBe("granted");
    }
    expect(await stub.grantInviteReward("p_over")).toBe("capped");
    expect(await stub.grantInviteReward("p_over")).toBe("duplicate");
    expect((await stub.getProfile()).coins).toBe(INVITE_REWARD_CAP * INVITE_REWARD_COINS);
  });
});
