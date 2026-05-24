import Link from "next/link";

import { BracketClient } from "@/components/BracketClient";
import { CreateBracketForm } from "@/components/CreateBracketForm";
import {
  buildAdminSnapshot,
  findBracketByAdminToken,
  findBracketById,
  listBracketHistory,
} from "@/lib/workquiz/bracket";
import type { AdminHistoryItem } from "@/lib/workquiz/types";

export const dynamic = "force-dynamic";

const adminDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  year: "numeric",
});

function formatAdminDate(value: string) {
  return adminDateFormatter.format(new Date(value));
}

function AdminCreatePortal({
  adminHistory,
  initialTemplate,
  section,
}: {
  adminHistory: AdminHistoryItem[];
  initialTemplate?: {
    title: string;
    entrants: Array<{ name: string; imageUrl?: string }>;
    rosterMembers: string[];
    seedingMode: "manual" | "random";
    sourceTitle?: string;
  } | null;
  section: "create" | "history";
}) {
  const showingHistory = section === "history";

  return (
    <main className="bw-admin-app">
      <nav className="bw-admin-nav" aria-label="Admin">
        <div className="bw-nav-logo">
          Bored<span>@Work</span>
        </div>
        <span className="bw-nav-badge">Admin</span>
        <div className="bw-nav-tabs">
          <Link className="bw-nav-tab" href="/admin">
            Live
          </Link>
          <Link className={`bw-nav-tab ${!showingHistory ? "active" : ""}`} href="/admin">
            + New Tournament
          </Link>
          <Link className={`bw-nav-tab ${showingHistory ? "active" : ""}`} href="/admin?section=history">
            History
          </Link>
        </div>
      </nav>

      <div className="bw-admin-main">
        <aside className="bw-sidebar">
          <div className="bw-sidebar-label">Live Tournament</div>
          <Link className="bw-sidebar-link" href="/admin">
            <span>Overview</span>
          </Link>
          <Link className="bw-sidebar-link" href="/admin">
            <span>Who&apos;s Voted</span>
          </Link>
          <Link className="bw-sidebar-link" href="/admin">
            <span>Live Results</span>
          </Link>
          <Link className="bw-sidebar-link" href="/admin">
            <span>Advance Round</span>
          </Link>

          <div className="bw-sidebar-label">Setup</div>
          <Link className={`bw-sidebar-link ${!showingHistory ? "active" : ""}`} href="/admin">
            New Tournament
          </Link>
          <Link className={`bw-sidebar-link ${showingHistory ? "active" : ""}`} href="/admin?section=history">
            Past Tournaments
          </Link>
        </aside>

        <section className="bw-admin-content">
          {showingHistory ? (
            <div className="bw-section-panel active">
              <div className="bw-panel-title">Past Tournaments</div>
              <p className="bw-panel-sub">Every debate that has been settled.</p>
              {adminHistory.length ? (
                adminHistory.map((item, index) => (
                  <div className="bw-history-item" key={item.id}>
                    <div>
                      <div className="bw-history-num">Tournament #{adminHistory.length - index}</div>
                      <div className="bw-history-topic">{item.title}</div>
                      <div className="bw-history-winner">Champion: {item.winnerName}</div>
                    </div>
                    <div className="bw-history-meta">
                      <div>{formatAdminDate(item.tournamentDate)}</div>
                      <Link href={`/past/${encodeURIComponent(item.id)}`}>View bracket</Link>
                    </div>
                  </div>
                ))
              ) : (
                <div className="bw-card">
                  <div className="bw-card-title">No completed tournaments yet</div>
                  <p className="bw-muted">Previous winners will show up here once you finish a bracket.</p>
                </div>
              )}
            </div>
          ) : (
            <div className="bw-section-panel active">
              <div className="bw-panel-title">New Tournament</div>
              <p className="bw-panel-sub">Set up a fresh bracket. Once created, share the player link.</p>
              <CreateBracketForm variant="admin" initialTemplate={initialTemplate} />
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ adminToken?: string; template?: string; section?: string }>;
}) {
  const params = await searchParams;
  const authorizedAdmin = params.adminToken ? await findBracketByAdminToken(params.adminToken) : null;
  const templateBracket =
    authorizedAdmin && params.template ? await findBracketById(params.template) : null;

  if (params.adminToken && authorizedAdmin && !params.template) {
    const snapshot = await buildAdminSnapshot(authorizedAdmin, params.adminToken);

    return (
      <BracketClient
        adminToken={params.adminToken}
        initialSnapshot={snapshot}
        mode="admin"
        token={authorizedAdmin.publicToken}
      />
    );
  }

  return (
    <AdminCreatePortal
      adminHistory={await listBracketHistory()}
      initialTemplate={
        templateBracket
          ? {
              title: templateBracket.title,
              entrants: templateBracket.entrants.map((entrant) => ({
                name: entrant.name,
                imageUrl: entrant.imageUrl,
              })),
              rosterMembers:
                templateBracket.rosterMembers?.map((member) => member.name) ??
                Array.from({ length: templateBracket.totalPlayers }, (_, index) => `Player ${index + 1}`),
              seedingMode: templateBracket.seedingMode,
              sourceTitle: templateBracket.title,
            }
          : null
      }
      section={params.section === "history" ? "history" : "create"}
    />
  );
}
