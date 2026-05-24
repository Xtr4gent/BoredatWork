import { notFound } from "next/navigation";

import { BracketClient } from "@/components/BracketClient";
import { buildSnapshot, findBracketById } from "@/lib/workquiz/bracket";

export const dynamic = "force-dynamic";

export default async function PastBracketPage({
  params,
}: {
  params: Promise<{ bracketId: string }>;
}) {
  const { bracketId } = await params;
  const bracket = await findBracketById(bracketId);

  if (!bracket) {
    notFound();
  }

  if (bracket.kind === "test") {
    notFound();
  }

  const snapshot = buildSnapshot(bracket);

  return <BracketClient initialSnapshot={snapshot} mode="history" token={bracket.publicToken} />;
}
