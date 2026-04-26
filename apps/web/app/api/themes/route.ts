import { NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { themes } from "@legends/db/schema";
import { db } from "@/lib/db";

export async function GET() {
  const rows = await db.select().from(themes).orderBy(asc(themes.createdAt));
  return NextResponse.json(rows);
}
