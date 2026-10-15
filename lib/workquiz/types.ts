export type SeedingMode = "manual" | "random";
export type BracketKind = "public" | "test";
export type BracketStatus = "draft" | "live" | "completed" | "disabled";
export type RoundStatus = "upcoming" | "live" | "tiebreaker" | "closed";
export type MatchupStatus = "pending" | "live" | "needs_tiebreaker" | "closed";

export type EntrantInput =
  | string
  | {
      name: string;
      imageUrl?: string;
    };

export interface EntrantRecord {
  id: string;
  name: string;
  seed: number;
  imageUrl?: string;
}

export interface RosterMemberRecord {
  id: string;
  name: string;
}

/**
 * Pseudonymous fingerprint of the browser behind a claim or vote. Every field
 * is a short keyed hash (or a coarse "Chrome on Windows" label), so the store
 * never holds raw IP addresses or user agents. Only equality matters.
 */
export interface VoterClientInfo {
  browserId: string;
  network: string | null;
  device: string | null;
  agent: string | null;
}

export type VoterEventType =
  | "claim"
  | "claim_blocked"
  | "switch_blocked"
  | "reclaim"
  | "release"
  | "reset_all";

export interface VoterEventRecord {
  id: string;
  type: VoterEventType;
  at: string;
  rosterMemberId: string | null;
  client: VoterClientInfo | null;
  /** Browser that held the name before a reclaim or release. */
  previousBrowserId?: string | null;
  note?: string;
}

export interface VoteRecord {
  id: string;
  rosterMemberId: string;
  entrantId: string;
  createdAt: string;
  client?: VoterClientInfo;
}

export interface MatchupRecord {
  id: string;
  slot: number;
  entrantAId: string | null;
  entrantBId: string | null;
  winnerEntrantId: string | null;
  status: MatchupStatus;
  votes: VoteRecord[];
  updatedAt: string;
}

export interface RoundRecord {
  id: string;
  number: number;
  label: string;
  startsAt: string;
  endsAt: string;
  status: RoundStatus;
  roundStartPingClaimedAt?: string;
  roundStartPingedAt?: string;
  matchups: MatchupRecord[];
}

export interface BracketRecord {
  id: string;
  kind?: BracketKind;
  title: string;
  slug: string;
  status: BracketStatus;
  isCurrentPublic: boolean;
  publicToken: string;
  adminTokenHash: string;
  seedingMode: SeedingMode;
  createdAt: string;
  publishedAt: string;
  totalPlayers: number;
  roundDurationHours: number;
  /**
   * "daily": one round per day in a fixed time-of-day window (what the create
   * form makes). "back-to-back": rounds run straight after each other.
   * Missing on brackets created before this was recorded.
   */
  scheduleKind?: "daily" | "back-to-back";
  revoteDurationHours: number;
  entrants: EntrantRecord[];
  directQualifierEntrantIds?: string[];
  rosterMembers: RosterMemberRecord[];
  /** browserToken -> rosterMemberId; optional on legacy brackets until first bind */
  voterBindings?: Record<string, string>;
  /**
   * rosterMemberId -> secret id of the current registration (or a "released:"
   * marker). The remembered-name cookie must carry it to recover a name.
   */
  memberClaims?: Record<string, string>;
  /** Capped audit log of name claims, blocked takeovers and resets. */
  voterEvents?: VoterEventRecord[];
  rounds: RoundRecord[];
}

export interface StoreShape {
  brackets: BracketRecord[];
}

export interface CreateBracketInput {
  title: string;
  kind?: BracketKind;
  seedingMode: SeedingMode;
  entrants: EntrantInput[];
  directQualifierNames?: string[];
  rosterMembers: string[];
  seededEntrants?: EntrantInput[];
  startsAt: string;
  endsAt?: string;
  totalPlayers: number;
  roundDurationHours?: number;
  revoteDurationHours?: number;
}

export interface AdminHistoryItem {
  id: string;
  title: string;
  winnerName: string;
  tournamentDate: string;
  completedAt: string;
  entrantNames: string[];
  rosterMemberNames: string[];
  seedingMode: SeedingMode;
}

export interface BracketSnapshotEntrant {
  id: string;
  name: string;
  seed: number;
  imageUrl?: string;
}

export interface BracketSnapshotRosterMember {
  id: string;
  name: string;
}

export interface BracketSnapshotVoteState {
  canVote: boolean;
  votedEntrantId: string | null;
}

export interface AdminVoteEntry {
  rosterMemberId: string;
  rosterMemberName: string;
  entrantId: string;
  entrantName: string;
  createdAt: string;
}

export interface BracketSnapshotRosterStatus {
  rosterMemberId: string;
  name: string;
  hasVoted: boolean;
}

export interface BracketSnapshotMatchup {
  id: string;
  slot: number;
  status: MatchupStatus;
  entrantA: BracketSnapshotEntrant | null;
  entrantB: BracketSnapshotEntrant | null;
  winnerEntrantId: string | null;
  votesA: number;
  votesB: number;
  totalVotes: number;
  voteState: BracketSnapshotVoteState;
  adminVotes?: AdminVoteEntry[];
}

export interface BracketSnapshotRound {
  id: string;
  number: number;
  label: string;
  startsAt: string;
  endsAt: string;
  status: RoundStatus;
  matchups: BracketSnapshotMatchup[];
}

export interface BracketSnapshot {
  id: string;
  kind: BracketKind;
  title: string;
  slug: string;
  status: BracketStatus;
  isCurrentPublic: boolean;
  publicToken: string;
  publicUrl: string;
  adminUrl?: string;
  seedingMode: SeedingMode;
  createdAt: string;
  publishedAt: string;
  totalPlayers: number;
  roundDurationHours: number;
  entrants: BracketSnapshotEntrant[];
  rosterMembers: BracketSnapshotRosterMember[];
  rounds: BracketSnapshotRound[];
  currentRoundId: string | null;
  currentRoundUniqueVoters: number;
  totalVotes: number;
  selectedRosterMemberId?: string | null;
  currentRoundRosterStatuses: BracketSnapshotRosterStatus[];
  adminHistory?: AdminHistoryItem[];
  voteWatch?: VoteWatchSnapshot;
}

export type VoteWatchSeverity = "high" | "medium" | "low";

export interface VoteWatchFlag {
  id: string;
  severity: VoteWatchSeverity;
  title: string;
  detail: string;
  rosterMemberNames: string[];
}

export interface VoteWatchMember {
  rosterMemberId: string;
  name: string;
  registered: boolean;
  browserLabel: string | null;
  networkLabel: string | null;
  agent: string | null;
  votesCast: number;
  browsersUsed: number;
}

export interface VoteWatchEvent {
  id: string;
  type: VoterEventType;
  at: string;
  rosterMemberName: string | null;
  browserLabel: string | null;
  networkLabel: string | null;
  agent: string | null;
  note?: string;
}

export interface VoteWatchSnapshot {
  flags: VoteWatchFlag[];
  members: VoteWatchMember[];
  recentEvents: VoteWatchEvent[];
}

export interface PublicBracketSnapshotRosterMember {
  name: string;
  claimed: boolean;
  isYou: boolean;
}

export interface PublicBracketSnapshotEntrant {
  name: string;
  seed: number;
  imageUrl?: string;
}

export interface PublicBracketSnapshotVoteState {
  canVote: boolean;
  votedSide: "A" | "B" | null;
}

export interface PublicBracketSnapshotMatchup {
  slot: number;
  status: MatchupStatus;
  entrantA: PublicBracketSnapshotEntrant | null;
  entrantB: PublicBracketSnapshotEntrant | null;
  winnerName: string | null;
  votesA: number;
  votesB: number;
  totalVotes: number;
  voteState: PublicBracketSnapshotVoteState;
}

export interface PublicBracketSnapshotRound {
  number: number;
  label: string;
  startsAt: string;
  endsAt: string;
  status: RoundStatus;
  matchups: PublicBracketSnapshotMatchup[];
}

export interface PublicBracketSnapshotRosterStatus {
  name: string;
  hasVoted: boolean;
}

export interface PublicBracketSnapshot {
  id: string;
  kind: BracketKind;
  title: string;
  slug: string;
  status: BracketStatus;
  isCurrentPublic: boolean;
  publicUrl: string;
  seedingMode: SeedingMode;
  createdAt: string;
  publishedAt: string;
  totalPlayers: number;
  roundDurationHours: number;
  entrants: PublicBracketSnapshotEntrant[];
  rosterMembers: PublicBracketSnapshotRosterMember[];
  rounds: PublicBracketSnapshotRound[];
  currentRoundNumber: number | null;
  currentRoundUniqueVoters: number;
  totalVotes: number;
  selectedRosterMemberName: string | null;
  currentRoundRosterStatuses: PublicBracketSnapshotRosterStatus[];
}
