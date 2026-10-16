import { NextResponse } from "next/server";

import {
  buildAdminSnapshot,
  copyForUndo,
  disableBracket,
  matchesAdminKey,
  recordUndo,
} from "@/lib/workquiz/bracket";
import { publish } from "@/lib/workquiz/realtime";
import { updateStore } from "@/lib/workquiz/store";

export async function POST(
  _request: Request,
  context: { params: Promise<{ adminToken: string }> },
) {
  const { adminToken } = await context.params;
  let updatedBracketPublicToken: string | null = null;
  let refusal: string | null = null;
  const updatedStore = await updateStore((store) => {
    const mutable = store.brackets.find((entry) => matchesAdminKey(entry, adminToken));

    if (!mutable) {
      throw new Error("Bracket not found.");
    }

    if (mutable.status === "disabled") {
      // Shutting down twice would replace the useful undo copy with a
      // copy of the already shut-down tournament.
      refusal = "This tournament is already shut down.";
      return store;
    }

    const copy = copyForUndo(mutable);
    disableBracket(mutable);
    recordUndo(mutable, "shutdown", copy);
    updatedBracketPublicToken = mutable.publicToken;
    return store;
  }).catch((error) => {
    if (error instanceof Error && error.message === "Bracket not found.") {
      return null;
    }
    throw error;
  });

  if (refusal) {
    return NextResponse.json({ error: refusal }, { status: 400 });
  }

  if (!updatedStore || !updatedBracketPublicToken) {
    return NextResponse.json({ error: "Bracket not found." }, { status: 404 });
  }

  const updatedBracket = updatedStore.brackets.find((entry) => entry.publicToken === updatedBracketPublicToken);
  if (!updatedBracket) {
    return NextResponse.json({ error: "Bracket not found." }, { status: 404 });
  }

  publish(updatedBracket.publicToken, { type: "disabled" });

  return NextResponse.json(await buildAdminSnapshot(updatedBracket, adminToken));
}
