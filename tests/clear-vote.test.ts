import assert from "node:assert/strict";
import test from "node:test";

import { advanceBracket, castVote, clearMatchupVote, createBracket } from "@/lib/workquiz/bracket";
import { ensureStore, readStore, updateStore, writeStore } from "@/lib/workquiz/store";

const roster = ["Gabe", "Alex", "Jordan", "Sam"];

async function resetStore() {
  await ensureStore();
  await writeStore({ brackets: [] });
}

async function liveBracketWithVotes() {
  await resetStore();
  const { bracket, adminToken } = await createBracket({
    title: "Clear Vote",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date(Date.now() - 60 * 1000).toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });
  const matchup = bracket.rounds[0].matchups[0];

  // Gabe and Alex vote Mars, Jordan votes Twix.
  for (const [index, side] of (["A", "A", "B"] as const).entries()) {
    const browserToken = `browser-${index}`;
    await updateStore((store) => {
      const mutable = store.brackets.find((entry) => entry.publicToken === bracket.publicToken)!;
      mutable.voterBindings = { ...mutable.voterBindings, [browserToken]: mutable.rosterMembers[index].id };
      return store;
    });
    await castVote({ publicToken: bracket.publicToken, browserToken, matchupSlot: matchup.slot, side });
  }

  return { bracket, adminToken, matchupId: matchup.id };
}

async function closeRoundOne(publicToken: string) {
  await updateStore((store) => {
    const mutable = store.brackets.find((entry) => entry.publicToken === publicToken)!;
    advanceBracket(mutable, new Date(Date.parse(mutable.rounds[0].endsAt) + 1000));
    return store;
  });
}

test("a vote can still be cleared while voting on the matchup is open", async () => {
  const { bracket, adminToken, matchupId } = await liveBracketWithVotes();

  const updated = await clearMatchupVote({ adminToken, matchupId, rosterMemberId: bracket.rosterMembers[0].id });
  assert.equal(updated.rounds[0].matchups[0].votes.length, 2);
});

test("votes in a decided matchup cannot be cleared, so the result stays consistent", async () => {
  const { bracket, adminToken, matchupId } = await liveBracketWithVotes();
  await closeRoundOne(bracket.publicToken);

  const before = (await readStore()).brackets[0];
  const decided = before.rounds[0].matchups[0];
  assert.equal(decided.status, "closed");
  const winner = decided.winnerEntrantId;
  assert.ok(winner, "round one has a winner");

  await assert.rejects(
    () => clearMatchupVote({ adminToken, matchupId, rosterMemberId: bracket.rosterMembers[0].id }),
    /already decided/i,
  );

  const after = (await readStore()).brackets[0].rounds[0].matchups[0];
  assert.equal(after.votes.length, 3, "no vote was removed");
  assert.equal(after.winnerEntrantId, winner, "the winner is unchanged");
});
