import Link from "next/link";

import { BracketClient } from "@/components/BracketClient";
import { getOrCreateBrowserToken, getRememberedRosterMemberId } from "@/lib/workquiz/auth";
import {
  buildPublicSnapshot,
  ensureVoterBinding,
  findCurrentPublicBracket,
} from "@/lib/workquiz/bracket";
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

  const browserToken = await getOrCreateBrowserToken();
  const rememberedRosterMemberId = await getRememberedRosterMemberId();
  await ensureVoterBinding({
    publicToken: bracket.publicToken,
    browserToken,
    rememberedRosterMemberId,
  });

  const refreshedBracket = (await findCurrentPublicBracket()) ?? bracket;
  const rosterMemberId =
    rosterMemberIdForBrowser(refreshedBracket, browserToken) ?? rememberedRosterMemberId;
  const snapshot = buildPublicSnapshot(refreshedBracket, {
    rosterMemberId: refreshedBracket.rosterMembers.some((member) => member.id === rosterMemberId)
      ? rosterMemberId
      : null,
  });

  return (
    <BracketClient initialSnapshot={snapshot} mode="public" token={refreshedBracket.publicToken} />
  );
}
