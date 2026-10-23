// <follows-who address="…"> for any page: whatever it wraps, pressed, opens
// a small card about the account, the same in every app: your app's name and
// photo for it, the @handle it shows on Moniker (or its ID's tail), how many
// follow it and how many it follows, a Follow button, and links to its
// Moniker and Follows pages. Register it once with a graph from
// createFollows, and a reader of your app's own card:
//
//   defineWho(graph, { card: async (address) => ({ name, photo, bio }) });
//   <follows-who address="bafyrei…"><moniker-name address="bafyrei…" name="Dana" plain></moniker-name></follows-who>
//
// What it wraps is inside a button, so wrap a name without a link of its
// own (`plain` on <moniker-name>).
// `card` answers undefined for an account with no card in your app; `photo`
// is a URL. Card text is shown as text, with every @ dropped, so only a
// verified handle shows with an @. Style it from outside with the
// --follows-* properties the button takes, and --follows-surface for the
// card's backdrop.

import { defineFollowButton } from "./element.mjs";

const FOLLOWS_APP = "https://adalinxx.github.io/follows/app/";

const style = `
  :host { display: inline; }
  .open { all: unset; cursor: pointer; display: inline; border-radius: 4px; }
  .open:focus-visible { outline: 2px solid var(--follows-accent, #3346D3); outline-offset: 2px; }
  [popover] { margin: 0; inset: auto; position: fixed; box-sizing: border-box; width: min(20em, calc(100vw - 32px)); padding: 16px;
    border: 1px solid var(--follows-line, #c9ccd4); border-radius: 12px; background: var(--follows-surface, Canvas); color: var(--follows-ink, CanvasText);
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.16); font: inherit; text-align: start; }
  .top { display: flex; gap: 12px; align-items: center; }
  .photo { flex: none; width: 48px; height: 48px; border-radius: 50%; object-fit: cover; background: var(--follows-line, #c9ccd4);
    display: inline-flex; align-items: center; justify-content: center; font-weight: 700; overflow: hidden; }
  .names { min-width: 0; display: flex; flex-direction: column; }
  .name { font-weight: 700; overflow-wrap: anywhere; }
  .handle { color: var(--follows-accent, #3346D3); font-family: ui-monospace, monospace; font-size: 0.9em; }
  .id { color: var(--follows-muted, #5f6470); font-family: ui-monospace, monospace; font-size: 0.9em; }
  .bio { margin: 12px 0 0; overflow-wrap: anywhere; }
  .counts { margin: 12px 0; display: flex; gap: 16px; font-size: 0.9em; color: var(--follows-muted, #5f6470); }
  .counts b { color: var(--follows-ink, CanvasText); }
  .links { margin: 12px 0 0; display: flex; gap: 16px; font-size: 0.85em; }
  .links a { color: inherit; }
  [data-follow] { --follows-width: 100%; }
  [data-follow]:not([hidden]) { display: flex; }
`;

/** Card text as text: every @ (and its look-alikes) and invisible control dropped, as Moniker's displayName does. */
const plain = (text) => String(text ?? "").replace(/[@\uFF20\uFE6B\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, "").trim();

export function defineWho(graph, { tag = "follows-who", card = async () => undefined, buttonTag = "follows-button", followsURL = FOLLOWS_APP } = {}) {
  if (customElements.get(tag)) return;
  defineFollowButton(graph, { tag: buttonTag });

  customElements.define(
    tag,
    class extends HTMLElement {
      static observedAttributes = ["address"];
      #open;
      #panel;
      #drawn = 0;
      constructor() {
        super();
        const root = this.attachShadow({ mode: "open" });
        this.#open = Object.assign(document.createElement("button"), { type: "button", className: "open" });
        this.#open.append(document.createElement("slot"));
        this.#open.setAttribute("aria-haspopup", "dialog");
        this.#open.setAttribute("aria-expanded", "false");
        this.#panel = document.createElement("div");
        this.#panel.popover = "auto";
        this.#panel.setAttribute("role", "dialog");
        root.append(Object.assign(document.createElement("style"), { textContent: style }), this.#open, this.#panel);
        // The button toggles the card natively, so a press on it while open closes it, not reopens it.
        this.#open.popoverTargetElement = this.#panel;
        // Closed with focus inside (Escape, or a press on it), focus goes back to what opened it.
        this.#panel.addEventListener("beforetoggle", (event) => {
          if (event.newState === "closed") this.#refocus = this.#panel.contains(this.shadowRoot.activeElement);
        });
        this.#panel.addEventListener("toggle", (event) => {
          const open = event.newState === "open";
          this.#open.setAttribute("aria-expanded", String(open));
          if (open) {
            addEventListener("resize", this.#onResize);
            this.#place();
            this.#fill();
            return;
          }
          removeEventListener("resize", this.#onResize);
          this.#drawn++;
          const away = document.activeElement;
          if (this.#refocus && (!away || away === document.body || away === this)) this.#open.focus();
          this.#refocus = false;
        });
      }
      #refocus = false;
      #onResize = () => this.#place();
      disconnectedCallback() {
        removeEventListener("resize", this.#onResize);
      }
      attributeChangedCallback() {
        if (this.#panel.matches(":popover-open")) this.#fill();
      }
      /** Below what it wraps, or above when there's no room, kept on screen. */
      #place() {
        const at = this.#open.getBoundingClientRect();
        const { width, height } = this.#panel.getBoundingClientRect();
        const left = Math.max(16, Math.min(at.left, innerWidth - width - 16));
        const below = at.bottom + 8;
        const top = below + height > innerHeight - 16 && at.top - height - 8 > 16 ? at.top - height - 8 : below;
        Object.assign(this.#panel.style, { left: `${left}px`, top: `${top}px` });
      }
      async #fill() {
        const ticket = ++this.#drawn;
        const address = this.getAttribute("address") ?? "";
        this.#panel.replaceChildren(Object.assign(document.createElement("p"), { textContent: "Loading…" }));
        const [who, mine, counts] = await Promise.all([
          graph.person(address).catch(() => ({ account: address })),
          Promise.resolve().then(() => card(address)).catch(() => undefined),
          graph.counts(address).catch(() => undefined),
        ]);
        if (ticket !== this.#drawn) return;
        const el = (name, props = {}, ...children) => {
          const node = Object.assign(document.createElement(name), props);
          node.append(...children);
          return node;
        };
        const name = plain(mine?.name);
        const photo = mine?.photo
          ? el("img", { className: "photo", src: mine.photo, alt: "" })
          : el("span", { className: "photo", ariaHidden: "true", textContent: (name || who.handle || "?").charAt(0).toUpperCase() });
        const label = who.handle === undefined
          ? el("span", { className: "id", textContent: `…${address.slice(-4)}` })
          : el("span", { className: "handle", textContent: `@${who.handle}` });
        const names = el("div", { className: "names" }, ...(name ? [el("span", { className: "name", textContent: name })] : []), label);
        const heading = name || (who.handle === undefined ? `Account …${address.slice(-4)}` : `@${who.handle}`);
        this.#panel.setAttribute("aria-label", heading);
        const parts = [el("div", { className: "top" }, photo, names)];
        if (mine?.bio) parts.push(el("p", { className: "bio", textContent: plain(mine.bio) }));
        if (counts) {
          const count = (n, one, many) => el("span", {}, el("b", { textContent: n.toLocaleString("en-US") }), ` ${n === 1 ? one : many}`);
          parts.push(el("p", { className: "counts" }, count(counts.followers, "follower", "followers"), count(counts.following, "following", "following")));
        }
        const button = document.createElement(buttonTag);
        button.setAttribute("target", address);
        button.dataset.follow = "";
        parts.push(button);
        const page = who.handle === undefined ? address : `@${who.handle}`;
        const links = [el("a", { href: `${followsURL}#/${encodeURIComponent(page)}`, target: "_blank", rel: "noopener", textContent: "Follows page" })];
        if (who.handle !== undefined && graph.moniker?.pageURL) {
          links.push(el("a", { href: graph.moniker.pageURL(`@${who.handle}`), target: "_blank", rel: "noopener", textContent: "Moniker page" }));
        }
        parts.push(el("p", { className: "links" }, ...links));
        this.#panel.replaceChildren(...parts);
        this.#place();
      }
    },
  );
}
