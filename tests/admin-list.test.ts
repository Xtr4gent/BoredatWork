import assert from "node:assert/strict";
import test from "node:test";

import { POST as logout } from "@/app/api/admin-logout/route";
import {
  ADMIN_SECTION_SLUGS,
  adminSectionFromPath,
  adminSectionFromSlug,
  adminTournamentStatus,
  adminWorkspacePath,
  type AdminSection,
} from "@/lib/workquiz/admin-sections";
import {
  createBracket,
  disableBracket,
  findBracketByAdminToken,
  listAdminTournaments,
  markBracketAsCurrentPublic,
  matchesAdminKey,
} from "@/lib/workquiz/bracket";
import { ensureStore, updateStore, writeStore } from "@/lib/workquiz/store";

const roster = ["Gabe", "Alex", "Jordan", "Sam"];

async function resetStore() {
  await ensureStore();
  await writeStore({ brackets: [] });
}

async function make(title: string, kind: "public" | "test" = "public") {
  return createBracket({
    title,
    kind,
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date(Date.now() - 60 * 1000).toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });
}

test("a tournament is found by its id or by its old secret admin token", async () => {
  await resetStore();
  const { bracket, adminToken } = await make("Keys");

  assert.equal(matchesAdminKey(bracket, bracket.id), true);
  assert.equal(matchesAdminKey(bracket, adminToken), true);
  assert.equal(matchesAdminKey(bracket, "someone-elses-key"), false);
  assert.equal((await findBracketByAdminToken(bracket.id))?.id, bracket.id);
  assert.equal((await findBracketByAdminToken(adminToken))?.id, bracket.id);
});

test("the Tournaments list shows every tournament with one status, active first", async () => {
  await resetStore();
  const running = await make("Running, not published");
  const onVoting = await make("On voting");
  await markBracketAsCurrentPublic(onVoting.adminToken);
  await make("A test", "test");
  const shutDown = await make("Shut down");
  const finished = await make("Finished");

  await updateStore((store) => {
    disableBracket(store.brackets.find((entry) => entry.id === shutDown.bracket.id)!);
    const done = store.brackets.find((entry) => entry.id === finished.bracket.id)!;
    const final = done.rounds[0].matchups[0];
    final.status = "closed";
    final.winnerEntrantId = final.entrantAId;
    done.rounds[0].status = "closed";
    done.status = "completed";
    return store;
  });

  const list = await listAdminTournaments();
  const byTitle = Object.fromEntries(list.map((entry) => [entry.title, entry]));

  assert.equal(list.length, 5);
  assert.equal(byTitle["On voting"].status, "on-voting");
  assert.equal(byTitle["On voting"].isOnVoting, true);
  assert.equal(byTitle["Running, not published"].status, "running");
  assert.equal(byTitle["A test"].status, "test");
  assert.equal(byTitle["Shut down"].status, "shut-down");
  assert.equal(byTitle["Finished"].status, "finished");
  assert.equal(byTitle["Finished"].championName, "Mars");
  assert.equal(byTitle["Running, not published"].playerCount, 4);
  assert.deepEqual(
    list.map((entry) => entry.status),
    ["on-voting", "running", "test", "finished", "shut-down"],
  );
  assert.equal(running.bracket.id, byTitle["Running, not published"].id);
});

test("the workspace and the list agree on status", () => {
  assert.equal(adminTournamentStatus({ status: "live", isCurrentPublic: true }), "on-voting");
  assert.equal(adminTournamentStatus({ status: "live", isCurrentPublic: false }), "running");
  assert.equal(adminTournamentStatus({ status: "completed", isCurrentPublic: true }), "finished");
  assert.equal(adminTournamentStatus({ status: "disabled", kind: "test" }), "shut-down");
  assert.equal(adminTournamentStatus({ status: "live", kind: "test", isCurrentPublic: false }), "test");
});

test("workspace sections round-trip through the URL; unknown slugs open Overview", () => {
  for (const section of Object.keys(ADMIN_SECTION_SLUGS) as AdminSection[]) {
    const path = adminWorkspacePath("abc123", section);
    const slug = path.split("/").filter(Boolean)[3];
    assert.equal(adminSectionFromSlug(slug), section);
  }
  assert.equal(adminWorkspacePath("abc123"), "/admin/t/abc123/overview");
  assert.equal(adminSectionFromSlug("not-a-section"), "live");
  assert.equal(adminSectionFromSlug(undefined), "live");
});

test("sections merged into Settings keep their old links working", () => {
  for (const legacy of ["rounds", "links", "danger"]) {
    assert.equal(adminSectionFromSlug(legacy), "settings", legacy);
  }
  assert.equal(adminWorkspacePath("abc123", "settings"), "/admin/t/abc123/settings");
});

test("Back/Forward read the section from the address the same way the page builds it", () => {
  for (const section of Object.keys(ADMIN_SECTION_SLUGS) as AdminSection[]) {
    assert.equal(adminSectionFromPath(adminWorkspacePath("abc123", section)), section);
  }
  assert.equal(adminSectionFromPath("/admin/t/abc123"), "live", "no section in the address opens Overview");
  assert.equal(adminSectionFromPath("/admin/t/abc123/players/"), "roster", "a trailing slash is fine");
  assert.equal(adminSectionFromPath("/admin/t/an%20id/vote-watch"), "watch", "encoded ids do not shift the slug");
  assert.equal(adminSectionFromPath("/admin"), "live");
});

test("log out clears the admin session cookie and sends you to the login page", async () => {
  const response = await logout();

  assert.equal(response.status, 303);
  // Relative, so the browser stays on the host it is using (not the server's bind address).
  assert.equal(response.headers.get("location"), "/admin-login");
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /workquiz_admin_session=;/);
  assert.match(cookie, /Max-Age=0/i);
});
