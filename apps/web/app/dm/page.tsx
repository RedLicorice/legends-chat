import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Legacy `/dm` route. The DM list now lives in the unified left sidebar on
 * `/`, so we redirect to the home page with the `dms` filter chip preselected.
 * The legacy `?tab=bots` query param maps to `?filter=bots` for parity.
 */
export default async function DmPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = (await (searchParams ?? Promise.resolve({}))) as Record<string, string | string[] | undefined>;
  const tab = typeof sp.tab === "string" ? sp.tab : null;
  if (tab === "bots") redirect("/?filter=bots");
  redirect("/?filter=dms");
}
