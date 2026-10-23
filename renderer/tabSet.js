// TabSet: the order of a window's tabs, which one is active and the recently
// closed ones. Only ids; no DOM. The window shell maps ids to its tabs.

const CLOSED_LIMIT = 25;

export class TabSet {
  #ids = [];
  #active = null;
  #closed = [];

  get size() {
    return this.#ids.length;
  }

  get activeId() {
    return this.#active;
  }

  ids() {
    return [...this.#ids];
  }

  add(id, { index = this.#ids.length, activate = true } = {}) {
    this.#ids.splice(Math.max(0, Math.min(index, this.#ids.length)), 0, id);
    if (activate || this.#active === null) this.#active = id;
  }

  // Returns the new active id: the right neighbour of a removed active tab,
  // else its left one. Removing another tab keeps the active one.
  remove(id) {
    const i = this.#ids.indexOf(id);
    if (i < 0) return this.#active;
    this.#ids.splice(i, 1);
    if (id === this.#active) this.#active = this.#ids[i] ?? this.#ids[i - 1] ?? null;
    return this.#active;
  }

  move(id, toIndex) {
    const i = this.#ids.indexOf(id);
    if (i < 0) return;
    this.#ids.splice(i, 1);
    this.#ids.splice(Math.max(0, Math.min(toIndex, this.#ids.length)), 0, id);
  }

  activate(id) {
    if (!this.#ids.includes(id)) return false;
    this.#active = id;
    return true;
  }

  // The tab `step` places from the active one, wrapping around.
  next(step) {
    const n = this.#ids.length;
    if (!n) return null;
    const i = this.#ids.indexOf(this.#active);
    return this.#ids[(((i + step) % n) + n) % n];
  }

  nth(n) {
    return this.#ids[n - 1] ?? null;
  }

  last() {
    return this.#ids.at(-1) ?? null;
  }

  othersOf(id) {
    return this.#ids.filter((x) => x !== id);
  }

  rightOf(id) {
    const i = this.#ids.indexOf(id);
    return i < 0 ? [] : this.#ids.slice(i + 1);
  }

  pushClosed(entry) {
    this.#closed.push(entry);
    if (this.#closed.length > CLOSED_LIMIT) this.#closed.shift();
  }

  popClosed() {
    return this.#closed.pop() ?? null;
  }
}
