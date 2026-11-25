import { log } from "./log";

/**
 * 死信队列的消费者：记日志，存进表里，然后确认。到了这里的消息不会再自动重试。
 * 那条 error 级别的日志就是告警的来源：平台的监控规则盯着 dead_letter 这个事件名。
 */
export async function storeDeadLetters(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const insert = env.DB.prepare("INSERT INTO dead_letter (at, queue, message_id, body) VALUES (?, ?, ?, ?)");
  const now = Date.now();
  await env.DB.batch(
    batch.messages.map((message) => {
      const body = JSON.stringify(message.body) ?? "null";
      // 日志里只放开头一段，完整的内容在表里。
      log.error("dead_letter", { queue: batch.queue, messageId: message.id, preview: body.slice(0, 300) });
      return insert.bind(now, batch.queue, message.id, body);
    }),
  );
}
