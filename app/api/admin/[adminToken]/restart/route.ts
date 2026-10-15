import { NextResponse } from "next/server";

import { buildAdminSnapshot, restartBracket } from "@/lib/workquiz/bracket";
import { publish } from "@/lib/workquiz/realtime";
import { updateStore } from "@/lib/workquiz/store";
import { hashValue } from "@/lib/workquiz/utils";

export async function POST(
  _request: Request,
  context: { params: Promise<{ adminToken: string }> },
) {
  const { adminToken } = await context.params;
  let updatedBracketPublicToken: string | null = null;
  let refusal: string | null = null;
  const updatedStore = await updateStore((store) => {
    const mutable = store.brackets.find((entry) => entry.adminTokenHash === hashValue(adminToken));

    if (!mutable) {
      throw new Error("Bracket not found.");
    }

    try {
      restartBracket(mutable);
    } catch (error) {
      refusal = error instanceof Error ? error.message : "This tournament can't be restarted.";
      return store;
    }
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

  publish(updatedBracket.publicToken, { type: "restarted" });

  return NextResponse.json(await buildAdminSnapshot(updatedBracket, adminToken));
}
