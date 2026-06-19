import { NextResponse } from "next/server";

import { isAdminAuthenticated } from "@/lib/workquiz/admin-auth";
import { getOrCreateBrowserToken } from "@/lib/workquiz/auth";
import { buildPublicSnapshot, castVote, findBracketByPublicToken } from "@/lib/workquiz/bracket";
import { rosterMemberIdForBrowser } from "@/lib/workquiz/voter";

export async function POST(
  request: Request,
  context: { params: Promise<{ publicToken: string }> },
) {
  const { publicToken } = await context.params;
  const bracket = await findBracketByPublicToken(publicToken);
  const body = (await request.json()) as {
    matchupSlot?: number;
    side?: "A" | "B";
  };

  if (!bracket || bracket.status === "disabled") {
    return NextResponse.json({ error: "Bracket not available." }, { status: 404 });
  }

  if ((bracket.kind ?? "public") === "test" && !(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Bracket not available." }, { status: 404 });
  }

  if (typeof body.matchupSlot !== "number" || (body.side !== "A" && body.side !== "B")) {
    return NextResponse.json({ error: "matchupSlot and side are required." }, { status: 400 });
  }

  const browserToken = await getOrCreateBrowserToken();

  try {
    const updatedBracket = await castVote({
      publicToken,
      browserToken,
      matchupSlot: body.matchupSlot,
      side: body.side,
    });

    const rosterMemberId = rosterMemberIdForBrowser(updatedBracket, browserToken);
    return NextResponse.json(
      buildPublicSnapshot(updatedBracket, {
        rosterMemberId,
      }),
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Vote failed." },
      { status: 400 },
    );
  }
}
