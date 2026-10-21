// The follow graph's records. An account follows a target: another account,
// by its address, or a name, a Moniker handle written `@<h>`, which means
// whoever holds it now, so a name's followers go with it when it changes
// hands. Account `<a>` follows `<t>` while two keys exist,
// `user/<a>/follows/<t>` and its twin `followers/<t>/<a>`, so that both ends
// are one prefix read. Only `<a>` may write them, and always together (the
// chain's policy).
//
// Targets come out as stored: an address, or `@` and a handle. They go in the
// same way, and a bare handle is taken as a name (an address is never one).

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

/** Whether `handle` is one Moniker and the policy accept: lowercase letters, digits and `_`. */
export const isHandle = (handle) => typeof handle === "string" && /^[a-z0-9_]+$/.test(handle);

/** Whether `target` is a name: `@` and a handle. */
export const isName = (target) => typeof target === "string" && target.startsWith("@") && isHandle(target.slice(1));

/** `target` as stored: an address, or `@` and a handle; throws when it is neither. */
export function target(text) {
  const t = String(text);
  if (isAddress(t) || isName(t)) return t;
  if (isHandle(t)) return `@${t}`;
  throw new Error(`not an account or a name: ${text}`);
}

export const followKey = (follower, followed) => `user/${follower}/follows/${target(followed)}`;
export const followerKey = (follower, followed) => `followers/${target(followed)}/${follower}`;

/** Whether account `follower` follows `followed`. */
export const follows = async (state, follower, followed) => (await state.get(followKey(follower, followed))) !== undefined;

/** What account `address` follows, in key order: `@` names, then addresses. */
export async function following(state, address) {
  const prefix = `user/${address}/follows/`;
  const found = [];
  for await (const [key] of state.list(prefix)) found.push(key.slice(prefix.length));
  return found;
}

/** The accounts that follow `followed`, in key order. */
export async function followers(state, followed) {
  const prefix = `followers/${target(followed)}/`;
  const found = [];
  for await (const [key] of state.list(prefix)) found.push(key.slice(prefix.length));
  return found;
}

/** Account `follower` follows `followed`; nothing to write when it already does. */
export async function follow(state, follower, followed) {
  if (await follows(state, follower, followed)) return { actions: [] };
  return { actions: [followKey, followerKey].map((key) => ({ key: key(follower, followed), newValue: "1" })) };
}

/** Account `follower` stops following `followed`; nothing to write when it does not. */
export async function unfollow(state, follower, followed) {
  const keys = [followKey(follower, followed), followerKey(follower, followed)];
  const oldValues = await Promise.all(keys.map((key) => state.get(key)));
  if (oldValues[0] === undefined) return { actions: [] };
  return { actions: keys.map((key, i) => ({ key, oldValue: oldValues[i] })) };
}

/**
 * What `follower` is saving, from transaction bodies not yet in a block:
 * `{ target: true }` for a follow, `{ target: false }` for an unfollow. A
 * pending write may still be dropped, so it is never a follow yet.
 */
export function pendingIn(bodies, follower) {
  const prefix = `user/${follower}/follows/`;
  const found = {};
  for (const body of bodies) {
    if (!body?.signers?.includes(follower)) continue;
    for (const { key, newValue } of body.actions ?? []) if (key.startsWith(prefix)) found[key.slice(prefix.length)] = newValue !== undefined;
  }
  return found;
}
