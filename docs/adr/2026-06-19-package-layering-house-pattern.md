# ADR-0018: Package layering — the four house rules for orden packages

**Date:** 2026-06-19
**Status:** accepted

## Context

The workspace splits into generic, reusable packages (`outliner`, `chat-core`,
`chat-ui`, `annotation-core`, `workflows`), the `host-api` spine (ADR-0004), and the
apps that consume them. A consistent layering discipline already governed the chat and
annotation packages — but it lived only in their code and doc comments, nowhere a new
package author would look. So the same package could drift either way: a package
advertised as "framework-agnostic" quietly baking in orden domain knowledge, or a
downstream package reaching past `host-api` straight into a generic one.

Both failure modes had actually happened. `@orden/outliner` — whose README called it
framework-agnostic — had hardcoded orden's kanban lifecycle (`CardState`,
`LIFECYCLE_ORDER`, `COMPLETE_TTL_MS`, `STATE_LABELS`, a literal "Kanban" header), and
the same board position carried three different names across packages (`SessionState` /
`LifecycleState`+`CardState` / `StageRole`). The on-hold + lifecycle-config work
(`docs/plans/2026-06-19-on-hold-and-lifecycle-config.md`) fixed those by conforming
`outliner` / `workflows` / `host-api` to the rules the chat and annotation packages
already followed.

This ADR writes the rules down so conformance is deliberate, not rediscovered each
time. It records an existing pattern; it does not propose a new mechanism.

## Decision

Four rules govern how orden packages depend on each other. Dependency direction is
strictly one-way — **generic package → `host-api` → app**, with extension packages
(`workflows`, `chat-core`) feeding into `host-api`. Nothing flows back up.

### Rule 1 — Generic packages depend on nothing orden-specific

A package meant to be reusable must not import orden domain knowledge or bake it into
its types. It exposes generic primitives parameterised by the caller.

- `@orden/outliner` exposes `Card<T>`, `Column<T>` (`packages/outliner/src/types.ts:23`),
  and `buildBoard<T>` / `renderBoard` (`packages/outliner/src/index.ts:22`) — the board
  mechanics with the card payload (the lane identity) left as a type parameter. A grep
  of `packages/outliner/src` for orden policy constants (`CardState`, `LIFECYCLE_ORDER`,
  `COMPLETE_TTL_MS`, `STATE_LABELS`, `isExpiredComplete`) now matches **zero**: that
  board policy moved into the host (`host-api/src/index.ts:556` notes the move). The
  lifecycle is received as data, never imported.
- `chat-core`'s `ChatVault` (`packages/chat-core/src/index.ts:149`) is a four-method
  structural port (`get` / `set` / `list` / `delete`) — "structurally identical to
  host-api's `VaultStore`, but declared here so chat-core has no host-api dep."

### Rule 2 — `host-api` is the foundation: it owns the defaults and consumes extensions

`host-api` is the single seam the apps depend on. It holds the runtime DEFAULTS and is
the CONSUMER of the extension packages — it imports their types and **re-exports** them,
so downstream code reads the vocabulary from `host-api` and never imports the extension
package directly.

- The original instance: `host-api` does `export * from "@orden/chat-core"`, so the web
  app gets the chat model through the spine.
- The lifecycle now mirrors it exactly. `packages/host-api/src/index.ts:12-28` imports
  `DEFAULT_LIFECYCLE`, `Lane`, `Role`, `LaneDef`, `LifecycleConfig` from
  `@orden/workflows` and re-exports them, then exposes `Host.lifecycle(): LifecycleConfig`
  (`:471`) so callers read a resolved config from the host rather than reaching into
  `workflows`. The file header states the rule: host-api "CONSUMES it … downstream
  packages import the lifecycle types from host-api and never touch `@orden/workflows`
  directly."
- The seam also covers the DOM-free outliner helpers: `host-api` re-exports `journalKey`
  (`:35`) and `fromMarkdown` / `toMarkdown` (`:36`). Because of that, `@orden/mcp`
  dropped its direct `@orden/outliner` dependency entirely and reads `journalKey` from
  the spine (`packages/mcp/src/tools.ts:6-9`) — a layering leak closed by routing the
  generic helper through the re-export point instead of deep-importing past it.

### Rule 3 — One vocabulary per concept; display labels layer on top

Each concept gets exactly one identity vocabulary. Presentation (labels, ordering,
display copy) layers on top as data — never folded into the identity, never duplicated
per consumer.

- The board lifecycle splits into two deliberately separate concepts (`packages/workflows/src/lifecycle.ts`):
  `Role` (`"initial" | "active" | "waiting" | "terminal"` — the closed, four-way
  classification a workflow step projects onto, `:25`) and `Lane` (the OPEN set of where
  a card actually *is*; workflows can declare custom lanes, and `on-hold` is a manual,
  role-less lane). `LaneDef` carries `label` as "Presentation, not identity" (`:51-52`);
  the role↔lane correspondence is explicit DATA in `LifecycleConfig`, not two parallel
  enums that happen to line up.
- The display labels live once, in `DEFAULT_LIFECYCLE.lanes[*].label`
  (`packages/workflows/src/lifecycle.ts:98`). The web derives its label map from that
  config (`apps/web/src/lifecycle.ts`), collapsing the `STATE_LABELS` copies that
  previously sat in both the outliner and the web.
- `annotation-core` keeps the W3C Web Annotation Data Model types unprefixed (`Source`,
  `Selector`, `TextQuoteSelector`) and namespaces the orden conversational superset under
  an `orden:` prefix (`orden:status`, `orden:audience`, `orden:thread`) — domain
  knowledge sits beside the standard, not smeared into it (ADR-0011;
  `packages/annotation-core/src/wadm.ts`).

### Rule 4 — Params, not imports, across layers

When a lower layer needs something a higher layer owns, the higher layer **passes it in
as a parameter**, rather than the lower layer importing upward. This is what keeps
Rule 1 enforceable.

- `outliner`'s `buildBoard<T>(cards, states)` (`packages/outliner/src/kanban.ts:11`)
  takes the ordered lane list as an argument — "it does not know which lanes exist or
  their order — that is received as a parameter." `host-api` resolves `DEFAULT_LIFECYCLE`
  and hands the lanes down to outliner/web/mcp.
- `chat-core`'s engine writes through the injected `ChatVault` port; the host supplies
  the real vault. The engine never imports `host-api`.
- `chat-ui`'s `ChatClient` (`packages/chat-ui/src/client.ts:13`) "depends ONLY on
  `@orden/chat-core` types, never on host-api — so the UI can be wired over any
  transport without coupling." Its only workspace dependency is `@orden/chat-core`.

The contracts compose: Rule 1 (generic packages stay clean) is only achievable because
of Rule 4 (callers inject); Rule 2 (host-api is the consumer/re-export seam) is what
makes Rule 4's injection point well-defined; Rule 3 keeps the injected data
single-sourced. Same philosophy as the pluggable chat harness (ADR-0012) and the MCP
tool bus (ADR-0008): extend a table, don't reach across a layer.

## Consequences

**Easier:**

- A new generic package has an explicit standard to conform to up front, instead of one
  inferred after the fact from chat-core. The worked examples above are the reference.
- Adding a lifecycle lane, a chat harness, or an annotation field is a change in one
  layer (the data/config or the extension package) that the others receive as a
  parameter — no edits rippling up through importers.
- The dependency graph stays a DAG with `host-api` as the hub, so a generic package can
  be reused or tested in isolation with a stub injected for its port.

**Harder:**

- Re-exporting through `host-api` is boilerplate: a new extension type has to be imported
  and re-exported in the spine before an app can use it. The payoff is that the app never
  learns the extension package's name.
- Injecting config as a parameter is more indirection than a hardcoded constant. The bet
  (already paying off for workflows) is that the indirection is where the next variation
  lands — custom workflow lanes, additional harnesses.

**Enforcement is by convention, not the compiler.** Nothing stops a generic package from
adding an `@orden/host-api` dependency; the discipline is caught in review against these
four rules and the worked examples, not by a build error.
