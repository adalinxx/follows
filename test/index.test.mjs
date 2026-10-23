import assert from "node:assert/strict";
import { test } from "node:test";
import { createFollows, DEFAULTS, isAddress, isHandle } from "../src/index.mjs";

// Enough of the Lattice SDK for createFollows to start; nothing here reads a node.
const sdk = { VolumeClient: class {}, HTTPVolumeTransport: class {}, decodeDagCbor: () => undefined };
const address = "bafyreibc6ggvvnkjlyjghue3qxnagcoprbsh725cutnnnkt3t6dambbt6a";
const other = "bafyreibc6ggvvnkjlyjghue3qxnagcoprbsh725cutnnnkt3t6dambbt6a".replace(/a$/, "e");
// Enough of a Moniker client: @ada points at `other`, which shows it; the account `address` shows no handle.
const moniker = {
  state: async () => ({}),
  pointer: async (h) => (h === "ada" ? other : undefined),
  handlesOf: async (accounts) => accounts.map((a) => (a === other ? "ada" : undefined)),
};

test("needs the SDK and Moniker", () => {
  assert.throws(() => createFollows({ moniker }), /needs \{ sdk \}/);
  assert.throws(() => createFollows({ sdk }), /needs \{ moniker \}/);
});

test("defaults to the testnet trial chain and its shared hosts", () => {
  const graph = createFollows({ sdk, moniker });
  assert.deepEqual(graph.chain, DEFAULTS.chain);
  assert.deepEqual(graph.nodes, DEFAULTS.nodes);
});

test("writes need a wallet; nobody follows themselves", async () => {
  await assert.rejects(createFollows({ sdk, moniker }).follow("@ada", { wallet: undefined }), /Lattice wallet/);
  const wallet = { address: async () => other, writeRecords: async () => assert.fail("sent") };
  await assert.rejects(createFollows({ sdk, moniker }).follow("@ada", { wallet }), /yourself/);
  await assert.rejects(createFollows({ sdk, moniker }).follow("Ada!", { wallet }), /not an account or a handle/);
});

test("a person is an account with the handle it shows, or a handle alone", async () => {
  const graph = createFollows({ sdk, moniker });
  assert.deepEqual(await graph.person("ada"), { account: other, handle: "ada" });
  assert.deepEqual(await graph.person(other), { account: other, handle: "ada" });
  assert.deepEqual(await graph.person(address), { account: address });
  assert.deepEqual(await graph.person("@nobody"), { handle: "nobody" });
  // A handle no account shows follows no one.
  assert.deepEqual(await graph.following("@nobody"), []);
  assert.deepEqual(await graph.followingAccounts("@nobody"), []);
});

test("checks addresses and handles", () => {
  assert.ok(isAddress(address));
  assert.ok(!isAddress("bafyrei"));
  assert.ok(isAddress(other));
  assert.ok(isHandle("ada_1"));
  assert.ok(!isHandle("@ada"));
  assert.ok(!isHandle("Ada"));
  assert.ok(!isHandle(""));
  assert.ok(!isHandle(address.slice(0, 7) + "/x"));
});
