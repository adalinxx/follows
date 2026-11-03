// The policy modules name no machine: a module is stored by every node that
// hosts its chain, so a home directory compiled into it (rustc keeps the
// path of every panic location) is published with it. policy/build.sh
// builds the module without one.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const file = (path) => new URL(`../${path}`, import.meta.url);
const BUILT = "policy/target/wasm32-unknown-unknown/release/follows_policy.wasm";
const MODULES = ["chain/follows_policy.wasm", "e2e/ui/moniker/moniker_policy.wasm", BUILT];

// A home directory other than the fixed one policy/build.sh maps Cargo's to.
const HOME = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)(?!anonymous[/\\])[^/\\\0]+/g;

for (const path of MODULES) {
  test(`${path} names no home directory`, { skip: !existsSync(file(path)) && "not built" }, () => {
    const found = [...new Set(readFileSync(file(path)).toString("latin1").match(HOME) ?? [])];
    assert.deepEqual(found, [], `${path} carries ${found.join(", ")}: build it with policy/build.sh`);
  });
}

test("chain/follows_policy.wasm is the module policy/build.sh builds", { skip: !existsSync(file(BUILT)) && "not built" }, () => {
  assert.ok(readFileSync(file(BUILT)).equals(readFileSync(file("chain/follows_policy.wasm"))),
    "the built module differs from chain/follows_policy.wasm: copy it there, and name its CID in chain/spec.json");
});
