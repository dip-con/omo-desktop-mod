// Runs a loader bundle in a vm context with a tiny fake DOM: selectors present on the page are a Set the test edits,
// MutationObservers fire on mutate(), and every __omoModsCall payload is recorded in sent.
import vm from 'node:vm';

function element(tag) {
  const attrs = new Map();
  const listeners = new Map();
  return {
    tagName: tag, style: {}, textContent: '', hidden: false, disabled: false,
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => attrs.get(k) ?? null,
    removeAttribute: (k) => attrs.delete(k),
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    dispatch: (type, ev) => (listeners.get(type) ?? []).forEach((fn) => fn(ev)),
  };
}

export function fakePage(bundle, { pathname = '/', present = ['#root'], rootChildren = 1, readyState = 'complete' } = {}) {
  const selectors = new Set(present);
  const observers = new Set();
  const styles = [];
  const modRoots = [];
  const winListeners = new Map();
  const sent = [];
  const timers = new Map();
  let timerId = 0;
  const body = { children: [], appendChild: (el) => body.children.push(el) };
  const document = {
    readyState,
    head: { appendChild: (el) => styles.push(el) },
    body,
    createElement: element,
    getElementById: (id) => (id === 'root' && selectors.has('#root') ? { childElementCount: rootChildren } : null),
    querySelector(sel) {
      const style = /^style\[data-omo-mod="(.+)"\]$/.exec(sel);
      if (style) return styles.find((s) => s.getAttribute('data-omo-mod') === style[1]) ?? null;
      return selectors.has(sel) ? {} : null;
    },
    querySelectorAll(sel) {
      const id = /^\[data-omo-mod-root="(.+)"\]$/.exec(sel)?.[1];
      return modRoots.filter((r) => r.getAttribute('data-omo-mod-root') === id);
    },
  };
  class MutationObserver {
    constructor(fn) {
      this.fn = fn;
    }
    observe() {
      observers.add(this);
    }
    disconnect() {
      observers.delete(this);
    }
  }
  const context = {
    document,
    location: { pathname },
    MutationObserver,
    setTimeout: (fn, ms) => (timers.set(++timerId, { fn, ms }), timerId),
    clearTimeout: (id) => timers.delete(id),
    Map,
    JSON,
    Promise,
    Error,
    String,
    addEventListener: (type, fn) => winListeners.set(type, [...(winListeners.get(type) ?? []), fn]),
    removeEventListener: () => {},
    __omoModsCall: (payload) => sent.push(JSON.parse(payload)),
  };
  context.window = context;
  vm.createContext(context);
  return {
    window: context,
    document,
    sent,
    styles,
    badge: () => body.children.find((c) => c.id === 'omo-mods-badge'),
    run: () => vm.runInContext(bundle, context),
    addRoot(id) {
      const el = element('div');
      el.setAttribute('data-omo-mod-root', id);
      modRoots.push(el);
      return el;
    },
    setPresent(sel, on) {
      if (on) selectors.add(sel);
      else selectors.delete(sel);
    },
    // Fires every pending timer whose delay is ms (all timers when ms is omitted).
    runTimers(ms) {
      for (const [id, t] of [...timers]) {
        if (ms !== undefined && t.ms !== ms) continue;
        timers.delete(id);
        t.fn();
      }
    },
    mutate: () => [...observers].forEach((o) => o.fn([])),
    fire: (type, ev) => (winListeners.get(type) ?? []).forEach((fn) => fn(ev)),
    controls: (method) => sent.filter((m) => m.id === 0 && m.method === method),
  };
}
