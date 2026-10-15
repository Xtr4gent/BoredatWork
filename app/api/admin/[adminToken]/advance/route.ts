import { NextResponse } from "next/server";

import { advanceBracket, buildAdminSnapshot, matchesAdminKey } from "@/lib/workquiz/bracket";
import { publish } from "@/lib/workquiz/realtime";
import { schedulePendingRoundStartPings } from "@/lib/workquiz/round-start-ping";
import { updateStore } from "@/lib/workquiz/store";

export async function POST(
  _request: Request,
  context: { params: Promise<{ adminToken: string }> },
) {
  const { adminToken } = await context.params;
  let updatedBracketPublicToken: string | null = null;
  const updatedStore = await updateStore((store) => {
    const mutable = store.brackets.find((entry) => matchesAdminKey(entry, adminToken));

    if (!mutable) {
      throw new Error("Bracket not found.");
    }

    const liveRound = mutable.rounds.find((round) => round.status === "live");
    const nextMoment = liveRound ? new Date(new Date(liveRound.endsAt).getTime() + 1000) : new Date();
    advanceBracket(mutable, nextMoment);
    updatedBracketPublicToken = mutable.publicToken;
    return store;
  }).catch((error) => {
    if (error instanceof Error && error.message === "Bracket not found.") {
      return null;
    }
    throw error;
  });

  if (!updatedStore || !updatedBracketPublicToken) {
    return NextResponse.json({ error: "Bracket not found." }, { status: 404 });
  }

  const updatedBracket = updatedStore.brackets.find((entry) => entry.publicToken === updatedBracketPublicToken);
  if (!updatedBracket) {
    return NextResponse.json({ error: "Bracket not found." }, { status: 404 });
  }

  publish(updatedBracket.publicToken, { type: "advanced" });
  schedulePendingRoundStartPings();

  return NextResponse.json(await buildAdminSnapshot(updatedBracket, adminToken));
}
