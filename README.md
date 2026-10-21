# Follows

One follow graph that every app shares. Follow someone once, and every app
that reads Follows knows it. Your audience comes with you, so you don't start
at zero in each app.

Follows is its own Lattice chain. It holds follows and nothing else.

## Records

An account follows two kinds of target:

- **An account**, by its address. The follow stays with that account,
  whatever names it holds or sells.
- **A name**, a Moniker handle written `@<h>`. The follow is of whoever holds
  the name now: if the name is sold, given away or moved to a new key, its
  followers go with it. That suits a business or a brand, whose name is who
  it is.

A follow of `<t>` by account `<a>` is two keys, so that each end of the graph
is one prefix read:

| Key | Lists |
| --- | --- |
| `user/<a>/follows/<t>` | what `<a>` follows: read `user/<a>/follows/` |
| `followers/<t>/<a>` | who follows `<t>`: read `followers/<t>/` |

`<a>` is an account address, and only `<a>` writes or deletes its follows,
always both keys in one transaction, to the same value; clients write `"1"`.
The chain starts with neither, so the two lists always agree: nobody shows up
as a follower without following. `<t>` is an address or `@` and a handle
(lowercase letters, digits and `_`). Who holds a name is Moniker's business:
following a name nobody holds yet is allowed.

The follower is always an account, never a name: only a signature shows who
followed, and this chain can't see who holds a name on Moniker.

### What following means, for apps

- Following an account shows what that account writes.
- Following `@h` shows what the current holder of `@h` writes. When `@h`
  changes hands, followers see the new holder. An app that wants a post tied
  to a name can let the author say which name it speaks as (say,
  `as: "h"`) and show it only when the author held the name when posting.
- An account's audience is its own followers plus the followers of the names
  it holds. Count each person once when adding them up.

Names and photos for addresses come from
[Moniker](https://github.com/adalinxx/moniker), the profile chain.

## The page

Live at https://adalinxx.github.io/follows/app/, reading the testnet trial.

`app/` is a static page: search a `@handle` or an address. A name's page
shows who follows the name and whoever holds it now; an account's page shows
who follows the account; each links to the other. The Following tab lists the
names and accounts they follow, a name shown as its current holder. Each list
has a filter that matches name, `@handle` or address. Names and photos come from
Moniker through [moniker-sdk](https://github.com/adalinxx/moniker-sdk), a
submodule at `app/vendor/moniker-sdk` pinned to a release: clone with
`--recurse-submodules`. Links: `#/@handle`, `#/<address>`, and
`#/<who>/following`.

```sh
python3 -m http.server 8767   # from the repository root, then open http://127.0.0.1:8767/app/
```

## Use Follows in your app

```js
import { createFollows } from "https://cdn.jsdelivr.net/gh/adalinxx/follows@v0.1.0/src/browser.mjs";

const graph = createFollows();                    // testnet trial by default; or { nodes, chain }
const followed = await graph.following(address);  // what they follow: ["@ada", "bafyrei…"]
const fans = await graph.followers("@ada");       // who follows the name
const fans2 = await graph.followers(address);      // who follows the account
await graph.follows(address, "@ada");             // true or false

const wallet = window.lattice;                    // Selfhold
await graph.follow("@ada", { wallet });           // undefined if already following
await graph.unfollow(address, { wallet });
```

A target is an address or a name. A name may be given without its `@`; an
address is never mistaken for one.

Reads go to the first node that answers. Every trie node is checked against
its CID, so a read doesn't depend on trusting the node that served it. Writes
go to the person's wallet, which shows each one and signs it. The library
never holds a key. Writes are free on the testnet trial.

In Node, or with your own copy of the Lattice SDK, import `src/index.mjs` and
pass the SDK in: `createFollows({ sdk })`.

## Layout

- `policy/`: the chain's validity policy (Rust, built to wasm). It uses the
  shared rules crate from Moniker. `policy/host-check` replays the test
  contexts through Lattice's own evaluator.
- `chain/spec.json`: the chain spec, which names the policy module by CID.
- `src/`: the library. `src/records/follows.mjs` holds the records,
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

They cover search by handle and address, both tabs, counts, the filter,
navigation and links, empty lists, accounts with no card, hostile names and
photos, self-follows, handles that changed hands, unfollows, a long list, a
slow page overtaken by a newer one, dead nodes, phone width and dark mode.

The e2e test launches the chain from `chain/spec.json` on a private node.
Alice and Carol follow Bob, and the test reads both ends of the graph. Writing
someone else's follow, or half of a follow, is refused. Then Alice unfollows
Bob.
