import assert from "node:assert/strict";
import test from "node:test";

import { advanceReadyBrackets, createBracket } from "@/lib/workquiz/bracket";
import { ensureStore, readStore, updateStore, writeStore } from "@/lib/workquiz/store";
import { recordVoterEvent } from "@/lib/workquiz/vote-watch";

const roster = ["Gabe", "Alex", "Jordan", "Sam"];

async function resetStore() {
  await ensureStore();
  await writeStore({ brackets: [] });
}

/** A bracket whose first round is scheduled an hour out. */
async function upcomingBracket(now: Date) {
  await resetStore();
  const { bracket } = await createBracket({
    title: "Advance Race",
    seedingMode: "manual",
    entrants: ["Mars", "Twix", "Kitkat", "Aero"],
    rosterMembers: roster,
    startsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 6,
  });
  return bracket;
}

async function storedBracket(publicToken: string) {
  return (await readStore()).brackets.find((entry) => entry.publicToken === publicToken)!;
}

test("advanceReadyBrackets stays read-only when no round is due", async () => {
  const now = new Date();
  const bracket = await upcomingBracket(now);
  const before = JSON.stringify(await readStore());

  let lockedWriteStarted = false;
  await advanceReadyBrackets(now, {
    beforeLockedWrite: async () => {
      lockedWriteStarted = true;
    },
  });

  assert.equal(lockedWriteStarted, false);
  assert.equal(JSON.stringify(await readStore()), before);
  assert.equal((await storedBracket(bracket.publicToken)).rounds[0].status, "upcoming");
});

test("advanceReadyBrackets keeps a write committed between its check and its save", async () => {
  const now = new Date();
  const bracket = await upcomingBracket(now);
  const later = new Date(now.getTime() + 2 * 60 * 60 * 1000); // round one is now due to open
  const gabeId = bracket.rosterMembers[0].id;

  const brackets = await advanceReadyBrackets(later, {
    // Someone picks their name while the advance is in flight. The old code
    // wrote back the store it read before this, erasing the pick.
    beforeLockedWrite: async () => {
      await updateStore((store) => {
        const mutable = store.brackets.find((entry) => entry.publicToken === bracket.publicToken)!;
        recordVoterEvent(mutable, { type: "claim", rosterMemberId: gabeId, client: null, note: "mid-advance" });
        return store;
      });
    },
  });

  const stored = await storedBracket(bracket.publicToken);
  assert.notEqual(stored.rounds[0].status, "upcoming", "the due round should have advanced");
  assert.ok(
    stored.voterEvents?.some((event) => event.note === "mid-advance"),
    "the write committed mid-advance must survive",
  );

  // The caller gets the copy that was saved, not the stale pre-lock read.
  const returned = brackets.find((entry) => entry.publicToken === bracket.publicToken)!;
  assert.ok(returned.voterEvents?.some((event) => event.note === "mid-advance"));
});
