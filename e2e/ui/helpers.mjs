// What the UI tests do outside the page: make accounts and write records the
// way another client would, signed here and sent to the node's public submit.
import * as sdk from "../../vendor/lattice-sdk.js";
import * as follows from "../../src/records/follows.mjs";
import { tip, view, volumeLoader } from "../../src/records/state.mjs";
import { transaction } from "../../src/records/wallet.mjs";
import * as names from "../../app/vendor/moniker-sdk/src/records/names.mjs";
import { FOLLOWS, MONIKER } from "./stack.mjs";

export { sdk };

/** A new account: its address, private key, and the key in hex for Selfhold. */
export function newAccount() {
  const privateKey = sdk.generatePrivateKey();
  return { address: sdk.accountFromPrivateKey(privateKey).address, privateKey, keyHex: Buffer.from(privateKey).toString("hex") };
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

  /** Moniker as the records read it, from its tip now. */
  const resolver = async () => {
    const m = await state.moniker();
    return { pointers: (hs) => Promise.all(hs.map((h) => names.pointer(m, h))), handlesOf: (as) => names.handlesOf(m, as) };
  };
  /** The actions for `who` following `t`, an account or a @handle, as the library writes them. */
  const followActions = async (who, t) => (await follows.follow(await state.follows(), await resolver(), who.address, t)).actions;

  return {
    state,
    submit,
    write,
    /** The actions for `who` claiming the free `@handle` and showing it, unsent. */
    claimActions: async (who, handle) => (await names.claim(await state.moniker(), who.address, handle, { show: true })).actions,
    /** `who` claims the free `@handle` on Moniker and shows it. */
    claim: async (who, handle) => write(MONIKER, who, (await names.claim(await state.moniker(), who.address, handle, { show: true })).actions),
    /** `who` stops showing its handle: apps show its account's tail. */
    stopShowing: async (who) => write(MONIKER, who, (await names.stopShowing(await state.moniker(), who.address)).actions),
    /** `from` gives `@handle` to `to`, who takes it and shows it. */
    give: async (from, handle, to) => {
      await write(MONIKER, from, (await names.offerName(await state.moniker(), from.address, handle, to.address)).actions);
      await write(MONIKER, to, (await names.buy(await state.moniker(), to.address, handle, { show: true })).actions);
    },
    /** `who` follows each of `targets` (accounts or @handles) as the library would, in one transaction. */
    follow: async (who, ...targets) => {
      const actions = [];
      for (const t of targets) actions.push(...(await followActions(who, t)));
      await write(FOLLOWS, who, actions);
    },
    followActions,
    /** `who` follows `account` by its account, whatever handle it shows. */
    followAccount: async (who, account) =>
      write(FOLLOWS, who, [follows.followKey(who.address, account), follows.followerKey(who.address, account)].map((key) => ({ key, newValue: "1" }))),
    unfollow: async (who, t) => write(FOLLOWS, who, (await follows.unfollow(await state.follows(), await resolver(), who.address, t)).actions),
    /** Whether `who` holds a follow key for `t`, exactly as given (an address or `@h`). */
    keyed: async (who, t) => (await (await state.follows()).get(follows.followKey(who.address, t))) === "1",
  };
}
