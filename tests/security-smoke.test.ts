import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPublicSnapshot,
  castVote,
  claimVoterIdentity,
  createBracket,
} from "@/lib/workquiz/bracket";
import { ensureStore, updateStore, writeStore } from "@/lib/workquiz/store";

const roster = ["Gabe", "Alex", "Jordan", "Sam"];

async function resetStore() {
  await ensureStore();
  await writeStore({ brackets: [] });
}

async function bindBrowser(publicToken: string, browserToken: string, rosterMemberId: string) {
  await updateStore((store) => {
    const bracket = store.brackets.find((entry) => entry.publicToken === publicToken);
    if (bracket) {
      bracket.voterBindings ??= {};
      bracket.voterBindings[browserToken] = rosterMemberId;
    }
    return store;
  });
}

test("SECURITY: same user cannot vote twice in the same matchup", async () => {
  await resetStore();
  const { bracket } = await createBracket({
    title: "Smoke",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const voterId = bracket.rosterMembers[0].id;
  const browser = "gabe-browser";
  await bindBrowser(bracket.publicToken, browser, voterId);

  const matchup = bracket.rounds[0].matchups[0];
  await castVote({
    publicToken: bracket.publicToken,
    browserToken: browser,
    matchupSlot: matchup.slot,
    side: "A",
  });

  await assert.rejects(
    () =>
      castVote({
        publicToken: bracket.publicToken,
        browserToken: browser,
        matchupSlot: matchup.slot,
        side: "B",
      }),
    /already voted/,
  );
});

test("SECURITY: user can vote once per matchup in a multi-matchup round (not duplicate same matchup)", async () => {
  await resetStore();
  const { bracket } = await createBracket({
    title: "Smoke",
    seedingMode: "manual",
    entrants: ["A", "B", "C", "D"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const voterId = bracket.rosterMembers[0].id;
  const browser = "gabe-browser";
  await bindBrowser(bracket.publicToken, browser, voterId);

  const [matchupA, matchupB] = bracket.rounds[0].matchups;
  await castVote({
    publicToken: bracket.publicToken,
    browserToken: browser,
    matchupSlot: matchupA.slot,
    side: "A",
  });
  await castVote({
    publicToken: bracket.publicToken,
    browserToken: browser,
    matchupSlot: matchupB.slot,
    side: "A",
  });

  const store = await updateStore((s) => s);
  const stored = store.brackets.find((entry) => entry.publicToken === bracket.publicToken)!;
  const votesForGabe = stored.rounds[0].matchups.flatMap((matchup) =>
    matchup.votes.filter((vote) => vote.rosterMemberId === voterId),
  );
  assert.equal(votesForGabe.length, 2);
});

test("SECURITY: cannot vote without registering a name on this browser", async () => {
  await resetStore();
  const { bracket } = await createBracket({
    title: "Smoke",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  await assert.rejects(
    () =>
      castVote({
        publicToken: bracket.publicToken,
        browserToken: "unbound-browser",
        matchupSlot: bracket.rounds[0].matchups[0].slot,
        side: "A",
      }),
    /Choose your name/,
  );
});

test("SECURITY: one browser cannot claim two roster names", async () => {
  await resetStore();
  const { bracket } = await createBracket({
    title: "Smoke",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  await claimVoterIdentity({
    publicToken: bracket.publicToken,
    browserToken: "browser-a",
    rosterMemberName: roster[0],
  });

  await assert.rejects(
    () =>
      claimVoterIdentity({
        publicToken: bracket.publicToken,
        browserToken: "browser-a",
        rosterMemberName: roster[1],
      }),
    /already registered/,
  );
});

test("SECURITY: two browsers cannot claim the same roster name", async () => {
  await resetStore();
  const { bracket } = await createBracket({
    title: "Smoke",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  await claimVoterIdentity({
    publicToken: bracket.publicToken,
    browserToken: "browser-a",
    rosterMemberName: roster[0],
  });

  await assert.rejects(
    () =>
      claimVoterIdentity({
        publicToken: bracket.publicToken,
        browserToken: "browser-b",
        rosterMemberName: roster[0],
      }),
    /already registered on another device/,
  );
});

test("SECURITY: incognito stacking requires a fresh browser per fake voter", async () => {
  await resetStore();
  const { bracket } = await createBracket({
    title: "Smoke",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const matchup = bracket.rounds[0].matchups[0];
  for (const [index, member] of bracket.rosterMembers.entries()) {
    await claimVoterIdentity({
      publicToken: bracket.publicToken,
      browserToken: `incognito-${index}`,
      rosterMemberName: member.name,
    });
    await castVote({
      publicToken: bracket.publicToken,
      browserToken: `incognito-${index}`,
      matchupSlot: matchup.slot,
      side: "A",
    });
  }

  const store = await updateStore((s) => s);
  const stored = store.brackets.find((entry) => entry.publicToken === bracket.publicToken)!;
  assert.equal(stored.rounds[0].matchups[0].votes.length, roster.length);
});

test("SECURITY: public snapshot hides ids needed for old replay attacks", async () => {
  await resetStore();
  const { bracket } = await createBracket({
    title: "Smoke",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const snapshot = buildPublicSnapshot(bracket, { rosterMemberId: bracket.rosterMembers[0].id });
  const json = JSON.stringify(snapshot);

  assert.equal(json.includes(bracket.rosterMembers[0].id), false);
  assert.equal(json.includes(bracket.rounds[0].matchups[0].id), false);
  assert.equal(json.includes(bracket.entrants[0].id), false);
  assert.equal(json.includes("publicToken"), false);
});

test("SECURITY: cannot vote on a closed or invalid matchup slot", async () => {
  await resetStore();
  const { bracket } = await createBracket({
    title: "Smoke",
    seedingMode: "manual",
    entrants: ["Mars", "Twix"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });

  const voterId = bracket.rosterMembers[0].id;
  await bindBrowser(bracket.publicToken, "browser-a", voterId);

  await assert.rejects(
    () =>
      castVote({
        publicToken: bracket.publicToken,
        browserToken: "browser-a",
        matchupSlot: 999,
        side: "A",
      }),
    /not open for voting/,
  );
});
