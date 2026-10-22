// The page's pure parts: what was typed into the search box, and which
// profiles a filter keeps.
import { isProfileId } from "../src/index.mjs";

const HANDLE = /^[a-z0-9_]+$/;

/**
 * Whom the search box names: `{ id }` for a profile id as typed, else
 * `{ handle }`, or null. A @ makes it a handle, even one shaped like an id.
 */
export function parseWho(text) {
  const typed = String(text ?? "").trim();
  if (isProfileId(typed)) return { id: typed };
  const handle = typed.replace(/^@/, "").toLowerCase();
  return HANDLE.test(handle) ? { handle } : null;
}

/** Whether a filter keeps a profile: its name, @handle or id contains the query. */
export function matches(profile, query) {
  const q = String(query ?? "").trim().toLowerCase().replace(/^@/, "");
  if (q === "") return true;
  return [profile.name, profile.handle, profile.id].some((field) => typeof field === "string" && field.toLowerCase().includes(q));
}

/** `1 follower`, `2 followers`, `1,204 following`. */
export const count = (n, one, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
