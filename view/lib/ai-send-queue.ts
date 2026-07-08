/** 按连接（profileId）串行 AI 请求，避免同一连接叠加上一条未完成的 Agent 回合 */
const queues = new Map<string, Promise<unknown>>()

export function aiSendQueueKey(backend: string, connectionKey: string): string {
  return `${backend}:${connectionKey}`
}

export function runAiSendQueued<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve()
  const run = prev
    .catch(() => undefined)
    .then(() => task())
  queues.set(key, run)
  return run.finally(() => {
    if (queues.get(key) === run) queues.delete(key)
  }) as Promise<T>
}
