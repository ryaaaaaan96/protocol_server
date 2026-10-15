CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '12 hours'
);
CREATE TABLE login_attempts (
    username TEXT PRIMARY KEY, failures INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE projects (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    description TEXT NOT NULL DEFAULT '',
    revision INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE project_members (
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('engineer','viewer')),
    PRIMARY KEY (project_id,user_id)
);
CREATE TABLE devices (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    code TEXT NOT NULL CHECK (code ~ '^CFG_DEV_(LOCAL|DSP[1-8])$'),
    scope TEXT NOT NULL CHECK (scope IN ('LOCAL','DSP')),
    base_address INT NOT NULL CHECK (base_address BETWEEN 0 AND 65535),
    end_address INT NOT NULL CHECK (end_address BETWEEN base_address AND 65535),
    UNIQUE(project_id, code)
);
CREATE TABLE platform_signals (
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL CHECK (symbol ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
    signal_id INT NOT NULL CHECK (signal_id BETWEEN 1 AND 65535),
    PRIMARY KEY(project_id,symbol)
);
CREATE TABLE points (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN ('LOCAL','DSP')),
    ordinal INT NOT NULL DEFAULT 0,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
    enum_name TEXT NOT NULL DEFAULT '',
    signal_id TEXT NOT NULL DEFAULT '',
    data_type TEXT NOT NULL DEFAULT 'U16',
    byte_length INT NOT NULL DEFAULT 2 CHECK (byte_length BETWEEN 1 AND 65535),
    access TEXT NOT NULL DEFAULT 'RO',
    unit TEXT NOT NULL DEFAULT '',
    scale DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (scale > 0 AND scale < 'Infinity'::float8),
    address_mode TEXT NOT NULL DEFAULT 'none' CHECK(address_mode IN ('manual','auto','none')),
    modbus_address INT CHECK(modbus_address BETWEEN 0 AND 65535),
    upp_model INT CHECK(upp_model BETWEEN 1 AND 65535),
    upp_offset INT CHECK(upp_offset BETWEEN 0 AND 65535),
    flags TEXT NOT NULL DEFAULT '0',
    poll_interval INT NOT NULL DEFAULT 0 CHECK(poll_interval >= 0),
    set_priority INT NOT NULL DEFAULT 0 CHECK(set_priority >= 0),
    scan_priority INT NOT NULL DEFAULT 0 CHECK(scan_priority >= 0),
    callback TEXT NOT NULL DEFAULT 'NULL',
    default_value TEXT NOT NULL DEFAULT '',
    min_value TEXT NOT NULL DEFAULT '',
    max_value TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    source_sheet TEXT NOT NULL DEFAULT '',
    source_row INT,
    raw_json JSONB NOT NULL DEFAULT '{}',
    version INT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX points_project_scope ON points(project_id,scope,ordinal,id);
CREATE TABLE imports (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    report JSONB NOT NULL,
    created_by BIGINT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE releases (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    revision INT NOT NULL,
    snapshot JSONB NOT NULL,
    files JSONB NOT NULL,
    sha256 TEXT NOT NULL,
    created_by BIGINT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(project_id,name)
);
CREATE TABLE audit_logs (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT REFERENCES projects(id) ON DELETE CASCADE,
    user_id BIGINT REFERENCES users(id),
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    before_data JSONB,
    after_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The server sets user/project context with SET LOCAL inside each transaction.
-- No request identity survives a connection-pool checkout.
CREATE FUNCTION app_user_id() RETURNS BIGINT LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id',true),'')::bigint
$$;
CREATE FUNCTION app_is_admin() RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM users WHERE id=app_user_id() AND active AND is_admin)
$$;
CREATE FUNCTION app_can_access(pid BIGINT, writing BOOLEAN DEFAULT FALSE) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (NULLIF(current_setting('app.project_id',true),'') IS NULL
          OR pid=NULLIF(current_setting('app.project_id',true),'')::bigint)
    AND (app_is_admin() OR EXISTS (
      SELECT 1 FROM project_members m JOIN users u ON u.id=m.user_id
      WHERE m.project_id=pid AND u.id=app_user_id() AND u.active
      AND (NOT writing OR m.role='engineer')))
$$;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
CREATE POLICY project_read ON projects FOR SELECT USING (app_can_access(id));
CREATE POLICY project_insert ON projects FOR INSERT WITH CHECK(app_is_admin());
CREATE POLICY project_update ON projects FOR UPDATE USING(app_can_access(id,true));
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['points','devices','platform_signals','imports','releases'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY read_rows ON %I FOR SELECT USING(app_can_access(project_id))',t);
    EXECUTE format('CREATE POLICY insert_rows ON %I FOR INSERT WITH CHECK(app_can_access(project_id,true))',t);
    EXECUTE format('CREATE POLICY update_rows ON %I FOR UPDATE USING(app_can_access(project_id,true))',t);
    EXECUTE format('CREATE POLICY delete_rows ON %I FOR DELETE USING(app_can_access(project_id,true))',t);
  END LOOP;
END $$;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_logs FOR SELECT USING(app_is_admin() OR app_can_access(project_id));
CREATE POLICY audit_insert ON audit_logs FOR INSERT WITH CHECK(user_id=app_user_id() AND (project_id IS NULL OR app_can_access(project_id)));
