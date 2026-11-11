import { buildBackupBody, verifyBackupRequest } from "@/lib/workquiz/backup-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function plain(status: number, message: string) {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
  });
}

/**
 * GET /api/backup/export: the same file as the admin's Download backup
 * button, for the nightly pull. Signed requests only (see
 * lib/workquiz/backup-export.ts). It sits outside /api/admin on purpose:
 * there is no admin session here, so the proxy must not ask for one.
 *
 * `x-backup-sha256` is the hash of the body, so the caller can tell a
 * complete download from a cut-off one.
 */
export async function GET(request: Request) {
  const check = verifyBackupRequest({
    timestamp: request.headers.get("x-backup-timestamp"),
    signature: request.headers.get("x-backup-signature"),
  });
  if (!check.ok) {
    // Until a public key is configured the address does not exist.
    return check.reason === "not-configured" ? plain(404, "Not found") : plain(401, "Unauthorized");
  }

  try {
    const backup = await buildBackupBody();
    return new Response(backup.body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="boredatwork-backup-${backup.exportedAt.slice(0, 10)}.json"`,
        "Cache-Control": "no-store",
        "x-backup-sha256": backup.sha256,
        "x-backup-tournaments": String(backup.tournaments),
      },
    });
  } catch (error) {
    console.error("[BACKUP_EXPORT] failed", error);
    return plain(500, "Backup export failed");
  }
}
