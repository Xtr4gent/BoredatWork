import LandingPageClient from "@/components/LandingPageClient";
import {
  advanceReadyBrackets,
  buildSnapshot,
  listBracketHistory,
  selectCurrentPublicBracket,
} from "@/lib/workquiz/bracket";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const brackets = await advanceReadyBrackets(new Date());
  const bracket = selectCurrentPublicBracket(brackets);
  const snapshot = bracket ? buildSnapshot(bracket) : null;
  const live = snapshot?.rounds.some((round) => round.status === "live") ?? false;
  const pastTopics = await listBracketHistory(6, brackets);

  return <LandingPageClient initialIsLive={live} pastTopics={pastTopics} />;
}
