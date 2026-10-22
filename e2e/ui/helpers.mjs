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

  return {
    state,
    submit,
    write,
    /** The actions for `who` claiming the free `@handle`, unsent. */
    claimActions: async (who, handle) => (await names.claim(await state.moniker(), who.address, handle)).actions,
    /** `who` claims the free `@handle` on Moniker. */
    claim: async (who, handle) => write(MONIKER, who, (await names.claim(await state.moniker(), who.address, handle)).actions),
    /** `from` sells `@handle` to `to` (listed at 0, then bought). */
    sell: async (from, handle, to) => {
      await write(MONIKER, from, (await names.list(await state.moniker(), from.address, handle, 0n)).actions);
      await write(MONIKER, to, (await names.buy(await state.moniker(), to.address, handle)).actions);
    },
    /** Account `who`, as `@h`, follows each of `targets`, in one transaction. */
    follow: async (who, h, ...targets) => {
      const s = await state.follows();
      const actions = [];
      for (const t of targets) actions.push(...(await follows.follow(s, who.address, h, t)).actions);
      await write(FOLLOWS, who, actions);
    },
    /** The actions for `who`, as `@h`, following `@t`, unsent. */
    followActions: async (who, h, t) => (await follows.follow(await state.follows(), who.address, h, t)).actions,
    unfollow: async (who, h, t) => write(FOLLOWS, who, (await follows.unfollow(await state.follows(), who.address, h, t)).actions),
  };
}
