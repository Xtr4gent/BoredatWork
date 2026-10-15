/**
 * Admin workspace sections and their URL slugs (/admin/t/<id>/<slug>).
 * Kept outside the "use client" component so server pages can read it.
 */
export type AdminSection = "live" | "roster" | "watch" | "results" | "settings";

export const ADMIN_SECTION_SLUGS: Record<AdminSection, string> = {
  live: "overview",
  roster: "players",
  watch: "vote-watch",
  results: "results",
  settings: "settings",
};

/** Sidebar order and labels. */
export const ADMIN_SECTION_LABELS: Array<[AdminSection, string]> = [
  ["live", "Overview"],
  ["roster", "Players"],
  ["watch", "Vote Watch"],
  ["results", "Results"],
  ["settings", "Settings"],
];

/**
 * Sections that were merged into Settings; old links still land there. A Map,
 * so URL text such as "constructor" can't match an inherited object property.
 */
const LEGACY_SLUGS = new Map<string, AdminSection>([
  ["rounds", "settings"],
  ["links", "settings"],
  ["danger", "settings"],
]);

export function adminSectionFromSlug(slug: string | undefined): AdminSection {
  const match = (Object.entries(ADMIN_SECTION_SLUGS) as Array<[AdminSection, string]>).find(
    ([, value]) => value === slug,
  );
  return match ? match[0] : ((slug ? LEGACY_SLUGS.get(slug) : undefined) ?? "live");
}

export function adminWorkspacePath(bracketId: string, section: AdminSection = "live") {
  return `/admin/t/${encodeURIComponent(bracketId)}/${ADMIN_SECTION_SLUGS[section]}`;
}

export type AdminTournamentStatus = "on-voting" | "running" | "test" | "finished" | "shut-down";

/** One status per tournament, the same on the Tournaments list and in its workspace. */
export function adminTournamentStatus(bracket: {
  status: string;
  kind?: string;
  isCurrentPublic?: boolean;
}): AdminTournamentStatus {
  if (bracket.status === "disabled") {
    return "shut-down";
  }
  if ((bracket.kind ?? "public") === "test") {
    return "test";
  }
  if (bracket.status === "completed") {
    return "finished";
  }
  return bracket.isCurrentPublic ? "on-voting" : "running";
}

export const ADMIN_STATUS_TAG: Record<AdminTournamentStatus, { label: string; className: string }> = {
  "on-voting": { label: "On /voting", className: "bw-tag bw-tag-lime" },
  running: { label: "Not on /voting", className: "bw-tag bw-tag-coral" },
  test: { label: "Test", className: "bw-tag bw-tag-muted" },
  finished: { label: "Finished", className: "bw-tag bw-tag-muted" },
  "shut-down": { label: "Shut down", className: "bw-tag bw-tag-muted" },
};

/** Section named by a workspace pathname (/admin/t/<id>/<slug>); Overview when absent. */
export function adminSectionFromPath(pathname: string): AdminSection {
  const [admin, t, , slug] = pathname.split("/").filter(Boolean);
  return admin === "admin" && t === "t" ? adminSectionFromSlug(slug) : "live";
}
