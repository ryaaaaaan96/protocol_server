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
 project_uid UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 config_key TEXT NOT NULL UNIQUE CHECK(config_key ~ '^[a-z][a-z0-9_-]{0,39}$'),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 description TEXT NOT NULL DEFAULT '',
 database_name TEXT NOT NULL UNIQUE CHECK(database_name ~ '^protocol_project_[a-z][a-z0-9_]{0,39}$'),
 status TEXT NOT NULL DEFAULT 'creating' CHECK(status IN ('creating','ready','failed')),
 created_by BIGINT REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE project_members (
 project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('engineer','viewer')),
 edit_scope TEXT NOT NULL DEFAULT 'all' CHECK(edit_scope IN ('all','scoped')),
 PRIMARY KEY(project_id,user_id)
);
CREATE TABLE project_member_grants (
 project_id BIGINT NOT NULL, user_id BIGINT NOT NULL,
 board_key TEXT NOT NULL CHECK(board_key ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
 scope TEXT NOT NULL CHECK(scope IN ('board','internal','protocol')),
 endpoint_key TEXT CHECK(endpoint_key ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
 CHECK((scope='protocol')=(endpoint_key IS NOT NULL)),
 FOREIGN KEY(project_id,user_id) REFERENCES project_members(project_id,user_id) ON DELETE CASCADE,
 UNIQUE NULLS NOT DISTINCT(project_id,user_id,board_key,scope,endpoint_key)
);
CREATE TABLE audit_logs (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT REFERENCES projects(id) ON DELETE CASCADE,
    user_id BIGINT REFERENCES users(id),
    actor_name TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    before_data JSONB,
    after_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
-- Used only by the server router; returns no credentials or business data.
CREATE FUNCTION app_project_registry(pid BIGINT) RETURNS SETOF projects
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT * FROM projects WHERE id=pid
$$;
-- Read-only members need a shared registry lock without registry UPDATE rights.
CREATE FUNCTION app_lock_project(pid BIGINT) RETURNS SETOF projects
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT * FROM projects WHERE id=pid AND app_can_access(id) FOR SHARE
$$;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
CREATE POLICY registry_read ON projects FOR SELECT USING(app_can_access(id));
CREATE POLICY registry_insert ON projects FOR INSERT WITH CHECK(app_is_admin());
CREATE POLICY registry_update ON projects FOR UPDATE USING(app_is_admin()) WITH CHECK(app_is_admin());
ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_members FORCE ROW LEVEL SECURITY;
CREATE POLICY members_read ON project_members FOR SELECT USING(app_can_access(project_id));
CREATE POLICY members_write ON project_members FOR ALL USING(app_is_admin()) WITH CHECK(app_is_admin());
ALTER TABLE project_member_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_member_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY grants_read ON project_member_grants FOR SELECT USING(app_can_access(project_id));
CREATE POLICY grants_write ON project_member_grants FOR ALL USING(app_is_admin()) WITH CHECK(app_is_admin());
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_logs FOR SELECT USING(app_is_admin() OR app_can_access(project_id));
CREATE POLICY audit_insert ON audit_logs FOR INSERT WITH CHECK(user_id=app_user_id() AND (project_id IS NULL OR app_can_access(project_id)));
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
