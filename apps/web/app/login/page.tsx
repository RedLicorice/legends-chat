import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { LoginClient } from "./LoginClient";

export const dynamic = "force-dynamic";

// PWA cold-open lands here (manifest start_url = /login due to CF root
// challenge). If the user already has a valid session, redirect to / so they
// don't see the sign-in form and assume re-login is required.
export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = (await (searchParams ?? Promise.resolve({}))) as Record<string, string | string[] | undefined>;
  // Don't redirect if landing here from an explicit error link (so the user
  // can read the error message rendered by LoginClient).
  const hasError = typeof sp.error === "string" && sp.error.length > 0;
  if (!hasError) {
    const user = await getCurrentUser();
    if (user) redirect("/");
  }
  return <LoginClient />;
}
