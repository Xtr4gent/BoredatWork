"use client";

import Link from "next/link";
import { useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  BracketSnapshot,
  BracketSnapshotEntrant,
  BracketSnapshotMatchup,
  PublicBracketSnapshot,
  PublicBracketSnapshotEntrant,
  PublicBracketSnapshotMatchup,
  BracketSnapshotRound,
} from "@/lib/workquiz/types";
import { CreateBracketForm } from "@/components/CreateBracketForm";

type AdminSection = "live" | "roster" | "results" | "advance" | "create" | "links" | "history" | "danger";

const easternFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

function formatEasternDateTime(value: string) {
  return easternFormatter.format(new Date(value));
}

function formatCountdown(targetIso: string, nowTick: number) {
  const msLeft = new Date(targetIso).getTime() - nowTick;
  if (msLeft <= 0) {
    return "less than a minute";
  }

  const totalSeconds = Math.floor(msLeft / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

function useHydrated() {
  return useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
}

function percent(part: number, total: number) {
  if (!total) {
    return 0;
  }

  return Math.round((part / total) * 100);
}

function entrantLabel(entrant: BracketSnapshotEntrant | PublicBracketSnapshotEntrant | null) {
  return entrant ? entrant.name : "TBD";
}

function isPublicSnapshot(
  snapshot: BracketSnapshot | PublicBracketSnapshot,
): snapshot is PublicBracketSnapshot {
  return "selectedRosterMemberName" in snapshot;
}

function championName(snapshot: BracketSnapshot | PublicBracketSnapshot) {
  if (isPublicSnapshot(snapshot)) {
    const finalRound = snapshot.rounds[snapshot.rounds.length - 1];
    return finalRound?.matchups[0]?.winnerName ?? null;
  }

  const finalRound = snapshot.rounds[snapshot.rounds.length - 1];
  const winnerId = finalRound?.matchups[0]?.winnerEntrantId;
  return snapshot.entrants.find((entrant) => entrant.id === winnerId)?.name ?? null;
}

function renderEntrantImage(
  entrant: BracketSnapshotEntrant | PublicBracketSnapshotEntrant | null,
  className: string,
) {
  if (!entrant?.imageUrl) {
    return null;
  }

  return (
    <span
      aria-label={`${entrant.name} option image`}
      className={className}
      role="img"
      style={{ backgroundImage: `url(${entrant.imageUrl})` }}
    />
  );
}

function matchupTitle(matchup: BracketSnapshotMatchup) {
  return `${entrantLabel(matchup.entrantA)} vs ${entrantLabel(matchup.entrantB)}`;
}

function resultWidth(votes: number, total: number) {
  return `${percent(votes, total)}%`;
}

function resultBarClassName(votes: number, otherVotes: number, totalVotes: number, baseClassName: string) {
  const isLeader = totalVotes > 0 && votes >= otherVotes;
  return isLeader ? baseClassName : `${baseClassName} losing`;
}

type BracketClientProps =
  | {
      mode: "public";
      token: string;
      initialSnapshot: PublicBracketSnapshot;
    }
  | {
      mode: "admin";
      token: string;
      adminToken?: string;
      initialSnapshot: BracketSnapshot;
    }
  | {
      mode: "history";
      token: string;
      initialSnapshot: BracketSnapshot;
    };

export function BracketClient(props: BracketClientProps) {
  const { token, mode, initialSnapshot } = props;
  const adminToken = props.mode === "admin" ? props.adminToken : undefined;
  const [snapshot, setSnapshot] = useState<BracketSnapshot | PublicBracketSnapshot>(initialSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [selectedRosterMemberName, setSelectedRosterMemberName] = useState<string | null>(
    mode === "public" ? initialSnapshot.selectedRosterMemberName ?? null : null,
  );
  const [selectedRosterMemberId] = useState<string | null>(
    mode !== "public" && "selectedRosterMemberId" in initialSnapshot
      ? (initialSnapshot.selectedRosterMemberId ?? null)
      : null,
  );
  const [identityPickerOpen, setIdentityPickerOpen] = useState(
    mode === "public" && !initialSnapshot.selectedRosterMemberName,
  );
  const [identityReady, setIdentityReady] = useState(
    () =>
      mode !== "public" ||
      Boolean(
        isPublicSnapshot(initialSnapshot) && initialSnapshot.selectedRosterMemberName,
      ),
  );
  const [pendingVotes, setPendingVotes] = useState<Record<number, "A" | "B">>({});
  const [adminSection, setAdminSection] = useState<AdminSection>("live");
  const [inspectedRosterMemberId, setInspectedRosterMemberId] = useState<string | null>(null);
  const [rosterAddText, setRosterAddText] = useState("");
  const [rosterAddPending, setRosterAddPending] = useState(false);
  const hydrated = useHydrated();
  const lastEtagRef = useRef<{ url: string; etag: string } | null>(null);

  const refresh = useEffectEvent(async () => {
    if (mode === "history") {
      return;
    }

    const query = "";
    const url = mode === "admin" ? `/api/admin/${adminToken}` : `/api/brackets/${token}${query}`;
    const headers: Record<string, string> = {};
    if (lastEtagRef.current?.url === url) {
      headers["If-None-Match"] = lastEtagRef.current.etag;
    }

    const response = await fetch(url, { cache: "no-store", headers });
    if (response.status === 304) {
      return;
    }

    const result = (await response.json()) as (BracketSnapshot | PublicBracketSnapshot) & { error?: string };
    if (!response.ok) {
      setError(result.error ?? "Could not refresh the bracket.");
      return;
    }

    const etag = response.headers.get("etag");
    lastEtagRef.current = etag ? { url, etag } : null;
    setSnapshot(result);
    if (mode === "public" && isPublicSnapshot(result)) {
      setSelectedRosterMemberName(result.selectedRosterMemberName ?? null);
      setIdentityReady(true);
      if (result.selectedRosterMemberName) {
        setIdentityPickerOpen(false);
      }
    }
  });

  useEffect(() => {
    if (mode === "history") {
      return;
    }

    let disposed = false;
    let ws: WebSocket | null = null;
    let reconnectAttempts = 0;
    let reconnectTimer: number | undefined;
    let pollTimer: number | undefined;
    let refreshTimer: number | undefined;

    // Coalesces bursts of realtime events into one fetch. Hidden tabs skip
    // refreshes entirely; the visibilitychange handler catches them up.
    const scheduleRefresh = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      if (refreshTimer !== undefined) {
        return;
      }

      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        void refresh();
      }, 750);
    };

    const stopFallbackPolling = () => {
      if (pollTimer !== undefined) {
        window.clearInterval(pollTimer);
        pollTimer = undefined;
      }
    };

    // Only used while the websocket is down, and only for visible tabs.
    const startFallbackPolling = () => {
      if (pollTimer !== undefined) {
        return;
      }

      pollTimer = window.setInterval(() => {
        if (document.visibilityState === "visible") {
          scheduleRefresh();
        }
      }, 30000);
    };

    const connect = () => {
      if (disposed) {
        return;
      }

      reconnectTimer = undefined;
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${scheme}://${window.location.host}/ws?token=${token}`);

      ws.addEventListener("open", () => {
        reconnectAttempts = 0;
        stopFallbackPolling();
      });

      ws.addEventListener("message", scheduleRefresh);

      ws.addEventListener("close", () => {
        ws = null;
        if (disposed) {
          return;
        }

        startFallbackPolling();
        const delayMs =
          Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempts, 5)) + Math.random() * 1000;
        reconnectAttempts += 1;
        reconnectTimer = window.setTimeout(connect, delayMs);
      });
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      void refresh();

      if (!ws && reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
        connect();
      }
    };

    connect();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      stopFallbackPolling();
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer);
      }
      document.removeEventListener("visibilitychange", onVisible);
      ws?.close();
    };
  }, [mode, token]);

  useEffect(() => {
    if (mode === "public") {
      void refresh();
    }
  }, [mode, selectedRosterMemberName]);

  const currentRound = useMemo(() => {
    if (isPublicSnapshot(snapshot)) {
      return snapshot.rounds.find((round) => round.number === snapshot.currentRoundNumber) ?? null;
    }

    return snapshot.rounds.find((round) => round.id === snapshot.currentRoundId) ?? null;
  }, [snapshot]);

  useEffect(() => {
    if (mode === "history") {
      return;
    }

    const timer = window.setInterval(() => {
      setNowTick(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [mode]);

  const handledDeadlineRef = useRef<string | null>(null);

  useEffect(() => {
    if (!currentRound) {
      return;
    }

    const deadlineIso =
      currentRound.status === "live" ? currentRound.endsAt : currentRound.startsAt;

    if (new Date(deadlineIso).getTime() > nowTick) {
      return;
    }

    // Refresh once per crossed deadline. Without this guard the 1s countdown
    // tick refetched the snapshot every second for as long as a deadline sat
    // in the past (e.g. waiting on a tie-breaker).
    const roundKey = isPublicSnapshot(snapshot)
      ? currentRound.number
      : (currentRound as BracketSnapshotRound).id;
    const deadlineKey = `${roundKey}:${currentRound.status}:${deadlineIso}`;
    if (handledDeadlineRef.current === deadlineKey) {
      return;
    }

    handledDeadlineRef.current = deadlineKey;
    void refresh();
  }, [currentRound, nowTick]);

  const displayPublicUrl = useMemo(() => {
    if (!hydrated) {
      return snapshot.publicUrl;
    }

    return new URL(snapshot.publicUrl, window.location.origin).toString();
  }, [hydrated, snapshot.publicUrl]);

  const displayAdminUrl = useMemo(() => {
    if (isPublicSnapshot(snapshot) || !snapshot.adminUrl) {
      return null;
    }

    if (!hydrated) {
      return snapshot.adminUrl;
    }

    return new URL(snapshot.adminUrl, window.location.origin).toString();
  }, [hydrated, snapshot]);

  const displayCurrentUrl = useMemo(() => {
    if (!hydrated) {
      return "/voting";
    }

    return new URL("/voting", window.location.origin).toString();
  }, [hydrated]);
  const displayTestUrl = useMemo(() => {
    if (!adminToken) {
      return null;
    }

    const href = `/test?adminToken=${encodeURIComponent(adminToken)}`;
    return hydrated ? new URL(href, window.location.origin).toString() : href;
  }, [adminToken, hydrated]);

  const reuseTemplateBase = useMemo(() => {
    if (!adminToken) {
      return null;
    }

    return `/admin?adminToken=${encodeURIComponent(adminToken)}`;
  }, [adminToken]);

  const currentRoundBanner = useMemo(() => {
    if (snapshot.status === "disabled") {
      return {
        title: "Bracket shut down",
        body: "The public link has been disabled and voting is no longer available.",
      };
    }

    if (!currentRound) {
      return {
        title: "Bracket complete",
        body: "The final round is over. Time to celebrate the winner.",
      };
    }

    if (currentRound.status === "live") {
      return {
        title: `${currentRound.label} is live`,
        body: `Voting closes in ${formatCountdown(currentRound.endsAt, nowTick)}.`,
      };
    }

    if (currentRound.status === "tiebreaker") {
      return {
        title: "Tie breaker in progress",
        body: "Voting is locked while the admin asks an outside person to choose the winner.",
      };
    }

    if (currentRound.status === "upcoming") {
      return {
        title: `${currentRound.label} has not opened yet`,
        body: hydrated
          ? `Voting opens in ${formatCountdown(currentRound.startsAt, nowTick)}.`
          : "Voting opens soon.",
      };
    }

    return {
      title: `${currentRound.label} is closed`,
      body: "Results are locked in while the bracket syncs the next stage.",
    };
  }, [currentRound, hydrated, nowTick, snapshot.status]);

  const selectedRosterMemberDisplayName = useMemo(() => {
    if (mode === "public") {
      return selectedRosterMemberName;
    }

    if (isPublicSnapshot(snapshot)) {
      return null;
    }

    return snapshot.rosterMembers.find((member) => member.id === selectedRosterMemberId)?.name ?? null;
  }, [mode, selectedRosterMemberId, selectedRosterMemberName, snapshot]);

  const createNewBracketHref = useMemo(
    () => (adminToken ? `/admin?adminToken=${encodeURIComponent(adminToken)}` : "/admin"),
    [adminToken],
  );

  const activeMatchups = currentRound?.matchups.filter((matchup) => matchup.status === "live") ?? [];
  const tieBreakerMatchups =
    currentRound?.matchups.filter((matchup) => matchup.status === "needs_tiebreaker") ?? [];
  const primaryMatchup = activeMatchups[0] ?? currentRound?.matchups[0] ?? snapshot.rounds[0]?.matchups[0] ?? null;
  const turnout = percent(snapshot.currentRoundUniqueVoters, snapshot.totalPlayers);
  const pendingRosterCount = Math.max(snapshot.totalPlayers - snapshot.currentRoundUniqueVoters, 0);
  const champion = championName(snapshot);
  const isTestBracket = snapshot.kind === "test";
  const rosterInspectorStatuses = !isPublicSnapshot(snapshot)
    ? snapshot.currentRoundRosterStatuses.length
      ? snapshot.currentRoundRosterStatuses
      : snapshot.rosterMembers.map((member) => ({
          rosterMemberId: member.id,
          name: member.name,
          hasVoted: false,
        }))
    : [];

  const fallbackInspectedRosterMemberId =
    rosterInspectorStatuses.find((member) => member.hasVoted)?.rosterMemberId ??
    rosterInspectorStatuses[0]?.rosterMemberId ??
    null;
  const activeInspectedRosterMemberId =
    inspectedRosterMemberId &&
    rosterInspectorStatuses.some((member) => member.rosterMemberId === inspectedRosterMemberId)
      ? inspectedRosterMemberId
      : fallbackInspectedRosterMemberId;
  const inspectedRosterMember =
    rosterInspectorStatuses.find((member) => member.rosterMemberId === activeInspectedRosterMemberId) ?? null;
  const inspectedRoundVotes = !isPublicSnapshot(snapshot)
    ? (currentRound?.matchups ?? []).map((matchup) => {
        const adminMatchup = matchup as BracketSnapshotMatchup;
        const vote =
          adminMatchup.adminVotes?.find(
            (entry) => entry.rosterMemberId === activeInspectedRosterMemberId,
          ) ?? null;
        return {
          matchup: adminMatchup,
          vote,
        };
      })
    : [];

  async function handleRosterSelection(nextRosterMemberName: string) {
    setError(null);

    if (mode === "public") {
      const previousName = selectedRosterMemberName;
      setSelectedRosterMemberName(nextRosterMemberName);
      setIdentityPickerOpen(false);
      setIdentityReady(true);

      const response = await fetch(`/api/brackets/${token}/identity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rosterMemberName: nextRosterMemberName }),
      });
      const result = (await response.json()) as PublicBracketSnapshot & { error?: string };
      if (!response.ok) {
        setSelectedRosterMemberName(previousName);
        setError(result.error ?? "Could not register your name.");
        setIdentityPickerOpen(true);
        setIdentityReady(Boolean(previousName));
        return;
      }

      setSnapshot(result);
      setSelectedRosterMemberName(result.selectedRosterMemberName ?? nextRosterMemberName);
      return;
    }

    setSelectedRosterMemberName(nextRosterMemberName);
    setIdentityPickerOpen(false);
  }

  async function vote(matchupSlot: number, side: "A" | "B") {
    setError(null);
    if (!identityReady) {
      setError("Still connecting your name. Try again in a moment.");
      return;
    }
    if (!selectedRosterMemberName) {
      setError("Choose your name before voting.");
      setIdentityPickerOpen(true);
      return;
    }
    if (pendingVotes[matchupSlot]) {
      return;
    }

    setPendingVotes((previous) => ({ ...previous, [matchupSlot]: side }));

    const response = await fetch(`/api/brackets/${token}/votes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchupSlot, side }),
    });
    const result = (await response.json()) as PublicBracketSnapshot & { error?: string };

    setPendingVotes((previous) => {
      const next = { ...previous };
      delete next[matchupSlot];
      return next;
    });

    if (!response.ok) {
      setError(result.error ?? "Vote failed.");
      return;
    }

    setSnapshot(result);
    setSelectedRosterMemberName(result.selectedRosterMemberName ?? selectedRosterMemberName);
  }

  async function advanceNow() {
    if (!adminToken) {
      return;
    }

    if (!window.confirm("Are you sure you want to advance to the next round early?")) {
      return;
    }

    const response = await fetch(`/api/admin/${adminToken}/advance`, { method: "POST" });
    const result = (await response.json()) as BracketSnapshot & { error?: string };
    if (!response.ok) {
      setError(result.error ?? "Could not advance the round.");
      return;
    }

    setSnapshot(result);
  }

  async function restartNow() {
    if (!adminToken) {
      return;
    }

    if (!window.confirm("Are you sure you want to restart the bracket from round one?")) {
      return;
    }

    setError(null);
    const response = await fetch(`/api/admin/${adminToken}/restart`, { method: "POST" });
    const result = (await response.json()) as BracketSnapshot & { error?: string };
    if (!response.ok) {
      setError(result.error ?? "Could not restart the bracket.");
      return;
    }

    setSnapshot(result);
  }

  async function resetVoterBindingsNow() {
    if (!adminToken) {
      return;
    }

    if (
      !window.confirm(
        "Reset all name registrations? Votes stay as they are. Everyone will pick their name again on /voting.",
      )
    ) {
      return;
    }

    setError(null);
    const response = await fetch(`/api/admin/${adminToken}/bindings/reset`, { method: "POST" });
    const result = (await response.json()) as BracketSnapshot & { error?: string };
    if (!response.ok) {
      setError(result.error ?? "Could not reset voter registrations.");
      return;
    }

    setSnapshot(result);
  }

  async function addRosterMembersNow() {
    if (!adminToken) {
      return;
    }

    const names = rosterAddText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (!names.length) {
      setError("Enter at least one name to add.");
      return;
    }

    setError(null);
    setRosterAddPending(true);
    try {
      const response = await fetch(`/api/admin/${adminToken}/roster/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names }),
      });
      const result = (await response.json()) as BracketSnapshot & { error?: string };
      if (!response.ok) {
        setError(result.error ?? "Could not add roster members.");
        return;
      }

      setSnapshot(result);
      setRosterAddText("");
    } finally {
      setRosterAddPending(false);
    }
  }

  async function shutDownNow() {
    if (!adminToken) {
      return;
    }

    const confirmation = isTestBracket
      ? "Discard this test bracket? It will stay out of public voting and Past Tournaments."
      : "Are you sure you want to shut down this bracket and disable the public link?";
    if (!window.confirm(confirmation)) {
      return;
    }

    setError(null);
    const response = await fetch(`/api/admin/${adminToken}/shutdown`, { method: "POST" });
    const result = (await response.json()) as BracketSnapshot & { error?: string };
    if (!response.ok) {
      setError(result.error ?? "Could not shut down the bracket.");
      return;
    }

    setSnapshot(result);
  }

  async function clearVote(matchupId: string, rosterMemberId: string, rosterMemberName: string) {
    if (!adminToken) {
      return;
    }

    if (!window.confirm(`Are you sure you want to clear ${rosterMemberName}'s vote for this matchup?`)) {
      return;
    }

    setError(null);
    const response = await fetch(`/api/admin/${adminToken}/votes/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchupId, rosterMemberId }),
    });
    const result = (await response.json()) as BracketSnapshot & { error?: string };
    if (!response.ok) {
      setError(result.error ?? "Could not clear the vote.");
      return;
    }

    setSnapshot(result);
  }

  async function makeCurrentPublicNow() {
    if (!adminToken) {
      return;
    }

    setError(null);
    const response = await fetch(`/api/admin/${adminToken}/current`, { method: "POST" });
    const result = (await response.json()) as BracketSnapshot & { error?: string };
    if (!response.ok) {
      setError(result.error ?? "Could not mark this bracket as current.");
      return;
    }

    setSnapshot(result);
  }

  async function resolveTieBreakerNow(
    matchup: BracketSnapshotMatchup,
    winner: BracketSnapshotEntrant | null,
  ) {
    if (!winner) {
      return;
    }

    if (!adminToken) {
      setError("Admin token is missing. Refresh admin page and try again.");
      return;
    }

    if (!window.confirm(`Advance ${winner.name} as the tie-breaker winner?`)) {
      return;
    }

    setError(null);
    try {
      const response = await fetch(`/api/admin/${adminToken}/ties/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchupId: matchup.id, winnerEntrantId: winner.id }),
      });
      const raw = await response.text();
      let result: (BracketSnapshot & { error?: string }) | null = null;
      if (raw) {
        try {
          result = JSON.parse(raw) as BracketSnapshot & { error?: string };
        } catch {
          result = {
            error: "Tie-breaker request failed before the server returned JSON.",
          } as BracketSnapshot & { error?: string };
        }
      }

      if (!response.ok || !result) {
        setError(result?.error ?? "Could not resolve the tie breaker.");
        return;
      }

      setSnapshot(result);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not resolve the tie breaker.");
    }
  }

  function renderPublicVote(matchup: PublicBracketSnapshotMatchup) {
    const pendingSide = pendingVotes[matchup.slot];
    const votedSide = pendingSide ?? matchup.voteState.votedSide;
    const canVote = !pendingSide && matchup.voteState.canVote;
    const canSeeVoteCounts =
      matchup.status !== "live" ||
      !canVote ||
      Boolean(votedSide);
    const votePctA = percent(matchup.votesA, matchup.totalVotes);
    const votePctB = percent(matchup.votesB, matchup.totalVotes);
    const resultBarAClassName = resultBarClassName(
      matchup.votesA,
      matchup.votesB,
      matchup.totalVotes,
      "bw-result-bar-fill",
    );
    const resultBarBClassName = resultBarClassName(
      matchup.votesB,
      matchup.votesA,
      matchup.totalVotes,
      "bw-result-bar-fill",
    );

    return (
      <section className="bw-vote-section" key={`slot-${matchup.slot}`}>
        {!selectedRosterMemberName || votedSide ? (
          <div className="bw-vote-prompt">
            {!selectedRosterMemberName
              ? "Pick your name first, then vote"
              : pendingSide
                ? "Submitting your vote..."
                : "✓ Voted — here's how it's going"}
          </div>
        ) : null}
        <div className="bw-vote-cards">
          {[matchup.entrantA, matchup.entrantB].map((entrant, index) => {
            const side = index === 0 ? "A" : "B";
            const isVotedWinner = votedSide === side;
            const isVotedLoser = Boolean(votedSide) && !isVotedWinner;
            const isPendingSelection = pendingSide === side;

            return (
              <button
                className={`bw-vote-card ${isVotedWinner ? "voted-win" : ""} ${
                  isVotedLoser ? "voted-lose" : ""
                } ${isPendingSelection && !isVotedWinner ? "is-selected" : ""}`}
                disabled={!canVote || !entrant}
                key={`${matchup.slot}-${side}`}
                onClick={() => entrant && vote(matchup.slot, side)}
                type="button"
              >
                <span className="bw-vote-card-check">✓</span>
                {renderEntrantImage(entrant, "bw-vote-card-media")}
                <span className="bw-vote-card-name">{entrantLabel(entrant)}</span>
                <span className="bw-vote-card-hint">
                  {votedSide ? "" : "Tap to vote"}
                </span>
              </button>
            );
          })}
          <div className="bw-vote-vs">VS</div>
        </div>

        <div className={`bw-vote-results ${canSeeVoteCounts ? "show" : ""}`}>
          <div className="bw-result-row">
            <div className="bw-result-label">
              <span className="bw-result-label-name">{entrantLabel(matchup.entrantA)}</span>
              <div className="bw-result-stats">
                <span className="bw-result-count">{matchup.votesA} votes</span>
                <span className="bw-result-pct">{votePctA}%</span>
              </div>
            </div>
            <div className="bw-result-bar-track">
              <div className={resultBarAClassName} style={{ width: `${votePctA}%` }} />
            </div>
          </div>
          <div className="bw-result-row">
            <div className="bw-result-label">
              <span className="bw-result-label-name">{entrantLabel(matchup.entrantB)}</span>
              <div className="bw-result-stats">
                <span className="bw-result-count">{matchup.votesB} votes</span>
                <span className="bw-result-pct">{votePctB}%</span>
              </div>
            </div>
            <div className="bw-result-bar-track">
              <div className={resultBarBClassName} style={{ width: `${votePctB}%` }} />
            </div>
          </div>
          <div className="bw-result-total">{matchup.totalVotes} total votes</div>
        </div>

        {!canSeeVoteCounts ? (
          <p className="bw-muted bw-result-lock">Results unlock after you vote.</p>
        ) : null}
      </section>
    );
  }

  function renderBracketBoard() {
    const publicView = isPublicSnapshot(snapshot);

    return (
      <div className="bw-bracket-wrap">
        <div className="bw-bracket-grid">
          {snapshot.rounds.map((round) => {
            const adminRound = round as BracketSnapshotRound;
            const roundKey = publicView ? `round-${round.number}` : adminRound.id;
            const isLiveRound = publicView
              ? currentRound?.number === round.number
              : (currentRound as BracketSnapshotRound | null)?.id === adminRound.id;

            return (
            <div className="bw-b-col" key={roundKey}>
              <div className={`bw-b-col-header ${isLiveRound ? "live" : ""}`}>
                {round.label}
              </div>
              <div className="bw-b-group">
                {round.matchups.map((matchup) => {
                  const adminMatchup = matchup as BracketSnapshotMatchup;
                  const publicMatchup = matchup as PublicBracketSnapshotMatchup;
                  const winnerA = publicView
                    ? Boolean(
                        publicMatchup.winnerName &&
                          publicMatchup.entrantA?.name === publicMatchup.winnerName,
                      )
                    : adminMatchup.winnerEntrantId &&
                      adminMatchup.entrantA?.id === adminMatchup.winnerEntrantId;
                  const winnerB = publicView
                    ? Boolean(
                        publicMatchup.winnerName &&
                          publicMatchup.entrantB?.name === publicMatchup.winnerName,
                      )
                    : adminMatchup.winnerEntrantId &&
                      adminMatchup.entrantB?.id === adminMatchup.winnerEntrantId;
                  const canSeeVoteCounts =
                    mode !== "public" ||
                    matchup.status !== "live" ||
                    !matchup.voteState.canVote ||
                    Boolean(
                      publicView
                        ? publicMatchup.voteState.votedSide
                        : adminMatchup.voteState.votedEntrantId,
                    );
                  const matchupKey = publicView ? `slot-${matchup.slot}` : adminMatchup.id;

                  return (
                    <div
                      className={`bw-b-match ${matchup.status === "live" ? "is-live" : ""}`}
                      key={matchupKey}
                    >
                      <div className={`bw-b-entry ${winnerA ? "winner" : winnerB ? "loser" : ""}`}>
                        <span className="bw-b-seed">{matchup.entrantA?.seed ?? ""}</span>
                        <span className="bw-b-name">{entrantLabel(matchup.entrantA)}</span>
                        {winnerA ? <span className="bw-b-win-dot" /> : null}
                        {matchup.status === "live" ? <span className="bw-b-live-dot" /> : null}
                        {canSeeVoteCounts ? <span className="bw-b-score">{matchup.votesA}</span> : null}
                      </div>
                      <div className={`bw-b-entry ${winnerB ? "winner" : winnerA ? "loser" : ""}`}>
                        <span className="bw-b-seed">{matchup.entrantB?.seed ?? ""}</span>
                        <span className="bw-b-name">{entrantLabel(matchup.entrantB)}</span>
                        {winnerB ? <span className="bw-b-win-dot" /> : null}
                        {matchup.status === "live" ? <span className="bw-b-live-dot" /> : null}
                        {canSeeVoteCounts ? <span className="bw-b-score">{matchup.votesB}</span> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            );
          })}
          <div className="bw-b-col bw-b-champion">
            <div className="bw-b-col-header live">Champion</div>
            <div className="bw-b-champ-card">
              <div className="bw-b-champ-label">Champion</div>
              {champion ? <div className="bw-b-champ-name">{champion}</div> : <div className="bw-b-champ-tbd">TBD</div>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  function renderResultBars(matchup: BracketSnapshotMatchup) {
    const aPct = percent(matchup.votesA, matchup.totalVotes);
    const bPct = percent(matchup.votesB, matchup.totalVotes);
    const resultBarAClassName = resultBarClassName(
      matchup.votesA,
      matchup.votesB,
      matchup.totalVotes,
      "bw-bar-fill",
    );
    const resultBarBClassName = resultBarClassName(
      matchup.votesB,
      matchup.votesA,
      matchup.totalVotes,
      "bw-bar-fill",
    );

    return (
      <>
        <div className="bw-matchup-result">
          <div className="bw-matchup-result-header">
            <span>{entrantLabel(matchup.entrantA)}</span>
            <div className="bw-matchup-result-stats">
              <span className="bw-res-count">{matchup.votesA} votes</span>
              <span className="bw-res-pct">{aPct}%</span>
            </div>
          </div>
          <div className="bw-bar-track">
            <div className={resultBarAClassName} style={{ width: resultWidth(matchup.votesA, matchup.totalVotes) }} />
          </div>
        </div>
        <div className="bw-matchup-result">
          <div className="bw-matchup-result-header">
            <span>{entrantLabel(matchup.entrantB)}</span>
            <div className="bw-matchup-result-stats">
              <span className="bw-res-count">{matchup.votesB} votes</span>
              <span className="bw-res-pct">{bPct}%</span>
            </div>
          </div>
          <div className="bw-bar-track">
            <div className={resultBarBClassName} style={{ width: resultWidth(matchup.votesB, matchup.totalVotes) }} />
          </div>
        </div>
      </>
    );
  }

  function renderTieBreakerPanel() {
    if (isPublicSnapshot(snapshot) || !tieBreakerMatchups.length) {
      return null;
    }

    return (
      <section className="bw-tie-panel">
        <div>
          <div className="bw-panel-title danger">Tie Breaker Needed</div>
          <p className="bw-panel-sub">
            Ask your outside person, then choose who should advance. Public voting stays locked until this is resolved.
          </p>
        </div>
        <div className="bw-tie-list">
          {tieBreakerMatchups.map((matchup) => {
            const adminMatchup = matchup as BracketSnapshotMatchup;
            return (
            <div className="bw-tie-card" key={adminMatchup.id}>
              <div className="bw-card-title">{matchupTitle(adminMatchup)}</div>
              {renderResultBars(adminMatchup)}
              <div className="bw-tie-actions">
                <button
                  className="bw-btn bw-btn-lime"
                  disabled={!adminMatchup.entrantA}
                  onClick={() => resolveTieBreakerNow(adminMatchup, adminMatchup.entrantA)}
                  type="button"
                >
                  Advance {entrantLabel(adminMatchup.entrantA)}
                </button>
                <button
                  className="bw-btn bw-btn-lime"
                  disabled={!adminMatchup.entrantB}
                  onClick={() => resolveTieBreakerNow(adminMatchup, adminMatchup.entrantB)}
                  type="button"
                >
                  Advance {entrantLabel(adminMatchup.entrantB)}
                </button>
              </div>
            </div>
            );
          })}
        </div>
      </section>
    );
  }

  function renderAdminSection() {
    if (isPublicSnapshot(snapshot)) {
      return null;
    }

    const adminSnapshot = snapshot;
    const adminCurrentRound = currentRound as BracketSnapshotRound | null;

    if (adminSection === "roster") {
      return (
        <section className="bw-section-panel active">
          <div className="bw-panel-title">Who&apos;s Voted</div>
          <p className="bw-panel-sub">
            {currentRound?.label ?? "Current round"} · {snapshot.currentRoundUniqueVoters} of {snapshot.totalPlayers} voted
          </p>
          <div className="bw-card">
            <div className="bw-card-header-row">
              <div className="bw-card-title">Roster Status</div>
              <div className="bw-tag-row">
                <span className="bw-tag bw-tag-lime">{snapshot.currentRoundUniqueVoters} voted</span>
                <span className="bw-tag bw-tag-coral">{pendingRosterCount} pending</span>
              </div>
            </div>
            <div className="bw-roster-grid">
              {rosterInspectorStatuses.map((member) => (
                <button
                  className={`bw-roster-chip bw-roster-chip-btn ${member.hasVoted ? "voted" : "pending"} ${
                    activeInspectedRosterMemberId === member.rosterMemberId ? "selected" : ""
                  }`}
                  key={member.rosterMemberId}
                  onClick={() => setInspectedRosterMemberId(member.rosterMemberId)}
                  type="button"
                >
                  <span className={`bw-chip-avatar ${member.hasVoted ? "voted-av" : "pending-av"}`}>
                    {member.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="bw-chip-name">{member.name}</span>
                  <span className={`bw-chip-status ${member.hasVoted ? "done" : "waiting"}`}>
                    {member.hasVoted ? "Voted" : "Pending"}
                  </span>
                </button>
              ))}
            </div>
            <div className="bw-roster-add-panel">
              <div className="bw-card-title">Add Roster Members</div>
              <p className="bw-muted">
                Add someone mid-tournament. They can pick their name on /voting and vote in the current round right away.
              </p>
              <label className="bw-field">
                <span>Names</span>
                <textarea
                  placeholder={"One name per line"}
                  rows={3}
                  value={rosterAddText}
                  onChange={(event) => setRosterAddText(event.target.value)}
                />
                <small>Paste one or more names. Existing roster names must stay unique.</small>
              </label>
              <div className="bw-btn-row">
                <button
                  className="bw-btn bw-btn-lime"
                  disabled={rosterAddPending || !rosterAddText.trim()}
                  onClick={() => void addRosterMembersNow()}
                  type="button"
                >
                  {rosterAddPending ? "Adding..." : "Add to Roster"}
                </button>
              </div>
            </div>
            <div className="bw-roster-inspector-detail">
              <div className="bw-card-title">
                {inspectedRosterMember ? `${inspectedRosterMember.name}'s Votes` : "Select a voter"}
              </div>
              {inspectedRosterMember && inspectedRoundVotes.length ? (
                <div className="bw-roster-vote-list">
                  {inspectedRoundVotes.map(({ matchup, vote }) => (
                    <div className="bw-roster-vote-item" key={matchup.id}>
                      <div className="bw-roster-vote-matchup">{matchupTitle(matchup)}</div>
                      <div className="bw-roster-vote-choice">
                        {vote ? `Voted for ${vote.entrantName}` : "No vote yet"}
                      </div>
                      {vote ? (
                        <button
                          className="bw-btn bw-btn-outline"
                          onClick={() =>
                            clearVote(matchup.id, inspectedRosterMember.rosterMemberId, inspectedRosterMember.name)
                          }
                          type="button"
                        >
                          Clear vote
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="bw-muted">No current-round matchups to inspect yet.</p>
              )}
            </div>
          </div>
        </section>
      );
    }

    if (adminSection === "results") {
      return (
        <section className="bw-section-panel active">
          <div className="bw-panel-title">Live Results</div>
          <p className="bw-panel-sub">All matchups · current round</p>
          {adminSnapshot.rounds.map((round) => (
            <div
              className={round.id === adminCurrentRound?.id ? "bw-card" : "bw-card is-dimmed"}
              key={round.id}
            >
              <div className="bw-card-title">
                {round.label}
                <span className={`bw-tag ${round.status === "live" ? "bw-tag-lime" : "bw-tag-muted"}`}>
                  {round.status}
                </span>
              </div>
              {round.matchups.map((matchup) => (
                <div className="bw-admin-matchup-block" key={matchup.id}>
                  <div className="bw-matchup-name">{matchupTitle(matchup)}</div>
                  {renderResultBars(matchup)}
                  {matchup.adminVotes?.length ? (
                    <div className="bw-admin-vote-list">
                      {matchup.adminVotes.map((voteEntry) => (
                        <div
                          className="bw-admin-vote-item"
                          key={`${matchup.id}-${voteEntry.rosterMemberId}`}
                        >
                          <span>
                            {voteEntry.rosterMemberName} voted for {voteEntry.entrantName}
                          </span>
                          <button
                            className="bw-btn bw-btn-outline"
                            onClick={() =>
                              clearVote(
                                matchup.id,
                                voteEntry.rosterMemberId,
                                voteEntry.rosterMemberName,
                              )
                            }
                            type="button"
                          >
                            Clear vote
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </section>
      );
    }

    if (adminSection === "advance") {
      return (
        <section className="bw-section-panel active">
          <div className="bw-panel-title">Advance Round</div>
          <p className="bw-panel-sub">Close the current matchup and move the bracket forward.</p>
          <div className="bw-advance-panel">
            <div className="bw-advance-card">
              <div className="bw-advance-card-title">Auto-Advance Timer</div>
              <div className="bw-timer-display" suppressHydrationWarning>
                {currentRound?.status === "live" && hydrated
                  ? formatCountdown(currentRound.endsAt, nowTick)
                  : "Paused"}
              </div>
              <div className="bw-timer-sub">{currentRoundBanner.body}</div>
            </div>
            <div className="bw-advance-card">
              <div className="bw-advance-card-title">Manual Controls</div>
              <div className="bw-btn-row">
                <button className="bw-btn bw-btn-lime" onClick={advanceNow} type="button">
                  Advance to Next Round
                </button>
                <button className="bw-btn bw-btn-outline" onClick={restartNow} type="button">
                  Restart Bracket
                </button>
              </div>
            </div>
          </div>
        </section>
      );
    }

    if (adminSection === "create") {
      return (
        <section className="bw-section-panel active">
          <div className="bw-panel-title">New Tournament</div>
          <p className="bw-panel-sub">Set up a fresh bracket. Once created, share the player link.</p>
          <CreateBracketForm variant="admin" />
        </section>
      );
    }

    if (adminSection === "links") {
      return (
        <section className="bw-section-panel active">
          <div className="bw-panel-title">{isTestBracket ? "Test Bracket Links" : "Tournament Links"}</div>
          <p className="bw-panel-sub">
            {isTestBracket
              ? "Private test voting, admin access, and discard controls."
              : "Current public link, private admin link, and public status controls."}
          </p>
          <div className="bw-card">
            <div className="bw-btn-row">
              {!isTestBracket && !snapshot.isCurrentPublic && snapshot.status !== "disabled" ? (
                <button className="bw-btn bw-btn-lime" onClick={makeCurrentPublicNow} type="button">
                  Make Current Public Bracket
                </button>
              ) : null}
              {snapshot.status !== "disabled" ? (
                <button className="bw-btn bw-btn-danger" onClick={shutDownNow} type="button">
                  {isTestBracket ? "Discard Test Bracket" : "Shut Down Public Link"}
                </button>
              ) : null}
              {isTestBracket && displayTestUrl ? (
                <a className="bw-btn bw-btn-lime" href={displayTestUrl}>
                  Open Test Voting
                </a>
              ) : null}
              <a className="bw-btn bw-btn-outline" href={createNewBracketHref}>
                New Tournament
              </a>
            </div>
            <div className="bw-link-stack">
              <div>
                <span>{isTestBracket ? "Public status" : "Stable public link"}</span>
                <code>
                  {isTestBracket
                    ? "Private test bracket"
                    : snapshot.isCurrentPublic
                      ? displayCurrentUrl
                      : "/voting (not active yet)"}
                </code>
              </div>
              {isTestBracket ? (
                <div>
                  <span>Test voting link</span>
                  <code>{snapshot.status === "disabled" ? "Discarded" : displayTestUrl}</code>
                </div>
              ) : (
                <div>
                  <span>Public voting link</span>
                  <code>{snapshot.status === "disabled" ? "Disabled" : displayPublicUrl}</code>
                </div>
              )}
              {displayAdminUrl ? (
                <div>
                  <span>Secret admin link</span>
                  <code>{displayAdminUrl}</code>
                </div>
              ) : null}
            </div>
          </div>
        </section>
      );
    }

    if (adminSection === "history") {
      return (
        <section className="bw-section-panel active">
          <div className="bw-panel-title">Past Tournaments</div>
          <p className="bw-panel-sub">Every debate that has been settled.</p>
          {snapshot.adminHistory?.length ? (
            snapshot.adminHistory.map((item, index) => (
              <div className="bw-history-item" key={item.id}>
                <div>
                  <div className="bw-history-num">Tournament #{snapshot.adminHistory!.length - index}</div>
                  <div className="bw-history-topic">{item.title}</div>
                  <div className="bw-history-winner">Champion: {item.winnerName}</div>
                </div>
                <div className="bw-history-meta">
                  <div>{formatEasternDateTime(item.tournamentDate)}</div>
                  <a href={`/past/${encodeURIComponent(item.id)}`}>View bracket</a>
                  {reuseTemplateBase ? (
                    <a href={`${reuseTemplateBase}&template=${encodeURIComponent(item.id)}`}>
                      Reuse topic
                    </a>
                  ) : null}
                </div>
              </div>
            ))
          ) : (
            <div className="bw-card">
              <div className="bw-card-title">No completed tournaments yet</div>
              <p className="bw-muted">Previous winners will show up here once you finish a bracket.</p>
            </div>
          )}
        </section>
      );
    }

    if (adminSection === "danger") {
      return (
        <section className="bw-section-panel active">
          <div className="bw-panel-title danger">Danger Zone</div>
          <p className="bw-panel-sub">
            {isTestBracket
              ? "These actions only affect this private test bracket. Confirm prompts are required."
              : "These actions change the active tournament. Confirm prompts are required."}
          </p>
          <div className="bw-danger-card">
            <div className="bw-danger-card-header">
              <div>
                <div className="bw-danger-card-title">Reset Name Registrations</div>
                <div className="bw-danger-card-desc">
                  Clears stuck &quot;name taken&quot; issues without removing any votes. Send everyone back to /voting to pick their name again.
                </div>
              </div>
              <button className="bw-btn bw-btn-danger" onClick={resetVoterBindingsNow} type="button">
                Reset Names
              </button>
            </div>
          </div>
          <div className="bw-danger-card">
            <div className="bw-danger-card-header">
              <div>
                <div className="bw-danger-card-title">Restart Bracket</div>
                <div className="bw-danger-card-desc">Wipes votes and sends the tournament back to round one.</div>
              </div>
              <button className="bw-btn bw-btn-danger" onClick={restartNow} type="button">
                Restart
              </button>
            </div>
          </div>
          <div className="bw-danger-card">
            <div className="bw-danger-card-header">
              <div>
                <div className="bw-danger-card-title">Force End Current Round</div>
                <div className="bw-danger-card-desc">Immediately closes voting with the current results.</div>
              </div>
              <button className="bw-btn bw-btn-danger" onClick={advanceNow} type="button">
                Force End
              </button>
            </div>
          </div>
          <div className="bw-danger-card">
            <div className="bw-danger-card-header">
              <div>
                <div className="bw-danger-card-title">
                  {isTestBracket ? "Discard Test Bracket" : "Shut Down Public Link"}
                </div>
                <div className="bw-danger-card-desc">
                  {isTestBracket
                    ? "Disables this private test bracket and keeps it out of history."
                    : "Disables public voting for this bracket."}
                </div>
              </div>
              <button className="bw-btn bw-btn-danger-solid" onClick={shutDownNow} type="button">
                {isTestBracket ? "Discard" : "Shut Down"}
              </button>
            </div>
          </div>
        </section>
      );
    }

    return (
      <section className="bw-section-panel active">
        <div className="bw-panel-title">{isTestBracket ? "Test Tournament" : "Live Tournament"}</div>
        <p className="bw-panel-sub">
          {snapshot.title} · {currentRound ? `${currentRound.label}` : "Bracket complete"}
          {isTestBracket ? " · Private test mode" : ""}
        </p>
        <div className="bw-stats-row">
          <div className="bw-stat-card">
            <div className="bw-stat-val lime">{snapshot.currentRoundUniqueVoters}</div>
            <div className="bw-stat-label">Votes cast</div>
          </div>
          <div className="bw-stat-card">
            <div className="bw-stat-val coral">{pendingRosterCount}</div>
            <div className="bw-stat-label">Yet to vote</div>
          </div>
          <div className="bw-stat-card">
            <div className="bw-stat-val">{turnout}%</div>
            <div className="bw-stat-label">Turnout</div>
          </div>
          <div className="bw-stat-card">
            <div className="bw-stat-val gold" suppressHydrationWarning>
              {currentRound?.status === "live" && hydrated
                ? formatCountdown(currentRound.endsAt, nowTick)
                : snapshot.status}
            </div>
            <div className="bw-stat-label">Time left</div>
          </div>
        </div>
        {primaryMatchup ? (
          <div className="bw-card">
            <div className="bw-card-title">Current Matchup</div>
            {renderResultBars(primaryMatchup as BracketSnapshotMatchup)}
            <p className="bw-muted">
              {snapshot.currentRoundUniqueVoters} of {snapshot.totalPlayers} roster members have voted
            </p>
          </div>
        ) : null}
        <div className="bw-card">
          <div className="bw-card-title">Quick Actions</div>
          <div className="bw-btn-row">
            {!isTestBracket && !snapshot.isCurrentPublic && snapshot.status !== "disabled" ? (
              <button className="bw-btn bw-btn-lime" onClick={makeCurrentPublicNow} type="button">
                Make Current Public Bracket
              </button>
            ) : null}
            {isTestBracket && displayTestUrl ? (
              <a className="bw-btn bw-btn-lime" href={displayTestUrl}>
                Open Test Voting
              </a>
            ) : null}
            <button className="bw-btn bw-btn-lime" onClick={() => setAdminSection("advance")} type="button">
              Advance to Next Round
            </button>
            <button className="bw-btn bw-btn-outline" onClick={() => setAdminSection("roster")} type="button">
              View Who&apos;s Voted
            </button>
            <button className="bw-btn bw-btn-outline" onClick={() => setAdminSection("results")} type="button">
              Full Results
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (mode === "admin") {
    return (
      <div className="bw-admin-app">
        <nav className="bw-admin-nav" aria-label="Admin">
          <div className="bw-nav-logo">
            Bored<span>@Work</span>
          </div>
          <span className="bw-nav-badge">{isTestBracket ? "Admin Test Mode" : "Admin"}</span>
          <div className="bw-btn-row">
            <Link className="bw-btn bw-btn-outline" href="/admin">
              Admin Home
            </Link>
            <Link className="bw-btn bw-btn-outline" href="/">
              Public Home
            </Link>
          </div>
          <div className="bw-nav-tabs">
            <button
              className={`bw-nav-tab ${adminSection === "live" ? "active" : ""}`}
              onClick={() => setAdminSection("live")}
              type="button"
            >
              Live
            </button>
            <button
              className={`bw-nav-tab ${adminSection === "create" ? "active" : ""}`}
              onClick={() => setAdminSection("create")}
              type="button"
            >
              + New Tournament
            </button>
            <button
              className={`bw-nav-tab ${adminSection === "history" ? "active" : ""}`}
              onClick={() => setAdminSection("history")}
              type="button"
            >
              History
            </button>
          </div>
        </nav>
        <div className="bw-admin-main">
          <aside className="bw-sidebar">
            <div className="bw-sidebar-label">{isTestBracket ? "Test Tournament" : "Live Tournament"}</div>
            {[
              ["live", "Overview"],
              ["roster", "Who's Voted"],
              ["results", "Live Results"],
              ["advance", "Advance Round"],
              ["links", "Links"],
            ].map(([section, label]) => (
              <button
                className={`bw-sidebar-link ${adminSection === section ? "active" : ""}`}
                key={section}
                onClick={() => setAdminSection(section as AdminSection)}
                type="button"
              >
                <span>{label}</span>
                {section === "live" ? <span className="bw-sidebar-live-dot" /> : null}
              </button>
            ))}
            <div className="bw-sidebar-label">Setup</div>
            <button
              className={`bw-sidebar-link ${adminSection === "create" ? "active" : ""}`}
              onClick={() => setAdminSection("create")}
              type="button"
            >
              New Tournament
            </button>
            <button
              className={`bw-sidebar-link ${adminSection === "history" ? "active" : ""}`}
              onClick={() => setAdminSection("history")}
              type="button"
            >
              Past Tournaments
            </button>
            <div className="bw-sidebar-label">Danger</div>
            <button
              className={`bw-sidebar-link danger-link ${adminSection === "danger" ? "active" : ""}`}
              onClick={() => setAdminSection("danger")}
              type="button"
            >
              Danger Zone
            </button>
          </aside>
          <main className="bw-admin-content">
            {error ? <p className="bw-error-text">{error}</p> : null}
            {renderTieBreakerPanel()}
            {renderAdminSection()}
          </main>
        </div>
      </div>
    );
  }

  if (mode === "history") {
    return (
      <div className="bw-vote-app">
        <nav className="bw-public-nav" aria-label="Tournament archive">
          <div className="bw-nav-logo">
            Bored<span>@Work</span>
          </div>
          <div className="bw-nav-topic">Past Tournament</div>
          <Link className="bw-nav-identity" href="/">
            Back home
          </Link>
        </nav>
        <main className="bw-page">
          <header className="bw-topic-header">
            <div className="bw-topic-round-badge">Archive</div>
            <h1 className="bw-topic-title">{snapshot.title}</h1>
            <p className="bw-topic-meta">
              Champion: {champion ?? "TBD"} · {snapshot.totalVotes} total votes
            </p>
            <p className="bw-topic-meta">{currentRoundBanner.body}</p>
          </header>
          {renderBracketBoard()}
        </main>
      </div>
    );
  }

  return (
    <div className="bw-vote-app">
      {mode === "public" && identityPickerOpen ? (
        <div className="bw-modal-backdrop" role="presentation">
          <section
            aria-labelledby="identity-modal-title"
            aria-modal="true"
            className="bw-modal"
            role="dialog"
          >
            <div className="bw-modal-title" id="identity-modal-title">
              Who are you?
            </div>
            <p className="bw-modal-sub">
              Pick your name to cast your vote. Tap your name again if you cleared cookies or switched browsers.
            </p>
            <div className="bw-modal-roster">
              {isPublicSnapshot(snapshot)
                ? snapshot.rosterMembers.map((member) => (
                    <button
                      className={`bw-roster-btn ${
                        member.isYou || member.name === selectedRosterMemberName ? "selected" : ""
                      }`}
                      key={member.name}
                      onClick={() => void handleRosterSelection(member.name)}
                      type="button"
                    >
                      {member.name}
                      {member.isYou ? " (you)" : member.claimed ? " (tap to use here)" : ""}
                    </button>
                  ))
                : null}
            </div>
            <p className="bw-modal-footnote">Not on the list? Talk to the admin.</p>
          </section>
        </div>
      ) : null}

      <nav className="bw-public-nav" aria-label="Tournament">
        <Link className="bw-nav-logo" href="/">
          Bored<span>@Work</span>
        </Link>
        <div className="bw-nav-topic">{snapshot.title}</div>
        <button className="bw-nav-identity" onClick={() => setIdentityPickerOpen(true)} type="button">
          <span className="bw-nav-avatar">{selectedRosterMemberDisplayName?.slice(0, 1) ?? "?"}</span>
          <span>{selectedRosterMemberDisplayName ?? "Choose name"}</span>
        </button>
      </nav>

      <main className="bw-page">
        <header className="bw-topic-header">
          <div className="bw-topic-round-badge">
            <span className="bw-round-dot" />
            {isTestBracket ? "Test Mode · " : ""}
            {currentRound ? currentRound.label : "Final results"}
          </div>
          <h1 className="bw-topic-title">{snapshot.title}</h1>
          <p className="bw-topic-meta">
            {snapshot.entrants.length} contenders · {snapshot.currentRoundUniqueVoters} / {snapshot.totalPlayers} voted
          </p>
          <p className="bw-topic-meta" suppressHydrationWarning>
            {hydrated ? currentRoundBanner.body : "Syncing round timing..."}
          </p>
        </header>

        {error ? <p className="bw-error-text">{error}</p> : null}

        {activeMatchups.length ? (
          activeMatchups.map((matchup) => renderPublicVote(matchup as PublicBracketSnapshotMatchup))
        ) : (
          <section className="bw-vote-section">
            <div className="bw-vote-prompt">{currentRoundBanner.title}</div>
            <p className="bw-muted bw-empty-message">{currentRoundBanner.body}</p>
          </section>
        )}

        <div className="bw-section-divider">
          <div className="bw-section-divider-line" />
          <div className="bw-section-divider-label">Full Bracket</div>
          <div className="bw-section-divider-line" />
        </div>

        {renderBracketBoard()}
      </main>
    </div>
  );
}
