import assert from "node:assert/strict";
import test from "node:test";

import { POST as availabilityRoute } from "@/app/api/admin/[adminToken]/roster/availability/route";
import {
  AWAY_VOTE_MESSAGE,
  buildPublicSnapshot,
  buildSnapshot,
  castVote,
  createBracket,
} from "@/lib/workquiz/bracket";
import { ensureStore, readStore, updateStore, writeStore } from "@/lib/workquiz/store";

const roster = ["Gabe", "Alex", "Jordan", "Sam"];

async function liveTournament() {
  await ensureStore();
  await writeStore({ brackets: [] });
  const { bracket } = await createBracket({
    title: "Availability",
    seedingMode: "manual",
    // Two matchups in round one, so "finished voting" means two votes.
    entrants: ["A", "B", "C", "D"],
    rosterMembers: roster,
    startsAt: new Date(Date.now() - 60 * 1000).toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 6,
  });
  return bracket;
}

function memberId(bracket: Awaited<ReturnType<typeof liveTournament>>, name: string) {
  return bracket.rosterMembers.find((member) => member.name === name)!.id;
}

async function bind(publicToken: string, rosterMemberId: string) {
  const browserToken = `browser-${rosterMemberId}`;
  await updateStore((store) => {
    const bracket = store.brackets.find((entry) => entry.publicToken === publicToken)!;
    bracket.voterBindings ??= {};
    bracket.voterBindings[browserToken] = rosterMemberId;
    return store;
  });
  return browserToken;
}

async function voteAll(publicToken: string, browserToken: string) {
  await castVote({ publicToken, browserToken, matchupSlot: 1, side: "A" });
  return castVote({ publicToken, browserToken, matchupSlot: 2, side: "A" });
}

function setAway(bracketId: string, body: Record<string, unknown>) {
  return availabilityRoute(
    new Request(`https://example.test/api/admin/${bracketId}/roster/availability`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ adminToken: bracketId }) },
  );
}

async function current(bracketId: string) {
  return (await readStore()).brackets.find((entry) => entry.id === bracketId)!;
}

test("a player marked away can't vote until switched back on", async () => {
  const bracket = await liveTournament();
  const sam = memberId(bracket, "Sam");
  const browser = await bind(bracket.publicToken, sam);

  assert.equal((await setAway(bracket.id, { rosterMemberId: sam, away: true })).status, 200);
  await assert.rejects(
    castVote({ publicToken: bracket.publicToken, browserToken: browser, matchupSlot: 1, side: "A" }),
    (error: Error) => error.message === AWAY_VOTE_MESSAGE,
  );

  const publicView = buildPublicSnapshot(await current(bracket.id), { rosterMemberId: sam });
  assert.equal(publicView.selectedRosterMemberAway, true);
  assert.equal(publicView.rounds[0].matchups[0].voteState.canVote, false, "vote buttons are off for them");

  assert.equal((await setAway(bracket.id, { rosterMemberId: sam, away: false })).status, 200);
  await castVote({ publicToken: bracket.publicToken, browserToken: browser, matchupSlot: 1, side: "A" });
  assert.equal((await current(bracket.id)).rounds[0].matchups[0].votes.length, 1);
});

test("turnout counts only people who can vote, on the admin and public pages", async () => {
  const bracket = await liveTournament();
  await voteAll(bracket.publicToken, await bind(bracket.publicToken, memberId(bracket, "Gabe")));
  await setAway(bracket.id, { rosterMemberId: memberId(bracket, "Sam"), away: true });

  const stored = await current(bracket.id);
  const admin = buildSnapshot(stored);
  const publicView = buildPublicSnapshot(stored);
  assert.equal(admin.currentRoundUniqueVoters, 1);
  assert.equal(admin.eligiblePlayers, 3, "4 players, 1 away");
  assert.equal(publicView.eligiblePlayers, 3);
  assert.equal(admin.totalPlayers, 4, "the roster itself is unchanged");
  assert.equal(admin.currentRoundRosterStatuses.find((member) => member.name === "Sam")?.away, true);
  assert.deepEqual(
    publicView.currentRoundRosterStatuses.find((member) => member.name === "Sam"),
    { name: "Sam", hasVoted: false },
    "the public page never says who is away",
  );
});

test("someone marked away after voting still counts, and their votes stay", async () => {
  const bracket = await liveTournament();
  const alex = memberId(bracket, "Alex");
  await voteAll(bracket.publicToken, await bind(bracket.publicToken, alex));
  await setAway(bracket.id, { rosterMemberId: alex, away: true });

  const stored = await current(bracket.id);
  assert.equal(stored.rounds[0].matchups[0].votes.length, 1, "their vote is kept");
  const admin = buildSnapshot(stored);
  assert.equal(admin.eligiblePlayers, 4, "they voted this round, so they are counted");
  assert.equal(admin.currentRoundUniqueVoters, 1);
  assert.equal(buildPublicSnapshot(stored).eligiblePlayers, 4);
});

test("Everyone can vote switches every away player back on, once each", async () => {
  const bracket = await liveTournament();
  await setAway(bracket.id, { rosterMemberId: memberId(bracket, "Sam"), away: true });
  await setAway(bracket.id, { rosterMemberId: memberId(bracket, "Jordan"), away: true });
  assert.equal(buildSnapshot(await current(bracket.id)).eligiblePlayers, 2);

  assert.equal((await setAway(bracket.id, { everyone: true, away: false })).status, 200);
  const stored = await current(bracket.id);
  assert.equal(buildSnapshot(stored).eligiblePlayers, 4);
  assert.ok(stored.rosterMembers.every((member) => !member.away));
  const backEvents = (stored.voterEvents ?? []).filter((event) => event.type === "back");
  assert.equal(backEvents.length, 2, "only the two who were away are logged");
});

test("the availability route rejects bad requests", async () => {
  const bracket = await liveTournament();
  assert.equal((await setAway(bracket.id, { rosterMemberId: memberId(bracket, "Sam") })).status, 400, "no away flag");
  assert.equal((await setAway(bracket.id, { away: true })).status, 400, "nobody named");
  assert.equal((await setAway(bracket.id, { rosterMemberId: "nobody", away: true })).status, 400);
  assert.equal((await setAway(bracket.id, { rosterMemberId: 123, away: true })).status, 400, "id must be a string");
  const nullBody = await availabilityRoute(
    new Request("https://example.test/x", { method: "POST", body: "null" }),
    { params: Promise.resolve({ adminToken: bracket.id }) },
  );
  assert.equal(nullBody.status, 400, "a JSON null body is a 400, not a crash");
  const missing = await availabilityRoute(
    new Request("https://example.test/x", { method: "POST", body: JSON.stringify({ everyone: true, away: false }) }),
    { params: Promise.resolve({ adminToken: "not-a-tournament" }) },
  );
  assert.equal(missing.status, 404);
});
