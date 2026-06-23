import { NextResponse } from "next/server";

import { addRosterMembers, buildAdminSnapshot } from "@/lib/workquiz/bracket";

export async function POST(
  request: Request,
  context: { params: Promise<{ adminToken: string }> },
) {
  const { adminToken } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { names?: string[]; name?: string };

  const names = body.names?.length
    ? body.names
    : body.name?.trim()
      ? [body.name]
      : [];

  try {
    const updated = await addRosterMembers({ adminToken, names });
    return NextResponse.json(await buildAdminSnapshot(updated, adminToken));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not add roster members.";
    const status = message === "Bracket not found." ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
