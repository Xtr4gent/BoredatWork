import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceBracket,
  addRosterMembers,
  buildAdminSnapshot,
  buildPreviewSnapshot,
  buildPublicSnapshot,
  buildSnapshot,
  castVote,
  claimVoterIdentity,
  clearMatchupVote,
  createBracket,
  disableBracket,
  ensureVoterBinding,
  findCurrentPublicBracket,
  listBracketHistory,
  markBracketAsCurrentPublic,
  resolveTieBreaker,
  restartBracket,
} from "@/lib/workquiz/bracket";
import { GET as getStatusRoute } from "@/app/api/status/route";
import {
  buildExpectedAdminSessionValue,
  hasValidAdminSessionValue,
  isAdminAuthConfigured,
  sanitizeAdminRedirectTarget,
} from "@/lib/workquiz/admin-auth";
import { DEFAULT_LANDING_HISTORY } from "@/lib/workquiz/landing-history";
import { ensureStore, readStore, updateStore, writeStore } from "@/lib/workquiz/store";

const roster = ["Gabe", "Alex", "Jordan", "Sam"];

async function bindAndCastVote(params: {
  publicToken: string;
  rosterMemberId: string;
  matchupSlot: number;
  side: "A" | "B";
  browserToken?: string;
}) {
  const browserToken = params.browserToken ?? `browser-${params.rosterMemberId}`;

  await updateStore((store) => {
    const bracket = store.brackets.find((entry) => entry.publicToken === params.publicToken);
    if (bracket) {
      bracket.voterBindings ??= {};
      bracket.voterBindings[browserToken] = params.rosterMemberId;
    }
    return store;
  });

  return castVote({
    publicToken: params.publicToken,
    browserToken,
    matchupSlot: params.matchupSlot,
    side: params.side,
  });
}

async function resetStore() {
  await ensureStore();
  await writeStore({ brackets: [] });
}

test("createBracket builds the bracket and returns an admin token", async () => {
  await resetStore();
  const startsAt = new Date().toISOString();
  const endsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { bracket, adminToken } = await createBracket({
    title: "Chocolate Bar Showdown",
    seedingMode: "manual",
    entrants: [
      { name: "Mars", imageUrl: "https://example.com/mars.jpg" },
      "Twix",
      "Kit Kat",
      "Aero",
    ],
    rosterMembers: roster,
    startsAt,
    endsAt,
    totalPlayers: roster.length,
  });

  assert.equal(bracket.rounds.length, 2);
  assert.equal(bracket.rounds[0].matchups.length, 2);
  assert.ok(adminToken.length > 10);
  assert.equal(bracket.rosterMembers.length, roster.length);
  assert.equal(bracket.totalPlayers, roster.length);
  assert.equal(bracket.entrants[0].imageUrl, "https://example.com/mars.jpg");
});

test("manual seeding pairs adjacent entrants in round one", async () => {
  await resetStore();
  const entrants = Array.from({ length: 32 }, (_, index) => `Option ${index + 1}`);
  const { bracket } = await createBracket({
    title: "Manual Order Showdown",
    seedingMode: "manual",
    entrants,
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  assert.equal(bracket.rounds[0].matchups.length, 16);
  for (const [index, matchup] of bracket.rounds[0].matchups.entries()) {
    const expectedA = bracket.entrants[index * 2];
    const expectedB = bracket.entrants[index * 2 + 1];
    assert.equal(matchup.entrantAId, expectedA.id);
    assert.equal(matchup.entrantBId, expectedB.id);
  }
});

test("createBracket supports qualifier mode with a dedicated play-in round", async () => {
  await resetStore();
  const { bracket } = await createBracket({
    title: "Qualifier Format",
    seedingMode: "manual",
    entrants: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"],
    directQualifierNames: ["A", "B", "C", "D", "E", "F"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  assert.equal(bracket.rounds[0].label, "Play-In");
  assert.equal(bracket.rounds[0].matchups.length, 2);
  assert.equal(bracket.rounds[1].matchups.length, 4);
});

test("qualifier mode reserves main-bracket slots for play-in winners", async () => {
  await resetStore();
  const { bracket } = await createBracket({
    title: "Qualifier Slot Mapping",
    seedingMode: "manual",
    entrants: ["A", "B", "C", "D", "E", "F", "G", "H"],
    directQualifierNames: ["A", "B", "C", "D"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const playInRound = bracket.rounds[0];
  const [playInA, playInB] = playInRound.matchups;
  const firstMainMatchup = bracket.rounds[1].matchups[0];
  assert.ok(playInA.entrantAId && playInA.entrantBId);
  assert.ok(playInB.entrantAId && playInB.entrantBId);
  assert.equal(firstMainMatchup.entrantAId, null);
  assert.equal(firstMainMatchup.entrantBId, null);
  const hasDirectQualifierInMainRound = bracket.rounds[1].matchups.some(
    (matchup) => matchup.entrantAId || matchup.entrantBId,
  );
  assert.equal(hasDirectQualifierInMainRound, true);
});

test("castVote rejects duplicate votes from the same roster member in a matchup", async () => {
  await resetStore();
  const { bracket } = await createBracket({
    title: "Chocolate Bar Showdown",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const matchup = bracket.rounds[0].matchups[0];
  const voterId = bracket.rosterMembers[0].id;

  await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: voterId,
    matchupSlot: matchup.slot,
    side: "A",
  });

  await assert.rejects(() =>
    bindAndCastVote({
      publicToken: bracket.publicToken,
      rosterMemberId: voterId,
      matchupSlot: matchup.slot,
      side: "B",
    }),
  );
});

test("advanceBracket pauses tied matchups until the admin resolves the tie breaker", async () => {
  await resetStore();
  const startsAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { bracket, adminToken } = await createBracket({
    title: "Chocolate Bar Showdown",
    seedingMode: "manual",
    entrants: ["Mars", "Twix", "Kit Kat", "Aero"],
    rosterMembers: roster,
    startsAt,
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const semiA = bracket.rounds[0].matchups[0];
  const semiB = bracket.rounds[0].matchups[1];

  let updated = await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: bracket.rosterMembers[0].id,
    matchupSlot: semiA.slot,
    side: "A",
  });
  updated = await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: bracket.rosterMembers[1].id,
    matchupSlot: semiA.slot,
    side: "B",
  });
  updated = await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: bracket.rosterMembers[2].id,
    matchupSlot: semiB.slot,
    side: "A",
  });

  advanceBracket(updated, new Date(Date.now() + 60 * 60 * 1000));
  await writeStore({ brackets: [updated] });

  assert.equal(updated.rounds[0].status, "tiebreaker");
  assert.equal(updated.rounds[0].matchups[0].status, "needs_tiebreaker");
  assert.equal(updated.rounds[1].status, "upcoming");
  assert.equal(updated.rounds[1].matchups[0].status, "pending");
  assert.equal(updated.rounds[1].matchups[0].entrantBId, semiB.entrantAId);

  const resolved = await resolveTieBreaker({
    adminToken,
    matchupId: semiA.id,
    winnerEntrantId: semiA.entrantBId!,
  });

  assert.equal(resolved.rounds[0].status, "closed");
  assert.equal(resolved.rounds[0].matchups[0].winnerEntrantId, semiA.entrantBId);
  assert.equal(resolved.rounds[1].matchups[0].entrantAId, semiA.entrantBId);
});

test("advanceBracket recovers from a prematurely live next round when ties are unresolved", async () => {
  await resetStore();
  const startsAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { bracket } = await createBracket({
    title: "Recovery Showdown",
    seedingMode: "manual",
    entrants: ["Mars", "Twix", "Kit Kat", "Aero"],
    rosterMembers: roster,
    startsAt,
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const firstRound = bracket.rounds[0];
  const nextRound = bracket.rounds[1];
  firstRound.status = "tiebreaker";
  firstRound.matchups[0].status = "needs_tiebreaker";
  firstRound.matchups[0].winnerEntrantId = null;

  nextRound.status = "live";
  nextRound.matchups[0].status = "live";
  nextRound.matchups[0].winnerEntrantId = nextRound.matchups[0].entrantAId;
  nextRound.matchups[0].votes.push({
    id: "broken-vote",
    rosterMemberId: bracket.rosterMembers[0].id,
    entrantId: nextRound.matchups[0].entrantAId!,
    createdAt: new Date().toISOString(),
  });

  advanceBracket(bracket, new Date(Date.now() + 60 * 60 * 1000));

  assert.equal(nextRound.status, "upcoming");
  assert.equal(nextRound.matchups[0].status, "pending");
  assert.equal(nextRound.matchups[0].winnerEntrantId, null);
  assert.equal(nextRound.matchups[0].votes.length, 0);
});

test("advanceBracket heals a stale tiebreaker round after winners are set", async () => {
  await resetStore();
  const startsAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { bracket } = await createBracket({
    title: "Stale Tiebreaker Recovery",
    seedingMode: "manual",
    entrants: ["Mars", "Twix", "Kit Kat", "Aero"],
    rosterMembers: roster,
    startsAt,
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const semiA = bracket.rounds[0].matchups[0];
  const semiB = bracket.rounds[0].matchups[1];
  const roundTwo = bracket.rounds[1];

  let updated = await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: bracket.rosterMembers[0].id,
    matchupSlot: semiA.slot,
    side: "A",
  });
  updated = await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: bracket.rosterMembers[1].id,
    matchupSlot: semiA.slot,
    side: "B",
  });
  updated = await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: bracket.rosterMembers[2].id,
    matchupSlot: semiB.slot,
    side: "A",
  });

  advanceBracket(updated, new Date(Date.now() + 60 * 60 * 1000));
  updated.rounds[0].status = "tiebreaker";
  updated.rounds[0].matchups[0].winnerEntrantId = semiA.entrantBId;
  updated.rounds[0].matchups[0].status = "closed";
  roundTwo.matchups[0].entrantAId = null;
  roundTwo.matchups[0].status = "pending";

  advanceBracket(updated, new Date(Date.now() + 60 * 60 * 1000));

  assert.equal(updated.rounds[0].status, "closed");
  assert.equal(updated.rounds[1].matchups[0].entrantAId, semiA.entrantBId);
  assert.equal(updated.rounds[1].matchups[0].entrantBId, semiB.entrantAId);
  assert.equal(updated.rounds[1].status, "live");
});

test("advanceBracket promotes newly populated pending matchups in a live round", async () => {
  await resetStore();
  const { bracket } = await createBracket({
    title: "Live Matchup Activation",
    seedingMode: "manual",
    entrants: ["A", "B", "C", "D", "E", "F", "G", "H"],
    rosterMembers: roster,
    startsAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const roundTwo = bracket.rounds[1];
  roundTwo.status = "live";
  roundTwo.matchups[0].status = "pending";
  roundTwo.matchups[0].entrantAId = bracket.entrants[0].id;
  roundTwo.matchups[0].entrantBId = bracket.entrants[1].id;

  advanceBracket(bracket, new Date());

  assert.equal(roundTwo.matchups[0].status, "live");
});

test("resolveTieBreaker recovers malformed tie state and still allows admin resolution", async () => {
  await resetStore();
  const startsAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { bracket, adminToken } = await createBracket({
    title: "Corrupted Tie State",
    seedingMode: "manual",
    entrants: ["Mars", "Twix", "Kit Kat", "Aero"],
    rosterMembers: roster,
    startsAt,
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const semiA = bracket.rounds[0].matchups[0];
  const semiB = bracket.rounds[0].matchups[1];

  let updated = await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: bracket.rosterMembers[0].id,
    matchupSlot: semiA.slot,
    side: "A",
  });
  updated = await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: bracket.rosterMembers[1].id,
    matchupSlot: semiA.slot,
    side: "B",
  });
  updated = await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: bracket.rosterMembers[2].id,
    matchupSlot: semiB.slot,
    side: "A",
  });

  advanceBracket(updated, new Date(Date.now() + 60 * 60 * 1000));
  updated.rounds[0].status = "closed";
  updated.rounds[0].matchups[0].status = "closed";
  updated.rounds[1].status = "live";
  updated.rounds[1].matchups[0].status = "live";
  await writeStore({ brackets: [updated] });

  const resolved = await resolveTieBreaker({
    adminToken,
    matchupId: semiA.id,
    winnerEntrantId: semiA.entrantAId!,
  });

  assert.equal(resolved.rounds[0].matchups[0].winnerEntrantId, semiA.entrantAId);
  assert.equal(resolved.rounds[0].status, "closed");
  assert.equal(resolved.rounds[1].matchups[0].entrantAId, semiA.entrantAId);
});

test("resolveTieBreaker repairs other stale matchups in the same round", async () => {
  await resetStore();
  const startsAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { bracket, adminToken } = await createBracket({
    title: "Stale Tie Recovery",
    seedingMode: "manual",
    entrants: ["Mars", "Twix", "Kit Kat", "Aero"],
    rosterMembers: roster,
    startsAt,
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const semiA = bracket.rounds[0].matchups[0];
  const semiB = bracket.rounds[0].matchups[1];

  let updated = await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: bracket.rosterMembers[0].id,
    matchupSlot: semiA.slot,
    side: "A",
  });
  updated = await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: bracket.rosterMembers[1].id,
    matchupSlot: semiA.slot,
    side: "B",
  });
  updated = await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: bracket.rosterMembers[2].id,
    matchupSlot: semiB.slot,
    side: "A",
  });

  advanceBracket(updated, new Date(Date.now() + 60 * 60 * 1000));
  updated.rounds[0].status = "tiebreaker";
  updated.rounds[0].matchups[1].winnerEntrantId = null;
  updated.rounds[0].matchups[1].status = "live";
  await writeStore({ brackets: [updated] });

  const resolved = await resolveTieBreaker({
    adminToken,
    matchupId: semiA.id,
    winnerEntrantId: semiA.entrantBId!,
  });

  assert.equal(resolved.rounds[0].status, "closed");
  assert.equal(resolved.rounds[0].matchups[1].winnerEntrantId, semiB.entrantAId);
  assert.equal(resolved.rounds[0].matchups[1].status, "closed");
  assert.equal(resolved.rounds[1].matchups[0].entrantAId, semiA.entrantBId);
  assert.equal(resolved.rounds[1].matchups[0].entrantBId, semiB.entrantAId);
});

test("resolveTieBreaker is safe to retry after a winner is already set", async () => {
  await resetStore();
  const startsAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { bracket, adminToken } = await createBracket({
    title: "Tie Retry Safety",
    seedingMode: "manual",
    entrants: ["Mars", "Twix", "Kit Kat", "Aero"],
    rosterMembers: roster,
    startsAt,
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const semiA = bracket.rounds[0].matchups[0];
  const semiB = bracket.rounds[0].matchups[1];

  let updated = await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: bracket.rosterMembers[0].id,
    matchupSlot: semiA.slot,
    side: "A",
  });
  updated = await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: bracket.rosterMembers[1].id,
    matchupSlot: semiA.slot,
    side: "B",
  });
  updated = await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: bracket.rosterMembers[2].id,
    matchupSlot: semiB.slot,
    side: "A",
  });

  advanceBracket(updated, new Date(Date.now() + 60 * 60 * 1000));
  const firstResolution = await resolveTieBreaker({
    adminToken,
    matchupId: semiA.id,
    winnerEntrantId: semiA.entrantAId!,
  });
  const secondResolution = await resolveTieBreaker({
    adminToken,
    matchupId: semiA.id,
    winnerEntrantId: semiA.entrantAId!,
  });

  assert.equal(firstResolution.rounds[0].matchups[0].winnerEntrantId, semiA.entrantAId);
  assert.equal(secondResolution.rounds[0].matchups[0].winnerEntrantId, semiA.entrantAId);
});

test("buildSnapshot marks a roster member green only after finishing the whole current round", async () => {
  await resetStore();
  const { bracket } = await createBracket({
    title: "Chocolate Bar Showdown",
    seedingMode: "manual",
    entrants: ["Mars", "Twix", "Kit Kat", "Aero"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const voterId = bracket.rosterMembers[0].id;

  let updated = await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: voterId,
    matchupSlot: bracket.rounds[0].matchups[0].slot,
    side: "A",
  });

  let snapshot = buildSnapshot(updated, { rosterMemberId: voterId });
  assert.equal(snapshot.currentRoundUniqueVoters, 0);
  assert.equal(
    snapshot.currentRoundRosterStatuses.find((member) => member.rosterMemberId === voterId)?.hasVoted,
    false,
  );

  updated = await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: voterId,
    matchupSlot: updated.rounds[0].matchups[1].slot,
    side: "A",
  });

  snapshot = buildSnapshot(updated, { rosterMemberId: voterId });
  assert.equal(snapshot.currentRoundUniqueVoters, 1);
  assert.equal(snapshot.rounds[0].matchups[0].voteState.canVote, false);
  assert.equal(snapshot.selectedRosterMemberId, voterId);
});

test("buildSnapshot treats equivalent roster names as one voter identity", async () => {
  await resetStore();
  const { bracket } = await createBracket({
    title: "Chocolate Bar Showdown",
    seedingMode: "manual",
    entrants: ["Mars", "Twix", "Kit Kat", "Aero"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const canonicalJennieId = "legacy-jennie";
  const duplicateJennieId = "legacy-jennie-space";
  bracket.rosterMembers.push({ id: canonicalJennieId, name: "Jennie" });
  bracket.rosterMembers.push({ id: duplicateJennieId, name: "  jennie  " });
  bracket.totalPlayers = bracket.rosterMembers.length;

  for (const matchup of bracket.rounds[0].matchups) {
    matchup.votes.push({
      id: `vote-${matchup.id}`,
      rosterMemberId: duplicateJennieId,
      entrantId: matchup.entrantAId!,
      createdAt: new Date().toISOString(),
    });
  }

  const snapshot = buildSnapshot(bracket, { rosterMemberId: canonicalJennieId });
  const canonicalStatus = snapshot.currentRoundRosterStatuses.find(
    (entry) => entry.rosterMemberId === canonicalJennieId,
  );
  const duplicateStatus = snapshot.currentRoundRosterStatuses.find(
    (entry) => entry.rosterMemberId === duplicateJennieId,
  );

  assert.equal(canonicalStatus?.hasVoted, true);
  assert.equal(duplicateStatus?.hasVoted, true);
});

test("buildSnapshot points at the next upcoming round before voting opens", async () => {
  await resetStore();
  const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const endsAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const { bracket } = await createBracket({
    title: "Chocolate Bar Showdown",
    seedingMode: "manual",
    entrants: ["Mars", "Twix", "Kit Kat", "Aero", "Aero Mint", "Crunchie", "Coffee Crisp", "Smarties"],
    rosterMembers: roster,
    startsAt,
    endsAt,
    totalPlayers: roster.length,
  });

  const snapshot = buildSnapshot(bracket);

  assert.equal(snapshot.currentRoundId, snapshot.rounds[0].id);
  assert.equal(snapshot.rounds[0].label, "Quarterfinals");
  assert.equal(snapshot.rounds[1].label, "Semifinals");
  assert.equal(snapshot.rounds[2].label, "Finals");
});

test("daily round windows reuse the same 6 AM to 8 PM window on following days", async () => {
  await resetStore();
  const { bracket } = await createBracket({
    title: "Chocolate Bar Showdown",
    seedingMode: "manual",
    entrants: ["Mars", "Twix", "Kit Kat", "Aero"],
    rosterMembers: roster,
    startsAt: "2099-01-05T11:00:00.000Z",
    endsAt: "2099-01-06T01:00:00.000Z",
    totalPlayers: roster.length,
  });

  assert.equal(bracket.rounds[0].startsAt, "2099-01-05T11:00:00.000Z");
  assert.equal(bracket.rounds[0].endsAt, "2099-01-06T01:00:00.000Z");
  assert.equal(bracket.rounds[1].startsAt, "2099-01-06T11:00:00.000Z");
  assert.equal(bracket.rounds[1].endsAt, "2099-01-07T01:00:00.000Z");
});

test("daily round windows wait overnight before opening the next round", async () => {
  await resetStore();
  const { bracket } = await createBracket({
    title: "Chocolate Bar Showdown",
    seedingMode: "manual",
    entrants: ["Mars", "Twix", "Kit Kat", "Aero"],
    rosterMembers: roster,
    startsAt: "2026-04-20T10:00:00.000Z",
    endsAt: "2026-04-21T00:00:00.000Z",
    totalPlayers: roster.length,
  });
  const updated = bracket;
  updated.rounds[0].matchups[0].votes.push({
    id: "vote-1",
    rosterMemberId: bracket.rosterMembers[0].id,
    entrantId: bracket.rounds[0].matchups[0].entrantAId!,
    createdAt: "2026-04-20T12:00:00.000Z",
  });
  updated.rounds[0].matchups[1].votes.push({
    id: "vote-2",
    rosterMemberId: bracket.rosterMembers[1].id,
    entrantId: bracket.rounds[0].matchups[1].entrantAId!,
    createdAt: "2026-04-20T12:05:00.000Z",
  });

  advanceBracket(updated, new Date("2026-04-21T01:00:00.000Z"));

  assert.equal(updated.rounds[0].status, "closed");
  assert.equal(updated.rounds[1].status, "upcoming");
  assert.equal(updated.rounds[1].matchups[0].status, "pending");

  advanceBracket(updated, new Date("2026-04-21T10:00:00.000Z"));

  assert.equal(updated.rounds[1].status, "live");
  assert.equal(updated.rounds[1].matchups[0].status, "live");
});

test("restartBracket clears votes and sends the bracket back to round one", async () => {
  await resetStore();
  const startsAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { bracket } = await createBracket({
    title: "Chocolate Bar Showdown",
    seedingMode: "manual",
    entrants: ["Mars", "Twix", "Kit Kat", "Aero"],
    rosterMembers: roster,
    startsAt,
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const openingMatchup = bracket.rounds[0].matchups[0];

  await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: bracket.rosterMembers[0].id,
    matchupSlot: openingMatchup.slot,
    side: "A",
  });

  advanceBracket(bracket, new Date(Date.now() + 2 * 60 * 60 * 1000));
  restartBracket(bracket);

  assert.equal(bracket.status, "live");
  assert.equal(bracket.rounds.length, 2);
  assert.equal(bracket.rounds[0].status, "live");
  assert.equal(bracket.rounds[1].status, "upcoming");
  assert.equal(bracket.rounds[0].matchups[0].votes.length, 0);
  assert.equal(bracket.rounds[0].matchups[0].winnerEntrantId, null);
});

test("disableBracket makes the bracket unavailable for public use", async () => {
  await resetStore();
  const startsAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { bracket } = await createBracket({
    title: "Chocolate Bar Showdown",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt,
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  disableBracket(bracket);
  await writeStore({ brackets: [bracket] });
  const snapshot = buildSnapshot(bracket);

  assert.equal(snapshot.status, "disabled");
  assert.equal(snapshot.rounds[0].status, "closed");
  assert.equal(snapshot.rounds[0].matchups[0].status, "closed");
  await assert.rejects(() =>
    bindAndCastVote({
      publicToken: bracket.publicToken,
      rosterMemberId: bracket.rosterMembers[0].id,
      matchupSlot: bracket.rounds[0].matchups[0].slot,
      side: "A",
    }),
  );
});

test("clearMatchupVote removes one person's vote from a specific matchup", async () => {
  await resetStore();
  const { bracket, adminToken } = await createBracket({
    title: "Chocolate Bar Showdown",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const matchup = bracket.rounds[0].matchups[0];
  const voterId = bracket.rosterMembers[0].id;

  await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: voterId,
    matchupSlot: matchup.slot,
    side: "A",
  });

  const updated = await clearMatchupVote({
    adminToken,
    matchupId: matchup.id,
    rosterMemberId: voterId,
  });
  const snapshot = buildSnapshot(updated, { includeAdminUrl: true, adminToken });

  assert.equal(snapshot.rounds[0].matchups[0].totalVotes, 0);
  assert.equal(snapshot.rounds[0].matchups[0].adminVotes?.length, 0);
});

test("markBracketAsCurrentPublic makes exactly one bracket the stable public tournament", async () => {
  await resetStore();
  const first = await createBracket({
    title: "First Bracket",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const second = await createBracket({
    title: "Second Bracket",
    seedingMode: "manual",
    entrants: ["Kit Kat", "Aero"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  let current = await markBracketAsCurrentPublic(first.adminToken);
  assert.equal(current.title, "First Bracket");
  assert.equal((await findCurrentPublicBracket())?.id, first.bracket.id);

  current = await markBracketAsCurrentPublic(second.adminToken);
  assert.equal(current.title, "Second Bracket");

  const store = await readStore();
  assert.equal(store.brackets.find((entry) => entry.id === first.bracket.id)?.isCurrentPublic, false);
  assert.equal(store.brackets.find((entry) => entry.id === second.bracket.id)?.isCurrentPublic, true);
  assert.equal((await findCurrentPublicBracket())?.id, second.bracket.id);
});

test("test brackets stay private and cannot become the current public tournament", async () => {
  await resetStore();
  const publicBracket = await createBracket({
    title: "Public Bracket",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const testBracket = await createBracket({
    title: "Private Test Bracket",
    kind: "test",
    seedingMode: "manual",
    entrants: ["Kit Kat", "Aero"],
    rosterMembers: roster,
    startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  await markBracketAsCurrentPublic(publicBracket.adminToken);
  await assert.rejects(() => markBracketAsCurrentPublic(testBracket.adminToken), /Test brackets/);

  const current = await findCurrentPublicBracket();
  const snapshot = await buildAdminSnapshot(testBracket.bracket, testBracket.adminToken);

  assert.equal(current?.id, publicBracket.bracket.id);
  assert.equal(testBracket.bracket.isCurrentPublic, false);
  assert.equal(testBracket.bracket.rounds[0].status, "live");
  assert.equal(snapshot.kind, "test");
  assert.equal(snapshot.publicUrl.startsWith("/test?adminToken="), true);
});

test("completed test brackets never appear in tournament history", async () => {
  await resetStore();
  const { bracket } = await createBracket({
    title: "Private Test Bracket",
    kind: "test",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const matchup = bracket.rounds[0].matchups[0];
  const updated = await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: bracket.rosterMembers[0].id,
    matchupSlot: matchup.slot,
    side: "A",
  });
  advanceBracket(updated, new Date(Date.now() + 60 * 60 * 1000));
  await writeStore({ brackets: [updated] });

  assert.equal(updated.status, "completed");
  assert.equal((await listBracketHistory()).length, 0);
});

test("test brackets still support tie-breaker resolution and restart controls", async () => {
  await resetStore();
  const { bracket, adminToken } = await createBracket({
    title: "Private Test Bracket",
    kind: "test",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const matchup = bracket.rounds[0].matchups[0];
  let updated = await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: bracket.rosterMembers[0].id,
    matchupSlot: matchup.slot,
    side: "A",
  });
  updated = await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: bracket.rosterMembers[1].id,
    matchupSlot: matchup.slot,
    side: "B",
  });
  advanceBracket(updated, new Date(Date.now() + 60 * 60 * 1000));
  await writeStore({ brackets: [updated] });

  assert.equal(updated.rounds[0].status, "tiebreaker");

  const resolved = await resolveTieBreaker({
    adminToken,
    matchupId: matchup.id,
    winnerEntrantId: matchup.entrantBId!,
  });

  assert.equal(resolved.status, "completed");
  restartBracket(resolved);
  assert.equal(resolved.status, "live");
  assert.equal(resolved.rounds[0].status, "live");
  assert.equal(resolved.rounds[0].matchups[0].votes.length, 0);
});

test("buildPreviewSnapshot preserves a provided random preview seed order", async () => {
  await resetStore();
  const snapshot = buildPreviewSnapshot({
    title: "Chocolate Bar Showdown",
    entrants: [
      { name: "Mars", imageUrl: "https://example.com/mars.jpg" },
      "Twix",
      "Kit Kat",
      "Aero",
    ],
    rosterMembers: roster,
    seededEntrants: [
      "Aero",
      "Twix",
      { name: "Mars", imageUrl: "https://example.com/mars.jpg" },
      "Kit Kat",
    ],
    seedingMode: "random",
    startsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    endsAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    totalPlayers: roster.length,
  });

  assert.equal(snapshot.entrants[0].name, "Aero");
  assert.equal(snapshot.rounds[0].matchups[0].entrantA?.name, "Aero");
  assert.equal(snapshot.entrants[2].imageUrl, "https://example.com/mars.jpg");
  assert.equal(snapshot.rosterMembers.length, roster.length);
});

test("final ties wait for admin tie-breaker choice before crowning a champion", async () => {
  await resetStore();
  const { bracket, adminToken } = await createBracket({
    title: "Chocolate Bar Showdown",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const final = bracket.rounds[0].matchups[0];
  let updated = await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: bracket.rosterMembers[0].id,
    matchupSlot: final.slot,
    side: "A",
  });
  updated = await bindAndCastVote({
    publicToken: bracket.publicToken,
    rosterMemberId: bracket.rosterMembers[1].id,
    matchupSlot: final.slot,
    side: "B",
  });

  advanceBracket(updated, new Date(Date.now() + 60 * 60 * 1000));
  await writeStore({ brackets: [updated] });

  assert.equal(updated.status, "live");
  assert.equal(updated.rounds[0].status, "tiebreaker");

  const resolved = await resolveTieBreaker({
    adminToken,
    matchupId: final.id,
    winnerEntrantId: final.entrantBId!,
  });

  assert.equal(resolved.status, "completed");
  assert.equal(resolved.rounds[0].matchups[0].winnerEntrantId, final.entrantBId);
});

test("admin snapshot includes previous completed topics and winners", async () => {
  await resetStore();
  const { bracket: current, adminToken } = await createBracket({
    title: "Current Bracket",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const { bracket: previous } = await createBracket({
    title: "Previous Bracket",
    seedingMode: "manual",
    entrants: ["Kit Kat", "Aero"],
    rosterMembers: roster,
    startsAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const store = await readStore();
  const storedPrevious = store.brackets.find((entry) => entry.id === previous.id)!;
  storedPrevious.rounds[0].matchups[0].winnerEntrantId = storedPrevious.rounds[0].matchups[0].entrantAId;
  storedPrevious.rounds[0].matchups[0].status = "closed";
  storedPrevious.rounds[0].status = "closed";
  storedPrevious.status = "completed";
  await writeStore(store);

  const snapshot = await buildAdminSnapshot(current, adminToken);

  assert.equal(snapshot.adminHistory?.length, 1);
  assert.equal(snapshot.adminHistory?.[0].title, "Previous Bracket");
  assert.equal(snapshot.adminHistory?.[0].winnerName, "Kit Kat");
  assert.equal(snapshot.adminHistory?.[0].tournamentDate, previous.rounds[0].startsAt);
});

test("listBracketHistory returns championed brackets in newest-first tournament date order", async () => {
  await resetStore();

  const { bracket: liveBracket } = await createBracket({
    title: "Still Live",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const { bracket: olderBracket } = await createBracket({
    title: "Best Chocolate Bar",
    seedingMode: "manual",
    entrants: ["Kit Kat", "Aero"],
    rosterMembers: roster,
    startsAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const { bracket: newerBracket } = await createBracket({
    title: "Best Soda",
    seedingMode: "manual",
    entrants: ["Coke", "Pepsi"],
    rosterMembers: roster,
    startsAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const store = await readStore();
  const storedOlder = store.brackets.find((entry) => entry.id === olderBracket.id)!;
  storedOlder.rounds[0].matchups[0].winnerEntrantId = storedOlder.rounds[0].matchups[0].entrantAId;
  storedOlder.rounds[0].matchups[0].status = "closed";
  storedOlder.rounds[0].status = "closed";
  storedOlder.status = "completed";

  const storedNewer = store.brackets.find((entry) => entry.id === newerBracket.id)!;
  storedNewer.rounds[0].matchups[0].winnerEntrantId = storedNewer.rounds[0].matchups[0].entrantBId;
  storedNewer.rounds[0].matchups[0].status = "closed";
  storedNewer.rounds[0].status = "closed";
  storedNewer.status = "disabled";
  storedNewer.publishedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const storedLive = store.brackets.find((entry) => entry.id === liveBracket.id)!;
  storedLive.publishedAt = new Date().toISOString();
  storedLive.rounds[0].matchups[0].winnerEntrantId = storedLive.rounds[0].matchups[0].entrantAId;
  storedLive.rounds[0].matchups[0].status = "closed";
  storedLive.rounds[0].status = "closed";
  await writeStore(store);

  const history = await listBracketHistory();

  assert.equal(history.length, 3);
  assert.equal(history[0].title, "Still Live");
  assert.equal(history[0].winnerName, "Mars");
  assert.equal(history[0].tournamentDate, storedLive.rounds[0].startsAt);
  assert.equal(history[1].title, "Best Soda");
  assert.equal(history[1].winnerName, "Pepsi");
  assert.equal(history[2].title, "Best Chocolate Bar");
});

test("admin auth session token matches the configured env credentials", async () => {
  const previousUsername = process.env.WORKQUIZ_ADMIN_USERNAME;
  const previousPassword = process.env.WORKQUIZ_ADMIN_PASSWORD;

  process.env.WORKQUIZ_ADMIN_USERNAME = "admin";
  process.env.WORKQUIZ_ADMIN_PASSWORD = "swordfish";

  try {
    assert.equal(isAdminAuthConfigured(), true);
    const sessionValue = await buildExpectedAdminSessionValue();

    assert.ok(sessionValue);
    assert.equal(await hasValidAdminSessionValue(sessionValue), true);
    assert.equal(await hasValidAdminSessionValue("not-the-right-cookie"), false);
  } finally {
    if (previousUsername === undefined) {
      delete process.env.WORKQUIZ_ADMIN_USERNAME;
    } else {
      process.env.WORKQUIZ_ADMIN_USERNAME = previousUsername;
    }

    if (previousPassword === undefined) {
      delete process.env.WORKQUIZ_ADMIN_PASSWORD;
    } else {
      process.env.WORKQUIZ_ADMIN_PASSWORD = previousPassword;
    }
  }
});

test("sanitizeAdminRedirectTarget only allows safe in-app page routes", () => {
  assert.equal(sanitizeAdminRedirectTarget("/admin"), "/admin");
  assert.equal(sanitizeAdminRedirectTarget("/admin/token-123?tab=votes"), "/admin/token-123?tab=votes");
  assert.equal(sanitizeAdminRedirectTarget("https://evil.example/steal"), "/admin");
  assert.equal(sanitizeAdminRedirectTarget("//evil.example/steal"), "/admin");
  assert.equal(sanitizeAdminRedirectTarget("/api/admin/secret"), "/admin");
});

test("status route reports live state separately from current bracket presence", async () => {
  await resetStore();

  const { bracket, adminToken } = await createBracket({
    title: "Best Chocolate Bar",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  await markBracketAsCurrentPublic(adminToken);

  let response = await getStatusRoute();
  let body = await response.json();

  assert.equal(body.live, true);
  assert.equal(body.hasCurrentBracket, true);
  assert.equal(body.currentTitle, "Best Chocolate Bar");
  assert.equal(body.currentUrl, "/voting");
  assert.equal(body.adminUrl, "/admin");

  const store = await readStore();
  const storedBracket = store.brackets.find((entry) => entry.id === bracket.id)!;
  storedBracket.rounds[0].matchups[0].winnerEntrantId = storedBracket.rounds[0].matchups[0].entrantAId;
  storedBracket.rounds[0].matchups[0].status = "closed";
  storedBracket.rounds[0].status = "closed";
  storedBracket.status = "completed";
  await writeStore(store);

  response = await getStatusRoute();
  body = await response.json();

  assert.equal(body.live, false);
  assert.equal(body.hasCurrentBracket, true);
  assert.equal(body.currentTitle, "Best Chocolate Bar");
  assert.equal(Array.isArray(body.history), true);
});

test("status route falls back to the single real landing tournament when history is empty", async () => {
  await resetStore();

  const response = await getStatusRoute();
  const body = await response.json();

  assert.equal(body.live, false);
  assert.equal(body.hasCurrentBracket, false);
  assert.deepEqual(body.history, DEFAULT_LANDING_HISTORY);
});

test("addRosterMembers appends voters mid-tournament and updates turnout totals", async () => {
  await resetStore();
  const { bracket, adminToken } = await createBracket({
    title: "Midgame Roster",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const updated = await addRosterMembers({
    adminToken,
    names: ["Priya", "Maya"],
  });

  assert.equal(updated.rosterMembers.length, roster.length + 2);
  assert.equal(updated.totalPlayers, roster.length + 2);
  assert.ok(updated.rosterMembers.some((member) => member.name === "Priya"));
  assert.ok(updated.rosterMembers.some((member) => member.name === "Maya"));

  const snapshot = buildSnapshot(updated);
  assert.equal(snapshot.totalPlayers, roster.length + 2);
});

test("addRosterMembers lets new voters claim a name and vote in the live round", async () => {
  await resetStore();
  const { bracket, adminToken } = await createBracket({
    title: "Midgame Vote",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const updated = await addRosterMembers({
    adminToken,
    names: ["Priya"],
  });
  const newMember = updated.rosterMembers.find((member) => member.name === "Priya");
  assert.ok(newMember);

  const claimed = await claimVoterIdentity({
    publicToken: updated.publicToken,
    browserToken: "browser-priya",
    rosterMemberName: "Priya",
  });
  assert.equal(claimed.rosterMemberId, newMember!.id);

  await bindAndCastVote({
    publicToken: updated.publicToken,
    rosterMemberId: newMember!.id,
    matchupSlot: 1,
    side: "A",
    browserToken: "browser-priya",
  });

  const store = await readStore();
  const liveBracket = store.brackets.find((entry) => entry.id === updated.id);
  assert.ok(liveBracket);
  assert.equal(liveBracket!.rounds[0].matchups[0].votes.length, 1);
});

test("addRosterMembers rejects duplicate and unavailable brackets", async () => {
  await resetStore();
  const { adminToken } = await createBracket({
    title: "Duplicate Roster",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  await assert.rejects(
    () => addRosterMembers({ adminToken, names: ["Gabe"] }),
    /already on the roster/,
  );
  await assert.rejects(
    () => addRosterMembers({ adminToken, names: ["Priya", "priya"] }),
    /Duplicate name in request/,
  );
});

test("claimVoterIdentity binds one browser to one roster name", async () => {
  await resetStore();
  const { bracket } = await createBracket({
    title: "Binding Test",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const first = await claimVoterIdentity({
    publicToken: bracket.publicToken,
    browserToken: "browser-a",
    rosterMemberName: roster[0],
  });
  assert.equal(first.rosterMemberId, bracket.rosterMembers[0].id);

  const reclaimed = await claimVoterIdentity({
    publicToken: bracket.publicToken,
    browserToken: "browser-b",
    rosterMemberName: roster[0],
  });
  assert.equal(reclaimed.rosterMemberId, bracket.rosterMembers[0].id);

  await assert.rejects(() =>
    claimVoterIdentity({
      publicToken: bracket.publicToken,
      browserToken: "browser-a",
      rosterMemberName: roster[1],
    }),
  );
});

test("buildPublicSnapshot hides internal ids and resolves vote sides", async () => {
  await resetStore();
  const { bracket } = await createBracket({
    title: "Public Snapshot",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const voterId = bracket.rosterMembers[0].id;
  bracket.voterBindings = { "browser-a": voterId };
  const matchup = bracket.rounds[0].matchups[0];
  matchup.votes.push({
    id: "vote-1",
    rosterMemberId: voterId,
    entrantId: matchup.entrantAId!,
    createdAt: new Date().toISOString(),
  });

  const snapshot = buildPublicSnapshot(bracket, { rosterMemberId: voterId });
  assert.equal(snapshot.selectedRosterMemberName, roster[0]);
  assert.equal("id" in snapshot.rosterMembers[0], false);
  assert.equal(snapshot.rounds[0].matchups[0].voteState.votedSide, "A");
  assert.equal("id" in snapshot.rounds[0].matchups[0], false);
});

test("ensureVoterBinding lazily claims remembered roster members on legacy brackets", async () => {
  await resetStore();
  const { bracket } = await createBracket({
    title: "Legacy Migration",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  delete bracket.voterBindings;
  await writeStore({ brackets: [bracket] });

  const migrated = await ensureVoterBinding({
    publicToken: bracket.publicToken,
    browserToken: "legacy-browser",
    rememberedRosterMemberId: bracket.rosterMembers[1].id,
  });

  assert.equal(migrated, bracket.rosterMembers[1].id);
  const store = await readStore();
  const stored = store.brackets[0];
  assert.equal(stored.voterBindings?.["legacy-browser"], bracket.rosterMembers[1].id);
});
