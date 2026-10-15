import { NextResponse } from "next/server";

import { isAdminAuthenticated } from "@/lib/workquiz/admin-auth";
import { getOrCreateBrowserToken, getRememberedClaim } from "@/lib/workquiz/auth";
import {
  buildPublicSnapshot,
  ensureVoterBinding,
  findBracketByPublicToken,
} from "@/lib/workquiz/bracket";
import { getClientInfo } from "@/lib/workquiz/client-info";
import { jsonWithETag } from "@/lib/workquiz/etag";
import {
  isRememberedClaimCurrent,
  parseRememberedClaim,
  rosterMemberIdForBrowser,
  voterBindingNeedsMigration,
} from "@/lib/workquiz/voter";

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
  const remembered = await getRememberedClaim();
  // Only take the locked read-modify-write path (and re-read the store) when
  // this browser's binding actually needs migrating. On a normal poll nothing
  // changes, so this stays a single read with no database write.
  let refreshedBracket = bracket;
  if (voterBindingNeedsMigration(bracket, browserToken, remembered)) {
    await ensureVoterBinding({
      publicToken,
      browserToken,
      remembered,
      client: getClientInfo(request, browserToken),
    });
    refreshedBracket = (await findBracketByPublicToken(publicToken)) ?? bracket;
  }

  // A stale claim (freed by the admin, or superseded by a newer device) no
  // longer counts as that person, even for display.
  const rememberedForDisplay = isRememberedClaimCurrent(refreshedBracket, remembered)
    ? (parseRememberedClaim(remembered)?.rosterMemberId ?? null)
    : null;
  const rosterMemberId = rosterMemberIdForBrowser(refreshedBracket, browserToken) ?? rememberedForDisplay;

  return jsonWithETag(
    request,
    buildPublicSnapshot(refreshedBracket, {
      rosterMemberId: refreshedBracket.rosterMembers.some((member) => member.id === rosterMemberId)
        ? rosterMemberId
        : null,
    }),
  );
}
