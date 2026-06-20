import Link from "next/link";

import { BracketClient } from "@/components/BracketClient";
import { getBrowserToken } from "@/lib/workquiz/auth";
import { buildPublicSnapshot, findBracketByAdminToken } from "@/lib/workquiz/bracket";
import { rosterMemberIdForBrowser } from "@/lib/workquiz/voter";

export const dynamic = "force-dynamic";

export default async function TestVotingPage({
  searchParams,
}: {
  searchParams: Promise<{ adminToken?: string }>;
}) {
  const { adminToken } = await searchParams;
  const bracket = adminToken ? await findBracketByAdminToken(adminToken) : null;

  if (!adminToken || !bracket || (bracket.kind ?? "public") !== "test") {
    return (
      <main className="bw-vote-app">
        <nav className="bw-public-nav" aria-label="Test tournament">
          <div className="bw-nav-logo">
            Bored<span>@Work</span>
          </div>
          <div className="bw-nav-topic">Test Mode</div>
          <Link className="bw-nav-identity" href="/admin">
            Back to admin
          </Link>
        </nav>

        <section className="bw-page">
          <header className="bw-topic-header">
            <div className="bw-topic-round-badge">Admin Test Area</div>
            <h1 className="bw-topic-title">Choose a test bracket from the admin portal.</h1>
            <p className="bw-topic-meta">
              Test brackets are private, never public, and never appear in Past Tournaments.
            </p>
          </header>
        </section>
      </main>
    );
  }

  const browserToken = await getBrowserToken();
  const rosterMemberId = browserToken ? rosterMemberIdForBrowser(bracket, browserToken) : null;
  const snapshot = buildPublicSnapshot(bracket, { rosterMemberId });

  return <BracketClient initialSnapshot={snapshot} mode="public" token={bracket.publicToken} />;
}
