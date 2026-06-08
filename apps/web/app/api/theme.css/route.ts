import { asc } from "drizzle-orm";
import { themes } from "@legends/db/schema";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const revalidate = 300;

function buildThemeCss(
  themeRows: {
    id: string;
    colors: unknown;
    isGlass: boolean;
    bgGradient: string | null;
    customCss: string | null;
  }[],
): string {
  return themeRows
    .map((t) => {
      const colors = (t.colors as Record<string, string>) ?? {};
      const vars = Object.entries(colors)
        .map(([k, v]) => `--ch-${k}:${v}`)
        .join(";");
      let css = `[data-theme="${t.id}"]{${vars}}`;
      if (t.isGlass) {
        const grad =
          t.bgGradient ??
          "radial-gradient(ellipse 90% 90% at 15% 10%, #1c1448 0%, #0b0e22 55%, #070c14 100%)";
        css += `[data-theme="${t.id}"] body{background:${grad};background-attachment:fixed}`;
      }
      if (t.customCss) {
        // Strip </style> tags to prevent escape if customCss is ever inlined.
        css += t.customCss.replace(/<\/style>/gi, "");
      }
      return css;
    })
    .join("");
}

export async function GET(): Promise<Response> {
  const rows = await db
    .select()
    .from(themes)
    .orderBy(asc(themes.createdAt))
    .catch(() => [] as typeof themes.$inferSelect[]);
  const css = buildThemeCss(rows);
  return new Response(css, {
    status: 200,
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    },
  });
}
