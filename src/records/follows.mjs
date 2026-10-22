// The follow graph's records. A handle follows a handle: both are Moniker
// names, which accounts own. Account `<a>`, owning `@<h>`, follows `@<t>`
// with two keys, `follows/<h>/<t>/<a>` and its twin `followers/<t>/<h>/<a>`,
// so that both ends are one prefix read. Only `<a>` may write them, and
// always together (the chain's policy).
//
// The chain can't see Moniker, so readers decide: a follow counts only while
// its account owns `@<h>` on Moniker now, as told by an `owners(handles)` the
// reader passes in (each handle's owner, or undefined, in order). When a
// handle is sold, its old owner's follows lapse and the new owner starts
// fresh; the handle's followers stay.

/**
 * Whether `text` is an account address in its one canonical spelling, as the
 * policy checks a signer.
 */
export function isAddress(text) {
  const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
  return (
    typeof text === "string" &&
    text.length === 59 &&
    text.startsWith("bafyrei") &&
    [...text.slice(7)].every((c) => BASE32.includes(c)) &&
    BASE32.indexOf(text[7]) < 8 &&
    BASE32.indexOf(text[58]) % 4 === 0
  );
}

/** Whether `text` is a Moniker handle, without its @: lowercase letters, digits and `_`. */
export const isHandle = (text) => typeof text === "string" && /^[a-z0-9_]+$/.test(text);

/** A handle as given, with or without its @, as the bare handle. */
export const bare = (handle) => String(handle).replace(/^@/, "");

/** Throws unless `h` and `t` are handles. */
function handles(h, t) {
  for (const handle of [h, t]) if (!isHandle(handle)) throw new Error(`not a handle: ${handle}`);
}

export const followKey = (h, t, account) => (handles(h, t), `follows/${h}/${t}/${account}`);
export const followerKey = (h, t, account) => (handles(h, t), `followers/${t}/${h}/${account}`);

/** The keys under `prefix`, `<prefix><handle>/<account>`, as a map from handle to its accounts, in key order. */
async function accountsBy(state, prefix) {
  const found = new Map();
  for await (const [key] of state.list(prefix)) {
    const [handle, account] = key.slice(prefix.length).split("/");
    found.set(handle, [...(found.get(handle) ?? []), account]);
  }
  return found;
}

/** Whether `@h` follows `@t`: the account that owns `h` now wrote it. */
export async function follows(state, h, t, owners) {
  handles(h, t);
  const [owner] = await owners([h]);
  return owner !== undefined && (await state.get(followKey(h, t, owner))) !== undefined;
}

/** The handles `@h` follows, in key order: those its owner now wrote. */
export async function following(state, h, owners) {
  if (!isHandle(h)) return [];
  const [found, [owner]] = await Promise.all([accountsBy(state, `follows/${h}/`), owners([h])]);
  return [...found.keys()].filter((t) => found.get(t).includes(owner));
}

/** The handles that follow `@t`, in key order: each once, while its owner now wrote it. */
export async function followers(state, t, owners) {
  if (!isHandle(t)) return [];
  const found = await accountsBy(state, `followers/${t}/`);
  const hs = [...found.keys()];
  const now = await owners(hs);
  return hs.filter((h, i) => now[i] !== undefined && found.get(h).includes(now[i]));
}

/** `account`, owning `@h`, follows `@t`; nothing to write when its keys are there. */
export async function follow(state, account, h, t) {
  const keys = [followKey(h, t, account), followerKey(h, t, account)];
  if ((await state.get(keys[0])) !== undefined) return { actions: [] };
  return { actions: keys.map((key) => ({ key, newValue: "1" })) };
}

/** `account` deletes its keys for `@h` following `@t`; nothing to write when there are none. Others' keys stay. */
export async function unfollow(state, account, h, t) {
  const keys = [followKey(h, t, account), followerKey(h, t, account)];
  const oldValues = await Promise.all(keys.map((key) => state.get(key)));
  if (oldValues[0] === undefined) return { actions: [] };
  return { actions: keys.map((key, i) => ({ key, oldValue: oldValues[i] })) };
}

/**
 * What `account` is saving, from transaction bodies not yet in a block, by
 * `"<h>/<t>"`: `true` for a follow, `false` for an unfollow. A pending write
 * may still be dropped, so it is never a follow yet.
 */
export function pendingIn(bodies, account) {
  const found = {};
  for (const body of bodies) {
    // Anyone can put anything in a mempool: read only what is shaped as a body.
    if (!Array.isArray(body?.signers) || !body.signers.includes(account) || !Array.isArray(body.actions)) continue;
    for (const action of body.actions) {
      const [root, h, t, by, rest] = typeof action?.key === "string" ? action.key.split("/") : [];
      if (root === "follows" && by === account && rest === undefined && isHandle(h) && isHandle(t)) found[`${h}/${t}`] = action.newValue !== undefined;
    }
  }
  return found;
}
