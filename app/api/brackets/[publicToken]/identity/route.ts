import { NextResponse } from "next/server";

import { isAdminAuthenticated } from "@/lib/workquiz/admin-auth";
import { getOrCreateBrowserToken, getRememberedClaim, setRememberedClaim } from "@/lib/workquiz/auth";
import { buildPublicSnapshot, claimVoterIdentity, findBracketByPublicToken } from "@/lib/workquiz/bracket";
import { getClientInfo } from "@/lib/workquiz/client-info";
import { publish } from "@/lib/workquiz/realtime";
import { mergeRememberedEntry, rememberedEntryForBracket } from "@/lib/workquiz/voter";

export async function POST(
  request: Request,
  context: { params: Promise<{ publicToken: string }> },
) {
  const { publicToken } = await context.params;
  const bracket = await findBracketByPublicToken(publicToken);

  if (!bracket) {
    return NextResponse.json({ error: "Bracket not found." }, { status: 404 });
  }

  if ((bracket.kind ?? "public") === "test" && !(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Bracket not found." }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as { rosterMemberName?: string | null };
  const rosterMemberName = body.rosterMemberName?.trim() ?? null;

  if (!rosterMemberName) {
    return NextResponse.json({ error: "rosterMemberName is required." }, { status: 400 });
  }

  const browserToken = await getOrCreateBrowserToken();
  const rememberedCookie = await getRememberedClaim();

  try {
    const { bracket: updated, rosterMemberId, claimId } = await claimVoterIdentity({
      publicToken,
      browserToken,
      rosterMemberName,
      remembered: rememberedEntryForBracket(bracket, rememberedCookie),
      client: getClientInfo(request, browserToken),
    });

    await setRememberedClaim(mergeRememberedEntry(updated, rememberedCookie, rosterMemberId, claimId));
    // Open voting pages refresh on any realtime event, so the picked name
    // disappears from everyone else's picker within a second.
    publish(updated.publicToken, { type: "roster-claimed" });
    return NextResponse.json(
      buildPublicSnapshot(updated, {
        rosterMemberId,
      }),
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not register your name." },
      { status: 400 },
    );
  }
}
