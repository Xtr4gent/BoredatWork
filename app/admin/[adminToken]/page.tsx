import { redirect } from "next/navigation";

import { adminWorkspacePath } from "@/lib/workquiz/admin-sections";
import { findBracketByAdminToken } from "@/lib/workquiz/bracket";

/** Old /admin/<secret token> links: send them to that tournament's workspace. */
export default async function AdminBracketPage({
  params,
}: {
  params: Promise<{ adminToken: string }>;
}) {
  const { adminToken } = await params;
  const bracket = await findBracketByAdminToken(adminToken);
  redirect(bracket ? adminWorkspacePath(bracket.id) : "/admin");
}
