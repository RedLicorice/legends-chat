import type { Config } from "drizzle-kit";

export default {
  schema: "./src/schema.ts",
  out: "./src/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://legends:legends@localhost:5432/legends",
  },
  strict: true,
  verbose: true,
} satisfies Config;
