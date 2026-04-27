import { type NextRequest, NextResponse } from "next/server";
import { clearAuthCookies } from "@/lib/auth";

export async function POST(req: NextRequest) {
  await clearAuthCookies();
  return NextResponse.redirect(new URL("/login", req.nextUrl.origin));
}
