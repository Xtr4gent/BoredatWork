import { NextResponse } from "next/server";

import { buildAdminSnapshot, matchesAdminKey, undoLastAction } from "@/lib/workquiz/bracket";
import { publish } from "@/lib/workquiz/realtime";
import { schedulePendingRoundStartPings } from "@/lib/workquiz/round-start-ping";
import { updateStore } from "@/lib/workquiz/store";

/** Undoes the tournament's last restart or shut down. */
export async function POST(
  _request: Request,
  context: { params: Promise<{ adminToken: string }> },
) {
  const { adminToken } = await context.params;
  let found = false;
  let refusal: string | null = null;
  let keptOffVoting = false;
  const updatedStore = await updateStore((store) => {
    const mutable = store.brackets.find((entry) => matchesAdminKey(entry, adminToken));
    if (!mutable) {
      return store;
    }

    found = true;
    try {
      keptOffVoting = undoLastAction(store, mutable).keptOffVoting;
    } catch (error) {
      refusal = error instanceof Error ? error.message : "This can't be undone.";
    }
    return store;
  });

  if (!found) {
    return NextResponse.json({ error: "Bracket not found." }, { status: 404 });
  }

  if (refusal) {
    return NextResponse.json({ error: refusal }, { status: 400 });
  }

  const updatedBracket = updatedStore.brackets.find((entry) => matchesAdminKey(entry, adminToken));
  if (!updatedBracket) {
    return NextResponse.json({ error: "Bracket not found." }, { status: 404 });
  }

  // Voters reload whatever they are looking at; "restarted" makes them refetch.
  publish(updatedBracket.publicToken, { type: "restarted" });
  if (updatedBracket.isCurrentPublic) {
    publish(updatedBracket.publicToken, { type: "current-public" });
    schedulePendingRoundStartPings();
  }

  return NextResponse.json({ ...(await buildAdminSnapshot(updatedBracket, adminToken)), keptOffVoting });
}
