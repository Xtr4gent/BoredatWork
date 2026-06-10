import { NextResponse } from "next/server";

import { isAdminAuthenticated } from "@/lib/workquiz/admin-auth";
import { getRememberedRosterMemberId } from "@/lib/workquiz/auth";
import { buildSnapshot, findBracketByPublicToken } from "@/lib/workquiz/bracket";
import { jsonWithETag } from "@/lib/workquiz/etag";

export async function GET(
  request: Request,
  context: { params: Promise<{ publicToken: string }> },
) {
  const { publicToken } = await context.params;
  const bracket = await findBracketByPublicToken(publicToken);

  if (!bracket) {
    return NextResponse.json({ error: "Bracket not found." }, { status: 404 });
  }

  if (bracket.status === "disabled") {
    return NextResponse.json({ error: "Bracket not available." }, { status: 404 });
  }

  if ((bracket.kind ?? "public") === "test" && !(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Bracket not found." }, { status: 404 });
  }

  const searchParams = new URL(request.url).searchParams;
  const requestedRosterMemberId = searchParams.get("rosterMemberId");
  const rememberedRosterMemberId = searchParams.has("rosterMemberId")
    ? requestedRosterMemberId
    : await getRememberedRosterMemberId();
  const rosterMemberId = bracket.rosterMembers.some((member) => member.id === rememberedRosterMemberId)
    ? rememberedRosterMemberId ?? undefined
    : undefined;

  return jsonWithETag(request, buildSnapshot(bracket, { rosterMemberId }));
}
