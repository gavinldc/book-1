#!/usr/bin/env node
/**
 * 成本模型：按示例项目里一局对局、一个玩家一天实际会发生的操作，估算每月的账单。
 *
 *   node tools/cost-model.mjs                    # 打印几种规模的对比
 *   node tools/cost-model.mjs --dau 50000        # 指定日活
 *   node tools/cost-model.mjs --dau 10000 --awake 120   # 假设房间每局有 120 秒睡不着
 *
 * 这是估算，不是账单。每一局的操作次数是对着代码数出来的，上线后要用平台的用量数据替换它们。
 * 价格核对于 2026-11-25，见附录 A。
 */

/** 价格：每月包含的额度、计费单位、每个单位的价格（美元）。 */
const PRICES = {
  workerRequests: { included: 10e6, unit: 1e6, price: 0.3, label: "Workers 请求" },
  workerCpuMs: { included: 30e6, unit: 1e6, price: 0.02, label: "Workers CPU（毫秒）" },
  doRequests: { included: 1e6, unit: 1e6, price: 0.15, label: "对象请求" },
  doDurationGbS: { included: 400e3, unit: 1e6, price: 12.5, label: "对象时长（GB·秒）" },
  doRowsWritten: { included: 50e6, unit: 1e6, price: 1.0, label: "对象写入行数" },
  d1RowsRead: { included: 25e9, unit: 1e6, price: 0.001, label: "D1 读取行数" },
  d1RowsWritten: { included: 50e6, unit: 1e6, price: 1.0, label: "D1 写入行数" },
  queueOps: { included: 1e6, unit: 1e6, price: 0.4, label: "队列操作" },
  kvReads: { included: 10e6, unit: 1e6, price: 0.5, label: "KV 读取" },
  metricPoints: { included: 10e6, unit: 1e6, price: 0.25, label: "指标数据点" },
  logEvents: { included: 20e6, unit: 1e6, price: 0.6, label: "日志条数" },
};
const BASE_FEE = 5;
const DO_MEMORY_GB = 0.128;

/**
 * 一局排位赛（两个真人）里发生的操作。对着第 5 到 11 章的代码数出来的：
 * - Workers 请求：两条排队的连接，两条进房的连接。
 * - 对象请求：匹配对象 2（两次连接）；房间 1 次开房、2 次连接、1 次清理的定时器，
 *   加上收到的消息（2 次准备、约 11 次掷骰子）按 20 条折 1 次；
 *   每个玩家 4 次（排队前读资料和账号、记下所在房间、结算）。
 * - 对象写入：房间每次状态变化写状态、定时表各一行，设一次定时器算一行，掷骰子多写一行日志；
 *   每个玩家结算时写流水、流水的索引、资料、发件箱的写入和删除。
 * - 队列：一条对局记录、两条分数通知，每条算写入、读取、删除三次操作。
 * - D1：对局记录 1 行；两段录像和两条排行榜，各带一行索引。
 */
const PER_MATCH = {
  workerRequests: 4,
  workerCpuMs: 4 * 3,
  doRequests: 2 + (1 + 2 + 1 + 13 / 20) + 2 * 4,
  doRowsWritten: 80,
  doActiveSeconds: 1,
  d1RowsWritten: 9,
  queueOps: 9,
  metricPoints: 12,
  logEvents: 20,
};

/**
 * 一个玩家一天里对局之外的操作：登录一次，拉配置和资料若干次，看排行榜、邮箱、商店各几次。
 * 看一次排行榜要数名次，最多读约 2,000 行（第 7 章的上限）。
 */
const PER_PLAYER_DAY = {
  workerRequests: 30,
  workerCpuMs: 30 * 2,
  doRequests: 12,
  doRowsWritten: 6,
  doActiveSeconds: 0.2,
  d1RowsRead: 3 * 2000,
  d1RowsWritten: 1,
  kvReads: 15,
  metricPoints: 4,
  logEvents: 35,
};

function monthly({ dau, matchesPerPlayer, playersPerMatch, awakeSecondsPerMatch }) {
  const matches = (dau * matchesPerPlayer) / playersPerMatch;
  const usage = {};
  for (const key of Object.keys(PRICES)) usage[key] = 0;
  for (const [key, value] of Object.entries(PER_MATCH)) {
    if (key === "doActiveSeconds") usage.doDurationGbS += matches * (value + awakeSecondsPerMatch) * DO_MEMORY_GB * 30;
    else usage[key] += matches * value * 30;
  }
  for (const [key, value] of Object.entries(PER_PLAYER_DAY)) {
    if (key === "doActiveSeconds") usage.doDurationGbS += dau * value * DO_MEMORY_GB * 30;
    else usage[key] += dau * value * 30;
  }
  const lines = [];
  let total = BASE_FEE;
  for (const [key, price] of Object.entries(PRICES)) {
    const over = Math.max(0, usage[key] - price.included);
    // 超出的部分按计费单位向上取整。
    const cost = Math.ceil(over / price.unit) * price.price;
    total += cost;
    lines.push({ label: price.label, usage: usage[key], cost });
  }
  return { matches, lines, total };
}

const short = (n) =>
  n >= 1e8 ? `${(n / 1e8).toFixed(1)} 亿` : n >= 1e5 ? `${(n / 1e4).toFixed(0)} 万` : n >= 1e4 ? `${(n / 1e4).toFixed(1)} 万` : String(Math.round(n));

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((arg, i, all) => (arg.startsWith("--") ? [[arg.slice(2), all[i + 1]]] : [])),
);
const base = { matchesPerPlayer: Number(args.matches ?? 5), playersPerMatch: 2, awakeSecondsPerMatch: Number(args.awake ?? 0) };

if (args.dau) {
  const result = monthly({ ...base, dau: Number(args.dau) });
  console.log(`日活 ${args.dau}，每人每天 ${base.matchesPerPlayer} 局，每天 ${short(result.matches)} 局`);
  console.log("项目".padEnd(22) + "月用量".padStart(12) + "超出部分（美元）".padStart(14));
  for (const line of result.lines) {
    console.log(line.label.padEnd(22) + short(line.usage).padStart(12) + line.cost.toFixed(2).padStart(14));
  }
  console.log(`合计（含月费 ${BASE_FEE} 美元）：${result.total.toFixed(2)} 美元`);
} else {
  console.log("每人每天 5 局、两人一局。单位：美元/月。");
  console.log("日活".padEnd(10) + "房间正常休眠".padStart(12) + "每局 120 秒睡不着".padStart(18) + "每局 600 秒睡不着".padStart(18));
  for (const dau of [1_000, 10_000, 100_000, 1_000_000]) {
    const row = [0, 120, 600].map((awake) => monthly({ ...base, dau, awakeSecondsPerMatch: awake }).total.toFixed(0));
    console.log(String(dau).padEnd(10) + row[0].padStart(14) + row[1].padStart(20) + row[2].padStart(20));
  }
}
