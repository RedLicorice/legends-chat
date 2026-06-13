import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@legends/db/schema";

// During `next build` page-data collection, DATABASE_URL isn't set; the
// query is never actually executed in that phase, but importing this
// module would crash the build. Fall back to a sentinel that lets the
// module load; any real query at runtime will fail with a connect error
// — which is the correct failure mode if DATABASE_URL is genuinely missing.
const url = process.env.DATABASE_URL ?? "postgres://build-placeholder:0/_";

const globalForDb = globalThis as unknown as { __pg?: ReturnType<typeof postgres> };
const client = globalForDb.__pg ?? postgres(url, { max: 10 });
if (process.env.NODE_ENV !== "production") globalForDb.__pg = client;

export const db = drizzle(client, { schema });
