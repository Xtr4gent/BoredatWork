import { NextResponse } from "next/server";

import { buildAdminSnapshot, findBracketByAdminToken } from "@/lib/workquiz/bracket";

export async function GET(
  _request: Request,
  context: { params: Promise<{ adminToken: string }> },
) {
  const { adminToken } = await context.params;
  const bracket = await findBracketByAdminToken(adminToken);

  if (!bracket) {
    return NextResponse.json({ error: "Bracket not found." }, { status: 404 });
  }

  const response = NextResponse.json(await buildAdminSnapshot(bracket, adminToken));
  response.cookies.set("workquiz_admin_token", adminToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });

  return response;
}
