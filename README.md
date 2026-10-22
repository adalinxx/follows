# Follows

One follow graph that every app shares. Follow someone once, and every app
that reads Follows knows it. Your audience comes with you, so you don't start
at zero in each app.

Follows is its own Lattice chain. It holds follows and nothing else.

## Records

An account follows an account, or a handle. Handles are names on
[Moniker](https://github.com/adalinxx/moniker), the names chain: an account
owns `@<h>` there, points it at an account, and an account shows `@<h>` in
every app while it names `h` and `h` points back at it. A handle is
lowercase letters, digits and `_`. Accounts never need a handle to follow.

Account `<a>` following `<t>` is two keys, so that each end of the graph is
one prefix read. `<t>` is an account address, or `@` and a handle:

| Key | Lists |
| --- | --- |
| `follows/<a>/<t>` | whom `<a>` follows: read `follows/<a>/` |
| `followers/<t>/<a>` | who follows `<t>`: read `followers/<t>/` |

`<a>` signs: only it writes or deletes its keys, always both in one
transaction, to the same value, the `followers/` key directly after its
`follows/` twin; clients write `"1"`. The chain starts with neither, so the
two lists always agree. The policy checks only these shapes and that `<a>`
signs.

Following someone who shows a handle follows the handle; following someone
who shows none follows their account. This chain can't see Moniker, so
readers resolve handles: `@h` stands for the account it points at, while
that account shows `h`, the same test every app uses to show `@h` beside an
account. So:

- A person's followers are the accounts following their account, and those
  following the handle they show now, each account once.
- Whom an account follows is one entry a person. A followed handle that no
  account shows now stays on the list as `@h`, and counts for whoever shows
  it next.
- When a handle moves to another key (given, sold, or its owner moving to a
  new key), its followers follow that key. Followers of the old account stay
  with the account. An account's own follows are its own: renaming or giving
  away a handle never touches them.

## The page

Live at https://adalinxx.github.io/follows/app/, reading the testnet trial.

`app/` is a static page: search a `@handle` or an account to see how many
follow them and how many they follow, and both lists. People show by the
handle they show, or by their account's last four characters when they show
none; each links to their page, and long lists have a filter. Follow them
with the button: no handle needed. With Selfhold connected, the front page
shows you, with your counts and lists; showing no handle, it offers Moniker's
handle picker to claim or show one without leaving the page. Who shows which
handle is read from Moniker through
[moniker-sdk](https://github.com/adalinxx/moniker-sdk), a submodule at
`app/vendor/moniker-sdk`: clone with `--recurse-submodules`. Links:
`#/@handle`, `#/<account>`, and `/followers` or `/following` after either.

```sh
python3 -m http.server 8767   # from the repository root, then open http://127.0.0.1:8767/app/
```

## Use Follows in your app

```js
import { createFollows, defineFollowButton, defineWho } from "https://cdn.jsdelivr.net/gh/adalinxx/follows@v0.4.0/src/browser.mjs";
import { createMoniker } from "https://cdn.jsdelivr.net/gh/adalinxx/moniker-sdk@v0.3.0/src/browser.mjs";

const moniker = createMoniker();
const graph = createFollows({ moniker });          // testnet trial by default; or { nodes, chain }
await graph.person("@ada");                        // { account, handle: "ada" }, or { handle } if no account shows it
await graph.following(address);                    // whom it follows: [{ account, handle? } | { handle }, …]
await graph.followingAccounts(address);            // the accounts it follows, each once: build a feed from these
await graph.followers("@ada");                     // the accounts following Ada's account or handle, each once
await graph.counts(address);                       // { followers, following }
await graph.follows(address, "@bob");              // true or false

const wallet = window.lattice;                     // Selfhold
await graph.follow("@bob", { wallet });            // Bob's handle if he shows one, else his account; undefined if already
await graph.unfollow(bobAddress, { wallet });      // deletes this account's keys for Bob, by account and by handle
```

Anywhere a person goes, an account address or a handle (with or without
`@`) will do; a handle spelled like an address needs its `@`. Nobody follows
themselves.

### Showing people in your app

Key your records by account, as every Lattice app does, and show an account
by your app's own card for it and the handle it shows
(`moniker.handleOf(address)`, or `<moniker-name>` from moniker-sdk). Rank or
filter by `graph.followingAccounts(reader)`, and show a person's
`graph.counts(address)`.

A Follow button for any page, which asks Selfhold only when pressed:

```js
defineFollowButton(graph);
```

```html
<follows-button target="@ada"></follows-button>
<follows-button target="bafyrei…"></follows-button>
```

It reads "Follow @ada" / "Following @ada", or just "Follow" for someone who
shows no handle. It follows as the connected account, and hides on that
account's own page.

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

The same card about a person in every app: wrap a name in `<follows-who>`,
and pressing it opens your app's name, photo and bio for them, the handle
they show (or their account's tail), their counts, a Follow button, and
links to their Follows and Moniker pages.

```js
defineWho(graph, { card: async (address) => ({ name, photo, bio }) });   // your app's card, or undefined
```

```html
<follows-who address="bafyrei…"><moniker-name address="bafyrei…" name="Dana" plain></moniker-name></follows-who>
```

What it wraps sits inside a button, so wrap a name without a link of its own.
Card text is shown as text with every `@` dropped, so only a verified handle
shows with one. It closes on Escape or a press outside, and focus goes back
to the name. Style it with the button's properties and `--follows-surface`.

Reads go to the first node that answers. Every trie node is checked against
its CID, so a read doesn't depend on trusting the node that served it.
Handles are resolved from one Moniker state, all at once. Writes go to the
person's wallet, which shows each one and signs it. The library never holds
a key. Writes are free on the testnet trial.

In Node, or with your own copy of the Lattice SDK, import `src/index.mjs` and
pass the SDK in: `createFollows({ sdk, moniker })`. `moniker` needs only
`state()`, `pointer(handle)` and `handlesOf(addresses)`, as `createMoniker`
returns them.

## Layout

- `policy/`: the chain's validity policy (Rust, built to wasm). It uses the
  shared rules crate from Moniker. `policy/host-check` replays the test
  contexts through Lattice's own evaluator.
- `chain/spec.json`: the chain spec, which names the policy module by CID;
  `chain/follows_policy.wasm` is that module, built.
- `src/`: the library. `src/element.mjs` is `<follows-button>`, `src/who.mjs` is `<follows-who>`. `src/records/follows.mjs` holds the records,
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
cd e2e/ui && npm install && \
  LATTICE=<lattice-node>/.build/debug/lattice LATTICE_WALLET=<selfhold>/dist npm test
```

Following goes through the real Selfhold extension, holding each person's
key. They cover search by handle and by account, both lists with people
shown by handle or account tail, counts, the filter, navigation and links,
empty lists, hostile input, a handle no account shows, a handle given to
another key (its followers move, the old account keeps its own), unfollows,
following with no handle, following an account with no handle, unfollowing
someone followed both ways, you on the front page and its handle picker,
declining in Selfhold, your own page, a long list, a follow pending in the
mempool, a switched account, `<follows-who>` in another app's page, a slow
page overtaken by a newer one, dead nodes, phone width and dark mode.

The e2e test launches the chain from `chain/spec.json` and a Moniker chain on
a private node. Alice and Bob show @ada and @bob; Carol shows none. Alice and
Carol follow @bob, Bob follows Carol's account, and the test reads both ends
of the graph. Writing someone else's keys, a target that is neither an
account nor a `@handle`, half of a follow, or twins with different values is
refused. Then Alice gives @ada to Dan: @ada's followers follow Dan, and
Alice's account keeps its own followers and follows. Last, unfollowing
someone followed both ways deletes both.
