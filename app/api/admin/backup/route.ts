import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { ADMIN_AUTH, isAdminSessionValueCurrent } from "@/lib/workquiz/admin-auth";
import { buildBackupBody } from "@/lib/workquiz/backup-export";

export const dynamic = "force-dynamic";

/**
 * Downloads everything the app has saved (every tournament, vote and name
 * pick) as one JSON file, so a copy exists outside the database.
 *
 * The proxy already keeps signed-out visitors away from /api/admin. The
 * session is checked again here because this hands over all the data at
 * once: it must not depend on the proxy's path list staying correct.
 *
 * To restore, the `store` value is what the database row holds.
 */
export async function GET(request: NextRequest) {
  const session = request.cookies.get(ADMIN_AUTH.sessionCookie)?.value;
  if (!(await isAdminSessionValueCurrent(session))) {
    return NextResponse.json({ error: "Admin authentication required." }, { status: 401 });
  }

  const backup = await buildBackupBody();

  return new NextResponse(backup.body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="boredatwork-backup-${backup.exportedAt.slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
