import type { BracketRecord } from "@/lib/workquiz/types";

function normalizeRosterName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function ensureVoterBindings(bracket: BracketRecord) {
  bracket.voterBindings ??= {};
}

export function rosterMemberIdForBrowser(bracket: BracketRecord, browserToken: string) {
  ensureVoterBindings(bracket);
  return bracket.voterBindings![browserToken] ?? null;
}

export function browserTokenForRosterMember(bracket: BracketRecord, rosterMemberId: string) {
  ensureVoterBindings(bracket);
  for (const [token, memberId] of Object.entries(bracket.voterBindings!)) {
    if (memberId === rosterMemberId) {
      return token;
    }
  }

  return null;
}

export function isRosterMemberClaimed(bracket: BracketRecord, rosterMemberId: string) {
  return browserTokenForRosterMember(bracket, rosterMemberId) !== null;
}

export function findRosterMemberByName(bracket: BracketRecord, rosterMemberName: string) {
  const target = normalizeRosterName(rosterMemberName);
  return bracket.rosterMembers.find((member) => normalizeRosterName(member.name) === target) ?? null;
}

export function releaseRosterMemberBinding(bracket: BracketRecord, rosterMemberId: string) {
  ensureVoterBindings(bracket);
  for (const [token, memberId] of Object.entries(bracket.voterBindings!)) {
    if (memberId === rosterMemberId) {
      delete bracket.voterBindings![token];
    }
  }
}

export function bindBrowserToRosterMember(
  bracket: BracketRecord,
  browserToken: string,
  rosterMemberId: string,
  options?: { rebind?: boolean },
): { ok: true } | { ok: false; error: string } {
  ensureVoterBindings(bracket);

  const existingForBrowser = bracket.voterBindings![browserToken];
  if (existingForBrowser && existingForBrowser !== rosterMemberId) {
    const name =
      bracket.rosterMembers.find((member) => member.id === existingForBrowser)?.name ?? "someone else";
    return { ok: false, error: `This browser is already registered as ${name}.` };
  }

  const existingForMember = browserTokenForRosterMember(bracket, rosterMemberId);
  if (existingForMember && existingForMember !== browserToken) {
    if (!options?.rebind) {
      const name = bracket.rosterMembers.find((member) => member.id === rosterMemberId)?.name ?? "That name";
      return { ok: false, error: `${name} is already registered on another device.` };
    }

    delete bracket.voterBindings![existingForMember];
  }

  bracket.voterBindings![browserToken] = rosterMemberId;
  return { ok: true };
}

export function tryMigrateVoterBinding(
  bracket: BracketRecord,
  browserToken: string,
  rememberedRosterMemberId: string | null,
) {
  const existing = rosterMemberIdForBrowser(bracket, browserToken);
  if (existing) {
    return existing;
  }

  if (
    !rememberedRosterMemberId ||
    !bracket.rosterMembers.some((member) => member.id === rememberedRosterMemberId)
  ) {
    return null;
  }

  const result = bindBrowserToRosterMember(bracket, browserToken, rememberedRosterMemberId, {
    rebind: true,
  });
  return result.ok ? rememberedRosterMemberId : null;
}
