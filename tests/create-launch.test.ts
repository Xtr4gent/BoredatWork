import assert from "node:assert/strict";
import test from "node:test";

import { POST as createTournament } from "@/app/api/brackets/route";
import { createBracket, markBracketAsCurrentPublic } from "@/lib/workquiz/bracket";
import { ensureStore, readStore, writeStore } from "@/lib/workquiz/store";

const roster = ["Gabe", "Alex", "Jordan", "Sam"];

async function resetStore() {
  await ensureStore();
  await writeStore({ brackets: [] });
}

function request(body: Record<string, unknown>) {
  return new Request("https://example.test/api/brackets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Launch Test",
      entrants: ["Mars", "Twix", "Kitkat", "Aero"],
      rosterMembers: roster,
      seedingMode: "manual",
      startsAt: new Date(Date.now() - 60 * 1000).toISOString(),
      endsAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      ...body,
    }),
  });
}

test("Launch puts the new tournament on /voting, replacing the one that was there", async () => {
  await resetStore();
  const previous = await createBracket({
    title: "Old tournament",
    seedingMode: "manual",
    entrants: ["A", "B"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });
  await markBracketAsCurrentPublic(previous.adminToken);

  const response = await createTournament(request({ kind: "public", publish: true }));
  assert.equal(response.status, 200);
  const { adminUrl } = (await response.json()) as { adminUrl: string };

  const brackets = (await readStore()).brackets;
  const launched = brackets.find((entry) => entry.title === "Launch Test")!;
  assert.equal(launched.isCurrentPublic, true);
  assert.equal(brackets.find((entry) => entry.title === "Old tournament")!.isCurrentPublic, false);
  assert.equal(adminUrl, `/admin/t/${launched.id}/overview`);
  assert.equal(launched.scheduleKind, "daily");
});

test("a test tournament never goes on /voting, even if asked to publish", async () => {
  await resetStore();
  const response = await createTournament(request({ kind: "test", publish: true }));
  assert.equal(response.status, 200);

  const [created] = (await readStore()).brackets;
  assert.equal(created.kind, "test");
  assert.equal(created.isCurrentPublic, false);
});

test("creating without publish leaves /voting alone", async () => {
  await resetStore();
  const response = await createTournament(request({ kind: "public" }));
  assert.equal(response.status, 200);

  const [created] = (await readStore()).brackets;
  assert.equal(created.isCurrentPublic, false);
});
