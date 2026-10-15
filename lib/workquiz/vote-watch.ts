import { nanoid } from "nanoid";

import { browserIdForToken } from "@/lib/workquiz/client-info";
import type {
  BracketRecord,
  VoteWatchEvent,
  VoteWatchFlag,
  VoteWatchMember,
  VoteWatchSnapshot,
  VoterClientInfo,
  VoterEventRecord,
} from "@/lib/workquiz/types";

/**
 * The whole store is one JSON row rewritten on every write, so the log is
 * capped. Votes carry their own client info, so dropping old events never
 * loses the per-vote evidence.
 */
export const MAX_VOTER_EVENTS = 500;
const RECENT_EVENT_COUNT = 50;

export function recordVoterEvent(
  bracket: BracketRecord,
  event: Omit<VoterEventRecord, "id" | "at"> & { at?: string },
) {
  bracket.voterEvents ??= [];
  bracket.voterEvents.push({
    id: nanoid(10),
    at: event.at ?? new Date().toISOString(),
    type: event.type,
    rosterMemberId: event.rosterMemberId,
    client: event.client,
    ...(event.previousBrowserId !== undefined ? { previousBrowserId: event.previousBrowserId } : {}),
    ...(event.note ? { note: event.note } : {}),
  });

  if (bracket.voterEvents.length > MAX_VOTER_EVENTS) {
    bracket.voterEvents.splice(0, bracket.voterEvents.length - MAX_VOTER_EVENTS);
  }
}

/**
 * "Browser A3F9": derived from the stored hash itself, so a label never
 * changes between refreshes or when the capped log drops old events.
 */
class Labeller {
  constructor(private readonly prefix: string) {}

  label(key: string | null | undefined) {
    return key ? `${this.prefix} ${key.slice(0, 4).toUpperCase()}` : null;
  }
}

interface Observation {
  rosterMemberId: string;
  client: VoterClientInfo;
  at: string;
}

function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function listNames(names: Iterable<string>) {
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function buildVoteWatch(bracket: BracketRecord): VoteWatchSnapshot {
  const events = bracket.voterEvents ?? [];
  const memberById = new Map(bracket.rosterMembers.map((member) => [member.id, member]));
  const nameFor = (rosterMemberId: string | null | undefined) =>
    (rosterMemberId && memberById.get(rosterMemberId)?.name) ?? null;

  const browsers = new Labeller("Browser");
  const networks = new Labeller("Network");

  // Everything that proves "this browser acted as this person".
  const observations: Observation[] = [];
  for (const event of events) {
    if ((event.type === "claim" || event.type === "reclaim") && event.client && event.rosterMemberId) {
      observations.push({ rosterMemberId: event.rosterMemberId, client: event.client, at: event.at });
    }
  }
  for (const round of bracket.rounds) {
    for (const matchup of round.matchups) {
      for (const vote of matchup.votes) {
        if (vote.client) {
          observations.push({ rosterMemberId: vote.rosterMemberId, client: vote.client, at: vote.createdAt });
        }
      }
    }
  }
  // Chronological, so "latest" per member below is really the latest.
  observations.sort((a, b) => a.at.localeCompare(b.at));

  const flags: VoteWatchFlag[] = [];

  // A: one browser acting as several people. Equivalent spellings of one
  // name count as one person, matching how votes are de-duplicated.
  const namesByBrowser = new Map<string, Map<string, string>>();
  for (const observation of observations) {
    const name = nameFor(observation.rosterMemberId);
    if (!name) {
      continue;
    }
    const names = namesByBrowser.get(observation.client.browserId) ?? new Map<string, string>();
    names.set(normalizeName(name), name);
    namesByBrowser.set(observation.client.browserId, names);
  }
  for (const [browserId, names] of namesByBrowser) {
    if (names.size > 1) {
      const label = browsers.label(browserId);
      flags.push({
        id: `browser-${browserId}`,
        severity: "high",
        title: `${label} was used as ${names.size} different people`,
        detail: `The same browser registered or voted as ${listNames(names.values()).join(", ")}.`,
        rosterMemberNames: listNames(names.values()),
      });
    }
  }

  // B: same device hint on the same network, different browsers, different
  // names. Identical work PCs can collide, so this is a hint, not proof.
  const namesByDevice = new Map<string, { names: Map<string, string>; browsers: Set<string> }>();
  for (const observation of observations) {
    const { device, network, browserId } = observation.client;
    const name = nameFor(observation.rosterMemberId);
    if (!device || !network || !name) {
      continue;
    }
    const key = `${network}|${device}`;
    const entry = namesByDevice.get(key) ?? { names: new Map<string, string>(), browsers: new Set<string>() };
    entry.names.set(normalizeName(name), name);
    entry.browsers.add(browserId);
    namesByDevice.set(key, entry);
  }
  for (const [key, entry] of namesByDevice) {
    if (entry.names.size > 1 && entry.browsers.size > 1) {
      const network = networks.label(key.split("|")[0]);
      flags.push({
        id: `device-${key}`,
        severity: "medium",
        title: `${entry.names.size} people from what looks like one device`,
        detail: `${listNames(entry.names.values()).join(", ")} used ${entry.browsers.size} different browsers with matching device details on ${network}. Could be identical work PCs; worth a look.`,
        rosterMemberNames: listNames(entry.names.values()),
      });
    }
  }

  // C: blocked attempts.
  for (const event of events) {
    const target = nameFor(event.rosterMemberId);
    if (!target) {
      continue;
    }
    const browserLabel = browsers.label(event.client?.browserId);
    if (event.type === "switch_blocked") {
      flags.push({
        id: `event-${event.id}`,
        severity: "high",
        title: `Someone already registered tried to pick ${target}`,
        detail: `${browserLabel ?? "A browser"} is registered as ${event.note ?? "someone else"} and tried to switch to ${target}. Blocked.`,
        rosterMemberNames: listNames(new Set([target, ...(event.note ? [event.note] : [])])),
      });
    } else if (event.type === "claim_blocked") {
      flags.push({
        id: `event-${event.id}`,
        severity: "low",
        title: `${target}'s name was requested from a new browser`,
        detail: `${browserLabel ?? "A browser"} (${event.client?.agent ?? "unknown browser"}) tried to take ${target}, who is registered elsewhere. Blocked. Could just be ${target} on another device.`,
        rosterMemberNames: [target],
      });
    } else if (event.type === "reclaim" && event.previousBrowserId) {
      flags.push({
        id: `event-${event.id}`,
        severity: "low",
        title: `${target} moved to a new browser`,
        detail: `${target}'s name moved from ${browsers.label(event.previousBrowserId)} to ${browserLabel ?? "a new browser"} using the name remembered on that browser.`,
        rosterMemberNames: [target],
      });
    }
  }

  const severityOrder = { high: 0, medium: 1, low: 2 } as const;
  flags.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const boundBrowserByMember = new Map<string, string>();
  for (const [token, rosterMemberId] of Object.entries(bracket.voterBindings ?? {})) {
    boundBrowserByMember.set(rosterMemberId, browserIdForToken(token));
  }

  const members: VoteWatchMember[] = bracket.rosterMembers.map((member) => {
    const mine = observations.filter((observation) => observation.rosterMemberId === member.id);
    const latest = mine.at(-1);
    const votesCast = bracket.rounds.reduce(
      (total, round) =>
        total +
        round.matchups.reduce(
          (count, matchup) => count + matchup.votes.filter((vote) => vote.rosterMemberId === member.id).length,
          0,
        ),
      0,
    );
    const boundBrowserId = boundBrowserByMember.get(member.id) ?? null;

    return {
      rosterMemberId: member.id,
      name: member.name,
      registered: Boolean(boundBrowserId),
      browserLabel: browsers.label(boundBrowserId ?? latest?.client.browserId),
      networkLabel: networks.label(latest?.client.network),
      agent: latest?.client.agent ?? null,
      votesCast,
      browsersUsed: new Set(mine.map((observation) => observation.client.browserId)).size,
    };
  });

  const recentEvents: VoteWatchEvent[] = events
    .slice(-RECENT_EVENT_COUNT)
    .reverse()
    .map((event) => ({
      id: event.id,
      type: event.type,
      at: event.at,
      rosterMemberName: nameFor(event.rosterMemberId),
      browserLabel: browsers.label(event.client?.browserId),
      networkLabel: networks.label(event.client?.network),
      agent: event.client?.agent ?? null,
      ...(event.note ? { note: event.note } : {}),
    }));

  return { flags, members, recentEvents };
}
