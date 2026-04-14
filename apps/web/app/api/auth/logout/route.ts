import { NextResponse } from "next/server";
import { clearAuthCookies } from "@/lib/auth";

export async function POST() {
  await clearAuthCookies();
  return NextResponse.redirect(new URL("/login", process.env.APP_PUBLIC_URL ?? "http://localhost:3000"));
}
