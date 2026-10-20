// The follow graph's records. `<a>` follows `<b>` while `user/<a>/follows/<b>`
// exists, and only `<a>` may write or delete it (the chain's policy). Whom an
// account follows is one prefix read; who follows it is found by reading
// every follow, which is the whole chain.

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

/** Whether `follower` follows `followed`. */
export const follows = async (state, follower, followed) => (await state.get(followKey(follower, followed))) !== undefined;

/** The addresses `address` follows, in key order. */
export async function following(state, address) {
  const prefix = `user/${address}/follows/`;
  const found = [];
  for await (const [key] of state.list(prefix)) found.push(key.slice(prefix.length));
  return found;
}

/** The addresses that follow `address`, in key order. Reads every follow. */
export async function followers(state, address) {
  const suffix = `/follows/${address}`;
  const found = [];
  for await (const [key] of state.list("user/")) if (key.endsWith(suffix)) found.push(key.slice("user/".length, -suffix.length));
  return found;
}

/** `follower` follows `followed`; nothing to write when it already does. */
export async function follow(state, follower, followed) {
  if (!isAddress(followed)) throw new Error(`not an address: ${followed}`);
  if (await follows(state, follower, followed)) return { actions: [] };
  return { actions: [{ key: followKey(follower, followed), newValue: "1" }] };
}

/** `follower` stops following `followed`; nothing to write when it does not. */
export async function unfollow(state, follower, followed) {
  const key = followKey(follower, followed);
  const oldValue = await state.get(key);
  return { actions: oldValue === undefined ? [] : [{ key, oldValue }] };
}
