import { NextResponse } from "next/server";

import { isAdminAuthenticated } from "@/lib/workquiz/admin-auth";
import { getOrCreateBrowserToken, setRememberedRosterMemberId } from "@/lib/workquiz/auth";
import { claimVoterIdentity, findBracketByPublicToken } from "@/lib/workquiz/bracket";

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

  try {
    const { rosterMemberId } = await claimVoterIdentity({
      publicToken,
      browserToken,
      rosterMemberName,
    });

    await setRememberedRosterMemberId(rosterMemberId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not register your name." },
      { status: 400 },
    );
  }
}
