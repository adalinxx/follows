import assert from "node:assert/strict";
import { test } from "node:test";
import { createFollows, DEFAULTS, isAddress } from "../src/index.mjs";

// Enough of the Lattice SDK for createFollows to start; nothing here reads a node.
const sdk = { VolumeClient: class {}, HTTPVolumeTransport: class {}, decodeDagCbor: () => undefined };
const address = "bafyreibc6ggvvnkjlyjghue3qxnagcoprbsh725cutnnnkt3t6dambbt6a";

test("needs the SDK", () => {
  assert.throws(() => createFollows({}), /needs \{ sdk \}/);
});

test("defaults to the testnet trial chain and its shared hosts", () => {
  const graph = createFollows({ sdk });
  assert.deepEqual(graph.chain, DEFAULTS.chain);
  assert.deepEqual(graph.nodes, DEFAULTS.nodes);
});

test("writes need a wallet", async () => {
  await assert.rejects(createFollows({ sdk }).follow(address, { wallet: undefined }), /Lattice wallet/);
});

test("checks addresses", () => {
  assert.ok(isAddress(address));
  assert.ok(!isAddress("bafyrei"));
});
