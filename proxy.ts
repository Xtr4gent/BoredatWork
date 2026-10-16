import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  ADMIN_AUTH,
  buildAdminLoginRedirect,
  isAdminAuthConfigured,
  isAdminSessionValueCurrent,
} from "@/lib/workquiz/admin-auth";

export async function proxy(request: NextRequest) {
  const target = `${request.nextUrl.pathname}${request.nextUrl.search}`;

  if (!isAdminAuthConfigured()) {
    if (request.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json(
        {
          error:
            "Admin auth is not configured. Set WORKQUIZ_ADMIN_USERNAME and WORKQUIZ_ADMIN_PASSWORD.",
        },
        { status: 503 },
      );
    }

    return NextResponse.redirect(new URL(buildAdminLoginRedirect(target, "config"), request.url));
  }

  const sessionValue = request.cookies.get(ADMIN_AUTH.sessionCookie)?.value;
  if (await isAdminSessionValueCurrent(sessionValue)) {
    return NextResponse.next();
  }

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Admin authentication required." }, { status: 401 });
  }

  return NextResponse.redirect(new URL(buildAdminLoginRedirect(target), request.url));
}

export const config = {
  matcher: [
    "/admin",
    "/test",
    "/setup/:path*",
    "/admin/:path*",
    "/api/admin/:path*",
    "/api/brackets",
    "/api/brackets/preview",
  ],
};
