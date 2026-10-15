import Link from "next/link";

/** The admin portal's top bar, shared by every admin page. */
export function AdminTopNav({ active }: { active: "tournaments" | "new" | "workspace" }) {
  return (
    <nav className="bw-admin-nav" aria-label="Admin">
      <Link className="bw-nav-logo" href="/admin">
        Bored<span>@Work</span>
      </Link>
      <span className="bw-nav-badge">Admin</span>
      <div className="bw-nav-tabs">
        <Link className={`bw-nav-tab ${active !== "new" ? "active" : ""}`} href="/admin">
          Tournaments
        </Link>
        <Link className={`bw-nav-tab ${active === "new" ? "active" : ""}`} href="/admin/new">
          + New tournament
        </Link>
      </div>
      <div className="bw-btn-row">
        <Link className="bw-btn bw-btn-outline" href="/">
          Public site
        </Link>
        <form action="/api/admin-logout" method="post">
          <button className="bw-btn bw-btn-outline" type="submit">
            Log out
          </button>
        </form>
      </div>
    </nav>
  );
}
