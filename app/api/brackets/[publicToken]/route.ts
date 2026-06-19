import { NextResponse } from "next/server";

import { isAdminAuthenticated } from "@/lib/workquiz/admin-auth";
import { getOrCreateBrowserToken, getRememberedRosterMemberId } from "@/lib/workquiz/auth";
import {
  buildPublicSnapshot,
  ensureVoterBinding,
  findBracketByPublicToken,
} from "@/lib/workquiz/bracket";
import { jsonWithETag } from "@/lib/workquiz/etag";
import { rosterMemberIdForBrowser } from "@/lib/workquiz/voter";

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

  const browserToken = await getOrCreateBrowserToken();
  const rememberedRosterMemberId = await getRememberedRosterMemberId();
  await ensureVoterBinding({
    publicToken,
    browserToken,
    rememberedRosterMemberId,
  });

  const refreshedBracket = (await findBracketByPublicToken(publicToken)) ?? bracket;
  const rosterMemberId =
    rosterMemberIdForBrowser(refreshedBracket, browserToken) ?? rememberedRosterMemberId;

  return jsonWithETag(
    request,
    buildPublicSnapshot(refreshedBracket, {
      rosterMemberId: refreshedBracket.rosterMembers.some((member) => member.id === rosterMemberId)
        ? rosterMemberId
        : null,
    }),
  );
}
