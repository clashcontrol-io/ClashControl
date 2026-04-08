-- ClashControl shared project sync schema (Neon Postgres)
-- Run this once in the Neon SQL Editor after creating the project.
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS shared_projects (
  id            TEXT PRIMARY KEY,           -- project key, e.g. "MEP-abc123"
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
