import { NextResponse } from "next/server";

import { suggestEntrantPhotos } from "@/lib/workquiz/photo-scraper";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    names?: string[];
    skipCache?: boolean;
    searchVariant?: "default" | "alt";
  };
  if (!Array.isArray(body.names)) {
    return NextResponse.json({ error: "Names must be an array." }, { status: 400 });
  }

  const names = body.names.map((name) => String(name ?? "").trim());
  if (!names.length) {
    return NextResponse.json({ error: "Add at least one entrant name." }, { status: 400 });
  }

  if (names.length > 128) {
    return NextResponse.json({ error: "Too many names in one request." }, { status: 400 });
  }

  const suggestions = await suggestEntrantPhotos(names, {
    skipCache: Boolean(body.skipCache),
    searchVariant: body.searchVariant === "alt" ? "alt" : "default",
  });
  return NextResponse.json({ suggestions });
}
