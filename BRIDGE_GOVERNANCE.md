# Smart Bridge tool governance

Cross-repo learning note: this mirrors PDRA's autonomy-gate + audit-log
design (`Services/Ai/Audit/AutonomyGate.cs`, `AuditLog.cs`) so ClashControl's
LLM tool surface gets the same governance PDRA's already has, adapted to a
browser app with no synchronous confirm-dialog host.

## Why

`smart-bridge-server.js` forwards every one of the 66 tools an LLM can call
(`mcp-server.js`, the REST `/call/{tool}` API, and the `/chat` agent loop) to
the browser via `callBrowser()`. Before this change that path had no policy
layer: any caller that could reach the bridge could call `delete_model`,
`delete_issue`, `delete_sheet`, `batch_update_clashes`, or `import_bcf` and
it would execute immediately, with no audit trail and no chance to
reconsider. Origin/host allow-listing (already in place) controls *who* can
reach the bridge; it says nothing about *what* they're allowed to do once
they're in — that's what this layer adds.

## What changed

Two new zero-dependency modules, wired into `smart-bridge-server.js`'s
`governedCallBrowser()`, which both `/call/{tool}` and the `/chat` agent loop
now call instead of `callBrowser()` directly:

- **`bridge-governance.js`** — classifies every tool into `read_only`,
  `reversible`, or `destructive` (see the file for the full list and the
  reasoning per tool). Destructive tools require the caller to pass
  `confirm: true`; the first call without it is rejected with a steered
  error — `{ reason, next_step, context }` — that tells the caller exactly
  how to proceed, the same shape PDRA's `ToolSteering.Error` uses, so an LLM
  client can self-correct instead of asking a human blind or being silently
  refused.
- **`bridge-audit.js`** — an append-only, hash-chained JSONL ledger at
  `~/.clashcontrol/audit/YYYY-MM-DD.jsonl`. Every call is logged (allowed,
  rejected, or failed) with a hash of its arguments and result rather than
  the raw payload, so the log stays small and never captures full model
  geometry. The event shape and SHA-256(prevEvent) chaining are ported from
  Mycelium's public provenance reference implementation
  (`Mycelium/lib/provenance.mjs`), so a ClashControl ledger is structurally
  comparable to — and verifiable with — the same algorithm the open spine
  project documents. Best-effort: a logging failure never blocks a tool
  call.

## Tool tiers

| Tier | Behavior | Examples |
|---|---|---|
| `read_only` | Always allowed, always logged | `get_status`, `get_clashes`, `get_data_quality` |
| `reversible` | Allowed under `confirm`/`auto` mode, logged | `update_clash`, `create_issue`, `set_view`, `create_2d_sheet` |
| `destructive` | Requires `confirm: true` under `confirm` mode | `delete_model`, `delete_issue`, `delete_sheet`, `batch_update_clashes`, `import_bcf` |

A tool not in any list (e.g. one added to the manifest after this file)
defaults to `destructive` — fail safe. An unnecessary confirmation prompt is
a much smaller cost than silently running an unreviewed mutating tool.

## Env vars

- `CLASHCONTROL_AUTONOMY` — `auto` \| `confirm` (default) \| `read_only`.
- `CLASHCONTROL_AUTONOMY_GATE` — `on` (default) \| `off`. Kill switch;
  logging still happens when the gate is off.

## Verifying the ledger

```js
const { verify, todayLedgerPath } = require('./bridge-audit');
console.log(verify(todayLedgerPath()));
// { ok: true, count: N, errors: [] }
```

`errors` is non-empty if any line's `prevHash` doesn't match the canonical
hash of the line before it — i.e. the file was edited after the fact.
