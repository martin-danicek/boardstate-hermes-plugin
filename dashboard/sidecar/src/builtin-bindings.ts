// View-time default bindings for the data-source builtins.
//
// The board's data widgets (usage / sessions / cron / instances / agent-status)
// ship WITHOUT explicit `bindings` in every seeded doc and template — the intent
// (see templates.ts) was always that they "self-bind" to their Hermes RPC. That
// self-bind only existed as the RPC handlers `registerHermesDataRpc` registers;
// nothing ever attached a binding to the widget, so the view's `ensureBindings`
// skipped it entirely (primaryBinding() === null ⇒ no fetch ⇒ empty state) —
// most visible in the desktop polling fallback, where it left builtin:usage at
// $0.00/0 and builtin:cron at "No scheduled jobs." even though the RPCs answered.
//
// This module closes that gap WITHOUT touching the stored doc: `withDefaultBindings`
// wraps a DashboardStore so `read()` returns the doc with default `source:"rpc"`
// bindings attached to unbound data-source widgets. Because DashboardStore.mutate()
// reads through `this.read()` — and the wrapper delegates mutations to the REAL
// store — an injected binding is never persisted: a mutation validates the draft
// (injected bindings are schema-valid), writes the real store, and the injected
// bindings simply re-appear on the next read.
//
// A widget that already carries ANY binding is left untouched (explicit author
// intent wins). Binding IDs are stable ("value"), so the view caches/refreshes
// them exactly like hand-authored ones, and the methods are the read-scoped RPCs
// `registerHermesDataRpc` serves (or their unavailable-stubs outside a dashboard).

import type { DashboardStore } from "@boardstate/core";

type Widget = {
  id?: unknown;
  kind?: unknown;
  bindings?: unknown;
  [key: string]: unknown;
};

/** The default read method per data-source builtin kind (SPEC data shapes). */
export const DEFAULT_RPC_BY_KIND: Record<string, string> = {
  "builtin:usage": "usage.status",
  "builtin:sessions": "sessions.list",
  "builtin:cron": "cron.list",
  "builtin:instances": "system-presence",
  "builtin:agent-status": "sessions.list",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when the widget has at least one usable binding entry. */
function hasBinding(widget: Widget): boolean {
  return isRecord(widget.bindings) && Object.keys(widget.bindings).length > 0;
}

/**
 * Attach default rpc bindings to unbound data-source widgets, shallow-cloning
 * only the tabs/widgets that actually change. Returns the same doc object when
 * nothing changes (identity keeps cheap equality paths cheap).
 */
export function applyDefaultBindings(doc: unknown): unknown {
  if (!isRecord(doc) || !Array.isArray(doc.tabs)) return doc;
  let changed = false;
  const tabs = doc.tabs.map((tab) => {
    if (!isRecord(tab) || !Array.isArray(tab.widgets)) return tab;
    let tabChanged = false;
    const widgets = tab.widgets.map((widget) => {
      if (!isRecord(widget) || typeof widget.kind !== "string") return widget;
      const method = DEFAULT_RPC_BY_KIND[widget.kind];
      if (!method || hasBinding(widget as Widget)) return widget;
      tabChanged = true;
      return {
        ...widget,
        bindings: { value: { source: "rpc", method } },
      };
    });
    if (!tabChanged) return tab;
    changed = true;
    return { ...tab, widgets };
  });
  if (!changed) return doc;
  return { ...doc, tabs };
}

type StoreLike = DashboardStore & {
  read: () => Promise<unknown>;
};

/**
 * Wrap a store so `read()` injects default bindings (view-only); everything
 * else — mutate, replace, undo, stateDir, workspacePath — is the real store,
 * so persistence never sees an injected binding.
 */
export function withDefaultBindings<T extends StoreLike>(store: T): T {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "read") {
        return async () => applyDefaultBindings(await target.read());
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}
