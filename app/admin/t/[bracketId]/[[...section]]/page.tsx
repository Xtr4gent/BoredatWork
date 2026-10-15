import { notFound } from "next/navigation";

import { BracketClient } from "@/components/BracketClient";
import { adminSectionFromSlug } from "@/lib/workquiz/admin-sections";
import { buildAdminSnapshot, findBracketById } from "@/lib/workquiz/bracket";

export const dynamic = "force-dynamic";

/** One tournament's admin workspace: /admin/t/<id>/<section>. */
export default async function TournamentWorkspacePage({
  params,
}: {
  params: Promise<{ bracketId: string; section?: string[] }>;
}) {
  const { bracketId, section } = await params;
  const bracket = await findBracketById(bracketId);
  if (!bracket) {
    notFound();
  }

  // Admin APIs accept the tournament id (see matchesAdminKey), so the id is
  // the key the workspace uses for every admin action.
  return (
    <BracketClient
      adminToken={bracket.id}
      initialAdminSection={adminSectionFromSlug(section?.[0])}
      initialSnapshot={await buildAdminSnapshot(bracket, bracket.id)}
      mode="admin"
      token={bracket.publicToken}
    />
  );
}
