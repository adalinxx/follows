// The follow graph's records. A profile follows a profile: both are Moniker
// profiles, by id. Account `<a>`, acting for profile `<p>`, follows profile
// `<t>` with two keys, `follows/<p>/<t>/<a>` and its twin
// `followers/<t>/<p>/<a>`, so that both ends are one prefix read. Only `<a>`
// may write them, and always together (the chain's policy).
//
// The chain can't see Moniker, so readers decide: a follow counts while its
// account acts for `<p>` now (owns it, or is its admin), as checked by an
// `actsFor(account, p)` the reader passes in. When a profile changes hands,
// the old owner's follows lapse, and the new owner writes their own.

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

/** Whether `text` is a Moniker profile id: 16 characters of `a`–`z` and `2`–`7`. */
export const isProfileId = (text) => typeof text === "string" && /^[a-z2-7]{16}$/.test(text);

/** Throws unless `p` and `t` are profile ids. */
function profiles(p, t) {
  for (const id of [p, t]) if (!isProfileId(id)) throw new Error(`not a profile: ${id}`);
}

export const followKey = (p, t, account) => (profiles(p, t), `follows/${p}/${t}/${account}`);
export const followerKey = (p, t, account) => (profiles(p, t), `followers/${t}/${p}/${account}`);

/** The keys under `prefix`, `<prefix><id>/<account>`, as a map from id to its accounts, in key order. */
async function accountsBy(state, prefix) {
  const found = new Map();
  for await (const [key] of state.list(prefix)) {
    const [id, account] = key.slice(prefix.length).split("/");
    found.set(id, [...(found.get(id) ?? []), account]);
  }
  return found;
}

/** `actsFor`, asked once per account and profile. */
function remembered(actsFor) {
  const asked = new Map();
  return (account, p) => {
    const key = `${account}/${p}`;
    if (!asked.has(key)) asked.set(key, actsFor(account, p));
    return asked.get(key);
  };
}

/** Whether any of `accounts` acts for profile `p` now. */
const anyActs = async (accounts, p, actsFor) => (await Promise.all(accounts.map((a) => actsFor(a, p)))).includes(true);

/** The ids in `found` (from accountsBy) whose follow counts: `profileOf(id)` is the following profile. */
async function counted(found, profileOf, actsFor) {
  const acts = remembered(actsFor);
  const ids = [...found.keys()];
  const keep = await Promise.all(ids.map((id) => anyActs(found.get(id), profileOf(id), acts)));
  return ids.filter((_, i) => keep[i]);
}

/** Whether profile `p` follows profile `t`: some account that wrote it acts for `p` now. */
export async function follows(state, p, t, actsFor) {
  profiles(p, t);
  const prefix = `follows/${p}/${t}/`;
  const accounts = [];
  for await (const [key] of state.list(prefix)) accounts.push(key.slice(prefix.length));
  return anyActs(accounts, p, actsFor);
}

/** The profiles `p` follows, in key order. */
export const following = async (state, p, actsFor) => counted(await accountsBy(state, `follows/${p}/`), () => p, actsFor);

/** The profiles that follow `t`, in key order: each once, however many accounts wrote it. */
export const followers = async (state, t, actsFor) => counted(await accountsBy(state, `followers/${t}/`), (p) => p, actsFor);

/** `account`, acting for profile `p`, follows `t`; nothing to write when its keys are there. */
export async function follow(state, account, p, t) {
  const keys = [followKey(p, t, account), followerKey(p, t, account)];
  if ((await state.get(keys[0])) !== undefined) return { actions: [] };
  return { actions: keys.map((key) => ({ key, newValue: "1" })) };
}

/** `account` deletes its keys for `p` following `t`; nothing to write when there are none. Others' keys stay. */
export async function unfollow(state, account, p, t) {
  const keys = [followKey(p, t, account), followerKey(p, t, account)];
  const oldValues = await Promise.all(keys.map((key) => state.get(key)));
  if (oldValues[0] === undefined) return { actions: [] };
  return { actions: keys.map((key, i) => ({ key, oldValue: oldValues[i] })) };
}

/**
 * What `account` is saving, from transaction bodies not yet in a block, by
 * `"<p>/<t>"`: `true` for a follow, `false` for an unfollow. A pending write
 * may still be dropped, so it is never a follow yet.
 */
export function pendingIn(bodies, account) {
  const found = {};
  for (const body of bodies) {
    // Anyone can put anything in a mempool: read only what is shaped as a body.
    if (!Array.isArray(body?.signers) || !body.signers.includes(account) || !Array.isArray(body.actions)) continue;
    for (const action of body.actions) {
      const [root, p, t, by, rest] = typeof action?.key === "string" ? action.key.split("/") : [];
      if (root === "follows" && by === account && rest === undefined && isProfileId(p) && isProfileId(t)) found[`${p}/${t}`] = action.newValue !== undefined;
    }
  }
  return found;
}
