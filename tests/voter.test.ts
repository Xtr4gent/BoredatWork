import assert from "node:assert/strict";
import test from "node:test";

import type { BracketRecord } from "@/lib/workquiz/types";
import { tryMigrateVoterBinding, voterBindingNeedsMigration } from "@/lib/workquiz/voter";

function fixture(voterBindings: Record<string, string> = {}, memberClaims?: Record<string, string>) {
  return {
    rosterMembers: [
      { id: "m1", name: "Gabe" },
      { id: "m2", name: "Sam" },
    ],
    voterBindings,
    memberClaims,
  } as unknown as BracketRecord;
}

// voterBindingNeedsMigration gates a database write on the hot polling path,
// so it must agree exactly with whether tryMigrateVoterBinding changes state.
const cases: Array<{
  name: string;
  bindings: Record<string, string>;
  remembered: string | null;
  claims?: Record<string, string>;
}> = [
  { name: "current claim cookie", bindings: {}, remembered: "m1~c1", claims: { m1: "c1" } },
  { name: "current claim, name held by another browser", bindings: { tokB: "m1" }, remembered: "m1~c1", claims: { m1: "c1" } },
  { name: "stale claim cookie (newer device registered)", bindings: { tokB: "m1" }, remembered: "m1~c1", claims: { m1: "c2" } },
  { name: "claim released by the admin", bindings: {}, remembered: "m1~c1", claims: { m1: "released:x" } },
  { name: "legacy cookie after admin release", bindings: {}, remembered: "m1", claims: { m1: "released:x" } },
  { name: "legacy cookie, no claim record yet", bindings: {}, remembered: "m1", claims: {} },
  { name: "browser already bound", bindings: { tokA: "m1" }, remembered: "m1" },
  { name: "already bound, different remembered id", bindings: { tokA: "m1" }, remembered: "m2" },
  { name: "no binding, nothing remembered", bindings: {}, remembered: null },
  { name: "no binding, remembered id not on roster", bindings: {}, remembered: "gone" },
  { name: "no binding, remembered id on roster", bindings: {}, remembered: "m1" },
  { name: "remembered member bound to another browser", bindings: { tokB: "m1" }, remembered: "m1" },
];

for (const { name, bindings, remembered, claims } of cases) {
  test(`voterBindingNeedsMigration matches tryMigrateVoterBinding: ${name}`, () => {
    const bracket = fixture({ ...bindings }, claims ? { ...claims } : undefined);
    const predicted = voterBindingNeedsMigration(bracket, "tokA", remembered);

    const before = JSON.stringify(bracket);
    tryMigrateVoterBinding(bracket, "tokA", remembered);
    const changed = JSON.stringify(bracket) !== before;

    assert.equal(predicted, changed);
  });
}
