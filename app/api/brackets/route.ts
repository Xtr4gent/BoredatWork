import { NextResponse } from "next/server";

import { createBracket } from "@/lib/workquiz/bracket";
import { DEFAULT_ROUND_DURATION_HOURS } from "@/lib/workquiz/constants";
import type { BracketKind, EntrantInput } from "@/lib/workquiz/types";
import { normalizeContenderInputs, parseContendersFromText } from "@/lib/workquiz/utils";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    title?: string;
    kind?: BracketKind;
    entrants?: EntrantInput[];
    directQualifierNames?: string[];
    rosterMembers?: string[];
    seededEntrants?: EntrantInput[];
    entrantsText?: string;
    seedingMode?: "manual" | "random";
    startsAt?: string;
    endsAt?: string;
    totalPlayers?: number;
    roundDurationHours?: number;
  };

  let entrants: ReturnType<typeof normalizeContenderInputs>;
  let seededEntrants: ReturnType<typeof normalizeContenderInputs> | undefined;
  try {
    entrants = body.entrants?.length
      ? normalizeContenderInputs(body.entrants)
      : parseContendersFromText(body.entrantsText ?? "");
    seededEntrants = body.seededEntrants?.length ? normalizeContenderInputs(body.seededEntrants) : undefined;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid contender list." },
      { status: 400 },
    );
  }
  const rosterMembers = body.rosterMembers?.length ? body.rosterMembers : [];

  if (!body.title?.trim()) {
    return NextResponse.json({ error: "Title is required." }, { status: 400 });
  }

  if (entrants.length < 2) {
    return NextResponse.json(
      { error: "Add at least two entrants to create a bracket." },
      { status: 400 },
    );
  }

  if (rosterMembers.length < 2) {
    return NextResponse.json(
      { error: "Add at least two roster members to create the bracket." },
      { status: 400 },
    );
  }

  if (new Set(rosterMembers.map((member) => member.toLowerCase())).size !== rosterMembers.length) {
    return NextResponse.json(
      { error: "Roster names must be unique." },
      { status: 400 },
    );
  }

  if (body.endsAt && new Date(body.endsAt).getTime() <= new Date(body.startsAt ?? "").getTime()) {
    return NextResponse.json(
      { error: "Round one end time must be later than the start time." },
      { status: 400 },
    );
  }

  const { adminToken } = await createBracket({
    title: body.title.trim(),
    kind: body.kind === "test" ? "test" : "public",
    entrants,
    directQualifierNames: body.directQualifierNames,
    rosterMembers,
    seededEntrants,
    seedingMode: body.seedingMode ?? "manual",
    startsAt: body.startsAt ?? new Date().toISOString(),
    endsAt: body.endsAt,
    totalPlayers: rosterMembers.length,
    roundDurationHours: body.roundDurationHours ?? DEFAULT_ROUND_DURATION_HOURS,
  });

  return NextResponse.json({
    publicUrl: "/voting",
    adminUrl: `/admin?adminToken=${encodeURIComponent(adminToken)}`,
    testUrl: `/test?adminToken=${encodeURIComponent(adminToken)}`,
  });
}
