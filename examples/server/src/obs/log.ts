/**
 * 结构化日志。每条日志是一个对象：event 说明发生了什么，其余字段是可以用来筛选的上下文。
 * 平台会把对象的字段建成索引，所以按玩家、按订单、按事件名查询都很快。
 *
 * 约定：
 * - event 用固定的、下划线分隔的英文名，不要把变量拼进去。变量放进字段。
 * - 不要记录密钥、令牌、游客凭证，也不要记录带有它们的地址和请求头。
 * - error 级别表示需要有人处理；预期之内的失败（余额不足、签名不对）用 info 或 warn。
 */
export type LogFields = Record<string, unknown>;

function write(level: "info" | "warn" | "error", event: string, fields: LogFields): void {
  const entry: LogFields = { event, ...fields };
  // 异常对象直接序列化是空的，取出有用的部分。
  if (entry.error instanceof Error) {
    entry.error = { name: entry.error.name, message: entry.error.message, stack: entry.error.stack };
  } else if (entry.error !== undefined && typeof entry.error !== "object") {
    entry.error = { message: String(entry.error) };
  }
  console[level](entry);
}

export const log = {
  info: (event: string, fields: LogFields = {}) => write("info", event, fields),
  warn: (event: string, fields: LogFields = {}) => write("warn", event, fields),
  error: (event: string, fields: LogFields = {}) => write("error", event, fields),
};
