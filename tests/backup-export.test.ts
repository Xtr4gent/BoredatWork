import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

// @ts-expect-error Next bundles this copy of path-to-regexp without type declarations.
import { pathToRegexp as untypedPathToRegexp } from "next/dist/compiled/path-to-regexp";

import { GET as exportRoute } from "@/app/api/backup/export/route";
import { BACKUP_SIGNED_PREFIX, verifyBackupRequest } from "@/lib/workquiz/backup-export";
import { createBracket } from "@/lib/workquiz/bracket";
import { ensureStore, readStore, writeStore } from "@/lib/workquiz/store";
import { config as proxyConfig } from "@/proxy";

const pathToRegexp = untypedPathToRegexp as (pattern: string) => RegExp;

function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKey,
    // The same form the server setting takes: base64 of the SPKI DER body.
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

function sign(privateKey: crypto.KeyObject, timestamp: string, prefix = BACKUP_SIGNED_PREFIX) {
  return crypto.sign(null, Buffer.from(`${prefix}${timestamp}`, "utf8"), privateKey).toString("base64");
}

function nowSeconds(offset = 0) {
  return String(Math.floor(Date.now() / 1000) + offset);
}

function exportRequest(headers: Record<string, string> = {}) {
  return new Request("https://example.test/api/backup/export", { headers });
}

async function withPublicKey<T>(value: string | undefined, run: () => Promise<T>) {
  const env = process.env as Record<string, string | undefined>;
  const previous = env.BACKUP_PUBLIC_KEY;
  if (value === undefined) {
    delete env.BACKUP_PUBLIC_KEY;
  } else {
    env.BACKUP_PUBLIC_KEY = value;
  }
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete env.BACKUP_PUBLIC_KEY;
    } else {
      env.BACKUP_PUBLIC_KEY = previous;
    }
  }
}

async function seededStore() {
  await ensureStore();
  await writeStore({ brackets: [] });
  await createBracket({
    title: "Export me",
    seedingMode: "manual",
    entrants: ["A", "B", "C", "D"],
    rosterMembers: ["Gabe", "Alex"],
    startsAt: new Date(Date.now() - 60 * 1000).toISOString(),
    totalPlayers: 2,
    roundDurationHours: 6,
  });
}

test("the export address doesn't exist until a public key is set", async () => {
  await seededStore();
  const { privateKey } = keyPair();
  const timestamp = nowSeconds();
  for (const configured of [undefined, "", "not base64 at all", "AAAA"]) {
    await withPublicKey(configured, async () => {
      const response = await exportRoute(
        exportRequest({ "x-backup-timestamp": timestamp, "x-backup-signature": sign(privateKey, timestamp) }),
      );
      assert.equal(response.status, 404);
      assert.equal((await response.text()).includes("Export me"), false);
    });
  }
});

test("a correctly signed request gets the whole store and its hash", async () => {
  await seededStore();
  const { privateKey, publicKey } = keyPair();
  await withPublicKey(publicKey, async () => {
    const timestamp = nowSeconds();
    const response = await exportRoute(
      exportRequest({ "x-backup-timestamp": timestamp, "x-backup-signature": sign(privateKey, timestamp) }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-backup-tournaments"), "1");

    const body = await response.text();
    assert.equal(
      response.headers.get("x-backup-sha256"),
      crypto.createHash("sha256").update(body).digest("hex"),
    );
    const backup = JSON.parse(body) as { kind: string; version: number; store: unknown };
    assert.equal(backup.kind, "boredatwork-backup");
    assert.equal(backup.version, 1);
    assert.deepEqual(backup.store, JSON.parse(JSON.stringify(await readStore())));
  });
});

test("unsigned, wrongly signed and stale requests are refused without any data", async () => {
  await seededStore();
  const { privateKey, publicKey } = keyPair();
  const stranger = keyPair().privateKey;
  await withPublicKey(publicKey, async () => {
    const fresh = nowSeconds();
    const stale = nowSeconds(-6 * 60);
    const future = nowSeconds(6 * 60);
    const refused: Array<Record<string, string>> = [
      {},
      { "x-backup-timestamp": fresh },
      { "x-backup-signature": sign(privateKey, fresh) },
      // Signed by a different key.
      { "x-backup-timestamp": fresh, "x-backup-signature": sign(stranger, fresh) },
      // A real signature, but for a different moment than the one claimed.
      { "x-backup-timestamp": fresh, "x-backup-signature": sign(privateKey, stale) },
      // Correctly signed, but too old or too far ahead.
      { "x-backup-timestamp": stale, "x-backup-signature": sign(privateKey, stale) },
      { "x-backup-timestamp": future, "x-backup-signature": sign(privateKey, future) },
      // Signed for another app's export.
      { "x-backup-timestamp": fresh, "x-backup-signature": sign(privateKey, fresh, "alereads-backup-export:") },
      { "x-backup-timestamp": "not-a-number", "x-backup-signature": sign(privateKey, fresh) },
      { "x-backup-timestamp": fresh, "x-backup-signature": "short" },
    ];

    for (const headers of refused) {
      const response = await exportRoute(exportRequest(headers));
      assert.equal(response.status, 401, JSON.stringify(Object.keys(headers)));
      assert.equal((await response.text()).includes("Export me"), false);
    }
  });
});

test("the signature window is five minutes either side", () => {
  const { privateKey, publicKey } = keyPair();
  const now = new Date("2026-11-11T12:00:00Z");
  const at = (offsetSeconds: number) => {
    const timestamp = String(Math.floor(now.getTime() / 1000) + offsetSeconds);
    return verifyBackupRequest({ timestamp, signature: sign(privateKey, timestamp) }, { publicKey, now });
  };

  assert.deepEqual(at(0), { ok: true });
  assert.deepEqual(at(-299), { ok: true });
  assert.deepEqual(at(299), { ok: true });
  assert.deepEqual(at(-301), { ok: false, reason: "expired" });
  assert.deepEqual(at(301), { ok: false, reason: "expired" });
});

test("only an Ed25519 key is accepted as the public key", () => {
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const timestamp = nowSeconds();
  const check = verifyBackupRequest(
    { timestamp, signature: Buffer.alloc(64).toString("base64") },
    { publicKey: rsa.publicKey.export({ format: "der", type: "spki" }).toString("base64") },
  );
  assert.deepEqual(check, { ok: false, reason: "not-configured" });
});

test("the export address is outside the admin sign-in wall", async () => {
  // It has no admin session; if the proxy matched it, the nightly pull would
  // be sent to the sign-in page. Its own signature check is the lock.
  // Checked with the same matcher Next compiles the rules with, so a broad
  // rule such as "/api/:path*" is caught too.
  const matched = (path: string) => proxyConfig.matcher.some((pattern) => pathToRegexp(pattern).test(path));

  assert.equal(matched("/api/backup/export"), false);
  // The check itself works: these are behind the wall.
  assert.equal(matched("/api/admin/backup"), true);
  assert.equal(matched("/admin"), true);
  assert.equal(pathToRegexp("/api/:path*").test("/api/backup/export"), true);

  await writeStore({ brackets: [] });
});
