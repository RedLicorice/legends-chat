import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";

const GIPHY_API_KEY = process.env.GIPHY_API_KEY ?? "";
const GIPHY_BASE = "https://api.giphy.com/v1/gifs";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!GIPHY_API_KEY) return NextResponse.json({ error: "GIPHY_API_KEY not configured" }, { status: 503 });

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q") ?? "";
  const limit = Math.min(Number(searchParams.get("limit") ?? 20), 50);
  const offset = searchParams.get("offset") ?? "0";

  const endpoint = q.trim() ? "search" : "trending";
  const params = new URLSearchParams({
    api_key: GIPHY_API_KEY,
    limit: String(limit),
    rating: "g",
    ...(q.trim() && { q }),
    offset,
  });

  const res = await fetch(`${GIPHY_BASE}/${endpoint}?${params}`);
  if (!res.ok) return NextResponse.json({ error: "giphy error" }, { status: 502 });

  const data = await res.json() as {
    data: Array<{
      id: string;
      title: string;
      images: {
        fixed_height?: { url: string; width: string; height: string };
        fixed_height_small?: { url: string };
        original?: { url: string; width: string; height: string };
      };
    }>;
    pagination: { total_count: number; count: number; offset: number };
  };

  const gifs = data.data.map((r) => ({
    id: r.id,
    title: r.title,
    url: r.images.fixed_height?.url ?? r.images.original?.url ?? "",
    thumbnailUrl: r.images.fixed_height_small?.url ?? r.images.fixed_height?.url ?? "",
    width: Number(r.images.fixed_height?.width ?? r.images.original?.width ?? 0),
    height: Number(r.images.fixed_height?.height ?? r.images.original?.height ?? 0),
  }));

  const nextOffset = data.pagination.offset + data.pagination.count;
  return NextResponse.json({ gifs, next: nextOffset < data.pagination.total_count ? String(nextOffset) : null });
}
