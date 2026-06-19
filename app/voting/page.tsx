import Link from "next/link";

import { BracketClient } from "@/components/BracketClient";
import { getBrowserToken, getRememberedRosterMemberId } from "@/lib/workquiz/auth";
import { buildPublicSnapshot, findCurrentPublicBracket } from "@/lib/workquiz/bracket";
import { rosterMemberIdForBrowser } from "@/lib/workquiz/voter";

export const dynamic = "force-dynamic";

export default async function VotingPage() {
  const bracket = await findCurrentPublicBracket();

  if (!bracket) {
    return (
      <main className="bw-vote-app">
        <nav className="bw-public-nav" aria-label="Tournament">
          <div className="bw-nav-logo">
            Bored<span>@Work</span>
          </div>
          <div className="bw-nav-topic">No live tournament</div>
          <Link className="bw-nav-identity" href="/">
            Back home
          </Link>
        </nav>

        <section className="bw-page">
          <header className="bw-topic-header">
            <div className="bw-topic-round-badge">No Live Tournament</div>
            <h1 className="bw-topic-title">No tournament is live right now.</h1>
            <p className="bw-topic-meta">
              Check back when the next bracket is marked as the current public tournament.
            </p>
          </header>
        </section>
      </main>
    );
  }

  const browserToken = await getBrowserToken();
  const rememberedRosterMemberId = await getRememberedRosterMemberId();
  const boundRosterMemberId = browserToken ? rosterMemberIdForBrowser(bracket, browserToken) : null;
  const rosterMemberId =
    boundRosterMemberId ??
    (bracket.rosterMembers.some((member) => member.id === rememberedRosterMemberId)
      ? rememberedRosterMemberId
      : null);

  const snapshot = buildPublicSnapshot(bracket, { rosterMemberId });

  return <BracketClient initialSnapshot={snapshot} mode="public" token={bracket.publicToken} />;
}
