import { Redis } from "ioredis";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";
const g = globalThis as unknown as { __redis?: Redis };
export const redis = g.__redis ?? new Redis(url, { maxRetriesPerRequest: null });
if (process.env.NODE_ENV !== "production") g.__redis = redis;
