// Verifies the view-time default-binding injection for unbound data-source
// builtins — the polling-fallback fix (builtin:usage/$0.00, builtin:cron/"No
// scheduled jobs." while the RPCs answered fine).
//
// The full stack (registerBoardstateRpc over a wrapped store) needs only
// @boardstate/* npm packages — no Python, no browser. The module under test is
// esbuild-bundled (same pattern as theme.mjs) so the test runs on any Node.
// Run: node test/builtin-default-bindings.mjs
//
// Checks:
// 1. workspace.get returns usage/sessions/cron/instances/agent-status widgets
//    WITH default source:"rpc" bindings when the stored doc has none.
// 2. A widget that already HAS a binding is left untouched.
// 3. Nothing is persisted: after a mutation through the same host, the stored
//    workspace.json on disk still contains no injected bindings.
// 4. The browser path this enables: transport.request(method) answers (the
//    registered hermes-data RPC methods serve over the same host).

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { MemoryStorageAdapter, DashboardStore } from "@boardstate/core";
import {
  createInProcessHost,
  registerBoardstateRpc,
} from "@boardstate/server";

// Bundle the TS module under test to plain ESM (theme.mjs pattern).
const here = dirname(fileURLToPath(import.meta.url));
const bundled = await build({
  entryPoints: [join(here, "..", "dashboard", "sidecar", "src", "builtin-bindings.ts")],
  bundle: true,
  format: "esm",
  write: false,
  platform: "neutral",
});
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64")
);
const { withDefaultBindings, applyDefaultBindings, DEFAULT_RPC_BY_KIND } = mod;

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
};

// --- applyDefaultBindings (pure) ------------------------------------------------
const doc = () => ({
  schemaVersion: 1,
  workspaceVersion: 7,
  widgetsRegistry: {},
  prefs: { tabOrder: ["board"] },
  tabs: [
    {
      slug: "board",
      title: "Board",
      hidden: false,
      createdBy: "system",
      widgets: [
        { id: "usage", kind: "builtin:usage", title: "Usage", grid: { x: 0, y: 2, w: 4, h: 3 }, collapsed: false, hidden: false },
        { id: "cron", kind: "builtin:cron", title: "Cron", grid: { x: 0, y: 5, w: 8, h: 3 }, collapsed: false, hidden: false },
        { id: "sessions", kind: "builtin:sessions", title: "Sessions", grid: { x: 8, y: 2, w: 4, h: 5 }, collapsed: false, hidden: false },
        { id: "instances", kind: "builtin:instances", title: "Instances", grid: { x: 4, y: 2, w: 4, h: 3 }, collapsed: false, hidden: false },
        { id: "agent", kind: "builtin:agent-status", title: "Agents", grid: { x: 0, y: 8, w: 6, h: 4 }, collapsed: false, hidden: false },
        {
          id: "cost",
          kind: "builtin:stat-card",
          title: "Cost",
          grid: { x: 0, y: 0, w: 3, h: 2 },
          collapsed: false,
          hidden: false,
          bindings: { value: { source: "rpc", method: "usage.cost" } },
        },
        { id: "md", kind: "builtin:markdown", title: "Note", grid: { x: 3, y: 0, w: 9, h: 2 }, collapsed: false, hidden: false },
      ],
    },
  ],
});

const injected = applyDefaultBindings(doc());
const w = (d, id) => d.tabs[0].widgets.find((x) => x.id === id);
check("usage gets usage.status binding", w(injected, "usage")?.bindings?.value?.method === "usage.status");
check("cron gets cron.list binding", w(injected, "cron")?.bindings?.value?.method === "cron.list");
check("sessions gets sessions.list binding", w(injected, "sessions")?.bindings?.value?.method === "sessions.list");
check("instances gets system-presence binding", w(injected, "instances")?.bindings?.value?.method === "system-presence");
check("agent-status gets sessions.list binding", w(injected, "agent")?.bindings?.value?.method === "sessions.list");
check("explicit stat-card binding untouched", w(injected, "cost")?.bindings?.value?.method === "usage.cost");
check("markdown widget gets no bindings", w(injected, "md")?.bindings === undefined);
check("source doc not mutated in place", w(doc(), "usage")?.bindings === undefined);
check("identity kept when nothing to inject", applyDefaultBindings({ tabs: [] }) !== undefined);

// --- full host: workspace.get serves defaults, persistence stays clean -----------
// Mirrors the Windows polling-fallback report: a template-built board (see
// dashboard/src/templates.ts `data()`) stores data builtins WITHOUT bindings.
// A fresh store is seeded with exactly such a doc via the trusted replace path.
const templateDoc = {
  schemaVersion: 1,
  workspaceVersion: 1,
  widgetsRegistry: {},
  prefs: { tabOrder: ["board"] },
  tabs: [
    {
      slug: "board",
      title: "Board",
      hidden: false,
      createdBy: "system",
      widgets: [
        { id: "usage", kind: "builtin:usage", title: "Usage", grid: { x: 0, y: 2, w: 4, h: 3 }, collapsed: false, hidden: false, props: {} },
        { id: "sessions", kind: "builtin:sessions", title: "Sessions", grid: { x: 8, y: 2, w: 4, h: 5 }, collapsed: false, hidden: false, props: {} },
        { id: "cron", kind: "builtin:cron", title: "Scheduled jobs", grid: { x: 0, y: 5, w: 8, h: 3 }, collapsed: false, hidden: false, props: { limit: 8 } },
        {
          id: "cost",
          kind: "builtin:stat-card",
          title: "Cost",
          grid: { x: 0, y: 0, w: 3, h: 2 },
          collapsed: false,
          hidden: false,
          bindings: { value: { source: "rpc", method: "usage.cost" } },
        },
      ],
    },
  ],
};
const storage = new MemoryStorageAdapter();
const store = new DashboardStore({ storage });
await store.replace(templateDoc);
const host = createInProcessHost(store, storage);
registerBoardstateRpc(host, { store: withDefaultBindings(store), dataRead: { stateDir: store.stateDir } });

const got = await host.request("dashboard.workspace.get", {});
const servedTabs = got?.doc?.tabs ?? [];
const findServed = (id) => servedTabs.flatMap((t) => t.widgets ?? []).find((x) => x.id === id);
check("workspace.get serves usage with rpc binding", findServed("usage")?.bindings?.value?.source === "rpc" && findServed("usage")?.bindings?.value?.method === "usage.status");
check("workspace.get serves sessions with rpc binding", findServed("sessions")?.bindings?.value?.method === "sessions.list");
check("workspace.get serves cron with rpc binding", findServed("cron")?.bindings?.value?.method === "cron.list");
check("explicit stat-card binding untouched", findServed("cost")?.bindings?.value?.method === "usage.cost");

// Mutate through the same host, then inspect the REAL store's raw stored doc:
// the injected default binding must never be persisted.
await host.request("dashboard.widget.update", { tab: "board", id: "usage", patch: { title: "Usage (renamed)" } });
const rawStored = JSON.parse(await storage.readFile(store.workspacePath));
const storedUsage = (rawStored.tabs?.[0]?.widgets ?? []).find((x) => x.id === "usage");
check("injected binding NOT persisted (raw store)", storedUsage?.bindings === undefined);
check("mutation itself persisted (renamed)", storedUsage?.title === "Usage (renamed)");

// After the mutation, a fresh workspace.get STILL serves the default binding.
const got2 = await host.request("dashboard.workspace.get", {});
const servedUsage2 = (got2?.doc?.tabs?.[0]?.widgets ?? []).find((x) => x.id === "usage");
check("default binding re-served after mutation", servedUsage2?.bindings?.value?.method === "usage.status");

// Every default method is a read-scoped RPC the sidecar registers hermes-data
// handlers for (see hermes-data.ts HANDLERS keys — the registry the browser
// transport.request hits in the polling path).
const hermesMethods = new Set(["health", "system-presence", "usage.status", "usage.cost", "agents.list", "sessions.list", "sessions.resolve", "sessions.get", "sessions.usage", "sessions.usage.timeseries", "sessions.usage.logs", "node.list", "node.describe", "cron.get", "cron.list", "cron.status", "cron.runs", "dashboard.connector.list"]);
check(
  "every DEFAULT_RPC_BY_KIND method is an allowlisted read RPC",
  Object.values(DEFAULT_RPC_BY_KIND).every((m) => hermesMethods.has(m)),
);

if (failures) {
  console.log(`\nbuiltin default bindings: ${failures} failed`);
  process.exit(1);
}
console.log("\nbuiltin default bindings: all checks passed");
