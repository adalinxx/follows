// The follow graph's records. An account follows a name: a Moniker handle,
// which means whoever holds it now, so a name's followers go with it when it
// changes hands. Account `<a>` follows `@<h>` while two keys exist,
// `user/<a>/follows/@<h>` and its twin `followers/@<h>/<a>`, so that both ends
// are one prefix read. Only `<a>` may write them, and always together (the
// chain's policy).
//
// Handles go in and come out as Moniker spells them, without the `@`; one
// given with its `@` is taken too.

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

/** `handle` without its `@`; throws when it is not a handle. */
function name(handle) {
  const h = String(handle).replace(/^@/, "");
  if (!isHandle(h)) throw new Error(`not a handle: ${handle}`);
  return h;
}

export const followKey = (follower, handle) => `user/${follower}/follows/@${name(handle)}`;
export const followerKey = (follower, handle) => `followers/@${name(handle)}/${follower}`;

/** Whether account `follower` follows `handle`. */
export const follows = async (state, follower, handle) => (await state.get(followKey(follower, handle))) !== undefined;

/** The handles account `address` follows, in key order. */
export async function following(state, address) {
  const prefix = `user/${address}/follows/@`;
  const found = [];
  for await (const [key] of state.list(prefix)) found.push(key.slice(prefix.length));
  return found;
}

/** The accounts that follow `handle`, in key order. */
export async function followers(state, handle) {
  const prefix = `followers/@${name(handle)}/`;
  const found = [];
  for await (const [key] of state.list(prefix)) found.push(key.slice(prefix.length));
  return found;
}

/** Account `follower` follows `handle`; nothing to write when it already does. */
export async function follow(state, follower, handle) {
  if (await follows(state, follower, handle)) return { actions: [] };
  return { actions: [followKey, followerKey].map((key) => ({ key: key(follower, handle), newValue: "1" })) };
}

/** Account `follower` stops following `handle`; nothing to write when it does not. */
export async function unfollow(state, follower, handle) {
  const keys = [followKey(follower, handle), followerKey(follower, handle)];
  const oldValues = await Promise.all(keys.map((key) => state.get(key)));
  if (oldValues[0] === undefined) return { actions: [] };
  return { actions: keys.map((key, i) => ({ key, oldValue: oldValues[i] })) };
}
