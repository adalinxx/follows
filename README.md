# Follows

One follow graph that every app shares. Follow someone once, and every app
that reads Follows knows it. Your audience comes with you, so you don't start
at zero in each app.

Follows is its own Lattice chain. It holds follows and nothing else.

## Records

A profile follows a profile. Profiles live on
[Moniker](https://github.com/adalinxx/moniker), the profile chain: an account
(a key, never shown) owns profiles, each the public identity apps show, with a
card and @names, and may name admins who act as it. A profile id is 16
characters of `a`–`z` and `2`–`7`. An app that has a @name resolves it to its
profile on Moniker first.

A follow of profile `<t>` by profile `<p>`, written by account `<a>`, is two
keys, so that each end of the graph is one prefix read:

| Key | Lists |
| --- | --- |
| `follows/<p>/<t>/<a>` | what `<p>` follows: read `follows/<p>/` |
| `followers/<t>/<p>/<a>` | who follows `<t>`: read `followers/<t>/` |

Only `<a>` writes or deletes its keys, always both in one transaction, to the
same value, the `followers/` key directly after its `follows/` twin; clients
write `"1"`. The chain starts with neither, so the two
lists always agree.

This chain can't see Moniker, so it can't check that `<a>` acts for `<p>`.
Readers do: a follow counts while an account that wrote it acts for `<p>` on
Moniker now, as its owner or an admin. When a profile is sold or given away,
its old owner's follows lapse, and the new owner writes their own. Count
profiles, not keys: two admins following as one profile are one follower.

## The page

Live at https://adalinxx.github.io/follows/app/, reading the testnet trial.

`app/` is a static page: search a `@handle` or a profile ID. A profile's page
shows its card, how many profiles follow it and how many it follows, and
both lists, each with a filter that matches name, `@handle` or ID. Accounts
are never shown. Cards and photos come from Moniker through
[moniker-sdk](https://github.com/adalinxx/moniker-sdk), a submodule at
`app/vendor/moniker-sdk`: clone with `--recurse-submodules`. Links:
`#/@handle`, `#/<profile id>`, and `#/<who>/following`.

```sh
python3 -m http.server 8767   # from the repository root, then open http://127.0.0.1:8767/app/
```

## Use Follows in your app

```js
import { createFollows } from "https://cdn.jsdelivr.net/gh/adalinxx/follows@v0.3.0/src/browser.mjs";
import { createMoniker } from "https://cdn.jsdelivr.net/gh/adalinxx/moniker-sdk@v0.2.0/src/browser.mjs";

const moniker = createMoniker();
const graph = createFollows({ moniker });          // testnet trial by default; or { nodes, chain }
const t = await moniker.resolve("@ada");           // a @name's profile id
const followed = await graph.following(p);         // the profiles p follows
const fans = await graph.followers(t);             // the profiles that follow t
await graph.follows(p, t);                         // true or false

const wallet = window.lattice;                     // Selfhold
await graph.follow(p, t, { wallet });              // as p, which the account must own or admin; undefined if already
await graph.unfollow(p, t, { wallet });            // deletes this account's keys only
```

A Follow button for any page, which asks Selfhold only when pressed:

```js
import { createFollows, defineFollowButton } from "https://cdn.jsdelivr.net/gh/adalinxx/follows@v0.3.0/src/browser.mjs";

defineFollowButton(createFollows({ moniker }));
```

```html
<follows-button target="<profile id>" label="Ada Lovelace"></follows-button>
```

On a profile that shows a name it reads "Follow @ada" / "Following @ada";
on one without, "Follow" / "Following" (give it `label` with the profile's
name, for screen readers). The follower is the connected account's profile:
its one, or, with several, the one picked under the button ("as @ada"),
remembered in this browser. An account with no profile is told to make one on
Moniker (`defineFollowButton(graph, { monikerURL })`). It hides on your own
profiles.

A follow takes about a block (a minute on the trial) to save. The button
turns at once and its note says "Saving… about a minute." until a block
holds it, then "Saved.", and it fires `follows:change`. A follow still
waiting in a node's mempool shows as saving too, even one sent from another
app or device: `graph.pending(account)` finds them. With no wallet it fires
`follows:needs-wallet`; handle that event to show your own help, or the button
explains how to add Selfhold (and, on a phone, to use a computer). Style it
with `--follows-accent`, `--follows-accent-ink`, `--follows-ink`,
`--follows-line`, `--follows-muted`, `--follows-width` and
`--follows-note-align`.

Reads go to the first node that answers. Every trie node is checked against
its CID, so a read doesn't depend on trusting the node that served it. Writes
go to the person's wallet, which shows each one and signs it. The library
never holds a key. Writes are free on the testnet trial.

In Node, or with your own copy of the Lattice SDK, import `src/index.mjs` and
pass the SDK in: `createFollows({ sdk, moniker })`.

## Layout

- `policy/`: the chain's validity policy (Rust, built to wasm). It uses the
  shared rules crate from Moniker. `policy/host-check` replays the test
  contexts through Lattice's own evaluator.
- `chain/spec.json`: the chain spec, which names the policy module by CID;
  `chain/follows_policy.wasm` is that module, built.
- `src/`: the library. `src/element.mjs` is `<follows-button>`. `src/records/follows.mjs` holds the records,
  `state.mjs` reads state by walking down the trie, and `wallet.mjs` builds
  the wallet request. `state.mjs` and `wallet.mjs` are copied from
  moniker-sdk.
- `vendor/lattice-sdk.js`: the Lattice SDK, bundled for browsers.

## Test

```sh
(cd policy && cargo build --release --target wasm32-unknown-unknown)
npm test                                          # the policy, and the records through it
LATTICE=<lattice-node>/.build/debug/lattice node e2e/follows.mjs   # against a real node

CONTEXT_DIR=.contexts node --test test/policy.test.mjs
(cd policy/host-check && swift run -c release host-check \
  ../target/wasm32-unknown-unknown/release/follows_policy.wasm ../../.contexts)
```

The page's acceptance tests run it in Chromium against a private node with a
Follows chain and a Moniker chain (under Moniker's own policy, copied into
`e2e/ui/moniker/`):

```sh
cd e2e/ui && npm install && LATTICE=<lattice-node>/.build/debug/lattice npm test
```

They cover search by handle and profile ID, both lists, counts by profile,
the filter, navigation and links, empty lists, profiles with no name, hostile
names and photos, self-follows, a follow lapsing when its profile changes
hands, admins following as a profile, unfollows, the as-picker, the
no-profile note, a long list, a slow page overtaken by a newer one, dead
nodes, phone width and dark mode.

The e2e test launches the chain from `chain/spec.json` on a private node,
with a stand-in for Moniker. Alice's and Carol's profiles follow Bob's, and
the test reads both ends of the graph. Writing someone else's keys, half of a
follow, or twins with different values is refused. Then Alice unfollows Bob.
