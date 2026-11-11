import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceBracket,
  advanceReadyBrackets,
  buildPublicSnapshot,
  buildSnapshot,
  createBracket,
} from "@/lib/workquiz/bracket";
import { subscribe } from "@/lib/workquiz/realtime";
import { ensureStore, readStore, updateStore, writeStore } from "@/lib/workquiz/store";
import type { BracketRecord } from "@/lib/workquiz/types";

const HOUR = 60 * 60 * 1000;
const roster = ["Gabe", "Alex", "Jordan", "Sam", "Riley"];

/** Four contenders, so round one has two matchups; it started a minute ago. */
async function liveTournament() {
  await ensureStore();
  await writeStore({ brackets: [] });
  const { bracket } = await createBracket({
    title: "Missed votes",
    seedingMode: "manual",
    entrants: ["A", "B", "C", "D"],
    rosterMembers: roster,
    startsAt: new Date(Date.now() - 60 * 1000).toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 6,
  });
  return bracket;
}

function memberId(bracket: BracketRecord, name: string) {
  return bracket.rosterMembers.find((member) => member.name === name)!.id;
}

/** Casts round-one votes directly: `picks` is the side per matchup slot, e.g. "AB", "A", "". */
function vote(bracket: BracketRecord, name: string, picks: string) {
  const round = bracket.rounds[0];
  [...picks].forEach((side, index) => {
    const matchup = round.matchups[index];
    matchup.votes.push({
      id: `vote-${name}-${index}`,
      rosterMemberId: memberId(bracket, name),
      entrantId: side === "A" ? matchup.entrantAId! : matchup.entrantBId!,
      createdAt: new Date().toISOString(),
    });
  });
}

async function mutate(change: (bracket: BracketRecord) => void) {
  const store = await updateStore((current) => {
    change(current.brackets[0]);
    return current;
  });
  return store.brackets[0];
}

function afterRoundOne(bracket: BracketRecord) {
  return new Date(Date.parse(bracket.rounds[0].endsAt) + 1000);
}

test("a tournament waiting on a tiebreak is written once, not on every tick", async () => {
  const created = await liveTournament();
  // Matchup 1 ends 1-1 (a tie); matchup 2 has a clear winner.
  await mutate((bracket) => {
    vote(bracket, "Gabe", "AA");
    vote(bracket, "Alex", "BA");
  });

  let pushes = 0;
  const unsubscribe = subscribe(created.publicToken, () => {
    pushes += 1;
  });

  try {
    const firstTick = afterRoundOne(created);
    await advanceReadyBrackets(firstTick);
    const afterFirst = JSON.stringify(await readStore());
    assert.equal((await readStore()).brackets[0].rounds[0].status, "tiebreaker");
    assert.equal(pushes, 1);

    for (let minute = 1; minute <= 3; minute += 1) {
      await advanceReadyBrackets(new Date(firstTick.getTime() + minute * 60 * 1000));
    }

    assert.equal(JSON.stringify(await readStore()), afterFirst, "later ticks must not rewrite the store");
    assert.equal(pushes, 1, "later ticks must not tell open pages to refresh");
  } finally {
    unsubscribe();
  }
});

test("advancing a settled tournament again changes nothing", async () => {
  const created = await liveTournament();
  await mutate((bracket) => {
    vote(bracket, "Gabe", "AA");
    vote(bracket, "Alex", "AA");
    vote(bracket, "Jordan", "BB");
  });

  const moment = afterRoundOne(created);
  const bracket = structuredClone((await readStore()).brackets[0]);
  advanceBracket(bracket, moment);
  const once = JSON.stringify(bracket);
  advanceBracket(bracket, new Date(moment.getTime() + 60 * 1000));
  assert.equal(JSON.stringify(bracket), once);
});

test("lists who could vote in a finished round and didn't finish", async () => {
  const created = await liveTournament();
  await mutate((bracket) => {
    vote(bracket, "Gabe", "AA");
    vote(bracket, "Alex", "AA");
    vote(bracket, "Jordan", "A"); // one of two
    // Sam: nothing. Riley: nothing, but away.
    bracket.rosterMembers.find((member) => member.name === "Riley")!.away = true;
  });

  await advanceReadyBrackets(afterRoundOne(created));
  const snapshot = buildSnapshot((await readStore()).brackets[0], { includeAdminUrl: true });

  assert.equal(snapshot.missedVotes?.length, 1);
  const round = snapshot.missedVotes![0];
  assert.equal(round.roundNumber, 1);
  assert.equal(round.awayRecorded, true);
  assert.equal(round.couldVote, 4);
  assert.equal(round.awayCount, 1);
  // Nobody who voted nothing first, then partial voters.
  assert.deepEqual(
    round.missed.map((member) => [member.name, member.votesCast, member.votesPossible]),
    [
      ["Sam", 0, 2],
      ["Jordan", 1, 2],
    ],
  );
});

test("away is judged as it was when the round closed, not as it is now", async () => {
  const created = await liveTournament();
  await mutate((bracket) => {
    vote(bracket, "Gabe", "AA");
    vote(bracket, "Alex", "AA");
    vote(bracket, "Jordan", "AA");
    bracket.rosterMembers.find((member) => member.name === "Riley")!.away = true;
  });
  await advanceReadyBrackets(afterRoundOne(created));

  // Next day: Riley is back, Sam is away. Round one must not change its mind.
  const later = await mutate((bracket) => {
    bracket.rosterMembers.find((member) => member.name === "Riley")!.away = false;
    bracket.rosterMembers.find((member) => member.name === "Sam")!.away = true;
  });

  const round = buildSnapshot(later, { includeAdminUrl: true }).missedVotes![0];
  assert.deepEqual(
    round.missed.map((member) => member.name),
    ["Sam"],
  );
  assert.equal(round.awayCount, 1);
});

test("someone away who still finished voting counts as having voted", async () => {
  const created = await liveTournament();
  await mutate((bracket) => {
    for (const name of roster) {
      vote(bracket, name, "AA");
    }
    bracket.rosterMembers.find((member) => member.name === "Riley")!.away = true;
  });
  await advanceReadyBrackets(afterRoundOne(created));

  const round = buildSnapshot((await readStore()).brackets[0], { includeAdminUrl: true }).missedVotes![0];
  assert.equal(round.couldVote, 5);
  assert.equal(round.awayCount, 0);
  assert.deepEqual(round.missed, []);
});

test("a player added after a round closed isn't blamed for it", async () => {
  const created = await liveTournament();
  await mutate((bracket) => {
    for (const name of roster) {
      vote(bracket, name, "AA");
    }
  });
  await advanceReadyBrackets(afterRoundOne(created));

  const later = await mutate((bracket) => {
    bracket.rosterMembers.push({ id: "late-joiner", name: "Late Joiner" });
  });

  const round = buildSnapshot(later, { includeAdminUrl: true }).missedVotes![0];
  assert.equal(round.couldVote, 5);
  assert.deepEqual(round.missed, []);
});

test("a round closed before away lists were kept falls back to who is away now", async () => {
  const created = await liveTournament();
  await mutate((bracket) => {
    vote(bracket, "Gabe", "AA");
    vote(bracket, "Alex", "AA");
    vote(bracket, "Jordan", "AA");
  });
  await advanceReadyBrackets(afterRoundOne(created));

  const legacy = await mutate((bracket) => {
    delete bracket.rounds[0].closeRoster;
    bracket.rosterMembers.find((member) => member.name === "Riley")!.away = true;
  });

  const round = buildSnapshot(legacy, { includeAdminUrl: true }).missedVotes![0];
  assert.equal(round.awayRecorded, false);
  assert.deepEqual(
    round.missed.map((member) => member.name),
    ["Sam"],
  );
});

test("a tied round is listed too, and a live round is not", async () => {
  const created = await liveTournament();
  const live = buildSnapshot((await readStore()).brackets[0], { includeAdminUrl: true });
  assert.deepEqual(live.missedVotes, []);

  await mutate((bracket) => {
    vote(bracket, "Gabe", "AA");
    vote(bracket, "Alex", "BA");
  });
  await advanceReadyBrackets(afterRoundOne(created));

  const tied = (await readStore()).brackets[0];
  assert.equal(tied.rounds[0].status, "tiebreaker");
  assert.ok(tied.rounds[0].closeRoster, "the roster is stamped when a round closes into a tiebreak");
  const round = buildSnapshot(tied, { includeAdminUrl: true }).missedVotes![0];
  assert.deepEqual(
    round.missed.map((member) => member.name),
    ["Jordan", "Riley", "Sam"],
  );
});

test("the missed list is for the admin only", async () => {
  const created = await liveTournament();
  await advanceReadyBrackets(afterRoundOne(created));
  const bracket = (await readStore()).brackets[0];

  assert.equal(buildSnapshot(bracket).missedVotes, undefined);
  const publicSnapshot = buildPublicSnapshot(bracket, { rosterMemberId: memberId(bracket, "Gabe") });
  assert.equal("missedVotes" in publicSnapshot, false);
  assert.equal(JSON.stringify(publicSnapshot).includes("closeRoster"), false);
});

test("a later round still lists its own no-shows after round one", async () => {
  const created = await liveTournament();
  await mutate((bracket) => {
    for (const name of roster) {
      vote(bracket, name, "AA");
    }
  });

  // Close round one, then let round two (the final) run out with one voter.
  await advanceReadyBrackets(afterRoundOne(created));
  const withFinal = await mutate((bracket) => {
    const final = bracket.rounds[1];
    assert.equal(final.matchups.length, 1);
    final.startsAt = new Date(Date.parse(bracket.rounds[0].endsAt) + 1000).toISOString();
    final.endsAt = new Date(Date.parse(final.startsAt) + HOUR).toISOString();
  });
  await advanceReadyBrackets(new Date(Date.parse(withFinal.rounds[1].startsAt) + 1000));
  const finalLive = await mutate((bracket) => {
    const matchup = bracket.rounds[1].matchups[0];
    assert.equal(matchup.status, "live");
    matchup.votes.push({
      id: "final-vote",
      rosterMemberId: memberId(bracket, "Gabe"),
      entrantId: matchup.entrantAId!,
      createdAt: new Date().toISOString(),
    });
  });
  await advanceReadyBrackets(new Date(Date.parse(finalLive.rounds[1].endsAt) + 1000));

  const done = (await readStore()).brackets[0];
  assert.equal(done.status, "completed");
  const missed = buildSnapshot(done, { includeAdminUrl: true }).missedVotes!;
  // Newest round first.
  assert.deepEqual(
    missed.map((round) => [round.roundNumber, round.missed.map((member) => member.name)]),
    [
      [2, ["Alex", "Jordan", "Riley", "Sam"]],
      [1, []],
    ],
  );
});
