// Follows for any app: one follow graph every Lattice app shares, so a
// person's audience comes with them instead of starting at zero in each app.
// An account follows an account, or a handle: a Moniker name, standing for
// the account that shows it now.
//
//   const graph = createFollows({ sdk, moniker });      // sdk: the Lattice SDK module; moniker: createMoniker(…)
//   const people = await graph.following(address);     // [{ account, handle }, …]
//   const fans = await graph.followers("@bob");         // the accounts following @bob's account or handle
//   const feed = await graph.followingAccounts(address);  // the accounts to build a feed from
//   await graph.follow("@bob", { wallet: window.lattice });
//
// Following someone who shows a handle follows the handle; following
// someone without one follows their account. A person's followers are those
// of their account and of the handle they show, each account once.
//
// Reads go to the first of `nodes` that answers and are checked by CID, so
// they do not depend on trusting that node. Writes go to the wallet, which
// shows them to the person and signs; this library never holds a key.
import * as records from "./records/follows.mjs";
import { anyHost, tip, view, volumeLoader } from "./records/state.mjs";
import { writeRequest } from "./records/wallet.mjs";

/** Where Follows lives now: its testnet trial chain and the shared hosts. */
export const DEFAULTS = {
  chain: ["Nexus", "testnet", "follows-ade46a"],
  nodes: ["https://lattice-testnet-apps-iad.fly.dev", "https://lattice-testnet-apps-ams.fly.dev"],
  // The trial chain's hosts admit 0-fee transactions: writes are free.
  fee: 0n,
  // How long a read state is reused before asking for the tip again.
  freshFor: 10_000,
};

export function createFollows(options) {
  const { sdk, moniker, chain, nodes, fee, freshFor } = { ...DEFAULTS, ...options };
  if (!sdk) throw new Error("createFollows needs { sdk }: the Lattice SDK module");
  if (!moniker) throw new Error("createFollows needs { moniker }: createMoniker from moniker-sdk");
  /** Moniker as the records read it: where handles point and which handle each account shows. */
  const names = {
    pointers: (handles) => Promise.all(handles.map((h) => moniker.pointer(h))),
    handlesOf: (addresses) => moniker.handlesOf(addresses),
  };
  const volumes = new sdk.VolumeClient(anyHost(nodes.map((node) => new sdk.HTTPVolumeTransport(`${node}/volumes`, { chainPath: chain }))));
  const load = volumeLoader(volumes, sdk.decodeDagCbor);

  let current = null; // { at, state: Promise }
  /** The chain's state at the tip of the first node that answers, reused for `freshFor` ms. */
  function state({ fresh = false } = {}) {
    if (!fresh && current && Date.now() - current.at < freshFor) return current.state;
    const read = (async () => {
      let failure;
      for (const node of nodes) {
        try {
          const { generalStateCID } = await tip(sdk, node, chain, volumes);
          return view(load, generalStateCID);
        } catch (error) {
          failure = error;
        }
      }
      throw new Error(`No node is serving ${chain.join("/")}`, { cause: failure });
    })();
    current = { at: Date.now(), state: read };
    read.catch(() => current?.state === read && (current = null));
    return read;
  }

  const needWallet = (wallet) => {
    if (!wallet?.writeRecords) throw new Error("This needs a Lattice wallet such as Selfhold (window.lattice).");
    return wallet;
  };
  const me = async (wallet) => (await needWallet(wallet).address?.()) ?? (await wallet.connect());
  /** Sends `write` to the wallet unless there is nothing to write; resolves to its answer, or undefined. */
  const send = (wallet, write) => (write.actions.length > 0 ? needWallet(wallet).writeRecords(writeRequest(chain, write, fee)) : undefined);

  return {
    chain,
    nodes,
    state,
    moniker,

    /** Who `who` (an account, or a handle with or without @) is: `{ account, handle }`, or `{ handle }` when no account shows it. */
    person: async (who) => records.person(names, who),
    /** Whom `who` follows, one entry a person: `{ account, handle }`, or `{ handle }` for a handle no account shows now. */
    following: async (who) => {
      const { account } = await records.person(names, who);
      return account === undefined ? [] : records.following(await state(), names, account);
    },
    /** The accounts `who` follows, each once: what a feed is built from. */
    followingAccounts: async (who) => {
      const { account } = await records.person(names, who);
      if (account === undefined) return [];
      return (await records.following(await state(), names, account)).flatMap((p) => (p.account === undefined ? [] : [p.account]));
    },
    /** The accounts that follow `who`, by its account or the handle it shows, each once. */
    followers: async (who) => records.followers(await state(), names, who),
    /** How many accounts follow `who`, and how many people it follows: `{ followers, following }`. */
    counts: async (who) => {
      const s = await state();
      const { account } = await records.person(names, who);
      const [followers, following] = await Promise.all([records.followers(s, names, who), account === undefined ? [] : records.following(s, names, account)]);
      return { followers: followers.length, following: following.length };
    },
    /** Whether `account` follows `who`, by account or handle. */
    follows: async (account, who) => records.follows(await state(), names, account, who),
    /**
     * What `account` is saving now: follows (`true`) and unfollows (`false`)
     * waiting in the first answering node's mempool, by followed target:
     * an address or `@<h>`.
     */
    pending: async (account) => {
      for (const node of nodes) {
        try {
          const url = new URL("/api/mempool", node);
          url.searchParams.set("chainPath", chain.join("/"));
          const response = await fetch(url, { cache: "no-store" });
          if (!response.ok) continue;
          const { transactions = [] } = await response.json();
          // A few at a time: a full mempool must not flood the reader.
          const bodies = [];
          let next = 0;
          await Promise.all(
            Array.from({ length: Math.min(8, transactions.length) }, async () => {
              while (next < transactions.length) {
                const cid = transactions[next++];
                try {
                  // A transaction's volume carries its body.
                  const volume = await volumes.get(cid);
                  bodies.push(sdk.decodeDagCbor(volume.bytes(sdk.decodeDagCbor(volume.rootBytes()).body.rawCID)));
                } catch {}
              }
            }),
          );
          return records.pendingIn(bodies, account);
        } catch {}
      }
      return {};
    },

    /**
     * The connected account follows `who`: the handle they show, else their
     * account. Resolves to undefined when it follows them already.
     */
    follow: async (who, { wallet }) => {
      const account = await me(wallet);
      await moniker.state({ fresh: true });
      // Before reading Follows: nobody follows themselves.
      if ((await records.person(names, who)).account === account) throw new Error("You can't follow yourself.");
      return send(wallet, await records.follow(await state({ fresh: true }), names, account, who));
    },
    /** The connected account stops following `who`, by account and by handle. Resolves to undefined when it didn't. */
    unfollow: async (who, { wallet }) => {
      const account = await me(wallet);
      await moniker.state({ fresh: true });
      return send(wallet, await records.unfollow(await state({ fresh: true }), names, account, who));
    },
  };
}

export const { isAddress, isHandle, target } = records;
