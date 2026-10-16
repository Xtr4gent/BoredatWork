import { NextResponse } from "next/server";

import { ADMIN_AUTH } from "@/lib/workquiz/admin-auth";
import { revokeAdminSessions } from "@/lib/workquiz/admin-sessions";

/**
 * Signs every browser out of the admin portal, this one included: for a lost
 * phone, a shared computer, or a cookie that may have leaked. The proxy only
 * lets a signed-in admin reach this. The redirect is relative for the same
 * reason as /api/admin-logout.
 */
export async function POST() {
  await revokeAdminSessions();

  const response = new NextResponse(null, {
    status: 303,
    headers: { Location: `${ADMIN_AUTH.loginPath}?error=signed-out-everywhere` },
  });
  response.cookies.set(ADMIN_AUTH.sessionCookie, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
    path: "/",
  });
  return response;
}
