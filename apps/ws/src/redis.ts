import { Redis } from "ioredis";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";

export const pubClient = new Redis(url, { maxRetriesPerRequest: null });
export const subClient = pubClient.duplicate();
export const cacheClient = pubClient.duplicate();
