import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdminSnapshot,
  buildPublicSnapshot,
  castVote,
  claimVoterIdentity,
  clearVoterBindings,
  createBracket,
  ensureVoterBinding,
  releaseVoterBinding,
} from "@/lib/workquiz/bracket";
import { getClientInfo, summariseUserAgent } from "@/lib/workquiz/client-info";
import { ensureStore, readStore, updateStore, writeStore } from "@/lib/workquiz/store";
import type { BracketRecord, VoterClientInfo } from "@/lib/workquiz/types";
import { MAX_VOTER_EVENTS, buildVoteWatch, recordVoterEvent } from "@/lib/workquiz/vote-watch";

const roster = ["Gabe", "Alex", "Jordan", "Sam"];

async function resetStore() {
  await ensureStore();
  await writeStore({ brackets: [] });
}

async function newBracket() {
  await resetStore();
  const { bracket } = await createBracket({
    title: "Vote Watch",
    seedingMode: "manual",
    entrants: ["Mars", "Twix", "Kitkat", "Aero"],
    rosterMembers: roster,
    startsAt: new Date().toISOString(),
    totalPlayers: roster.length,
    roundDurationHours: 1,
  });
  return bracket;
}

async function storedBracket(publicToken: string) {
  const store = await readStore();
  return store.brackets.find((entry) => entry.publicToken === publicToken)!;
}

function client(overrides: Partial<VoterClientInfo> & { browserId: string }): VoterClientInfo {
  return { network: "net-office", device: null, agent: "Chrome on Windows", ...overrides };
}

test("getClientInfo stores hashes, never the raw IP or browser token", () => {
  const request = new Request("https://example.test/api", {
    headers: {
      "cf-connecting-ip": "203.0.113.7",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
      "x-workquiz-device": "1920|1080|24|1|America/Toronto|8",
    },
  });

  const info = getClientInfo(request, "secret-browser-token");
  const serialised = JSON.stringify(info);

  assert.equal(serialised.includes("203.0.113.7"), false);
  assert.equal(serialised.includes("secret-browser-token"), false);
  assert.equal(info.agent, "Chrome on Windows");
  assert.ok(info.network && info.device && info.browserId);

  // Same inputs, same pseudonyms: that is what lets Vote Watch compare them.
  assert.deepEqual(getClientInfo(request, "secret-browser-token"), info);
  assert.notEqual(getClientInfo(request, "other-token").browserId, info.browserId);
});

test("summariseUserAgent tells the common browsers apart", () => {
  assert.equal(
    summariseUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0",
    ),
    "Edge on Windows",
  );
  assert.equal(
    summariseUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    ),
    "Safari on iOS",
  );
  assert.equal(summariseUserAgent(null), null);
});

test("a blocked takeover is logged and flagged, and the name stays with its owner", async () => {
  const bracket = await newBracket();
  await claimVoterIdentity({
    publicToken: bracket.publicToken,
    browserToken: "gabe-laptop",
    rosterMemberName: "Gabe",
    client: client({ browserId: "b-gabe" }),
  });

  await assert.rejects(
    () =>
      claimVoterIdentity({
        publicToken: bracket.publicToken,
        browserToken: "sneaky-browser",
        rosterMemberName: "Gabe",
        client: client({ browserId: "b-sneaky" }),
      }),
    /already registered on another device/,
  );

  const stored = await storedBracket(bracket.publicToken);
  assert.equal(stored.voterBindings?.["gabe-laptop"], stored.rosterMembers[0].id);
  assert.equal(stored.voterBindings?.["sneaky-browser"], undefined);
  assert.deepEqual(
    stored.voterEvents?.map((event) => event.type),
    ["claim", "claim_blocked"],
  );

  const watch = buildVoteWatch(stored);
  assert.ok(watch.flags.some((flag) => flag.title.includes("Gabe's name was requested from a new browser")));
});

test("a browser that remembers one name cannot pick another after clearing its main cookie", async () => {
  const bracket = await newBracket();
  const alexId = bracket.rosterMembers[1].id;

  await claimVoterIdentity({
    publicToken: bracket.publicToken,
    browserToken: "token-1",
    rosterMemberName: "Alex",
  });

  // Main cookie cleared (new token) but the remembered-name cookie survived.
  await assert.rejects(
    () =>
      claimVoterIdentity({
        publicToken: bracket.publicToken,
        browserToken: "token-2",
        rosterMemberName: "Jordan",
        rememberedRosterMemberId: alexId,
        client: client({ browserId: "b-2" }),
      }),
    /already registered as Alex/,
  );

  const watch = buildVoteWatch(await storedBracket(bracket.publicToken));
  const flag = watch.flags.find((entry) => entry.severity === "high");
  assert.ok(flag, "switch attempt should be a high flag");
  assert.match(flag.title, /tried to pick Jordan/);
});

test("one browser voting as two people is a high flag", async () => {
  const bracket = await newBracket();
  const shared = client({ browserId: "b-shared" });

  await claimVoterIdentity({
    publicToken: bracket.publicToken,
    browserToken: "shared-browser",
    rosterMemberName: "Jordan",
    client: shared,
  });
  await castVote({
    publicToken: bracket.publicToken,
    browserToken: "shared-browser",
    matchupSlot: bracket.rounds[0].matchups[0].slot,
    side: "A",
    client: shared,
  });

  // Admin resets everyone; the same browser comes back as someone else.
  await updateStore((store) => {
    const mutable = store.brackets.find((entry) => entry.publicToken === bracket.publicToken)!;
    clearVoterBindings(mutable);
    return store;
  });
  await claimVoterIdentity({
    publicToken: bracket.publicToken,
    browserToken: "shared-browser",
    rosterMemberName: "Sam",
    client: shared,
  });

  const watch = buildVoteWatch(await storedBracket(bracket.publicToken));
  const flag = watch.flags.find((entry) => entry.severity === "high");
  assert.ok(flag);
  assert.deepEqual(flag.rosterMemberNames, ["Jordan", "Sam"]);
  assert.match(flag.title, /Browser 1 was used as 2 different people/);
});

test("two browsers with the same device details on one network are a medium flag", async () => {
  const bracket = await newBracket();

  await claimVoterIdentity({
    publicToken: bracket.publicToken,
    browserToken: "chrome",
    rosterMemberName: "Alex",
    client: client({ browserId: "b-chrome", device: "dev-1" }),
  });
  await claimVoterIdentity({
    publicToken: bracket.publicToken,
    browserToken: "edge",
    rosterMemberName: "Sam",
    client: client({ browserId: "b-edge", device: "dev-1", agent: "Edge on Windows" }),
  });
  // A colleague on a different device is not caught up in it.
  await claimVoterIdentity({
    publicToken: bracket.publicToken,
    browserToken: "colleague",
    rosterMemberName: "Jordan",
    client: client({ browserId: "b-colleague", device: "dev-2" }),
  });

  const watch = buildVoteWatch(await storedBracket(bracket.publicToken));
  assert.equal(watch.flags.length, 1);
  assert.equal(watch.flags[0].severity, "medium");
  assert.deepEqual(watch.flags[0].rosterMemberNames, ["Alex", "Sam"]);
});

test("honest voters on one office network raise no flags", async () => {
  const bracket = await newBracket();
  for (const [index, name] of roster.entries()) {
    await claimVoterIdentity({
      publicToken: bracket.publicToken,
      browserToken: `browser-${index}`,
      rosterMemberName: name,
      client: client({ browserId: `b-${index}`, device: `dev-${index}` }),
    });
  }

  const watch = buildVoteWatch(await storedBracket(bracket.publicToken));
  assert.deepEqual(watch.flags, []);
  assert.equal(watch.members.filter((member) => member.registered).length, roster.length);
});

test("admin release frees one name, logs it, and lets a new device take it", async () => {
  const bracket = await newBracket();
  const gabeId = bracket.rosterMembers[0].id;

  await claimVoterIdentity({
    publicToken: bracket.publicToken,
    browserToken: "old-phone",
    rosterMemberName: "Gabe",
  });

  await updateStore((store) => {
    const mutable = store.brackets.find((entry) => entry.publicToken === bracket.publicToken)!;
    assert.equal(releaseVoterBinding(mutable, gabeId), true);
    return store;
  });

  const claimed = await claimVoterIdentity({
    publicToken: bracket.publicToken,
    browserToken: "new-phone",
    rosterMemberName: "Gabe",
  });
  assert.equal(claimed.rosterMemberId, gabeId);

  const stored = await storedBracket(bracket.publicToken);
  assert.deepEqual(
    stored.voterEvents?.map((event) => event.type),
    ["claim", "release", "claim"],
  );
  assert.throws(() => releaseVoterBinding(stored, "not-a-member"), /Roster member not found/);
});

test("votes keep their client info and the public snapshot never exposes Vote Watch", async () => {
  const bracket = await newBracket();
  await claimVoterIdentity({
    publicToken: bracket.publicToken,
    browserToken: "browser-a",
    rosterMemberName: "Gabe",
  });
  await castVote({
    publicToken: bracket.publicToken,
    browserToken: "browser-a",
    matchupSlot: bracket.rounds[0].matchups[0].slot,
    side: "A",
    client: client({ browserId: "b-a" }),
  });

  const stored = await storedBracket(bracket.publicToken);
  assert.equal(stored.rounds[0].matchups[0].votes[0].client?.browserId, "b-a");

  const publicSnapshot = JSON.stringify(buildPublicSnapshot(stored, {}));
  assert.equal(publicSnapshot.includes("voteWatch"), false);
  assert.equal(publicSnapshot.includes("voterEvents"), false);
  assert.equal(publicSnapshot.includes("b-a"), false);

  const adminSnapshot = await buildAdminSnapshot(stored, "token");
  assert.ok(adminSnapshot.voteWatch);
  assert.equal(adminSnapshot.voteWatch.members.find((member) => member.name === "Gabe")?.votesCast, 1);
});

test("the event log is capped so the store row cannot grow without bound", () => {
  const bracket = { rosterMembers: [], rounds: [], voterEvents: [] } as unknown as BracketRecord;
  for (let index = 0; index < MAX_VOTER_EVENTS + 25; index += 1) {
    recordVoterEvent(bracket, { type: "claim_blocked", rosterMemberId: null, client: null, note: `n${index}` });
  }

  assert.equal(bracket.voterEvents?.length, MAX_VOTER_EVENTS);
  assert.equal(bracket.voterEvents?.[0].note, "n25");
});

test("a browser the admin freed a name from cannot grab it back, by polling or by picking it", async () => {
  const bracket = await newBracket();
  const alexId = bracket.rosterMembers[1].id;

  await claimVoterIdentity({ publicToken: bracket.publicToken, browserToken: "old-laptop", rosterMemberName: "Alex" });
  await updateStore((store) => {
    releaseVoterBinding(store.brackets.find((entry) => entry.publicToken === bracket.publicToken)!, alexId);
    return store;
  });

  // The old tab polls with its remembered-name cookie: no silent re-grab.
  const migrated = await ensureVoterBinding({
    publicToken: bracket.publicToken,
    browserToken: "old-laptop",
    rememberedRosterMemberId: alexId,
  });
  assert.equal(migrated, null);

  // Alex's new phone takes the name...
  await claimVoterIdentity({ publicToken: bracket.publicToken, browserToken: "new-phone", rosterMemberName: "Alex" });

  // ...and the old laptop cannot take it back by tapping the name either.
  await assert.rejects(
    () =>
      claimVoterIdentity({
        publicToken: bracket.publicToken,
        browserToken: "old-laptop",
        rosterMemberName: "Alex",
        rememberedRosterMemberId: alexId,
      }),
    /already registered on another device/,
  );

  const stored = await storedBracket(bracket.publicToken);
  assert.equal(stored.voterBindings?.["new-phone"], alexId);
});
