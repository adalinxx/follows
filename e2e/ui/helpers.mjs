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
    write,
    /** A new profile owned by `who`, with `card` and the free name `handle` if given; its id, once landed. */
    profile: async (who, card, handle) => {
      const { id, write: created } = await profile.createProfile(await state.moniker(), who.address, { card, handle });
      await write(MONIKER, who, created.actions);
      return id;
    },
    /** Account `who`, acting for profile `p`, follows each of `targets`, in one transaction. */
    follow: async (who, p, ...targets) => {
      const s = await state.follows();
      const actions = [];
      for (const t of targets) actions.push(...(await follows.follow(s, who.address, p, t)).actions);
      await write(FOLLOWS, who, actions);
    },
    /** The actions for `who`, as `p`, following `t`, unsent. */
    followActions: async (who, p, t) => (await follows.follow(await state.follows(), who.address, p, t)).actions,
    unfollow: async (who, p, t) => write(FOLLOWS, who, (await follows.unfollow(await state.follows(), who.address, p, t)).actions),
    /** `owner` makes account `admin` an admin of its profile `p`. */
    admin: async (owner, p, admin) => write(MONIKER, owner, (await profile.setAdmin(await state.moniker(), owner.address, p, admin.address)).actions),
    /** `from` offers its profile `p` to `to`, who takes it. */
    hand: async (from, p, to) => {
      await write(MONIKER, from, (await profile.setProfileTerms(await state.moniker(), from.address, p, { offer: to.address })).actions);
      await write(MONIKER, to, (await profile.takeProfile(await state.moniker(), to.address, p)).actions);
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
