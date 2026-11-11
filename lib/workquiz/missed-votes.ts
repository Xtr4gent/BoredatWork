import type { BracketRecord, MissedVotesRound, RoundRecord } from "@/lib/workquiz/types";

/**
 * Remembers who was on the roster, and who was marked away, at the moment a
 * round's voting closed. "Away" is a switch the admin flips day to day, so
 * without this a finished round could only be judged by who is away now.
 * Kept once: a round that is already closed is never re-stamped.
 */
export function recordCloseRoster(bracket: BracketRecord, round: RoundRecord) {
  round.closeRoster ??= {
    memberIds: bracket.rosterMembers.map((member) => member.id),
    awayIds: bracket.rosterMembers.filter((member) => member.away).map((member) => member.id),
  };
}

/**
 * For every round whose voting has closed: the people who could vote and did
 * not finish. Away people are left out, and so is anyone added to the roster
 * after the round closed. Newest round first.
 *
 * Rounds that closed before close rosters were recorded fall back to the
 * current roster and who is away now (`awayRecorded: false`).
 *
 * Shutting a tournament down marks its open and not-yet-opened rounds
 * "closed" too, although nobody could finish voting in them. Those rounds
 * never get a close roster, so in a shut-down tournament only rounds that
 * have one are reported.
 */
export function buildMissedVotes(
  bracket: BracketRecord,
  rosterAliases: Map<string, Set<string>>,
): MissedVotesRound[] {
  const membersById = new Map(bracket.rosterMembers.map((member) => [member.id, member]));
  const result: MissedVotesRound[] = [];

  for (const round of bracket.rounds) {
    if (round.status !== "closed" && round.status !== "tiebreaker") {
      continue;
    }

    if (bracket.status === "disabled" && !round.closeRoster) {
      continue;
    }

    const votingMatchups = round.matchups.filter((matchup) => matchup.entrantAId && matchup.entrantBId);
    if (!votingMatchups.length) {
      continue;
    }

    const memberIds = round.closeRoster?.memberIds ?? bracket.rosterMembers.map((member) => member.id);
    const awayIds = new Set(
      round.closeRoster?.awayIds ??
        bracket.rosterMembers.filter((member) => member.away).map((member) => member.id),
    );

    let couldVote = 0;
    let awayCount = 0;
    const missed: MissedVotesRound["missed"] = [];

    for (const memberId of memberIds) {
      const member = membersById.get(memberId);
      if (!member) {
        continue;
      }

      const equivalentIds = rosterAliases.get(memberId) ?? new Set([memberId]);
      const votesCast = votingMatchups.filter((matchup) =>
        matchup.votes.some((vote) => equivalentIds.has(vote.rosterMemberId)),
      ).length;
      const finished = votesCast === votingMatchups.length;

      // Same rule as turnout: away people only count if they finished voting.
      if (awayIds.has(memberId) && !finished) {
        awayCount += 1;
        continue;
      }

      couldVote += 1;
      if (!finished) {
        missed.push({
          rosterMemberId: memberId,
          name: member.name,
          votesCast,
          votesPossible: votingMatchups.length,
        });
      }
    }

    missed.sort((left, right) => left.votesCast - right.votesCast || left.name.localeCompare(right.name));
    result.push({
      roundNumber: round.number,
      roundLabel: round.label,
      awayRecorded: Boolean(round.closeRoster),
      couldVote,
      awayCount,
      missed,
    });
  }

  return result.reverse();
}
