import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@legends/db/schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const client = postgres(url, { max: 10 });
export const db = drizzle(client, { schema });
