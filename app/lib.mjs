// The page's pure parts: what was typed into the search box, which people a
// filter keeps, and how an account is labeled.
import { isAddress } from "../src/index.mjs";

const HANDLE = /^[a-z0-9_]+$/;

/** Whom the search box names: `{ address }`, `{ handle }`, or null. */
export function parseWho(text) {
  const typed = String(text ?? "").trim();
  if (isAddress(typed)) return { address: typed };
  const handle = typed.replace(/^@/, "").toLowerCase();
  return HANDLE.test(handle) ? { handle } : null;
}

/** Whether a filter keeps a profile: its name, @handle or address contains the query. */
export function matches(profile, query) {
  const q = String(query ?? "").trim().toLowerCase().replace(/^@/, "");
  if (q === "") return true;
  return [profile.name, profile.handle, profile.address].some((field) => typeof field === "string" && field.toLowerCase().includes(q));
}

/** What to call an account: its name, else @handle, else that it has no name. */
export const label = (profile) => profile.name ?? (profile.handle ? `@${profile.handle}` : "Unnamed account");

/** `1 follower`, `2 followers`, `1,204 following`. */
export const count = (n, one, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
