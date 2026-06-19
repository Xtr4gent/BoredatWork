import { cookies } from "next/headers";
import { nanoid } from "nanoid";

import { COOKIE_NAME, LAST_ROSTER_MEMBER_COOKIE } from "@/lib/workquiz/constants";

export async function getBrowserToken() {
  const jar = await cookies();
  return jar.get(COOKIE_NAME)?.value ?? null;
}

export async function getOrCreateBrowserToken() {
  const jar = await cookies();
  const existing = jar.get(COOKIE_NAME)?.value;
  if (existing) {
    return existing;
  }

  const token = nanoid(24);
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 90,
    path: "/",
  });

  return token;
}

export async function getRememberedRosterMemberId() {
  const jar = await cookies();
  return jar.get(LAST_ROSTER_MEMBER_COOKIE)?.value ?? null;
}

export async function setRememberedRosterMemberId(rosterMemberId: string | null) {
  const jar = await cookies();

  if (!rosterMemberId) {
    jar.delete(LAST_ROSTER_MEMBER_COOKIE);
    return;
  }

  jar.set(LAST_ROSTER_MEMBER_COOKIE, rosterMemberId, {
    httpOnly: false,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 90,
    path: "/",
  });
}
