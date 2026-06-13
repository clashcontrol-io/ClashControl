# Connective Spine — identity, freshness & provenance contract

> **Status:** draft v0.1 — the contract every data source conforms to so it can be
> joined, kept fresh, and held accountable inside the ClashControl connective layer.
> This is the **open** part of the platform: the schema is public; the *intelligence*
> (orchestrator, models) is not. ClashControl is the reference implementation.

## Why this exists

The demo cell is **Revit ↔ PDRA ↔ ClashControl ↔ LLM**: cross-tool data, joined on
IFC GUID, answered by one LLM, written back under human approval. The end goal is the
*same loop generalised* — more sources (clash, finance/ERP, contracts, site/QA, CDE),
more parties, across the lifecycle, accumulating an accountable history that can't be
re-created elsewhere.

That only works if every source speaks a shared contract for three things:

1. **Identity** — how to name the same real-world thing across tools.
2. **Freshness** — which revision of the truth a datum belongs to.
3. **Provenance** — who proposed/approved/executed each change, append-only.

GUID is necessary but **not** the spine. It joins model-derived sources (model, clash,
BCF, QA). It does **not** reach finance, contracts, or documents — those join on
**classification, work-package, cost-code, and zone**. So identity is a *record of
keys*, of which GUID is one edge.

## 1. Identity record

Every source emits, per object, as many of these keys as it has. None is mandatory;
the join uses whichever keys two sources share.

| Key | Meaning | Joins to |
|---|---|---|
| `ifcGuid` | IFC GlobalId (= Revit IfcGUID for Revit-exported models) | model, clash, BCF, QA |
| `revitId` | Revit ElementId | live Revit tools (PDRA), Connector |
| `classification` | `{ system, code }` — NL-SfB / Uniclass / OmniClass / Uniformat | **finance/ERP, specs** |
| `zone` | spatial bucket; today = storey/level (later IfcZone/IfcSpace) | site, QA, scheduling |
| `source` | originating tool id (`clashcontrol`, `pdra`, `erpnext`, …) | provenance, freshness |
| `sourceLocalId` | the object's id *inside* its source tool | round-trip / write-back |
| `projectKey` | shared project identifier | partitioning, multi-party |

**Rules**
- Treat `ifcGuid` as *one* edge type, never the sole join.
- A source that can emit `classification` SHOULD, even when it also has `ifcGuid` —
  it's the only bridge to non-geometric sources.
- Keys are additive: emit more over time without breaking consumers.

### Where ClashControl emits this today
- `get_clashes` → `globalIdA/B`, `revitIdA/B`, `classificationA/B`, `storey`.
- `get_issues` → `globalIds[]`, `revitIdA/B`.
- `get_element_by_guid` → `globalId`, `revitId`, `classification`, `storey`, … (inverse join).
- PDRA mirror: `pdra_inspect_elements` (`ifc_guid` alias), `pdra_get_element_by_ifcguid`.

## 2. Freshness stamp

Every source datum is "as-of" a revision. Joining across mismatched revisions is the
silent-wrong-answer failure mode, so the stamp is uniform and the orchestrator's
staleness guard is generic.

```
{ source, revisionId, asOf, confidence }
```

| Field | Meaning |
|---|---|
| `source` | originating tool id |
| `revisionId` | opaque, comparable token for "same revision or not" |
| `asOf` | ISO timestamp the datum reflects |
| `confidence` | `live` \| `snapshot` \| `derived` — how authoritative |

**Per-source revisionId**
- **CC live link** → Connector sync id / `model._version` + `lastSync` (`get_status.revision`).
- **CC IFC file** → `ifc:<name>#<elementCount>@v<version>` — a `snapshot` (may lag live Revit).
- **PDRA / live Revit** → `Document.GetDocumentVersion` (`VersionGUID` + `NumberOfSaves`); `has_unsaved_changes` flags in-session edits the guid doesn't yet reflect (`pdra_get_model_revision`).
- **ERP / CDE** → that system's revision/etag + timestamp.

**Rule:** the orchestrator MUST compare revisions before joining and refuse/flag a join
across `confidence: snapshot` data that is older than a `live` source.

## 3. Provenance event (the ledger)

The accountable history is the moat — it can't be backfilled, so it starts with the
first write-back. **Append-only.** Every proposal and every executed change emits one
event to a single sink (local JSONL/Postgres now; durable store later).

```jsonc
{
  "id":         "uuid",
  "ts":         "ISO-8601",
  "projectKey": "…",
  "actor":      "human:thom" | "agent:orchestrator" | "agent:llm",
  "proposedBy": "agent:llm",          // who suggested it
  "approvedBy": "human:thom" | null,  // null until approved
  "source":     "pdra" | "clashcontrol" | …,   // tool that executes/owns the change
  "action":     "set_clash_status" | "edit_element" | "create_workitem" | …,
  "targetKeys": { "ifcGuid": "…", "classification": {…}, … },  // identity record
  "revision":   { "source": "pdra", "revisionId": "…", "asOf": "…" },
  "before":     { … } | null,         // compact summary, not full geometry
  "after":      { … } | null,
  "result":     "proposed" | "approved" | "executed" | "rejected" | "failed",
  "transport":  "mcp/http" | "mcp/stdio"
}
```

**Rules**
- **Ownership / one writer per domain:** each `action` has exactly one owning `source`
  (e.g. CC owns clash status; PDRA owns model edits). No source writes another's domain.
- **Auto-propose → approve → execute:** a write is `proposed` first; it only becomes
  `executed` after an `approved` event from a human (reuse each tool's existing
  autonomy gate — PDRA's `AutonomyGate`, CC's autonomy envelope — don't reinvent).
- **Portable:** prefer riding standard carriers where possible — BCF for issues
  (CC already round-trips `cc:aiModel/aiSource/aiAt` provenance labels), IFC for model,
  IDS for requirements — so the ledger is accountable *and* open, not a proprietary trap.

## 4. Transport

- **Protocol:** MCP everywhere (JSON-RPC: `initialize` / `tools/list` / `tools/call`).
- **Transports (both are MCP):**
  - *stdio* — host spawns the server (CC `mcp-server.js`; the easy single-user
    Claude Desktop path).
  - *Streamable HTTP* — server on a localhost/network port (PDRA `:47000/mcp`); the
    many-to-many, multi-party, authenticated path the platform needs.
- **Recommendation:** each source exposes an **HTTP-MCP** endpoint for the orchestrator
  (keep stdio for direct single-user use). The orchestrator is the MCP **client** of all
  sources **and** the emitter of provenance events. tool/command traffic = MCP; the
  high-volume provenance/sync stream = a separate append-log/event bus (not MCP).

## 5. Principles (non-negotiable)

- **Open base, private intelligence.** This schema + the connectors are open; the
  orchestrator, composite decisions, and models are private. No source-specific or
  proprietary identity leaks into the open layer.
- **Sovereign by construction.** Localhost-first, self-hostable, model-agnostic
  (bring-your-own / swappable LLM). No hard dependency on a single SaaS in the base layer.
- **Generalise by adding edges, not rewrites.** New source = new keys + a freshness
  stamp + provenance emission. Prove the loop on model+clash, then add **one**
  non-model source (ERPNext, via `classification`) as the generalisation test before
  committing to the substrate.

## 6. Conformance checklist for a new source

- [ ] Emits an **identity record** (≥ one shared key; `classification` if it has it).
- [ ] Emits a **freshness stamp** (`source`, `revisionId`, `asOf`, `confidence`).
- [ ] Emits **provenance events** for every proposal/write, append-only.
- [ ] Declares its **owned domain** (what it, and only it, may write).
- [ ] Exposes tools over **MCP** (HTTP transport for the orchestrator path).
- [ ] Honours **propose → approve → execute** via its own autonomy gate.
