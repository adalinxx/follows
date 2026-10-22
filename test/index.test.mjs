import assert from "node:assert/strict";
import { test } from "node:test";
import { createFollows, DEFAULTS, isAddress, isProfileId } from "../src/index.mjs";

// Enough of the Lattice SDK for createFollows to start; nothing here reads a node.
const sdk = { VolumeClient: class {}, HTTPVolumeTransport: class {}, decodeDagCbor: () => undefined };
const address = "bafyreibc6ggvvnkjlyjghue3qxnagcoprbsh725cutnnnkt3t6dambbt6a";
// Enough of a Moniker client: Alice acts for no profile.
const moniker = { actsFor: async () => false };

test("needs the SDK and Moniker", () => {
  assert.throws(() => createFollows({ moniker }), /needs \{ sdk \}/);
  assert.throws(() => createFollows({ sdk }), /needs \{ moniker \}/);
});

test("defaults to the testnet trial chain and its shared hosts", () => {
  const graph = createFollows({ sdk, moniker });
  assert.deepEqual(graph.chain, DEFAULTS.chain);
  assert.deepEqual(graph.nodes, DEFAULTS.nodes);
});

test("writes need a wallet, and a profile the account acts for", async () => {
  const [p, t] = ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"];
  await assert.rejects(createFollows({ sdk, moniker }).follow(p, t, { wallet: undefined }), /Lattice wallet/);
  const wallet = { address: async () => address, writeRecords: async () => assert.fail("sent") };
  await assert.rejects(createFollows({ sdk, moniker }).follow(p, t, { wallet }), /isn't yours/);
});

test("checks addresses and profile ids", () => {
  assert.ok(isAddress(address));
  assert.ok(!isAddress("bafyrei"));
  assert.ok(isProfileId("abcdefghij234567"));
  assert.ok(!isProfileId("abcdefghij23456"));
  assert.ok(!isProfileId("abcdefghij234561"));
  assert.ok(!isProfileId(address));
});
