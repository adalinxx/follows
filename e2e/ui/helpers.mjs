// What the UI tests do outside the page: make accounts and write records the
// way another client would, signed here and sent to the node's public submit.
import * as sdk from "../../vendor/lattice-sdk.js";
import * as follows from "../../src/records/follows.mjs";
import { tip, view, volumeLoader } from "../../src/records/state.mjs";
import { transaction } from "../../src/records/wallet.mjs";
import * as profile from "../../app/vendor/moniker-sdk/src/records/profile.mjs";
import { FOLLOWS, MONIKER } from "./stack.mjs";

export { sdk };

/** A new account: its address and private key. */
export function newAccount() {
  const privateKey = sdk.generatePrivateKey();
  return { address: sdk.accountFromPrivateKey(privateKey).address, privateKey };
}

export async function until(label, condition, seconds = 300) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (await condition().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Writing and reading on the stack's chains, as `node` serves them. */
export function client(node) {
  const states = (chain) => {
    const volumes = new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${node}/volumes`, { chainPath: chain }));
    const load = volumeLoader(volumes, sdk.decodeDagCbor);
    return async () => view(load, (await tip(sdk, node, chain, volumes)).generalStateCID);
  };
  const state = { follows: states(FOLLOWS), moniker: states(MONIKER) };

  /** Sends `actions` on `chain` signed by `who`; resolves once the node took them. */
  async function submit(chain, who, actions) {
    const account = await fetch(`${node}/api/state/account/${who.address}?chainPath=${chain.join("/")}`).then((r) => (r.ok ? r.json() : {}));
    const body = transaction({ owner: who.address, actions, fee: 0n, nonce: BigInt(account.nonce ?? 0), chainPath: chain });
    const { publicKey, signature } = sdk.signTransactionBody(body, who.privateKey);
    // A public node limits how fast it takes submissions: wait and send again.
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`${node}/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)),
      });
      if (r.ok) return;
      if (r.status !== 429 || attempt >= 20) throw new Error(`submit: ${r.status} ${await r.text()}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * (Number(r.headers.get("retry-after")) || 1 + attempt)));
    }
  }

  /** `actions` on `chain`, signed by `who`, landed. */
  async function write(chain, who, actions) {
    if (actions.length === 0) return;
    await submit(chain, who, actions);
    const read = chain === FOLLOWS ? state.follows : state.moniker;
    await until("records land", async () => {
      const now = await read();
      for (const { key, newValue } of actions) if ((await now.get(key)) !== newValue) return false;
      return true;
    });
  }

  return {
    state,
    submit,
    /** Account `who` follows each of `handles`, in one transaction. */
    follow: async (who, ...handles) => {
      const s = await state.follows();
      const actions = [];
      for (const h of handles) actions.push(...(await follows.follow(s, who.address, h)).actions);
      await write(FOLLOWS, who, actions);
    },
    /** The actions for `who` following `handle`, unsent. */
    followActions: async (who, handle) => (await follows.follow(await state.follows(), who.address, handle)).actions,
    unfollow: async (who, handle) => write(FOLLOWS, who, (await follows.unfollow(await state.follows(), who.address, handle)).actions),
    /** `who`'s Moniker card set to `card`, and `handle` claimed and shown on it, in one transaction. */
    card: async (who, card, handle) => {
      const s = await state.moniker();
      // A handle bought in Moniker's app goes on the card too.
      const edit = await profile.editCard(s, who.address, handle ? { ...card, handle } : card);
      const claim = handle ? await profile.claim(s, who.address, handle) : { actions: [] };
      await write(MONIKER, who, [...edit.actions, ...claim.actions]);
    },
    /** `from` gives `handle` to `to`. */
    give: async (from, handle, to) => {
      const entry = await profile.resolve(await state.moniker(), handle);
      await write(MONIKER, from, profile.transfer(entry, to.address).actions);
    },
  };
}

/** A one-block media Volume, `{ type, bytes }`, kept by the node; its CID. */
export async function pinMedia(info, type, bytes) {
  const block = sdk.encodeDagCbor({ bytes, type });
  const cid = sdk.cidV1DagCbor(block);
  const r = await fetch(`${info.rpc}/pins`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(info.cookie())}`, "Content-Type": "application/json" },
    body: JSON.stringify({ cid, entries: { [cid]: Buffer.from(block).toString("base64") } }),
  });
  if (!r.ok) throw new Error(`pin: ${r.status} ${await r.text()}`);
  return cid;
}
