-- ClashControl shared project sync schema (Neon Postgres)
-- Run this once in the Neon SQL Editor after creating the project.
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS shared_projects (
  id            TEXT PRIMARY KEY,           -- project key, e.g. "MEP-abc123"
  name          TEXT NOT NULL,
  edit_key      TEXT,                       -- SHA-256 hex hash, not plaintext (api/project.js hashEditKey); creator-held raw value required for DELETE (PUT stays open — that's the collaboration model). Older rows may still hold a raw pre-hashing token — api/project.js's editKeyMatches() handles both.
  expires_at    TIMESTAMPTZ,                -- optional, set via POST body.expiresInDays; NULL = never expires (default, existing behavior)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migration for pre-editKey deployments (idempotent):
ALTER TABLE shared_projects ADD COLUMN IF NOT EXISTS edit_key TEXT;

-- Migration for pre-expiry deployments (idempotent):
ALTER TABLE shared_projects ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS shared_issues (
  id          TEXT NOT NULL,                -- clash/issue id (client-generated)
  project_id  TEXT NOT NULL REFERENCES shared_projects(id) ON DELETE CASCADE,
  data        JSONB NOT NULL,               -- minimal shared record (status, priority, assignee, title, etc.)
  updated_by  TEXT NOT NULL DEFAULT 'anonymous',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS shared_issues_project_idx
  ON shared_issues (project_id, updated_at DESC);

-- Change log (api/project.js v2, docs/INTERNALS.md §21.56) — additive.
-- One row per change record, append-only, never updated. `seq` numbers a
-- project's records in commit order (allocated from shared_projects.change_seq
-- in the same statement, under the project row lock); clients pull "after
-- seq N". Conflicts are computed by the clients from base / resolves
-- (shared-log-core.js), never stored. shared_issues stays readable: a
-- project's old rows are copied into records once (log_migrated).
ALTER TABLE shared_projects ADD COLUMN IF NOT EXISTS change_seq BIGINT NOT NULL DEFAULT 0;
ALTER TABLE shared_projects ADD COLUMN IF NOT EXISTS log_migrated BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS shared_changes (
  project_id  TEXT NOT NULL REFERENCES shared_projects(id) ON DELETE CASCADE,
  seq         BIGINT NOT NULL,              -- per-project commit order (the pull cursor)
  id          TEXT NOT NULL,                -- record id (client-generated, unique)
  user_id     TEXT NOT NULL,                -- author's random per-browser id
  user_name   TEXT,                         -- author's display name at write time
  ts          BIGINT NOT NULL,              -- author's clock (display only — never decides anything)
  target_kind TEXT NOT NULL,                -- clash | issue | note | viewpoint
  target_key  TEXT NOT NULL,                -- clash identity / issue / note / viewpoint id
  field       TEXT NOT NULL,                -- status, assignee, created, deleted, comment:<id>, ...
  value       JSONB,
  base        TEXT,                         -- the change of this field the author had seen
  resolves    JSONB,                        -- ids a resolution builds on
  meta        JSONB NOT NULL DEFAULT '{}',  -- {prev?, resolution?, covers?}
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS shared_changes_seq_idx
  ON shared_changes (project_id, seq);

-- Optional: drop old/unused projects after 90 days of inactivity
-- (run as a periodic Neon cron job, or skip — they're tiny)
-- DELETE FROM shared_projects WHERE last_activity < now() - INTERVAL '90 days';

-- Training data tables (used by /api/training)

CREATE TABLE IF NOT EXISTS nl_training (
  id               BIGSERIAL PRIMARY KEY,
  input            TEXT NOT NULL,
  matched          BOOLEAN NOT NULL DEFAULT false,
  action           TEXT,
  path             TEXT,
  feedback_type    TEXT,                        -- 'thumbs_up' | 'thumbs_down' | 'correction'
  correction_input  TEXT,
  correction_intent TEXT,
  confidence       REAL,
  app_version      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clash_training (
  id             BIGSERIAL PRIMARY KEY,
  clash_id       TEXT NOT NULL,
  feature_vector JSONB NOT NULL DEFAULT '{}',
  label          TEXT NOT NULL,                 -- 'true_positive' | 'false_positive' | 'duplicate'
  label_source   TEXT NOT NULL DEFAULT 'user',
  app_version    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS detection_runs (
  id              BIGSERIAL PRIMARY KEY,
  run_id          TEXT NOT NULL,
  model_count     INT NOT NULL DEFAULT 0,
  clash_count     INT NOT NULL DEFAULT 0,
  hard_count      INT NOT NULL DEFAULT 0,
  soft_count      INT NOT NULL DEFAULT 0,
  duplicate_count INT NOT NULL DEFAULT 0,
  duration_ms     INT NOT NULL DEFAULT 0,
  rules           JSONB NOT NULL DEFAULT '{}',
  app_version     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
