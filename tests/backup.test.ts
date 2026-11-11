import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { GET as backupRoute } from "@/app/api/admin/backup/route";
import { ADMIN_AUTH, buildAdminSessionValue } from "@/lib/workquiz/admin-auth";
import { clearAdminSessionsCache, revokeAdminSessions } from "@/lib/workquiz/admin-sessions";
import { castVote, createBracket } from "@/lib/workquiz/bracket";
import { namesForClipboard } from "@/lib/workquiz/copy-names";
import { ensureStore, readStore, updateStore, writeStore } from "@/lib/workquiz/store";
import { config as proxyConfig } from "@/proxy";

const credentials = { WORKQUIZ_ADMIN_USERNAME: "admin", WORKQUIZ_ADMIN_PASSWORD: "swordfish" };

async function withEnv<T>(values: Record<string, string>, run: () => Promise<T>) {
  const env = process.env as Record<string, string | undefined>;
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, env[key]]));
  Object.assign(env, values);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    }
  }
}

function backupRequest(session?: string | null) {
  return new NextRequest("https://example.test/api/admin/backup", {
    headers: session ? { cookie: `${ADMIN_AUTH.sessionCookie}=${session}` } : {},
  });
}

async function seededStore() {
  await ensureStore();
  await writeStore({ brackets: [] });
  clearAdminSessionsCache();
  const { bracket } = await createBracket({
    title: "Backup me",
    seedingMode: "manual",
    entrants: ["A", "B", "C", "D"],
    rosterMembers: ["Gabe", "Alex"],
    startsAt: new Date(Date.now() - 60 * 1000).toISOString(),
    totalPlayers: 2,
    roundDurationHours: 6,
  });
  await updateStore((store) => {
    store.brackets[0].voterBindings = { "browser-gabe": store.brackets[0].rosterMembers[0].id };
    return store;
  });
  await castVote({ publicToken: bracket.publicToken, browserToken: "browser-gabe", matchupSlot: 1, side: "A" });
}

test("the backup is refused without an admin session", async () => {
  await seededStore();
  await withEnv(credentials, async () => {
    for (const session of [null, "not-a-session", "123.abc"]) {
      const response = await backupRoute(backupRequest(session));
      assert.equal(response.status, 401);
      assert.equal((await response.text()).includes("Backup me"), false);
    }
  });
});

test("a signed-in admin downloads the whole store as a dated file", async () => {
  await seededStore();
  await withEnv(credentials, async () => {
    const session = (await buildAdminSessionValue(Date.now()))!;
    const response = await backupRoute(backupRequest(session));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(
      response.headers.get("content-disposition") ?? "",
      /^attachment; filename="boredatwork-backup-\d{4}-\d{2}-\d{2}\.json"$/,
    );

    const backup = (await response.json()) as { kind: string; version: number; exportedAt: string; store: unknown };
    assert.equal(backup.kind, "boredatwork-backup");
    assert.equal(backup.version, 1);
    assert.ok(Math.abs(Date.parse(backup.exportedAt) - Date.now()) < 60 * 1000);
    // Byte for byte what is saved: restoring `store` puts everything back.
    assert.deepEqual(backup.store, JSON.parse(JSON.stringify(await readStore())));
    assert.equal(JSON.stringify(backup.store).includes("browser-gabe"), true);
  });
});

test("a session ended by Sign out everywhere can't download the backup", async () => {
  await seededStore();
  await withEnv(credentials, async () => {
    const session = (await buildAdminSessionValue(Date.now() - 60 * 1000))!;
    assert.equal((await backupRoute(backupRequest(session))).status, 200);

    await revokeAdminSessions(new Date());
    clearAdminSessionsCache();
    assert.equal((await backupRoute(backupRequest(session))).status, 401);
  });
  await writeStore({ brackets: [] });
  clearAdminSessionsCache();
});

test("the proxy also guards the backup address", () => {
  assert.ok(proxyConfig.matcher.includes("/api/admin/:path*"));
});

test("names are copied as one comma-separated line", () => {
  assert.equal(namesForClipboard(["Sam", " Casey ", "", "Drew"]), "Sam, Casey, Drew");
  assert.equal(namesForClipboard(["Sam"]), "Sam");
  assert.equal(namesForClipboard([]), "");
});
