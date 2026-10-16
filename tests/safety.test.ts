import assert from "node:assert/strict";
import test from "node:test";

import { POST as restartRoute } from "@/app/api/admin/[adminToken]/restart/route";
import { POST as shutdownRoute } from "@/app/api/admin/[adminToken]/shutdown/route";
import { POST as undoRoute } from "@/app/api/admin/[adminToken]/undo/route";
import {
  buildAdminSessionValue,
  hasValidAdminSessionValue,
  resetLoginFailures,
  signInAdmin,
} from "@/lib/workquiz/admin-auth";
import { clearAdminSessionsCache, getAdminSessionsValidAfter, revokeAdminSessions } from "@/lib/workquiz/admin-sessions";
import { createBracket, markBracketAsCurrentPublic, restartBracket } from "@/lib/workquiz/bracket";
import { readSecret } from "@/lib/workquiz/secrets";
import { ensureStore, readStore, updateStore, writeStore } from "@/lib/workquiz/store";

const roster = ["Gabe", "Alex", "Jordan", "Sam"];
const DAY = 24 * 60 * 60 * 1000;

async function resetStore() {
  await ensureStore();
  await writeStore({ brackets: [] });
}

async function makeTournament(title = "Safety") {
  const created = await createBracket({
    title,
    seedingMode: "manual",
    entrants: ["A", "B", "C", "D"],
    rosterMembers: roster,
    startsAt: new Date(Date.now() - 60 * 1000).toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 6,
  });
  return created.bracket;
}

function adminPost(route: typeof restartRoute, bracketId: string) {
  return route(new Request(`https://example.test/api/admin/${bracketId}`, { method: "POST" }), {
    params: Promise.resolve({ adminToken: bracketId }),
  });
}

async function stored(bracketId: string) {
  return (await readStore()).brackets.find((entry) => entry.id === bracketId)!;
}

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T> | T) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const env = process.env as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

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

// ----------------------------------------------------------- restart / undo

test("a finished public tournament cannot be restarted, so its champion survives", async () => {
  await resetStore();
  const bracket = await makeTournament();
  bracket.status = "completed";

  assert.throws(() => restartBracket(bracket), /finished/i);
  assert.equal(bracket.status, "completed");
});

test("the restart route refuses a finished tournament and keeps no undo copy", async () => {
  await resetStore();
  const bracket = await makeTournament();
  await updateStore((store) => {
    store.brackets.find((entry) => entry.id === bracket.id)!.status = "completed";
    return store;
  });

  const response = await adminPost(restartRoute, bracket.id);
  assert.equal(response.status, 400);
  const after = await stored(bracket.id);
  assert.equal(after.status, "completed");
  assert.equal(after.undo, undefined);
});

test("undo puts a restarted tournament back the way it was", async () => {
  await resetStore();
  const bracket = await makeTournament();
  await updateStore((store) => {
    store.brackets.find((entry) => entry.id === bracket.id)!.voterBindings = { "browser-1": bracket.rosterMembers[0].id };
    return store;
  });
  const before = await stored(bracket.id);

  const restarted = await adminPost(restartRoute, bracket.id);
  assert.equal(restarted.status, 200);
  const snapshot = await restarted.json();
  assert.equal(snapshot.undo.action, "restart");
  assert.deepEqual((await stored(bracket.id)).voterBindings, {}, "restart cleared the names");

  const undone = await adminPost(undoRoute, bracket.id);
  assert.equal(undone.status, 200);
  const after = await stored(bracket.id);
  assert.deepEqual(after.voterBindings, before.voterBindings, "names are back");
  assert.deepEqual(after.rounds, before.rounds, "the schedule is back");
  assert.equal(after.undo, undefined, "an undo can only be used once");
  assert.equal(after.voterEvents?.at(-1)?.type, "undo");

  const again = await adminPost(undoRoute, bracket.id);
  assert.equal(again.status, 400);
});

test("undo brings a shut-down tournament back, and back onto /voting", async () => {
  await resetStore();
  const bracket = await makeTournament();
  await markBracketAsCurrentPublic(bracket.id);

  assert.equal((await adminPost(shutdownRoute, bracket.id)).status, 200);
  assert.equal((await stored(bracket.id)).status, "disabled");
  assert.equal((await stored(bracket.id)).isCurrentPublic, false);

  assert.equal((await adminPost(undoRoute, bracket.id)).status, 200);
  const after = await stored(bracket.id);
  assert.equal(after.status, "live");
  assert.equal(after.isCurrentPublic, true);
});

test("undoing a shut down leaves /voting alone if another tournament took it meanwhile", async () => {
  await resetStore();
  const first = await makeTournament("First");
  await markBracketAsCurrentPublic(first.id);
  await adminPost(shutdownRoute, first.id);
  const second = await makeTournament("Second");
  await markBracketAsCurrentPublic(second.id);

  const response = await adminPost(undoRoute, first.id);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).keptOffVoting, true);
  assert.equal((await stored(first.id)).status, "live");
  assert.equal((await stored(first.id)).isCurrentPublic, false);
  assert.equal((await stored(second.id)).isCurrentPublic, true);
});

test("shutting down twice is refused, so the useful undo copy is kept", async () => {
  await resetStore();
  const bracket = await makeTournament();
  await adminPost(shutdownRoute, bracket.id);
  const firstUndo = (await stored(bracket.id)).undo;

  assert.equal((await adminPost(shutdownRoute, bracket.id)).status, 400);
  assert.deepEqual((await stored(bracket.id)).undo, firstUndo);
});

// --------------------------------------------------------------- secrets

test("production refuses to run on the built-in development secrets", async () => {
  await withEnv({ NODE_ENV: "production", WORKQUIZ_SECRET: undefined, WORKQUIZ_CRON_SECRET: undefined }, () => {
    assert.throws(() => readSecret("WORKQUIZ_SECRET"), /must be set in production/);
    assert.throws(() => readSecret("WORKQUIZ_CRON_SECRET"), /must be set in production/);
  });
  await withEnv({ NODE_ENV: "production", WORKQUIZ_SECRET: "real-secret" }, () => {
    assert.equal(readSecret("WORKQUIZ_SECRET"), "real-secret");
  });
  await withEnv({ NODE_ENV: undefined, WORKQUIZ_SECRET: undefined }, () => {
    assert.equal(readSecret("WORKQUIZ_SECRET"), "dev-secret");
  });
});

// -------------------------------------------------------------- sessions

const credentials = { WORKQUIZ_ADMIN_USERNAME: "admin", WORKQUIZ_ADMIN_PASSWORD: "swordfish" };

test("an admin session expires after 30 days, enforced by the server", async () => {
  await withEnv(credentials, async () => {
    const issuedAt = Date.parse("2026-10-01T12:00:00Z");
    const session = await buildAdminSessionValue(issuedAt);

    assert.equal(await hasValidAdminSessionValue(session, { now: issuedAt + DAY }), true);
    assert.equal(await hasValidAdminSessionValue(session, { now: issuedAt + 31 * DAY }), false, "expired");
    assert.equal(await hasValidAdminSessionValue(session, { now: issuedAt - DAY }), false, "issued in the future");
  });
});

test("a session cookie can't be edited or carried over from the old format", async () => {
  await withEnv(credentials, async () => {
    const issuedAt = Date.now();
    const session = (await buildAdminSessionValue(issuedAt))!;
    const [, signature] = session.split(".");

    assert.equal(await hasValidAdminSessionValue(`${issuedAt + DAY}.${signature}`), false, "moved issue time");
    assert.equal(await hasValidAdminSessionValue(signature), false, "old cookie format");
    assert.equal(await hasValidAdminSessionValue("not-the-right-cookie"), false);
  });
});

test("changing the password ends every session", async () => {
  const session = await withEnv(credentials, () => buildAdminSessionValue(Date.now()));
  await withEnv({ ...credentials, WORKQUIZ_ADMIN_PASSWORD: "new-password" }, async () => {
    assert.equal(await hasValidAdminSessionValue(session), false);
  });
});

test("sign out everywhere ends sessions issued before it, not after", async () => {
  await resetStore();
  clearAdminSessionsCache();
  await withEnv(credentials, async () => {
    const signOutAt = Date.now();
    const older = await buildAdminSessionValue(signOutAt - 1000);
    const newer = await buildAdminSessionValue(signOutAt + 1000);

    await revokeAdminSessions(new Date(signOutAt));
    clearAdminSessionsCache();
    const validAfter = await getAdminSessionsValidAfter();
    assert.equal(validAfter, signOutAt, "read back from the store, not just the cache");

    assert.equal(await hasValidAdminSessionValue(older, { validAfter }), false);
    assert.equal(await hasValidAdminSessionValue(newer, { validAfter, now: signOutAt + 2000 }), true);
  });
  clearAdminSessionsCache();
});

// ----------------------------------------------------------- sign-in limit

test("five wrong passwords from one address lock that address out", async () => {
  resetLoginFailures();
  await withEnv(credentials, async () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await signInAdmin("admin", "wrong", { clientIp: "1.2.3.4", now, failureDelayMs: 0 });
      assert.deepEqual(result, { ok: false, reason: "invalid" });
    }

    // Even the right password is refused while locked, so guessing gains nothing.
    assert.deepEqual(await signInAdmin("admin", "swordfish", { clientIp: "1.2.3.4", now, failureDelayMs: 0 }), {
      ok: false,
      reason: "locked",
    });
    // Another address is not affected.
    assert.deepEqual(await signInAdmin("admin", "wrong", { clientIp: "5.6.7.8", now, failureDelayMs: 0 }), {
      ok: false,
      reason: "invalid",
    });
    // The lock lifts after 15 minutes.
    assert.deepEqual(
      await signInAdmin("admin", "wrong", { clientIp: "1.2.3.4", now: now + 16 * 60 * 1000, failureDelayMs: 0 }),
      { ok: false, reason: "invalid" },
    );
  });
  resetLoginFailures();
});

test("guessing from many addresses at once hits an overall cap", async () => {
  resetLoginFailures();
  await withEnv(credentials, async () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await signInAdmin("admin", "wrong", { clientIp: `10.0.0.${attempt}`, now, failureDelayMs: 0 });
    }

    assert.deepEqual(await signInAdmin("admin", "wrong", { clientIp: "10.0.1.1", now, failureDelayMs: 0 }), {
      ok: false,
      reason: "locked",
    });
  });
  resetLoginFailures();
});
