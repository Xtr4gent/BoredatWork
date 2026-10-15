import { NextResponse } from "next/server";

import { ADMIN_AUTH } from "@/lib/workquiz/admin-auth";

/**
 * Signs this browser out of the admin portal. Lives outside /api/admin so it
 * works even when the session has already expired. POST only, so a link or
 * image elsewhere cannot sign someone out.
 *
 * The redirect is relative on purpose: behind the custom server and Railway's
 * proxy, request.url carries the internal bind address (e.g. 0.0.0.0:8080),
 * so an absolute URL built from it would send the browser somewhere dead.
 */
export async function POST() {
  const response = new NextResponse(null, {
    status: 303,
    headers: { Location: ADMIN_AUTH.loginPath },
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
