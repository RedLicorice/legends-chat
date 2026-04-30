import { Redis } from "ioredis";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";
const g = globalThis as unknown as { __redis?: Redis };
export const redis = g.__redis ?? new Redis(url, { maxRetriesPerRequest: null });
// Swallow connection errors at module level — unhandled 'error' events crash Node.
// Actual request failures still surface through the calling code.
redis.on("error", () => {});
if (process.env.NODE_ENV !== "production") g.__redis = redis;
