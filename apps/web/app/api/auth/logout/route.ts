import { type NextRequest, NextResponse } from "next/server";
import { clearAuthCookies } from "@/lib/auth";
import { publicOriginServer } from "@/lib/public-origin.server";

export async function POST(req: NextRequest) {
  await clearAuthCookies();
  return NextResponse.redirect(new URL("/login", publicOriginServer(req)), 303);
}
