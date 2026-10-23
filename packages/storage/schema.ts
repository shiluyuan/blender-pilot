/** Versioned relational schema. JSONB retains complete versioned API entities;
 * query and ownership columns are typed, constrained and indexed. */
export const migrations = [
  {
    version: 1,
    sql: `
CREATE TABLE projects (
 id text PRIMARY KEY, name text NOT NULL CHECK(length(name)>0),
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, data jsonb NOT NULL CHECK(data->>'id'=id)
);
CREATE TABLE sessions (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), title text NOT NULL,
 native_thread_id text, created_at timestamptz NOT NULL, data jsonb NOT NULL CHECK(data->>'id'=id),
 UNIQUE(id,project_id)
);
CREATE INDEX sessions_project_created ON sessions(project_id,created_at DESC);
CREATE TABLE runs (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), session_id text NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','running','cancelling','succeeded','failed','cancelled','interrupted')),
 verification text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 data jsonb NOT NULL CHECK(data->>'id'=id),
 FOREIGN KEY(session_id,project_id) REFERENCES sessions(id,project_id)
);
CREATE INDEX runs_session_created ON runs(session_id,created_at);
CREATE INDEX runs_project_status ON runs(project_id,status);
CREATE UNIQUE INDEX runs_one_active_per_project ON runs(project_id) WHERE status IN ('queued','running','cancelling');
CREATE TABLE assets (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), name text NOT NULL,
 kind text NOT NULL, path text NOT NULL, sha256 text NOT NULL, size_bytes bigint NOT NULL CHECK(size_bytes>=0),
 created_at timestamptz NOT NULL, data jsonb NOT NULL CHECK(data->>'id'=id)
);
CREATE INDEX assets_project_created ON assets(project_id,created_at DESC);
CREATE INDEX assets_project_sha ON assets(project_id,sha256);
CREATE TABLE captures (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), created_at timestamptz NOT NULL, data jsonb NOT NULL CHECK(data->>'id'=id));
CREATE TABLE snapshots (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), created_at timestamptz NOT NULL, data jsonb NOT NULL CHECK(data->>'id'=id));
CREATE TABLE artifacts (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), created_at timestamptz NOT NULL, data jsonb NOT NULL CHECK(data->>'id'=id));
CREATE INDEX captures_project_created ON captures(project_id,created_at DESC);
CREATE INDEX snapshots_project_created ON snapshots(project_id,created_at DESC);
CREATE INDEX artifacts_project_created ON artifacts(project_id,created_at DESC);
CREATE TABLE uploads (id text PRIMARY KEY, project_id text REFERENCES projects(id), created_at timestamptz NOT NULL, data jsonb NOT NULL CHECK(data->>'id'=id));
CREATE INDEX uploads_project_created ON uploads(project_id,created_at DESC);
CREATE TABLE config (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE events (run_id text NOT NULL REFERENCES runs(id),seq integer NOT NULL CHECK(seq>0),type text NOT NULL,data jsonb NOT NULL, PRIMARY KEY(run_id,seq));
CREATE TABLE requests (key text PRIMARY KEY,run_id text NOT NULL REFERENCES runs(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE library_assets (
 id text PRIMARY KEY,name text NOT NULL,category text NOT NULL CHECK(category IN ('character','prop','scene','material','other')),
 tags text[] NOT NULL DEFAULT '{}',favorite boolean NOT NULL DEFAULT false,source_project_id text,
 path text NOT NULL,sha256 text NOT NULL,size_bytes bigint NOT NULL CHECK(size_bytes>=0),
 created_at timestamptz NOT NULL,data jsonb NOT NULL CHECK(data->>'id'=id)
);
CREATE INDEX library_category_created ON library_assets(category,created_at DESC);
CREATE INDEX library_created ON library_assets(created_at DESC);
CREATE INDEX library_favorites ON library_assets(created_at DESC) WHERE favorite;
CREATE INDEX library_tags ON library_assets USING gin(tags);
CREATE TABLE library_asset_sources (
 asset_id text NOT NULL REFERENCES library_assets(id), source_asset_id text NOT NULL REFERENCES library_assets(id),
 PRIMARY KEY(asset_id,source_asset_id),CHECK(asset_id<>source_asset_id)
);
CREATE TABLE migration_imports (source text PRIMARY KEY, imported_at timestamptz NOT NULL DEFAULT now(), details jsonb NOT NULL);
`,
  },
];
