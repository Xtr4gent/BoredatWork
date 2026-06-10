import { NextResponse } from "next/server";

import {
  advanceReadyBrackets,
  buildSnapshot,
  listBracketHistory,
  selectCurrentPublicBracket,
} from "@/lib/workquiz/bracket";
import { DEFAULT_LANDING_HISTORY } from "@/lib/workquiz/landing-history";

export const dynamic = "force-dynamic";

export async function GET() {
  // Reuse the brackets loaded by advanceReadyBrackets instead of re-reading
  // the store for the current bracket and again for the history list.
  const brackets = await advanceReadyBrackets(new Date());
  const bracket = selectCurrentPublicBracket(brackets);
  const snapshot = bracket ? buildSnapshot(bracket) : null;
  const live = snapshot?.rounds.some((round) => round.status === "live") ?? false;
  const history = (await listBracketHistory(6, brackets)).map((item) => ({
    topic: item.title,
    winner: item.winnerName,
    tournamentDate: item.tournamentDate,
    runners: item.entrantNames,
  }));

  return NextResponse.json(
    {
      live,
      hasCurrentBracket: bracket !== null,
      currentTitle: bracket?.title ?? null,
      currentUrl: "/voting",
      adminUrl: "/admin",
      history: history.length > 0 ? history : DEFAULT_LANDING_HISTORY,
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    },
  );
}
