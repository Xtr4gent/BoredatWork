import { NextResponse } from "next/server";

import { buildAdminSnapshot, matchesAdminKey, releaseVoterBinding } from "@/lib/workquiz/bracket";
import { publish } from "@/lib/workquiz/realtime";
import { updateStore } from "@/lib/workquiz/store";

export async function POST(
  request: Request,
  context: { params: Promise<{ adminToken: string }> },
) {
  const { adminToken } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { rosterMemberId?: string };
  const rosterMemberId = body.rosterMemberId?.trim();

  if (!rosterMemberId) {
    return NextResponse.json({ error: "rosterMemberId is required." }, { status: 400 });
  }

  let updatedBracketPublicToken: string | null = null;

  try {
    const updatedStore = await updateStore((store) => {
      const mutable = store.brackets.find((entry) => matchesAdminKey(entry, adminToken));

      if (!mutable) {
        throw new Error("Bracket not found.");
      }

      releaseVoterBinding(mutable, rosterMemberId);
      updatedBracketPublicToken = mutable.publicToken;
      return store;
    });

    const updatedBracket = updatedStore.brackets.find(
      (entry) => entry.publicToken === updatedBracketPublicToken,
    );
    if (!updatedBracket) {
      return NextResponse.json({ error: "Bracket not found." }, { status: 404 });
    }

    publish(updatedBracket.publicToken, { type: "bindings-reset" });
    return NextResponse.json(await buildAdminSnapshot(updatedBracket, adminToken));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not free that name.";
    const status = message === "Bracket not found." ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
