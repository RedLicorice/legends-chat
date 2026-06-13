import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// During `next build` page-data collection, DATABASE_URL isn't set; the
// query is never executed in that phase, but importing this module would
// crash the build. Fall back to a sentinel URL so the module loads; any
// real query at runtime will fail with a connect error if the env is
// genuinely missing — which is the correct failure mode.
const url = process.env.DATABASE_URL ?? "postgres://build-placeholder:0/_";

const client = postgres(url, { max: 10 });

export const db = drizzle(client, { schema });
export type DB = typeof db;
