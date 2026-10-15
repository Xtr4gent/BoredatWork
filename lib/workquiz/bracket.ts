import { nanoid } from "nanoid";

import {
  DEFAULT_REVOTE_DURATION_HOURS,
  DEFAULT_ROUND_DURATION_HOURS,
} from "@/lib/workquiz/constants";
import { publish } from "@/lib/workquiz/realtime";
import { schedulePendingRoundStartPings } from "@/lib/workquiz/round-start-ping";
import { readStore, updateStore } from "@/lib/workquiz/store";
import {
  AdminVoteEntry,
  AdminHistoryItem,
  BracketRecord,
  BracketSnapshot,
  BracketSnapshotRosterStatus,
  CreateBracketInput,
  EntrantRecord,
  MatchupRecord,
  PublicBracketSnapshot,
  PublicBracketSnapshotRosterStatus,
  RosterMemberRecord,
  RoundRecord,
  StoreShape,
  VoterClientInfo,
} from "@/lib/workquiz/types";
import { browserIdForToken } from "@/lib/workquiz/client-info";
import { buildVoteWatch, recordVoterEvent } from "@/lib/workquiz/vote-watch";
import {
  bindBrowserToRosterMember,
  browserTokenForRosterMember,
  findRosterMemberByName,
  releaseRosterMemberBinding,
  clearReleasedClaims,
  isReleasedClaim,
  isRememberedClaimCurrent,
  parseRememberedClaim,
  releasedClaimMarker,
  rememberedRosterMemberId,
  rosterMemberIdForBrowser,
  tryMigrateVoterBinding,
} from "@/lib/workquiz/voter";

/** Mints the secret for a new registration; older remembered cookies stop matching. */
function mintMemberClaim(bracket: BracketRecord, rosterMemberId: string) {
  const claimId = nanoid(16);
  bracket.memberClaims ??= {};
  bracket.memberClaims[rosterMemberId] = claimId;
  return claimId;
}
import {
  addHours,
  hashValue,
  isoDate,
  nextPowerOfTwo,
  normalizeContenderInputs,
  shuffle,
  slugify,
} from "@/lib/workquiz/utils";

function parseSchedule(startsAt: string, roundDurationHours: number, count: number, endsAt?: string) {
  if (endsAt) {
    return Array.from({ length: count }, (_, index) => ({
      startsAt: addHours(startsAt, 24 * index),
      endsAt: addHours(endsAt, 24 * index),
    }));
  }

  return Array.from({ length: count }, (_, index) => {
    const roundStart = index === 0 ? isoDate(startsAt) : addHours(startsAt, roundDurationHours * index);
    return {
      startsAt: roundStart,
      endsAt: addHours(roundStart, roundDurationHours),
    };
  });
}

function labelForRound(roundNumber: number, totalRounds: number) {
  const roundsRemaining = totalRounds - roundNumber + 1;

  if (roundsRemaining === 1) {
    return "Finals";
  }

  if (roundsRemaining === 2) {
    return "Semifinals";
  }

  if (roundsRemaining === 3) {
    return "Quarterfinals";
  }

  return `Round ${roundNumber}`;
}

function winnerNameForBracket(bracket: BracketRecord) {
  const lastRound = bracket.rounds.at(-1);
  const finalMatchup = lastRound?.matchups.at(0);
  const winnerEntrantId = finalMatchup?.winnerEntrantId;
  if (!winnerEntrantId) {
    return null;
  }

  return bracket.entrants.find((entrant) => entrant.id === winnerEntrantId)?.name ?? null;
}

function bracketKind(bracket: BracketRecord) {
  return bracket.kind ?? "public";
}

async function buildAdminHistory(brackets?: BracketRecord[]): Promise<AdminHistoryItem[]> {
  return (brackets ?? (await readStore()).brackets)
    .map((bracket) => {
      if (bracketKind(bracket) === "test") {
        return null;
      }

      const winnerName = winnerNameForBracket(bracket);
      if (!winnerName) {
        return null;
      }

      return {
        id: bracket.id,
        title: bracket.title,
        winnerName,
        tournamentDate: bracket.rounds[0]?.startsAt ?? bracket.publishedAt,
        completedAt: bracket.rounds.at(-1)?.endsAt ?? bracket.publishedAt,
        entrantNames: bracket.entrants.map((entrant) => entrant.name),
        rosterMemberNames: bracket.rosterMembers.map((member) => member.name),
        seedingMode: bracket.seedingMode,
      };
    })
    .filter((item): item is AdminHistoryItem => item !== null)
    .sort((left, right) => new Date(right.tournamentDate).getTime() - new Date(left.tournamentDate).getTime());
}

export async function listBracketHistory(limit?: number, brackets?: BracketRecord[]) {
  const history = await buildAdminHistory(brackets);

  if (typeof limit === "number") {
    return history.slice(0, limit);
  }

  return history;
}

function buildRoundsForBracket(
  bracket: BracketRecord,
  startsAt: string,
  roundDurationHours: number,
  endsAt?: string,
) {
  const directQualifierEntrantIds = new Set(bracket.directQualifierEntrantIds ?? []);
  const hasManualQualifiers =
    directQualifierEntrantIds.size > 0 &&
    directQualifierEntrantIds.size < bracket.entrants.length;

  if (!hasManualQualifiers) {
    const bracketSize = nextPowerOfTwo(bracket.entrants.length);
    const totalRounds = Math.log2(bracketSize);
    const roundSchedule = parseSchedule(startsAt, roundDurationHours, totalRounds, endsAt);
    const seedToEntrant = new Map(bracket.entrants.map((entrant) => [entrant.seed, entrant]));

    const rounds: RoundRecord[] = Array.from({ length: totalRounds }, (_, index) => ({
      id: nanoid(),
      number: index + 1,
      label: labelForRound(index + 1, totalRounds),
      startsAt: roundSchedule[index].startsAt,
      endsAt: roundSchedule[index].endsAt,
      status:
        index === 0 && new Date(roundSchedule[index].startsAt).getTime() <= Date.now()
          ? "live"
          : "upcoming",
      matchups: [],
    }));

    rounds[0].matchups = Array.from({ length: bracketSize / 2 }, (_, index) => {
      const seedA = index * 2 + 1;
      const seedB = index * 2 + 2;

      return {
        id: nanoid(),
        slot: index + 1,
        entrantAId: seedToEntrant.get(seedA)?.id ?? null,
        entrantBId: seedToEntrant.get(seedB)?.id ?? null,
        winnerEntrantId: null,
        status: rounds[0].status === "live" ? "live" : "pending",
        votes: [],
        updatedAt: new Date().toISOString(),
      };
    });

    for (let roundIndex = 1; roundIndex < totalRounds; roundIndex += 1) {
      rounds[roundIndex].matchups = Array.from(
        { length: rounds[roundIndex - 1].matchups.length / 2 },
        (_, index) => ({
          id: nanoid(),
          slot: index + 1,
          entrantAId: null,
          entrantBId: null,
          winnerEntrantId: null,
          status: "pending",
          votes: [],
          updatedAt: new Date().toISOString(),
        }),
      );
    }

    resolveAutomaticWinners({ ...bracket, rounds });
    return rounds;
  }

  const sortedEntrants = [...bracket.entrants].sort((left, right) => left.seed - right.seed);
  const directQualifiers = sortedEntrants.filter((entrant) => directQualifierEntrantIds.has(entrant.id));
  const playInEntrants = sortedEntrants.filter((entrant) => !directQualifierEntrantIds.has(entrant.id));
  const playInMatchupCount = Math.ceil(playInEntrants.length / 2);
  const mainEntrantCount = directQualifiers.length + playInMatchupCount;
  const mainBracketSize = nextPowerOfTwo(Math.max(2, mainEntrantCount));
  const mainRounds = Math.log2(mainBracketSize);
  const totalRounds = mainRounds + 1;
  const roundSchedule = parseSchedule(startsAt, roundDurationHours, totalRounds, endsAt);

  const rounds: RoundRecord[] = Array.from({ length: totalRounds }, (_, index) => ({
    id: nanoid(),
    number: index + 1,
    label:
      index === 0
        ? "Play-In"
        : labelForRound(index, mainRounds),
    startsAt: roundSchedule[index].startsAt,
    endsAt: roundSchedule[index].endsAt,
    status:
      index === 0 && new Date(roundSchedule[index].startsAt).getTime() <= Date.now()
        ? "live"
        : "upcoming",
    matchups: [],
  }));

  rounds[0].matchups = Array.from({ length: playInMatchupCount }, (_, index) => ({
    id: nanoid(),
    slot: index + 1,
    entrantAId: playInEntrants[index * 2]?.id ?? null,
    entrantBId: playInEntrants[index * 2 + 1]?.id ?? null,
    winnerEntrantId: null,
    status: rounds[0].status === "live" ? "live" : "pending",
    votes: [],
    updatedAt: new Date().toISOString(),
  }));

  rounds[1].matchups = Array.from({ length: mainBracketSize / 2 }, (_, index) => ({
    id: nanoid(),
    slot: index + 1,
    entrantAId: null,
    entrantBId: null,
    winnerEntrantId: null,
    status: "pending",
    votes: [],
    updatedAt: new Date().toISOString(),
  }));

  const reservedSlots = new Set<string>();
  for (let playInSlot = 1; playInSlot <= playInMatchupCount; playInSlot += 1) {
    const targetMatchup = rounds[1].matchups[Math.floor((playInSlot - 1) / 2)];
    if (!targetMatchup) {
      continue;
    }
    if ((playInSlot - 1) % 2 === 0) {
      reservedSlots.add(`${targetMatchup.slot}:A`);
    } else {
      reservedSlots.add(`${targetMatchup.slot}:B`);
    }
  }

  const firstMainRoundSlots = rounds[1].matchups.flatMap((matchup) => [
    { matchup, side: "A" as const },
    { matchup, side: "B" as const },
  ]);
  const fillableSlots = firstMainRoundSlots.filter(
    (slot) => !reservedSlots.has(`${slot.matchup.slot}:${slot.side}`),
  );

  directQualifiers.forEach((entrant, index) => {
    const slot = fillableSlots[index];
    if (!slot) {
      return;
    }
    if (slot.side === "A") {
      slot.matchup.entrantAId = entrant.id;
    } else {
      slot.matchup.entrantBId = entrant.id;
    }
  });

  for (let roundIndex = 2; roundIndex < totalRounds; roundIndex += 1) {
    rounds[roundIndex].matchups = Array.from(
      { length: rounds[roundIndex - 1].matchups.length / 2 },
      (_, index) => ({
        id: nanoid(),
        slot: index + 1,
        entrantAId: null,
        entrantBId: null,
        winnerEntrantId: null,
        status: "pending",
        votes: [],
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  resolveAutomaticWinners({ ...bracket, rounds });
  return rounds;
}

function deriveRoundDurationHours(input: CreateBracketInput) {
  if (input.endsAt) {
    const start = new Date(input.startsAt).getTime();
    const end = new Date(input.endsAt).getTime();
    const durationHours = (end - start) / (1000 * 60 * 60);

    if (!Number.isFinite(durationHours) || durationHours <= 0) {
      throw new Error("Round one end time must be later than the start time.");
    }

    return durationHours;
  }

  return input.roundDurationHours || DEFAULT_ROUND_DURATION_HOURS;
}

function entrantMap(bracket: BracketRecord) {
  return new Map(bracket.entrants.map((entrant) => [entrant.id, entrant]));
}

function normalizeRosterName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function buildRosterAliasMap(bracket: BracketRecord) {
  const idsByCanonicalName = new Map<string, Set<string>>();

  for (const member of bracket.rosterMembers) {
    const key = normalizeRosterName(member.name);
    const ids = idsByCanonicalName.get(key) ?? new Set<string>();
    ids.add(member.id);
    idsByCanonicalName.set(key, ids);
  }

  const aliasesByMemberId = new Map<string, Set<string>>();
  for (const member of bracket.rosterMembers) {
    const key = normalizeRosterName(member.name);
    aliasesByMemberId.set(member.id, idsByCanonicalName.get(key) ?? new Set([member.id]));
  }

  return aliasesByMemberId;
}

function voteCounts(matchup: MatchupRecord) {
  return matchup.votes.reduce<Record<string, number>>((counts, vote) => {
    counts[vote.entrantId] = (counts[vote.entrantId] ?? 0) + 1;
    return counts;
  }, {});
}

function compareVotes(matchup: MatchupRecord) {
  const counts = voteCounts(matchup);
  const votesA = matchup.entrantAId ? counts[matchup.entrantAId] ?? 0 : 0;
  const votesB = matchup.entrantBId ? counts[matchup.entrantBId] ?? 0 : 0;

  return {
    votesA,
    votesB,
  };
}

function setNextRoundParticipant(bracket: BracketRecord, roundIndex: number, matchupSlot: number, entrantId: string) {
  const nextRound = bracket.rounds[roundIndex + 1];
  if (!nextRound) {
    return;
  }

  const nextMatchup = nextRound.matchups[Math.floor((matchupSlot - 1) / 2)];
  if (!nextMatchup) {
    return;
  }

  if ((matchupSlot - 1) % 2 === 0) {
    nextMatchup.entrantAId = entrantId;
  } else {
    nextMatchup.entrantBId = entrantId;
  }
}

export function resolveAutomaticWinners(bracket: BracketRecord) {
  for (let roundIndex = 0; roundIndex < bracket.rounds.length; roundIndex += 1) {
    for (const matchup of bracket.rounds[roundIndex].matchups) {
      if (matchup.winnerEntrantId) {
        continue;
      }

      if (matchup.entrantAId && !matchup.entrantBId) {
        matchup.winnerEntrantId = matchup.entrantAId;
        matchup.status = "closed";
        setNextRoundParticipant(bracket, roundIndex, matchup.slot, matchup.entrantAId);
      } else if (matchup.entrantBId && !matchup.entrantAId) {
        matchup.winnerEntrantId = matchup.entrantBId;
        matchup.status = "closed";
        setNextRoundParticipant(bracket, roundIndex, matchup.slot, matchup.entrantBId);
      }
    }
  }
}

export async function createBracket(input: CreateBracketInput) {
  const normalizedEntrants = normalizeContenderInputs(input.entrants);
  const normalizedSeededEntrants =
    input.seededEntrants?.length === normalizedEntrants.length
      ? normalizeContenderInputs(input.seededEntrants)
      : null;
  const sourceEntrants =
    normalizedSeededEntrants
      ? normalizedSeededEntrants
      : input.seedingMode === "random"
        ? shuffle(normalizedEntrants)
        : normalizedEntrants;
  const roundDurationHours = deriveRoundDurationHours(input);
  const entrants = sourceEntrants.map<EntrantRecord>((entrant, index) => ({
    id: nanoid(),
    name: entrant.name,
    seed: index + 1,
    imageUrl: entrant.imageUrl,
  }));
  const entrantByNormalizedName = new Map(
    entrants.map((entrant) => [normalizeRosterName(entrant.name), entrant]),
  );
  const requestedQualifierNames = (input.directQualifierNames ?? []).map((name) => normalizeRosterName(name));
  const directQualifierEntrantIds = Array.from(
    new Set(
      requestedQualifierNames
        .map((name) => entrantByNormalizedName.get(name)?.id ?? null)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const rosterMembers = input.rosterMembers.map<RosterMemberRecord>((name) => ({
    id: nanoid(),
    name,
  }));

  const adminToken = nanoid(32);
  const bracket: BracketRecord = {
    id: nanoid(),
    kind: input.kind ?? "public",
    title: input.title.trim(),
    slug: slugify(input.title) || `bracket-${nanoid(6)}`,
    status: "live",
    isCurrentPublic: false,
    publicToken: nanoid(16),
    adminTokenHash: hashValue(adminToken),
    seedingMode: input.seedingMode,
    createdAt: new Date().toISOString(),
    publishedAt: new Date().toISOString(),
    totalPlayers: input.totalPlayers,
    roundDurationHours,
    revoteDurationHours: input.revoteDurationHours || DEFAULT_REVOTE_DURATION_HOURS,
    entrants,
    directQualifierEntrantIds,
    rosterMembers,
    voterBindings: {},
    rounds: [],
  };

  bracket.rounds = buildRoundsForBracket(bracket, input.startsAt, roundDurationHours, input.endsAt);
  if (bracketKind(bracket) === "test") {
    const firstRound = bracket.rounds[0];
    if (firstRound?.status === "upcoming") {
      firstRound.status = "live";
      for (const matchup of firstRound.matchups) {
        if (matchup.entrantAId && matchup.entrantBId && matchup.status === "pending") {
          matchup.status = "live";
        }
      }
    }
  }

  await updateStore((store) => ({
    ...store,
    brackets: [...store.brackets, bracket],
  }));

  publish(bracket.publicToken, { type: "created" });

  return { bracket, adminToken };
}

function winnerFromVotes(matchup: MatchupRecord) {
  if (!matchup.entrantAId || !matchup.entrantBId) {
    return matchup.entrantAId ?? matchup.entrantBId;
  }

  const { votesA, votesB } = compareVotes(matchup);
  if (votesA === votesB) {
    return null;
  }

  return votesA > votesB ? matchup.entrantAId : matchup.entrantBId;
}

function matchupNeedsTieBreaker(matchup: MatchupRecord) {
  if (!matchup.entrantAId || !matchup.entrantBId) {
    return false;
  }

  const { votesA, votesB } = compareVotes(matchup);
  return votesA === votesB;
}

function roundIsResolved(round: RoundRecord) {
  return round.matchups.every((matchup) => matchup.status === "closed" && matchup.winnerEntrantId);
}

function settleRoundAfterTieResolution(bracket: BracketRecord, roundIndex: number, nowIso: string) {
  const round = bracket.rounds[roundIndex];
  if (!round) {
    return false;
  }

  let hasOutstandingTie = false;

  for (const matchup of round.matchups) {
    if (matchup.winnerEntrantId) {
      setNextRoundParticipant(bracket, roundIndex, matchup.slot, matchup.winnerEntrantId);
      if (matchup.status !== "closed") {
        matchup.status = "closed";
        matchup.updatedAt = nowIso;
      }
      continue;
    }

    if (matchupNeedsTieBreaker(matchup)) {
      hasOutstandingTie = true;
      if (matchup.status !== "needs_tiebreaker") {
        matchup.status = "needs_tiebreaker";
        matchup.updatedAt = nowIso;
      }
      continue;
    }

    const winnerEntrantId = winnerFromVotes(matchup);
    if (!winnerEntrantId) {
      continue;
    }

    matchup.winnerEntrantId = winnerEntrantId;
    matchup.status = "closed";
    matchup.updatedAt = nowIso;
    setNextRoundParticipant(bracket, roundIndex, matchup.slot, winnerEntrantId);
  }

  return !hasOutstandingTie && roundIsResolved(round);
}

function repairUnresolvedTieStates(bracket: BracketRecord, now: Date, nowIso: string) {
  const nowMs = now.getTime();

  for (const round of bracket.rounds) {
    if (round.status === "upcoming") {
      continue;
    }

    const roundHasEnded = new Date(round.endsAt).getTime() <= nowMs;
    if (!roundHasEnded && round.status === "live") {
      continue;
    }

    let hasUnresolvedTie = false;
    for (const matchup of round.matchups) {
      if (matchup.winnerEntrantId || !matchupNeedsTieBreaker(matchup)) {
        continue;
      }

      hasUnresolvedTie = true;
      matchup.status = "needs_tiebreaker";
      matchup.updatedAt = nowIso;
    }

    if (hasUnresolvedTie) {
      round.status = "tiebreaker";
    }
  }
}

function roundCanStart(bracket: BracketRecord, roundIndex: number) {
  if (roundIndex === 0) {
    return true;
  }

  const previousRound = bracket.rounds[roundIndex - 1];
  return previousRound ? roundIsResolved(previousRound) : false;
}

function resetBlockedRound(round: RoundRecord, nowIso: string) {
  round.status = "upcoming";
  delete round.roundStartPingClaimedAt;
  delete round.roundStartPingedAt;

  for (const matchup of round.matchups) {
    const changed =
      matchup.status !== "pending" ||
      matchup.winnerEntrantId !== null ||
      matchup.votes.length > 0;

    matchup.status = "pending";
    matchup.winnerEntrantId = null;
    matchup.votes = [];
    if (changed) {
      matchup.updatedAt = nowIso;
    }
  }
}

export function advanceBracket(bracket: BracketRecord, now = new Date()) {
  if (bracket.status === "disabled") {
    return;
  }

  const nowIso = now.toISOString();
  repairUnresolvedTieStates(bracket, now, nowIso);
  for (let roundIndex = 0; roundIndex < bracket.rounds.length; roundIndex += 1) {
    const round = bracket.rounds[roundIndex];
    if (round.status !== "tiebreaker") {
      continue;
    }

    if (settleRoundAfterTieResolution(bracket, roundIndex, nowIso)) {
      round.status = "closed";
    }
  }
  for (let roundIndex = 1; roundIndex < bracket.rounds.length; roundIndex += 1) {
    const round = bracket.rounds[roundIndex];
    if (!roundCanStart(bracket, roundIndex)) {
      resetBlockedRound(round, nowIso);
    }
  }

  for (let roundIndex = 0; roundIndex < bracket.rounds.length; roundIndex += 1) {
    const round = bracket.rounds[roundIndex];

    if (round.status !== "live") {
      if (
        round.status === "upcoming" &&
        roundCanStart(bracket, roundIndex) &&
        new Date(round.startsAt).getTime() <= now.getTime()
      ) {
        round.status = "live";
        for (const matchup of round.matchups) {
          if (matchup.entrantAId && matchup.entrantBId && matchup.status === "pending") {
            matchup.status = "live";
          }
        }
      }
      continue;
    }

    for (const matchup of round.matchups) {
      if (
        matchup.status === "pending" &&
        matchup.entrantAId &&
        matchup.entrantBId &&
        !matchup.winnerEntrantId
      ) {
        matchup.status = "live";
        matchup.updatedAt = nowIso;
      }
    }

    if (new Date(round.endsAt).getTime() > now.getTime()) {
      continue;
    }

    let needsTieBreaker = false;

    for (const matchup of round.matchups) {
      if (matchup.winnerEntrantId) {
        matchup.status = "closed";
        continue;
      }

      if (matchupNeedsTieBreaker(matchup)) {
        needsTieBreaker = true;
        matchup.status = "needs_tiebreaker";
        matchup.updatedAt = nowIso;
        continue;
      }

      const winnerEntrantId = winnerFromVotes(matchup);
      matchup.winnerEntrantId = winnerEntrantId;
      matchup.status = "closed";

      if (winnerEntrantId) {
        setNextRoundParticipant(bracket, roundIndex, matchup.slot, winnerEntrantId);
      }
    }

    if (needsTieBreaker) {
      round.status = "tiebreaker";
      continue;
    }

    round.status = "closed";
    const nextRound = bracket.rounds[roundIndex + 1];
    if (nextRound) {
      if (new Date(nextRound.startsAt).getTime() <= now.getTime()) {
        nextRound.status = "live";
        for (const matchup of nextRound.matchups) {
          if (matchup.entrantAId && matchup.entrantBId && matchup.status === "pending") {
            matchup.status = "live";
          }
        }
      }
      resolveAutomaticWinners(bracket);
    } else {
      bracket.status = "completed";
    }
  }

  if (bracket.rounds.every((round) => round.status === "closed")) {
    bracket.status = "completed";
  }
}

/** Advances every eligible bracket in place; returns the public tokens that changed. */
function advanceEligibleBrackets(store: StoreShape, now: Date) {
  const changedTokens: string[] = [];

  for (const bracket of store.brackets) {
    if (bracket.status === "disabled" || bracketKind(bracket) === "test") {
      continue;
    }

    const before = JSON.stringify(bracket);
    advanceBracket(bracket, now);
    if (before !== JSON.stringify(bracket)) {
      changedTokens.push(bracket.publicToken);
    }
  }

  return changedTokens;
}

/**
 * Moves rounds forward when their time comes. Runs on every /api/status hit
 * and every scheduler tick, so the common case (nothing due) must stay a
 * single read: the check runs on a throwaway copy. When something is due, the
 * advance is redone inside updateStore on a fresh, row-locked copy. Writing
 * back the copy read before the lock would silently drop any vote or name
 * pick committed in between.
 *
 * `options.beforeLockedWrite` exists only so tests can commit a write in that
 * gap and prove it survives.
 */
export async function advanceReadyBrackets(
  now = new Date(),
  options?: { beforeLockedWrite?: () => Promise<void> },
) {
  const current = await readStore();
  if (advanceEligibleBrackets(structuredClone(current), now).length === 0) {
    return current.brackets;
  }

  await options?.beforeLockedWrite?.();

  let changedTokens: string[] = [];
  const saved = await updateStore((store) => {
    changedTokens = advanceEligibleBrackets(store, now);
    return store;
  });

  for (const publicToken of changedTokens) {
    publish(publicToken, { type: "advanced" });
  }
  if (changedTokens.length > 0) {
    schedulePendingRoundStartPings();
  }

  return saved.brackets;
}

export async function findBracketByPublicToken(publicToken: string) {
  return (await readStore()).brackets.find((bracket) => bracket.publicToken === publicToken) ?? null;
}

export function selectCurrentPublicBracket(brackets: BracketRecord[]) {
  return (
    brackets.find(
      (bracket) =>
        bracketKind(bracket) === "public" &&
        bracket.isCurrentPublic &&
        bracket.status !== "disabled",
    ) ?? null
  );
}

export async function findCurrentPublicBracket() {
  return selectCurrentPublicBracket((await readStore()).brackets);
}

export async function findBracketByAdminToken(adminToken: string) {
  const tokenHash = hashValue(adminToken);
  return (await readStore()).brackets.find((bracket) => bracket.adminTokenHash === tokenHash) ?? null;
}

/**
 * Re-binds a browser whose main cookie drifted, using its remembered claim,
 * and logs the move. Only the browser holding the name's CURRENT claim id can
 * do this (see voter.ts), so an admin release cannot be undone from an old
 * browser, whatever cookies it clears.
 */
function migrateVoterBindingWithAudit(
  bracket: BracketRecord,
  browserToken: string,
  remembered: string | null,
  client: VoterClientInfo | null,
) {
  const alreadyBound = rosterMemberIdForBrowser(bracket, browserToken);
  if (alreadyBound) {
    return alreadyBound;
  }

  const rememberedId = parseRememberedClaim(remembered)?.rosterMemberId ?? null;
  const previousToken = rememberedId ? browserTokenForRosterMember(bracket, rememberedId) : null;
  const migrated = tryMigrateVoterBinding(bracket, browserToken, remembered);
  if (migrated) {
    recordVoterEvent(bracket, {
      type: "reclaim",
      rosterMemberId: migrated,
      client,
      previousBrowserId: previousToken ? browserIdForToken(previousToken) : null,
    });
  }

  return migrated;
}

export async function ensureVoterBinding(params: {
  publicToken: string;
  browserToken: string;
  remembered?: string | null;
  client?: VoterClientInfo | null;
}) {
  let resolvedRosterMemberId: string | null = null;

  await updateStore((store) => {
    const bracket = store.brackets.find((entry) => entry.publicToken === params.publicToken);
    if (!bracket) {
      return store;
    }

    resolvedRosterMemberId = migrateVoterBindingWithAudit(
      bracket,
      params.browserToken,
      params.remembered ?? null,
      params.client ?? null,
    );
    return store;
  });

  return resolvedRosterMemberId;
}

/**
 * Hands a bound browser the current claim for its name, minting one when the
 * name has none (or only a release marker). Lets browsers holding old
 * member-only cookies move onto claim cookies without re-picking.
 */
export async function ensureClaimForBoundBrowser(params: { publicToken: string; browserToken: string }) {
  let result: { rosterMemberId: string; claimId: string } | null = null;

  await updateStore((store) => {
    const bracket = store.brackets.find((entry) => entry.publicToken === params.publicToken);
    const bound = bracket ? rosterMemberIdForBrowser(bracket, params.browserToken) : null;
    if (!bracket || !bound) {
      return store;
    }

    const existing = bracket.memberClaims?.[bound];
    const claimId = existing && !isReleasedClaim(existing) ? existing : mintMemberClaim(bracket, bound);
    result = { rosterMemberId: bound, claimId };
    return store;
  });

  return result as { rosterMemberId: string; claimId: string } | null;
}

/**
 * Binds a browser to a roster name and returns the claim id the caller must
 * store in the remembered-claim cookie. A name already registered on another
 * browser is NOT handed over; the only exception is the browser holding the
 * name's current claim (cookie drift). A browser holding a stale claim for the
 * name (the admin freed it, or a newer device took it) is refused even when
 * nobody holds the name. Blocked attempts are logged for Vote Watch.
 */
export async function claimVoterIdentity(params: {
  publicToken: string;
  browserToken: string;
  rosterMemberName: string;
  remembered?: string | null;
  client?: VoterClientInfo | null;
}) {
  let resolvedRosterMemberId: string | null = null;
  let resolvedClaimId: string | null = null;
  let claimError: string | null = null;

  const updatedStore = await updateStore((store) => {
    const bracket = store.brackets.find((entry) => entry.publicToken === params.publicToken);
    if (!bracket) {
      claimError = "Bracket not found.";
      return store;
    }

    if (bracket.status === "disabled") {
      claimError = "This bracket is no longer available.";
      return store;
    }

    const member = findRosterMemberByName(bracket, params.rosterMemberName);
    if (!member) {
      claimError = "Roster member not found.";
      return store;
    }

    const client = params.client ?? null;
    const currentForBrowser = rosterMemberIdForBrowser(bracket, params.browserToken);
    if (currentForBrowser === member.id) {
      const existingClaim = bracket.memberClaims?.[member.id];
      resolvedClaimId =
        existingClaim && !isReleasedClaim(existingClaim)
          ? existingClaim
          : mintMemberClaim(bracket, member.id);
      resolvedRosterMemberId = member.id;
      return store;
    }

    // A browser that remembers picking another name in this bracket counts as
    // that person even if its main cookie was cleared.
    const rememberedId = rememberedRosterMemberId(bracket, params.remembered);
    const identityForBrowser = currentForBrowser ?? rememberedId;
    if (identityForBrowser && identityForBrowser !== member.id) {
      const currentName =
        bracket.rosterMembers.find((entry) => entry.id === identityForBrowser)?.name ?? "someone else";
      recordVoterEvent(bracket, { type: "switch_blocked", rosterMemberId: member.id, client, note: currentName });
      claimError = `This browser is already registered as ${currentName}.`;
      return store;
    }

    const holderToken = browserTokenForRosterMember(bracket, member.id);
    const isOwnDriftedName = rememberedId === member.id && isRememberedClaimCurrent(bracket, params.remembered);
    // Freed by the admin: this browser's registration was revoked. (A claim
    // that was merely superseded by a newer device is not blocked here once
    // nobody holds the name, e.g. after a full reset.)
    if (
      rememberedId === member.id &&
      !isOwnDriftedName &&
      !holderToken &&
      isReleasedClaim(bracket.memberClaims?.[member.id])
    ) {
      recordVoterEvent(bracket, {
        type: "claim_blocked",
        rosterMemberId: member.id,
        client,
        note: "Old registration on this browser",
      });
      claimError = `${member.name} was freed from this browser by the organiser. Ask them if you need it back here.`;
      return store;
    }

    if (holderToken && !isOwnDriftedName) {
      recordVoterEvent(bracket, { type: "claim_blocked", rosterMemberId: member.id, client });
      claimError = `${member.name} is already registered on another device. If that's you, ask the organiser to free up your name.`;
      return store;
    }

    const result = bindBrowserToRosterMember(bracket, params.browserToken, member.id, { rebind: true });
    if (!result.ok) {
      claimError = result.error;
      return store;
    }

    recordVoterEvent(bracket, {
      type: holderToken ? "reclaim" : "claim",
      rosterMemberId: member.id,
      client,
      ...(holderToken ? { previousBrowserId: browserIdForToken(holderToken) } : {}),
    });
    resolvedClaimId = mintMemberClaim(bracket, member.id);
    resolvedRosterMemberId = member.id;
    return store;
  });

  if (claimError) {
    throw new Error(claimError);
  }

  const updated =
    updatedStore.brackets.find((bracket) => bracket.publicToken === params.publicToken) ?? null;
  if (!updated || !resolvedRosterMemberId || !resolvedClaimId) {
    throw new Error("Could not register your name.");
  }

  return {
    bracket: updated,
    rosterMemberId: resolvedRosterMemberId as string,
    claimId: resolvedClaimId as string,
  };
}

export async function castVote(params: {
  publicToken: string;
  browserToken: string;
  matchupSlot: number;
  side: "A" | "B";
  remembered?: string | null;
  client?: VoterClientInfo | null;
}) {
  let updatedBracketId: string | null = null;

  const updatedStore = await updateStore((store) => {
    const bracket = store.brackets.find((entry) => entry.publicToken === params.publicToken);
    if (!bracket) {
      throw new Error("Bracket not found.");
    }

    if (bracket.status === "disabled") {
      throw new Error("This bracket is no longer available.");
    }

    migrateVoterBindingWithAudit(
      bracket,
      params.browserToken,
      params.remembered ?? null,
      params.client ?? null,
    );

    const rosterMemberId = rosterMemberIdForBrowser(bracket, params.browserToken);
    if (!rosterMemberId) {
      throw new Error("Choose your name before voting.");
    }

    advanceBracket(bracket, new Date());
    const liveRound = bracket.rounds.find((round) => round.status === "live");
    if (!liveRound) {
      throw new Error("There is no live round right now.");
    }

    const matchup = liveRound.matchups.find((entry) => entry.slot === params.matchupSlot);
    if (!matchup || matchup.status !== "live") {
      throw new Error("This matchup is not open for voting.");
    }

    const entrantId = params.side === "A" ? matchup.entrantAId : matchup.entrantBId;
    if (!entrantId) {
      throw new Error("Invalid entrant.");
    }

    const rosterAliases = buildRosterAliasMap(bracket);
    const equivalentRosterIds = rosterAliases.get(rosterMemberId) ?? new Set([rosterMemberId]);
    const existingVote = matchup.votes.find((vote) => equivalentRosterIds.has(vote.rosterMemberId));
    if (existingVote) {
      throw new Error("This person already voted in this matchup.");
    }

    matchup.votes.push({
      id: nanoid(),
      rosterMemberId,
      entrantId,
      createdAt: new Date().toISOString(),
      ...(params.client ? { client: params.client } : {}),
    });
    matchup.updatedAt = new Date().toISOString();
    updatedBracketId = bracket.id;

    return store;
  });

  const updated = updatedStore.brackets.find((bracket) => bracket.id === updatedBracketId) ?? null;
  if (!updated) {
    throw new Error("Vote failed.");
  }

  publish(updated.publicToken, { type: "vote" });
  schedulePendingRoundStartPings();
  return updated;
}

export function restartBracket(bracket: BracketRecord) {
  const baseStartsAt = bracket.rounds[0]?.startsAt ?? new Date().toISOString();
  bracket.status = "live";
  bracket.voterBindings = {};
  clearReleasedClaims(bracket);
  recordVoterEvent(bracket, { type: "reset_all", rosterMemberId: null, client: null, note: "Bracket restarted" });
  bracket.rounds = buildRoundsForBracket(bracket, baseStartsAt, bracket.roundDurationHours);
}

export function clearVoterBindings(bracket: BracketRecord) {
  bracket.voterBindings = {};
  clearReleasedClaims(bracket);
  recordVoterEvent(bracket, {
    type: "reset_all",
    rosterMemberId: null,
    client: null,
    note: "Admin reset all name registrations",
  });
}

/**
 * Frees one roster name so its owner can pick it again on a new device. The
 * stored claim id is replaced, so no browser that ever held the name can
 * recover it from its remembered cookie; only a fresh pick can.
 */
export function releaseVoterBinding(bracket: BracketRecord, rosterMemberId: string) {
  if (!bracket.rosterMembers.some((member) => member.id === rosterMemberId)) {
    throw new Error("Roster member not found.");
  }

  const previousToken = browserTokenForRosterMember(bracket, rosterMemberId);
  const alreadyReleased = isReleasedClaim(bracket.memberClaims?.[rosterMemberId]);
  if (!previousToken && alreadyReleased) {
    return false;
  }

  releaseRosterMemberBinding(bracket, rosterMemberId);
  bracket.memberClaims ??= {};
  bracket.memberClaims[rosterMemberId] = releasedClaimMarker();
  recordVoterEvent(bracket, {
    type: "release",
    rosterMemberId,
    client: null,
    previousBrowserId: previousToken ? browserIdForToken(previousToken) : null,
    note: "Admin freed this name",
  });
  return Boolean(previousToken);
}

function normalizeAddedRosterName(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export async function addRosterMembers(params: { adminToken: string; names: string[] }) {
  const names = params.names.map((name) => normalizeAddedRosterName(name)).filter(Boolean);
  if (!names.length) {
    throw new Error("Add at least one roster member name.");
  }

  let updatedBracketId: string | null = null;

  const updatedStore = await updateStore((store) => {
    const bracket = store.brackets.find((entry) => entry.adminTokenHash === hashValue(params.adminToken));
    if (!bracket) {
      throw new Error("Bracket not found.");
    }

    if (bracket.status !== "live") {
      throw new Error("Roster members can only be added while the tournament is live.");
    }

    const existingNames = new Set(bracket.rosterMembers.map((member) => normalizeRosterName(member.name)));
    const batchNames = new Set<string>();

    for (const name of names) {
      const normalizedName = normalizeRosterName(name);
      if (existingNames.has(normalizedName)) {
        throw new Error(`${name} is already on the roster.`);
      }
      if (batchNames.has(normalizedName)) {
        throw new Error(`Duplicate name in request: ${name}.`);
      }
      batchNames.add(normalizedName);
    }

    for (const name of names) {
      bracket.rosterMembers.push({
        id: nanoid(),
        name,
      });
    }

    bracket.totalPlayers = bracket.rosterMembers.length;
    updatedBracketId = bracket.id;
    return store;
  });

  const updated = updatedStore.brackets.find((bracket) => bracket.id === updatedBracketId) ?? null;
  if (!updated) {
    throw new Error("Bracket not found.");
  }

  publish(updated.publicToken, { type: "roster-updated" });
  return updated;
}

export function disableBracket(bracket: BracketRecord) {
  bracket.status = "disabled";
  bracket.isCurrentPublic = false;
  for (const round of bracket.rounds) {
    if (round.status === "live" || round.status === "upcoming") {
      round.status = "closed";
    }

    for (const matchup of round.matchups) {
      if (matchup.status === "live" || matchup.status === "pending") {
        matchup.status = "closed";
      }
    }
  }
}

export async function markBracketAsCurrentPublic(adminToken: string) {
  let updatedBracketId: string | null = null;

  const updatedStore = await updateStore((store) => {
    const targetHash = hashValue(adminToken);
    const target = store.brackets.find((entry) => entry.adminTokenHash === targetHash);
    if (!target) {
      throw new Error("Bracket not found.");
    }

    if (target.status === "disabled") {
      throw new Error("Disabled brackets cannot be marked current.");
    }

    if (bracketKind(target) === "test") {
      throw new Error("Test brackets cannot be marked current public.");
    }

    for (const bracket of store.brackets) {
      bracket.isCurrentPublic = bracket.id === target.id;
    }
    updatedBracketId = target.id;

    return store;
  });

  const updated = updatedStore.brackets.find((bracket) => bracket.id === updatedBracketId) ?? null;
  if (!updated) {
    throw new Error("Bracket not found.");
  }

  publish(updated.publicToken, { type: "current-public" });
  schedulePendingRoundStartPings();
  return updated;
}

export async function clearMatchupVote(params: {
  adminToken: string;
  matchupId: string;
  rosterMemberId: string;
}) {
  let updatedBracketId: string | null = null;

  const updatedStore = await updateStore((store) => {
    const bracket = store.brackets.find((entry) => entry.adminTokenHash === hashValue(params.adminToken));
    if (!bracket) {
      throw new Error("Bracket not found.");
    }

    let targetMatchup: MatchupRecord | null = null;
    for (const round of bracket.rounds) {
      const matchup = round.matchups.find((entry) => entry.id === params.matchupId);
      if (matchup) {
        targetMatchup = matchup;
        break;
      }
    }

    if (!targetMatchup) {
      throw new Error("Matchup not found.");
    }

    const nextVotes = targetMatchup.votes.filter((vote) => vote.rosterMemberId !== params.rosterMemberId);
    if (nextVotes.length === targetMatchup.votes.length) {
      throw new Error("Vote not found for that person in this matchup.");
    }

    targetMatchup.votes = nextVotes;
    targetMatchup.updatedAt = new Date().toISOString();
    updatedBracketId = bracket.id;

    return store;
  });

  const updated = updatedStore.brackets.find((bracket) => bracket.id === updatedBracketId) ?? null;
  if (!updated) {
    throw new Error("Bracket not found.");
  }

  publish(updated.publicToken, { type: "vote-reset" });
  return updated;
}

export async function resolveTieBreaker(params: {
  adminToken: string;
  matchupId: string;
  winnerEntrantId: string;
}) {
  let updatedBracketId: string | null = null;

  const updatedStore = await updateStore((store) => {
    const bracket = store.brackets.find((entry) => entry.adminTokenHash === hashValue(params.adminToken));
    if (!bracket) {
      throw new Error("Bracket not found.");
    }

    let targetRound: RoundRecord | null = null;
    let targetRoundIndex = -1;
    let targetMatchup: MatchupRecord | null = null;

    for (const [roundIndex, round] of bracket.rounds.entries()) {
      const matchup = round.matchups.find((entry) => entry.id === params.matchupId);
      if (matchup) {
        targetRound = round;
        targetRoundIndex = roundIndex;
        targetMatchup = matchup;
        break;
      }
    }

    if (!targetRound || !targetMatchup) {
      throw new Error("Matchup not found.");
    }

    const matchupStillTied = matchupNeedsTieBreaker(targetMatchup);
    const unresolvedTie = !targetMatchup.winnerEntrantId && matchupStillTied;
    if (unresolvedTie) {
      targetRound.status = "tiebreaker";
      targetMatchup.status = "needs_tiebreaker";
    }

    if (targetMatchup.winnerEntrantId) {
      updatedBracketId = bracket.id;
      return store;
    }

    const canResolveTieBreaker =
      matchupStillTied ||
      targetMatchup.status === "needs_tiebreaker" ||
      targetRound.status === "tiebreaker";
    if (!canResolveTieBreaker) {
      throw new Error("This matchup does not need a tie breaker.");
    }

    if (![targetMatchup.entrantAId, targetMatchup.entrantBId].includes(params.winnerEntrantId)) {
      throw new Error("Tie-breaker winner must be one of the matchup contenders.");
    }

    const nowIso = new Date().toISOString();
    targetMatchup.winnerEntrantId = params.winnerEntrantId;
    targetMatchup.status = "closed";
    targetMatchup.updatedAt = nowIso;
    setNextRoundParticipant(bracket, targetRoundIndex, targetMatchup.slot, params.winnerEntrantId);

    const roundResolved = settleRoundAfterTieResolution(bracket, targetRoundIndex, nowIso);
    if (roundResolved) {
      targetRound.status = "closed";
      resolveAutomaticWinners(bracket);
      advanceBracket(bracket, new Date());
    } else {
      targetRound.status = "tiebreaker";
    }

    updatedBracketId = bracket.id;
    return store;
  });

  const updated = updatedStore.brackets.find((bracket) => bracket.id === updatedBracketId) ?? null;
  if (!updated) {
    throw new Error("Bracket not found.");
  }

  publish(updated.publicToken, { type: "tie-breaker" });
  schedulePendingRoundStartPings();
  return updated;
}

export function buildSnapshot(
  bracket: BracketRecord,
  options?: {
    rosterMemberId?: string;
    includeAdminUrl?: boolean;
    adminToken?: string;
    adminHistory?: AdminHistoryItem[];
  },
): BracketSnapshot {
  if (bracket.status !== "disabled") {
    advanceBracket(bracket, new Date());
  }
  const kind = bracketKind(bracket);
  const entrants = entrantMap(bracket);
  const rosterMap = new Map(bracket.rosterMembers.map((member) => [member.id, member]));
  const rosterAliases = buildRosterAliasMap(bracket);
  const currentRoundRecord =
    bracket.rounds.find((round) => round.status === "live") ??
    bracket.rounds.find((round) => round.status === "tiebreaker") ??
    bracket.rounds.find((round) => round.status === "upcoming") ??
    null;
  const currentRoundVotingMatchups =
    currentRoundRecord?.matchups.filter((matchup) => matchup.entrantAId && matchup.entrantBId) ?? [];
  const currentRoundRosterStatuses: BracketSnapshotRosterStatus[] = currentRoundRecord
    ? bracket.rosterMembers.map((member) => {
        const equivalentRosterIds = rosterAliases.get(member.id) ?? new Set([member.id]);
        const hasVoted =
          currentRoundVotingMatchups.length > 0 &&
          currentRoundVotingMatchups.every((matchup) =>
            matchup.votes.some((vote) => equivalentRosterIds.has(vote.rosterMemberId)),
          );

        return {
          rosterMemberId: member.id,
          name: member.name,
          hasVoted,
        };
      })
    : [];

  const rounds = bracket.rounds.map((round) => ({
    id: round.id,
    number: round.number,
    label: round.label,
    startsAt: round.startsAt,
    endsAt: round.endsAt,
    status: round.status,
    matchups: round.matchups.map((matchup) => {
      const counts = voteCounts(matchup);
      const votesA = matchup.entrantAId ? counts[matchup.entrantAId] ?? 0 : 0;
      const votesB = matchup.entrantBId ? counts[matchup.entrantBId] ?? 0 : 0;
      const voted = options?.rosterMemberId
        ? matchup.votes.find((vote) => vote.rosterMemberId === options.rosterMemberId)
        : null;

      return {
        id: matchup.id,
        slot: matchup.slot,
        status: matchup.status,
        entrantA: matchup.entrantAId ? entrants.get(matchup.entrantAId) ?? null : null,
        entrantB: matchup.entrantBId ? entrants.get(matchup.entrantBId) ?? null : null,
        winnerEntrantId: matchup.winnerEntrantId,
        votesA,
        votesB,
        totalVotes: votesA + votesB,
        voteState: {
          canVote: round.status === "live" && matchup.status === "live" && !voted,
          votedEntrantId: voted?.entrantId ?? null,
        },
        adminVotes: options?.includeAdminUrl
          ? matchup.votes.map<AdminVoteEntry>((vote) => ({
              rosterMemberId: vote.rosterMemberId,
              rosterMemberName: rosterMap.get(vote.rosterMemberId)?.name ?? "Unknown voter",
              entrantId: vote.entrantId,
              entrantName: entrants.get(vote.entrantId)?.name ?? "Unknown entrant",
              createdAt: vote.createdAt,
            }))
          : undefined,
      };
    }),
  }));

  const totalVotes = rounds.reduce(
    (sum, round) => sum + round.matchups.reduce((roundSum, matchup) => roundSum + matchup.totalVotes, 0),
    0,
  );
  const currentRoundUniqueVoters = currentRoundRosterStatuses.filter((member) => member.hasVoted).length;

  return {
    id: bracket.id,
    kind: bracketKind(bracket),
    title: bracket.title,
    slug: bracket.slug,
    status: bracket.status,
    isCurrentPublic: bracket.isCurrentPublic,
    publicToken: bracket.publicToken,
    publicUrl:
      kind === "test" && options?.adminToken
        ? `/test?adminToken=${encodeURIComponent(options.adminToken)}`
        : "/voting",
    adminUrl:
      options?.includeAdminUrl && options.adminToken
        ? `/admin?adminToken=${encodeURIComponent(options.adminToken)}`
        : undefined,
    seedingMode: bracket.seedingMode,
    createdAt: bracket.createdAt,
    publishedAt: bracket.publishedAt,
    totalPlayers: bracket.totalPlayers ?? bracket.entrants.length,
    roundDurationHours: bracket.roundDurationHours,
    entrants: bracket.entrants,
    rosterMembers: bracket.rosterMembers,
    rounds,
    currentRoundId: currentRoundRecord?.id ?? null,
    currentRoundUniqueVoters,
    totalVotes,
    selectedRosterMemberId: options?.rosterMemberId ?? null,
    currentRoundRosterStatuses,
    adminHistory: options?.includeAdminUrl ? options.adminHistory ?? [] : undefined,
    voteWatch: options?.includeAdminUrl ? buildVoteWatch(bracket) : undefined,
  };
}

export function buildPublicSnapshot(
  bracket: BracketRecord,
  options?: {
    rosterMemberId?: string | null;
  },
): PublicBracketSnapshot {
  if (bracket.status !== "disabled") {
    advanceBracket(bracket, new Date());
  }

  const entrants = entrantMap(bracket);
  const rosterMemberId = options?.rosterMemberId ?? null;
  const rosterMemberName =
    rosterMemberId
      ? (bracket.rosterMembers.find((member) => member.id === rosterMemberId)?.name ?? null)
      : null;
  const claimedRosterMemberIds = new Set(Object.values(bracket.voterBindings ?? {}));
  const rosterAliases = buildRosterAliasMap(bracket);
  const equivalentRosterIds = rosterMemberId
    ? (rosterAliases.get(rosterMemberId) ?? new Set([rosterMemberId]))
    : null;

  const currentRoundRecord =
    bracket.rounds.find((round) => round.status === "live") ??
    bracket.rounds.find((round) => round.status === "tiebreaker") ??
    bracket.rounds.find((round) => round.status === "upcoming") ??
    null;
  const currentRoundVotingMatchups =
    currentRoundRecord?.matchups.filter((matchup) => matchup.entrantAId && matchup.entrantBId) ?? [];
  const currentRoundRosterStatuses: PublicBracketSnapshotRosterStatus[] = currentRoundRecord
    ? bracket.rosterMembers.map((member) => {
        const memberEquivalentIds = rosterAliases.get(member.id) ?? new Set([member.id]);
        const hasVoted =
          currentRoundVotingMatchups.length > 0 &&
          currentRoundVotingMatchups.every((matchup) =>
            matchup.votes.some((vote) => memberEquivalentIds.has(vote.rosterMemberId)),
          );

        return {
          name: member.name,
          hasVoted,
        };
      })
    : [];

  const rounds = bracket.rounds.map((round) => ({
    number: round.number,
    label: round.label,
    startsAt: round.startsAt,
    endsAt: round.endsAt,
    status: round.status,
    matchups: round.matchups.map((matchup) => {
      const counts = voteCounts(matchup);
      const votesA = matchup.entrantAId ? (counts[matchup.entrantAId] ?? 0) : 0;
      const votesB = matchup.entrantBId ? (counts[matchup.entrantBId] ?? 0) : 0;
      const voted =
        equivalentRosterIds
          ? matchup.votes.find((vote) => equivalentRosterIds.has(vote.rosterMemberId))
          : null;
      let votedSide: "A" | "B" | null = null;
      if (voted?.entrantId === matchup.entrantAId) {
        votedSide = "A";
      } else if (voted?.entrantId === matchup.entrantBId) {
        votedSide = "B";
      }

      const entrantA = matchup.entrantAId ? entrants.get(matchup.entrantAId) ?? null : null;
      const entrantB = matchup.entrantBId ? entrants.get(matchup.entrantBId) ?? null : null;
      const winnerEntrant = matchup.winnerEntrantId ? entrants.get(matchup.winnerEntrantId) ?? null : null;

      return {
        slot: matchup.slot,
        status: matchup.status,
        entrantA: entrantA
          ? { name: entrantA.name, seed: entrantA.seed, imageUrl: entrantA.imageUrl }
          : null,
        entrantB: entrantB
          ? { name: entrantB.name, seed: entrantB.seed, imageUrl: entrantB.imageUrl }
          : null,
        winnerName: winnerEntrant?.name ?? null,
        votesA,
        votesB,
        totalVotes: votesA + votesB,
        voteState: {
          canVote: round.status === "live" && matchup.status === "live" && !voted,
          votedSide,
        },
      };
    }),
  }));

  const totalVotes = rounds.reduce(
    (sum, round) => sum + round.matchups.reduce((roundSum, matchup) => roundSum + matchup.totalVotes, 0),
    0,
  );
  const currentRoundUniqueVoters = currentRoundRosterStatuses.filter((member) => member.hasVoted).length;

  return {
    id: bracket.id,
    kind: bracketKind(bracket),
    title: bracket.title,
    slug: bracket.slug,
    status: bracket.status,
    isCurrentPublic: bracket.isCurrentPublic,
    publicUrl: "/voting",
    seedingMode: bracket.seedingMode,
    createdAt: bracket.createdAt,
    publishedAt: bracket.publishedAt,
    totalPlayers: bracket.totalPlayers ?? bracket.entrants.length,
    roundDurationHours: bracket.roundDurationHours,
    entrants: bracket.entrants.map((entrant) => ({
      name: entrant.name,
      seed: entrant.seed,
      imageUrl: entrant.imageUrl,
    })),
    rosterMembers: bracket.rosterMembers.map((member) => ({
      name: member.name,
      claimed: claimedRosterMemberIds.has(member.id),
      isYou: member.id === rosterMemberId,
    })),
    rounds,
    currentRoundNumber: currentRoundRecord?.number ?? null,
    currentRoundUniqueVoters,
    totalVotes,
    selectedRosterMemberName: rosterMemberName,
    currentRoundRosterStatuses,
  };
}

export async function buildAdminSnapshot(bracket: BracketRecord, adminToken: string) {
  return buildSnapshot(bracket, {
    includeAdminUrl: true,
    adminToken,
    adminHistory: await buildAdminHistory(),
  });
}

export function buildPreviewSnapshot(input: CreateBracketInput): BracketSnapshot {
  const normalizedEntrants = normalizeContenderInputs(input.entrants);
  const normalizedSeededEntrants =
    input.seededEntrants?.length === normalizedEntrants.length
      ? normalizeContenderInputs(input.seededEntrants)
      : null;
  const sourceEntrants =
    normalizedSeededEntrants
      ? normalizedSeededEntrants
      : input.seedingMode === "random"
        ? shuffle(normalizedEntrants)
        : normalizedEntrants;
  const previewBracket: BracketRecord = {
    id: `preview-${nanoid(8)}`,
    kind: input.kind ?? "public",
    title: input.title.trim(),
    slug: slugify(input.title) || `preview-${nanoid(4)}`,
    status: "live",
    isCurrentPublic: false,
    publicToken: `preview-${nanoid(8)}`,
    adminTokenHash: "preview",
    seedingMode: input.seedingMode,
    createdAt: new Date().toISOString(),
    publishedAt: new Date().toISOString(),
    totalPlayers: input.totalPlayers,
    roundDurationHours: deriveRoundDurationHours(input),
    revoteDurationHours: input.revoteDurationHours || DEFAULT_REVOTE_DURATION_HOURS,
    entrants: sourceEntrants.map<EntrantRecord>((entrant, index) => ({
      id: `preview-entrant-${index + 1}`,
      name: entrant.name,
      seed: index + 1,
      imageUrl: entrant.imageUrl,
    })),
    directQualifierEntrantIds: [],
    rosterMembers: input.rosterMembers.map<RosterMemberRecord>((name, index) => ({
      id: `preview-roster-${index + 1}`,
      name,
    })),
    rounds: [],
  };

  const previewEntrantByName = new Map(
    previewBracket.entrants.map((entrant) => [normalizeRosterName(entrant.name), entrant.id]),
  );
  previewBracket.directQualifierEntrantIds = Array.from(
    new Set(
      (input.directQualifierNames ?? [])
        .map((name) => previewEntrantByName.get(normalizeRosterName(name)) ?? null)
        .filter((id): id is string => Boolean(id)),
    ),
  );

  previewBracket.rounds = buildRoundsForBracket(
    previewBracket,
    input.startsAt,
    previewBracket.roundDurationHours,
    input.endsAt,
  );

  return buildSnapshot(previewBracket);
}

export async function findBracketById(bracketId: string) {
  return (await readStore()).brackets.find((bracket) => bracket.id === bracketId) ?? null;
}
