import assert from "node:assert/strict";
import test from "node:test";

import { advanceBracket, createBracket, disableBracket, restartBracket } from "@/lib/workquiz/bracket";
import { ensureStore, writeStore } from "@/lib/workquiz/store";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const roster = ["Gabe", "Alex", "Jordan", "Sam"];

// 6:00 AM to 8:00 PM Toronto (EST) on Monday 2026-01-05, as the create form sends it.
const WINDOW_START = Date.parse("2026-01-05T11:00:00.000Z");
const WINDOW_END = Date.parse("2026-01-06T01:00:00.000Z");

async function resetStore() {
  await ensureStore();
  await writeStore({ brackets: [] });
}

async function dailyBracket() {
  await resetStore();
  const { bracket } = await createBracket({
    title: "Restart",
    seedingMode: "manual",
    entrants: ["A", "B", "C", "D", "E", "F", "G", "H"],
    rosterMembers: roster,
    startsAt: new Date(WINDOW_START).toISOString(),
    endsAt: new Date(WINDOW_END).toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 14,
  });
  return bracket;
}

function times(bracket: Awaited<ReturnType<typeof dailyBracket>>) {
  return bracket.rounds.map((round) => ({
    start: Date.parse(round.startsAt),
    end: Date.parse(round.endsAt),
    status: round.status,
  }));
}

test("a shut-down tournament cannot be restarted", async () => {
  const bracket = await dailyBracket();
  disableBracket(bracket);

  assert.throws(() => restartBracket(bracket, new Date(WINDOW_START + 3 * DAY)), /shut down/i);
  assert.equal(bracket.status, "disabled");
});

test("restart keeps the daily 6 AM to 8 PM windows, one round per day", async () => {
  const bracket = await dailyBracket();
  const now = new Date(WINDOW_START + 3 * DAY + HOUR); // Thursday 7 AM, inside that day's window

  restartBracket(bracket, now);
  const rounds = times(bracket);

  for (const round of rounds) {
    assert.equal(round.end - round.start, 14 * HOUR, "each round is still a 14 hour window");
  }
  for (let index = 1; index < rounds.length; index += 1) {
    assert.equal(rounds[index].start - rounds[index - 1].start, DAY, "rounds are still a day apart");
  }
});

test("restart opens round one in today's window when it is still open", async () => {
  const bracket = await dailyBracket();
  const now = new Date(WINDOW_START + 3 * DAY + HOUR); // Thursday 7 AM

  restartBracket(bracket, now);
  const [first] = times(bracket);

  assert.equal(first.start, WINDOW_START + 3 * DAY, "Thursday 6 AM");
  assert.equal(first.status, "live");

  // The rebuilt schedule must not be in the past: advancing now changes nothing.
  advanceBracket(bracket, now);
  assert.equal(bracket.rounds[0].status, "live");
  assert.equal(bracket.status, "live");
});

test("restart after today's window has closed waits for tomorrow's", async () => {
  const bracket = await dailyBracket();
  const now = new Date(WINDOW_END + 3 * DAY + HOUR); // Thursday 9 PM

  restartBracket(bracket, now);
  const [first] = times(bracket);

  assert.equal(first.start, WINDOW_START + 4 * DAY, "Friday 6 AM");
  assert.equal(first.status, "upcoming");
});

test("restart of a back-to-back schedule starts round one now and keeps round lengths", async () => {
  await resetStore();
  const originalStart = Date.parse("2026-01-05T15:00:00.000Z");
  const { bracket } = await createBracket({
    title: "Back to back",
    seedingMode: "manual",
    entrants: ["A", "B", "C", "D"],
    rosterMembers: roster,
    startsAt: new Date(originalStart).toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 48,
  });
  const now = new Date(originalStart + 10 * DAY);

  restartBracket(bracket, now);
  const rounds = times(bracket);

  assert.equal(rounds[0].start, now.getTime());
  assert.equal(rounds[0].status, "live");
  assert.equal(rounds[0].end - rounds[0].start, 48 * HOUR);
  assert.equal(rounds[1].start, rounds[0].end);
});
