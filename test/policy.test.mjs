// Runs the built policy module the way the Lattice host does (host.mjs), on
// hand-made writes. Bodies are encoded by the Lattice SDK, whose encoding is
// pinned to Lattice's vectors.
//
//   (cd policy && cargo build --release --target wasm32-unknown-unknown)
//   node --test test/
//
// With CONTEXT_DIR set, every context is recorded with its verdict so
// policy/host-check can replay it through Lattice's own evaluator.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import * as sdk from "../vendor/lattice-sdk.js";
import { context, validate } from "./host.mjs";

const address = (seed) => sdk.addressFromPublicKey(sdk.publicKeyFromPrivate(new Uint8Array(32).fill(seed)));
const [ALICE, BOB] = [address(1), address(2)];
const PATH = ["Nexus", "follows"];

const contextDirectory = process.env.CONTEXT_DIR;
if (contextDirectory) mkdirSync(contextDirectory, { recursive: true });
let recorded = 0;

function accepts(actions, { signers = [ALICE], accountActions = [] } = {}) {
  const body = sdk.encodeTransactionBody({
    accountActions,
    actions,
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers,
    nonce: 0n,
    chainPath: PATH,
  }).bytes;
  const bytes = context(body, { path: PATH });
  const accepted = validate(bytes);
  if (contextDirectory) writeFileSync(`${contextDirectory}/${String(recorded++).padStart(3, "0")}-${accepted ? "accept" : "reject"}.bin`, bytes);
  return accepted;
}

// A follow is of an account, or of `@` and a Moniker handle.
const CAROL = address(3);
const [P, Q] = ["@alice", "@bob_2"];
const follow = (a, t) => `follows/${a}/${t}`;
const follower = (a, t) => `followers/${t}/${a}`;
/** Account `a` following `t`, as both keys, each with `change` ({ oldValue?, newValue? }). */
const both = (a, t, change) => [{ key: follow(a, t), ...change }, { key: follower(a, t), ...change }];

test("an account follows, refollows and unfollows an account or a handle, both keys at once", () => {
  for (const t of [P, CAROL]) {
    assert.ok(accepts(both(ALICE, t, { newValue: "1" })), t);
    assert.ok(accepts(both(ALICE, t, { oldValue: "1", newValue: "1" })), t);
    assert.ok(accepts(both(ALICE, t, { oldValue: "1" })), t);
  }
  assert.ok(accepts([...both(ALICE, P, { newValue: "1" }), ...both(ALICE, Q, { newValue: "1" }), ...both(ALICE, CAROL, { newValue: "1" })]));
  // Any handle, held by anyone or no one: Moniker's business, read by readers.
  assert.ok(accepts(both(ALICE, "@nobody_yet", { newValue: "1" })));
});

test("one key without its twin is refused", () => {
  assert.ok(!accepts([{ key: follow(ALICE, P), newValue: "1" }]));
  assert.ok(!accepts([{ key: follower(ALICE, P), newValue: "1" }]));
  assert.ok(!accepts([{ key: follow(ALICE, P), oldValue: "1" }]));
  assert.ok(!accepts([{ key: follower(ALICE, CAROL), oldValue: "1" }]));
  // A twin of another follow is no twin: another followed, another account.
  assert.ok(!accepts([{ key: follow(ALICE, P), newValue: "1" }, { key: follower(ALICE, Q), newValue: "1" }]));
  assert.ok(!accepts([{ key: follow(ALICE, P), newValue: "1" }, { key: follower(BOB, P), newValue: "1" }], { signers: [ALICE, BOB] }));
  // An account and a handle are different targets, even for the same person.
  assert.ok(!accepts([{ key: follow(ALICE, CAROL), newValue: "1" }, { key: follower(ALICE, `@${CAROL}`), newValue: "1" }]));
  // Ends swapped: Bob following Alice is no twin of Alice following Bob.
  assert.ok(!accepts([{ key: follow(ALICE, BOB), newValue: "1" }, { key: follower(BOB, ALICE), newValue: "1" }], { signers: [ALICE, BOB] }));
});

test("the twin comes directly after: not first, not after other follows", () => {
  assert.ok(!accepts([{ key: follower(ALICE, P), newValue: "1" }, { key: follow(ALICE, P), newValue: "1" }]));
  assert.ok(!accepts([{ key: follow(ALICE, P), newValue: "1" }, ...both(ALICE, Q, { newValue: "1" }), { key: follower(ALICE, P), newValue: "1" }]));
});

test("the work grows with the transaction, no faster", () => {
  const time = (n) => {
    const actions = [];
    for (let i = 0; i < n; i++) actions.push(...both(ALICE, `@t${i}`, { newValue: "1" }));
    const start = performance.now();
    assert.ok(accepts(actions));
    return performance.now() - start;
  };
  time(500);
  const [small, large] = [time(2000), time(8000)];
  assert.ok(large < small * 8, `${small.toFixed(1)}ms for 2000, ${large.toFixed(1)}ms for 8000`);
});

test("the twins always hold the same value", () => {
  assert.ok(!accepts([{ key: follow(ALICE, P), newValue: "1" }, { key: follower(ALICE, P), newValue: "2" }]));
  assert.ok(!accepts([{ key: follow(ALICE, P), oldValue: "1" }, { key: follower(ALICE, P), oldValue: "1", newValue: "1" }]));
  assert.ok(!accepts([{ key: follow(ALICE, P), oldValue: "1", newValue: "1" }, { key: follower(ALICE, P), oldValue: "1" }]));
});

test("nobody writes or deletes another account's keys", () => {
  assert.ok(!accepts(both(BOB, P, { newValue: "1" })));
  assert.ok(!accepts(both(BOB, CAROL, { oldValue: "1" })));
  assert.ok(!accepts([...both(ALICE, P, { newValue: "1" }), ...both(BOB, P, { newValue: "1" })]));
  // Signed by both, each writes their own.
  assert.ok(accepts([...both(ALICE, P, { newValue: "1" }), ...both(BOB, P, { newValue: "1" })], { signers: [ALICE, BOB] }));
});

test("a handle of any length may be followed", () => {
  for (const h of ["a", "_", "0", "x".repeat(300), ALICE]) assert.ok(accepts(both(ALICE, `@${h}`, { newValue: "1" })), h);
});

test("only an account following an account or @handle is a record", () => {
  for (const t of ["", "@", "alice", "@Alice", "@al-ice", "@al.ice", "@al ice", "@alicé", "@@alice", ALICE.toUpperCase(), `${ALICE}x`, "abcdefghijklmnop"]) {
    assert.ok(!accepts(both(ALICE, t, { newValue: "1" })), `followed ${t}`);
  }
  // The follower must be an address, and sign.
  for (const a of ["alice", "@alice", ALICE.toUpperCase(), `${ALICE}x`, ""]) assert.ok(!accepts(both(a, P, { newValue: "1" }), { signers: [ALICE, a] }), a);
  for (const key of [
    `${follow(ALICE, P)}/x`,
    `${follower(ALICE, P)}/x`,
    `follows/${ALICE}`,
    `followers/${P}`,
    `follow/${ALICE}/${P}`,
    `follows/alice/bob/${ALICE}`,
    `user/${ALICE}/follows/${P}`,
    "",
  ]) {
    assert.ok(!accepts([{ key, newValue: "1" }]), key);
  }
  // Twins that both run on are still not follows.
  assert.ok(!accepts([{ key: `${follow(ALICE, P)}/x`, newValue: "1" }, { key: `${follower(ALICE, P)}/x`, newValue: "1" }]));
  // One bad action rejects the whole write.
  assert.ok(!accepts([...both(ALICE, P, { newValue: "1" }), { key: `user/${ALICE}/profile`, newValue: "{}" }]));
});

test("values mean nothing else to the chain", () => {
  assert.ok(accepts(both(ALICE, P, { newValue: "" })));
  assert.ok(accepts(both(ALICE, CAROL, { newValue: JSON.stringify({ since: 1 }) })));
});

test("coin actions pass untouched", () => {
  assert.ok(accepts([], { accountActions: [{ owner: ALICE, delta: -5n }, { owner: BOB, delta: 5n }] }));
});

test("a malformed or missing body is rejected", () => {
  assert.ok(!validate(context(undefined, { path: PATH })));
  assert.ok(!validate(context(Uint8Array.of(0xa0, 0x00), { path: PATH })));
  assert.ok(!validate(Uint8Array.of(1, 2, 3)));
});
