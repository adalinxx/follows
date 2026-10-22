import assert from "node:assert/strict";
import { test } from "node:test";
import { createFollows, DEFAULTS, isAddress, isHandle } from "../src/index.mjs";

// Enough of the Lattice SDK for createFollows to start; nothing here reads a node.
const sdk = { VolumeClient: class {}, HTTPVolumeTransport: class {}, decodeDagCbor: () => undefined };
const address = "bafyreibc6ggvvnkjlyjghue3qxnagcoprbsh725cutnnnkt3t6dambbt6a";
const other = "bafyreibc6ggvvnkjlyjghue3qxnagcoprbsh725cutnnnkt3t6dambbt6a".replace(/a$/, "e");
// Enough of a Moniker client: @ada is owned by another account; the reads asked of it are kept.
const asked = [];
const moniker = { state: async () => ({}), owners: async (handles) => (asked.push(...handles), handles.map((h) => (h === "ada" ? other : undefined))), names: async () => [] };

test("needs the SDK and Moniker", () => {
  assert.throws(() => createFollows({ moniker }), /needs \{ sdk \}/);
  assert.throws(() => createFollows({ sdk }), /needs \{ moniker \}/);
});

test("defaults to the testnet trial chain and its shared hosts", () => {
  const graph = createFollows({ sdk, moniker });
  assert.deepEqual(graph.chain, DEFAULTS.chain);
  assert.deepEqual(graph.nodes, DEFAULTS.nodes);
});

test("writes need a wallet, and a handle the account owns", async () => {
  await assert.rejects(createFollows({ sdk, moniker }).follow("@ada", "@bob", { wallet: undefined }), /Lattice wallet/);
  const wallet = { address: async () => address, writeRecords: async () => assert.fail("sent") };
  asked.length = 0;
  await assert.rejects(createFollows({ sdk, moniker }).follow("@ada", "bob", { wallet }), /@ada isn't yours/);
  assert.deepEqual(asked, ["ada"]);
  await assert.rejects(createFollows({ sdk, moniker }).follow("nobody", "bob", { wallet }), /@nobody isn't yours/);
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

test("an account's handles, read anew from Moniker's tip when asked fresh", async () => {
  const reads = [];
  const fresh = { state: async ({ fresh = false } = {}) => (reads.push(fresh), { get: async () => undefined }), names: async () => [{ handle: "ada" }, { handle: "bob" }] };
  const graph = createFollows({ sdk, moniker: fresh });
  assert.deepEqual(await graph.handlesOf(address), ["ada", "bob"]);
  assert.deepEqual(reads, []);
  assert.deepEqual(await graph.handlesOf(address, { fresh: true }), ["ada", "bob"]);
  assert.deepEqual(reads, [true]);
});
