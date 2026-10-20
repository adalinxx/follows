// The follow graph's records. `<a>` follows `<b>` while two keys exist,
// `user/<a>/follows/<b>` and its twin `followers/<b>/<a>`, so that both ends
// are one prefix read. Only `<a>` may write them, and always together (the
// chain's policy).

/**
 * Whether `text` is an account address in its one canonical spelling, as the
 * policy checks it.
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

export const followKey = (follower, followed) => `user/${follower}/follows/${followed}`;
export const followerKey = (follower, followed) => `followers/${followed}/${follower}`;

/** Whether `follower` follows `followed`. */
export const follows = async (state, follower, followed) => (await state.get(followKey(follower, followed))) !== undefined;

/** The addresses `address` follows, in key order. */
export async function following(state, address) {
  const prefix = `user/${address}/follows/`;
  const found = [];
  for await (const [key] of state.list(prefix)) found.push(key.slice(prefix.length));
  return found;
}

/** The addresses that follow `address`, in key order. */
export async function followers(state, address) {
  const prefix = `followers/${address}/`;
  const found = [];
  for await (const [key] of state.list(prefix)) found.push(key.slice(prefix.length));
  return found;
}

/** `follower` follows `followed`; nothing to write when it already does. */
export async function follow(state, follower, followed) {
  if (!isAddress(followed)) throw new Error(`not an address: ${followed}`);
  if (await follows(state, follower, followed)) return { actions: [] };
  return { actions: [followKey, followerKey].map((key) => ({ key: key(follower, followed), newValue: "1" })) };
}

/** `follower` stops following `followed`; nothing to write when it does not. */
export async function unfollow(state, follower, followed) {
  const keys = [followKey(follower, followed), followerKey(follower, followed)];
  const oldValues = await Promise.all(keys.map((key) => state.get(key)));
  if (oldValues[0] === undefined) return { actions: [] };
  return { actions: keys.map((key, i) => ({ key, oldValue: oldValues[i] })) };
}
