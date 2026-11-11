import crypto from "node:crypto";

import { readStore } from "@/lib/workquiz/store";

/**
 * The backup file: everything the app has saved, as one JSON document.
 * `store` is exactly what the database row holds, so restoring means writing
 * it back. Used by the admin's Download backup button and by the nightly
 * pull.
 */
export async function buildBackupBody() {
  const store = await readStore();
  const exportedAt = new Date().toISOString();
  const body = JSON.stringify({ kind: "boredatwork-backup", version: 1, exportedAt, store });
  return {
    body,
    exportedAt,
    tournaments: store.brackets.length,
    sha256: crypto.createHash("sha256").update(body).digest("hex"),
  };
}

/**
 * The nightly pull has no admin session, so it signs its request instead.
 *
 * The caller signs "boredatwork-backup-export:UNIXSECONDS" with an Ed25519
 * private key that lives only on the backup server. This app holds just the
 * PUBLIC key (BACKUP_PUBLIC_KEY), so nothing in the app's settings can be
 * used to ask for a backup, and there is no shared secret to leak. A
 * signature is accepted for five minutes either side of the server clock.
 */
export const BACKUP_SIGNED_PREFIX = "boredatwork-backup-export:";
export const BACKUP_MAX_CLOCK_SKEW_SECONDS = 5 * 60;

export type BackupRequestCheck =
  | { ok: true }
  | { ok: false; reason: "not-configured" | "malformed" | "expired" | "bad-signature" };

/**
 * BACKUP_PUBLIC_KEY is the base64 body of an Ed25519 SPKI public key: what
 * `openssl pkey -pubout -outform DER | base64 -w0` prints.
 */
function loadPublicKey(raw: string | undefined): crypto.KeyObject | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }

  try {
    const key = crypto.createPublicKey({ key: Buffer.from(value, "base64"), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

export function verifyBackupRequest(
  input: { timestamp: string | null; signature: string | null },
  options: { publicKey?: string; now?: Date } = {},
): BackupRequestCheck {
  const key = loadPublicKey(options.publicKey ?? process.env.BACKUP_PUBLIC_KEY);
  if (!key) {
    return { ok: false, reason: "not-configured" };
  }

  const { timestamp, signature } = input;
  if (!timestamp || !signature || !/^\d{9,12}$/.test(timestamp)) {
    return { ok: false, reason: "malformed" };
  }

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > BACKUP_MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: "expired" };
  }

  const signatureBytes = Buffer.from(signature, "base64");
  if (signatureBytes.length !== 64) {
    return { ok: false, reason: "bad-signature" };
  }

  const message = Buffer.from(`${BACKUP_SIGNED_PREFIX}${timestamp}`, "utf8");
  try {
    return crypto.verify(null, message, key, signatureBytes) ? { ok: true } : { ok: false, reason: "bad-signature" };
  } catch {
    return { ok: false, reason: "bad-signature" };
  }
}
