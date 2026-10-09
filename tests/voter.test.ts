import assert from "node:assert/strict";
import test from "node:test";

import type { BracketRecord } from "@/lib/workquiz/types";
import { tryMigrateVoterBinding, voterBindingNeedsMigration } from "@/lib/workquiz/voter";

function fixture(voterBindings: Record<string, string> = {}) {
  return {
    rosterMembers: [
      { id: "m1", name: "Gabe" },
      { id: "m2", name: "Sam" },
    ],
    voterBindings,
  } as unknown as BracketRecord;
}

// voterBindingNeedsMigration gates a database write on the hot polling path,
// so it must agree exactly with whether tryMigrateVoterBinding changes state.
const cases: Array<{ name: string; bindings: Record<string, string>; remembered: string | null }> = [
  { name: "browser already bound", bindings: { tokA: "m1" }, remembered: "m1" },
  { name: "already bound, different remembered id", bindings: { tokA: "m1" }, remembered: "m2" },
  { name: "no binding, nothing remembered", bindings: {}, remembered: null },
  { name: "no binding, remembered id not on roster", bindings: {}, remembered: "gone" },
  { name: "no binding, remembered id on roster", bindings: {}, remembered: "m1" },
  { name: "remembered member bound to another browser", bindings: { tokB: "m1" }, remembered: "m1" },
];

for (const { name, bindings, remembered } of cases) {
  test(`voterBindingNeedsMigration matches tryMigrateVoterBinding: ${name}`, () => {
    const bracket = fixture({ ...bindings });
    const predicted = voterBindingNeedsMigration(bracket, "tokA", remembered);

    const before = JSON.stringify(bracket);
    tryMigrateVoterBinding(bracket, "tokA", remembered);
    const changed = JSON.stringify(bracket) !== before;

    assert.equal(predicted, changed);
  });
}
