import { NextResponse } from "next/server";

import { buildAdminSnapshot, findBracketByAdminToken } from "@/lib/workquiz/bracket";
import { jsonWithETag } from "@/lib/workquiz/etag";

export async function GET(
  request: Request,
  context: { params: Promise<{ adminToken: string }> },
) {
  const { adminToken } = await context.params;
  const bracket = await findBracketByAdminToken(adminToken);

  if (!bracket) {
    return NextResponse.json({ error: "Bracket not found." }, { status: 404 });
  }

  return jsonWithETag(request, await buildAdminSnapshot(bracket, adminToken));
}
