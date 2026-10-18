import { NextResponse } from "next/server";

import { buildAdminSnapshot, matchesAdminKey, setRosterAvailability } from "@/lib/workquiz/bracket";
import { publish } from "@/lib/workquiz/realtime";
import { updateStore } from "@/lib/workquiz/store";

/**
 * Switches voting off for people who are away (not at work), or back on.
 * Body: { rosterMemberId, away } for one person, or { everyone: true, away }.
 * Away people can't vote and don't count towards turnout; votes they already
 * cast are kept.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ adminToken: string }> },
) {
  const { adminToken } = await context.params;
  const body = (await request.json().catch(() => ({}))) as {
    rosterMemberId?: string;
    everyone?: boolean;
    away?: boolean;
  };

  if (typeof body.away !== "boolean") {
    return NextResponse.json({ error: "away (true or false) is required." }, { status: 400 });
  }

  const rosterMemberId = body.rosterMemberId?.trim();
  if (!body.everyone && !rosterMemberId) {
    return NextResponse.json({ error: "rosterMemberId or everyone is required." }, { status: 400 });
  }

  let found = false;
  let refusal: string | null = null;
  const updatedStore = await updateStore((store) => {
    const mutable = store.brackets.find((entry) => matchesAdminKey(entry, adminToken));
    if (!mutable) {
      return store;
    }

    found = true;
    try {
      setRosterAvailability(mutable, body.everyone ? "everyone" : { rosterMemberIds: [rosterMemberId!] }, body.away!);
    } catch (error) {
      refusal = error instanceof Error ? error.message : "Could not change who can vote.";
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

  // Open /voting pages refresh, so a switched-off player sees it straight away.
  publish(updatedBracket.publicToken, { type: "roster-updated" });
  return NextResponse.json(await buildAdminSnapshot(updatedBracket, adminToken));
}
