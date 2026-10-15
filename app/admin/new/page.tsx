import { AdminTopNav } from "@/components/AdminTopNav";
import { CreateBracketForm } from "@/components/CreateBracketForm";
import { findBracketById } from "@/lib/workquiz/bracket";

export const dynamic = "force-dynamic";

export default async function NewTournamentPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string }>;
}) {
  const { template } = await searchParams;
  const templateBracket = template ? await findBracketById(template) : null;

  return (
    <main className="bw-admin-app">
      <AdminTopNav active="new" />
      <div className="bw-admin-main">
        <section className="bw-admin-content">
          <div className="bw-section-panel active">
            <div className="bw-panel-title">New Tournament</div>
            <p className="bw-panel-sub">
              {templateBracket
                ? `Starting from "${templateBracket.title}". Change anything you like before launching.`
                : "Set up a fresh bracket."}
            </p>
            <CreateBracketForm
              variant="admin"
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
            />
          </div>
        </section>
      </div>
    </main>
  );
}
