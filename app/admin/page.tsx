import Link from "next/link";
import { redirect } from "next/navigation";

import { AdminTopNav } from "@/components/AdminTopNav";
import { ADMIN_STATUS_TAG, adminWorkspacePath } from "@/lib/workquiz/admin-sections";
import { findBracketByAdminToken, listAdminTournaments } from "@/lib/workquiz/bracket";
import type { AdminTournamentSummary } from "@/lib/workquiz/types";

export const dynamic = "force-dynamic";

const adminDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  year: "numeric",
});

function TournamentRow({ tournament }: { tournament: AdminTournamentSummary }) {
  const tag = ADMIN_STATUS_TAG[tournament.status];
  const details = [
    tournament.currentRoundLabel,
    tournament.championName ? `Champion: ${tournament.championName}` : null,
    `${tournament.playerCount} players`,
    `${tournament.entrantCount} contenders`,
    tournament.startsAt ? `Starts ${adminDateFormatter.format(new Date(tournament.startsAt))}` : null,
  ].filter(Boolean);

  return (
    <div className="bw-tournament-row">
      <div>
        <div className="bw-tag-row">
          <span className={tag.className}>{tag.label}</span>
          {tournament.isOnVoting && tournament.status !== "on-voting" ? (
            <span className="bw-tag bw-tag-lime">Shown on /voting</span>
          ) : null}
        </div>
        <div className="bw-history-topic">{tournament.title}</div>
        <p className="bw-muted">{details.join(" · ")}</p>
      </div>
      <div className="bw-btn-row">
        <Link className="bw-btn bw-btn-lime" href={adminWorkspacePath(tournament.id)}>
          Manage
        </Link>
        {tournament.status === "finished" ? (
          <Link className="bw-btn bw-btn-outline" href={`/past/${encodeURIComponent(tournament.id)}`}>
            Results
          </Link>
        ) : null}
        {tournament.kind === "public" ? (
          <Link className="bw-btn bw-btn-outline" href={`/admin/new?template=${encodeURIComponent(tournament.id)}`}>
            Reuse
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ adminToken?: string; template?: string }>;
}) {
  const params = await searchParams;

  // Links from before the overhaul: /admin?adminToken=... and ?template=...
  if (params.template) {
    redirect(`/admin/new?template=${encodeURIComponent(params.template)}`);
  }
  if (params.adminToken) {
    const bracket = await findBracketByAdminToken(params.adminToken);
    if (bracket) {
      redirect(adminWorkspacePath(bracket.id));
    }
  }

  const tournaments = await listAdminTournaments();
  const active = tournaments.filter((entry) => ["on-voting", "running", "test"].includes(entry.status));
  const past = tournaments.filter((entry) => ["finished", "shut-down"].includes(entry.status));

  return (
    <main className="bw-admin-app">
      <AdminTopNav active="tournaments" />
      <div className="bw-admin-main">
        <section className="bw-admin-content">
          <div className="bw-section-panel active">
            <div className="bw-card-header-row">
              <div>
                <div className="bw-panel-title">Tournaments</div>
                <p className="bw-panel-sub">Every tournament you have created. Open one to manage it.</p>
              </div>
              <Link className="bw-btn bw-btn-lime" href="/admin/new">
                + New tournament
              </Link>
            </div>

            <div className="bw-card-title bw-tournament-group">Active</div>
            {active.length ? (
              active.map((tournament) => <TournamentRow key={tournament.id} tournament={tournament} />)
            ) : (
              <div className="bw-card">
                <p className="bw-muted">Nothing running right now. Start a new tournament to get going.</p>
              </div>
            )}

            <div className="bw-card-title bw-tournament-group">Finished and shut down</div>
            {past.length ? (
              past.map((tournament) => <TournamentRow key={tournament.id} tournament={tournament} />)
            ) : (
              <div className="bw-card">
                <p className="bw-muted">Finished tournaments show up here with their champion.</p>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
