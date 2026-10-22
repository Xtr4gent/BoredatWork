import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdminSnapshot,
  buildPublicSnapshot,
  castVote,
  claimVoterIdentity,
  clearVoterBindings,
  createBracket,
  ensureClaimForBoundBrowser,
  ensureVoterBinding,
  releaseVoterBinding,
} from "@/lib/workquiz/bracket";
import { browserIdForToken, getClientInfo, summariseUserAgent } from "@/lib/workquiz/client-info";
import { ensureStore, readStore, updateStore, writeStore } from "@/lib/workquiz/store";
import type { BracketRecord, VoterClientInfo } from "@/lib/workquiz/types";
import { MAX_VOTER_EVENTS, buildVoteWatch, recordVoterEvent } from "@/lib/workquiz/vote-watch";
import {
  boundBrowserNeedsClaimCookie,
  formatRememberedClaim,
  isRememberedClaimCurrent,
  upgradeLegacyReleases,
} from "@/lib/workquiz/voter";

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

  const alex = await claimVoterIdentity({
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
        remembered: formatRememberedClaim(alexId, alex.claimId),
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
  assert.equal(flag.title, "Browser B-SHARED was used as 2 different people");
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

async function claimThenRelease(name: string) {
  const bracket = await newBracket();
  const member = bracket.rosterMembers.find((entry) => entry.name === name)!;
  const old = await claimVoterIdentity({
    publicToken: bracket.publicToken,
    browserToken: "old-laptop",
    rosterMemberName: name,
  });
  await updateStore((store) => {
    releaseVoterBinding(store.brackets.find((entry) => entry.publicToken === bracket.publicToken)!, member.id);
    return store;
  });
  return { bracket, memberId: member.id, oldCookie: formatRememberedClaim(member.id, old.claimId) };
}

test("a freed browser cannot grab the name back by polling", async () => {
  const { bracket, oldCookie } = await claimThenRelease("Alex");

  const migrated = await ensureVoterBinding({
    publicToken: bracket.publicToken,
    browserToken: "old-laptop",
    remembered: oldCookie,
  });
  assert.equal(migrated, null);
});

// Greptile finding 1: before the new device registers, nobody holds the
// name, so the old browser must be refused on its stale claim alone.
test("a freed browser cannot re-pick the name before the new device registers", async () => {
  const { bracket, memberId, oldCookie } = await claimThenRelease("Alex");

  await assert.rejects(
    () =>
      claimVoterIdentity({
        publicToken: bracket.publicToken,
        browserToken: "old-laptop",
        rosterMemberName: "Alex",
        remembered: oldCookie,
      }),
    /freed from this browser/,
  );

  // The freed name is still available for the new device.
  const fresh = await claimVoterIdentity({
    publicToken: bracket.publicToken,
    browserToken: "new-phone",
    rosterMemberName: "Alex",
  });
  assert.equal(fresh.rosterMemberId, memberId);
});

// Greptile finding 2: clearing the main cookie gives the old browser a fresh
// token; its stale remembered claim must still not migrate the name.
test("a freed browser that clears its main cookie still cannot take the name from the new device", async () => {
  const { bracket, memberId, oldCookie } = await claimThenRelease("Alex");

  await claimVoterIdentity({ publicToken: bracket.publicToken, browserToken: "new-phone", rosterMemberName: "Alex" });

  for (const freshToken of ["old-laptop", "old-laptop-new-token"]) {
    const migrated = await ensureVoterBinding({
      publicToken: bracket.publicToken,
      browserToken: freshToken,
      remembered: oldCookie,
    });
    assert.equal(migrated, null);
    await assert.rejects(
      () =>
        claimVoterIdentity({
          publicToken: bracket.publicToken,
          browserToken: freshToken,
          rosterMemberName: "Alex",
          remembered: oldCookie,
        }),
      /already registered on another device/,
    );
  }

  const stored = await storedBracket(bracket.publicToken);
  assert.equal(stored.voterBindings?.["new-phone"], memberId);
  assert.equal(Object.values(stored.voterBindings ?? {}).filter((id) => id === memberId).length, 1);
});

test("the current device still recovers its own name after its main cookie drifts", async () => {
  const bracket = await newBracket();
  const claim = await claimVoterIdentity({
    publicToken: bracket.publicToken,
    browserToken: "phone-token-1",
    rosterMemberName: "Sam",
  });

  const migrated = await ensureVoterBinding({
    publicToken: bracket.publicToken,
    browserToken: "phone-token-2",
    remembered: formatRememberedClaim(claim.rosterMemberId, claim.claimId),
  });
  assert.equal(migrated, claim.rosterMemberId);
});

// Greptile finding 3.
test("Vote Watch labels come from the stored ids, not the order events appear in", async () => {
  const bracket = await newBracket();
  await claimVoterIdentity({
    publicToken: bracket.publicToken,
    browserToken: "a",
    rosterMemberName: "Gabe",
    client: client({ browserId: "aaaa1111" }),
  });
  await claimVoterIdentity({
    publicToken: bracket.publicToken,
    browserToken: "b",
    rosterMemberName: "Sam",
    client: client({ browserId: "bbbb2222" }),
  });

  const stored = await storedBracket(bracket.publicToken);
  const before = buildVoteWatch(stored).members.find((member) => member.name === "Sam")?.browserLabel;
  stored.voterEvents = stored.voterEvents?.slice(1); // the capped log dropped Gabe's claim
  const after = buildVoteWatch(stored).members.find((member) => member.name === "Sam")?.browserLabel;

  assert.equal(before, `Browser ${browserIdForToken("b").toUpperCase()}`);
  assert.equal(after, before);
});

// Greptile #6 finding 3: browsers whose ids share a prefix get distinct labels.
test("Vote Watch never gives two different browsers the same label", () => {
  const bracket = {
    rosterMembers: [
      { id: "m1", name: "Gabe" },
      { id: "m2", name: "Sam" },
    ],
    rounds: [],
    voterBindings: {},
    voterEvents: [
      { id: "e1", type: "claim", at: "2026-10-15T10:00:00Z", rosterMemberId: "m1", client: client({ browserId: "aaaa111111" }) },
      { id: "e2", type: "claim", at: "2026-10-15T10:01:00Z", rosterMemberId: "m2", client: client({ browserId: "aaaa222222" }) },
    ],
  } as unknown as BracketRecord;

  const labels = buildVoteWatch(bracket).recentEvents.map((event) => event.browserLabel);
  assert.equal(new Set(labels).size, 2);
});

// Greptile #6 finding 2: a full reset or restart is a clean slate again.
test("resetting all names lets a previously freed browser pick its name again", async () => {
  const { bracket, memberId, oldCookie } = await claimThenRelease("Jordan");

  await updateStore((store) => {
    clearVoterBindings(store.brackets.find((entry) => entry.publicToken === bracket.publicToken)!);
    return store;
  });

  const again = await claimVoterIdentity({
    publicToken: bracket.publicToken,
    browserToken: "old-laptop",
    rosterMemberName: "Jordan",
    remembered: oldCookie,
  });
  assert.equal(again.rosterMemberId, memberId);
});

// Greptile #6 finding 1: releases recorded by the first Vote Watch build
// (per-token releasedBrowserTokens) survive the upgrade.
test("a release made before the claim-id upgrade still keeps the old browser out", async () => {
  const bracket = await newBracket();
  const alexId = bracket.rosterMembers[1].id;

  // Store exactly as the first build left it: name freed, token remembered,
  // no memberClaims, and the old browser still holding a member-only cookie.
  await updateStore((store) => {
    const mutable = store.brackets.find((entry) => entry.publicToken === bracket.publicToken)! as BracketRecord & {
      releasedBrowserTokens?: Record<string, string>;
    };
    mutable.voterBindings = {};
    mutable.releasedBrowserTokens = { "old-laptop": alexId };
    delete mutable.memberClaims;
    return store;
  });

  const migrated = await ensureVoterBinding({
    publicToken: bracket.publicToken,
    browserToken: "old-laptop-new-token",
    remembered: alexId,
  });
  assert.equal(migrated, null);

  await assert.rejects(
    () =>
      claimVoterIdentity({
        publicToken: bracket.publicToken,
        browserToken: "old-laptop",
        rosterMemberName: "Alex",
        remembered: alexId,
      }),
    /freed from this browser/,
  );

  const stored = (await readStore()).brackets.find((entry) => entry.publicToken === bracket.publicToken)! as BracketRecord & {
    releasedBrowserTokens?: Record<string, string>;
  };
  assert.equal(stored.releasedBrowserTokens, undefined);
  assert.equal(upgradeLegacyReleases(stored), false);
});

// Greptile #6 round 2, finding 1: a name re-registered on a new device before
// the upgrade stays recoverable for that device, and only for that device.
test("the upgrade keeps a name re-registered after a legacy release recoverable for its new holder", async () => {
  const bracket = await newBracket();
  const alexId = bracket.rosterMembers[1].id;

  // First build's state: Alex freed from old-laptop, then picked on new-phone;
  // both browsers hold member-only cookies, no memberClaims.
  await updateStore((store) => {
    const mutable = store.brackets.find((entry) => entry.publicToken === bracket.publicToken)! as BracketRecord & {
      releasedBrowserTokens?: Record<string, string>;
    };
    mutable.voterBindings = { "new-phone": alexId };
    mutable.releasedBrowserTokens = { "old-laptop": alexId };
    delete mutable.memberClaims;
    return store;
  });

  const upgraded = (await readStore()).brackets.find((entry) => entry.publicToken === bracket.publicToken)!;
  assert.ok(upgraded.memberClaims?.[alexId] && !upgraded.memberClaims[alexId].startsWith("released:"));

  // The old laptop's member-only cookie is now stale...
  assert.equal(isRememberedClaimCurrent(upgraded, alexId), false);

  // ...while the new phone is handed the live claim on its next poll...
  assert.equal(boundBrowserNeedsClaimCookie(upgraded, "new-phone", alexId), true);
  const claim = await ensureClaimForBoundBrowser({ publicToken: bracket.publicToken, browserToken: "new-phone" });
  assert.equal(claim?.claimId, upgraded.memberClaims?.[alexId]);
  const phoneCookie = formatRememberedClaim(alexId, claim!.claimId);
  assert.equal(boundBrowserNeedsClaimCookie(upgraded, "new-phone", phoneCookie), false);

  // ...so if the phone's main cookie later drifts, it still recovers its name.
  const recovered = await ensureVoterBinding({
    publicToken: bracket.publicToken,
    browserToken: "new-phone-new-token",
    remembered: phoneCookie,
  });
  assert.equal(recovered, alexId);
});

// Greptile #6 round 2, finding 3: after a full reset, a browser whose claim
// was only superseded (not freed) may pick its name if nobody holds it.
test("after a full reset a superseded (not freed) browser can pick its name again", async () => {
  const bracket = await newBracket();
  const first = await claimVoterIdentity({ publicToken: bracket.publicToken, browserToken: "laptop", rosterMemberName: "Sam" });
  const laptopCookie = formatRememberedClaim(first.rosterMemberId, first.claimId);

  // Sam's laptop cookie drifts; Sam re-picks there with the current claim,
  // which mints a newer claim the laptop's old cookie no longer matches.
  await claimVoterIdentity({
    publicToken: bracket.publicToken,
    browserToken: "laptop-2",
    rosterMemberName: "Sam",
    remembered: laptopCookie,
  });

  await updateStore((store) => {
    clearVoterBindings(store.brackets.find((entry) => entry.publicToken === bracket.publicToken)!);
    return store;
  });

  const again = await claimVoterIdentity({
    publicToken: bracket.publicToken,
    browserToken: "laptop",
    rosterMemberName: "Sam",
    remembered: laptopCookie,
  });
  assert.equal(again.rosterMemberId, first.rosterMemberId);
});

test("a browser that never registered does not get a claim cookie", async () => {
  const bracket = await newBracket();
  const stored = await storedBracket(bracket.publicToken);
  assert.equal(boundBrowserNeedsClaimCookie(stored, "stranger", null), false);
  assert.equal(await ensureClaimForBoundBrowser({ publicToken: bracket.publicToken, browserToken: "stranger" }), null);
});

test("a cleared cookie on one PC reads as 'new browser, same PC', a second device does not", async () => {
  const bracket = await newBracket();
  const [gabe, alex] = bracket.rosterMembers;
  // Gabe: day 1 cookie, then a recovery (no device hint) and votes from a new
  // cookie on the same PC, the Staples case from 2026-10-17.
  recordVoterEvent(bracket, { type: "claim", rosterMemberId: gabe.id, client: client({ browserId: "b-day1", device: "pc-1" }) });
  recordVoterEvent(bracket, { type: "reclaim", rosterMemberId: gabe.id, client: client({ browserId: "b-day2" }) });
  bracket.rounds[0].matchups[0].votes.push({
    id: "v1",
    rosterMemberId: gabe.id,
    entrantId: bracket.rounds[0].matchups[0].entrantAId!,
    createdAt: new Date().toISOString(),
    client: client({ browserId: "b-day2", device: "pc-1" }),
  });
  // Alex: two cookies on different devices (phone and PC).
  recordVoterEvent(bracket, { type: "claim", rosterMemberId: alex.id, client: client({ browserId: "b-pc", device: "pc-2" }) });
  recordVoterEvent(bracket, {
    type: "reclaim",
    rosterMemberId: alex.id,
    client: client({ browserId: "b-phone", device: "phone-1", agent: "Safari on iOS" }),
  });

  const members = buildVoteWatch(bracket).members;
  const gabeRow = members.find((member) => member.rosterMemberId === gabe.id)!;
  const alexRow = members.find((member) => member.rosterMemberId === alex.id)!;
  assert.equal(gabeRow.browsersUsed, 2);
  assert.equal(gabeRow.browsersLookLikeOnePc, true);
  assert.equal(alexRow.browsersUsed, 2);
  assert.equal(alexRow.browsersLookLikeOnePc, false);
});
