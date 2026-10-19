-- A project database contains exactly one project's editable state.
CREATE TABLE project_state (
 id BIGINT PRIMARY KEY,
 project_uid UUID NOT NULL UNIQUE,
 config_key TEXT NOT NULL UNIQUE CHECK(config_key ~ '^[a-z][a-z0-9_-]{0,39}$'),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120), description TEXT NOT NULL DEFAULT '',
 topology_config JSONB CHECK(topology_config IS NULL OR jsonb_typeof(topology_config)='object'),
 revision INT NOT NULL DEFAULT 1 CHECK(revision>0), schema_version INT NOT NULL DEFAULT 4 CHECK(schema_version=4),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX project_state_singleton ON project_state((true));
CREATE FUNCTION app_user_id() RETURNS BIGINT LANGUAGE sql STABLE AS $$
 SELECT NULLIF(current_setting('app.user_id',true),'')::bigint
$$;
CREATE FUNCTION app_project_id() RETURNS BIGINT LANGUAGE sql STABLE AS $$
 SELECT NULLIF(current_setting('app.project_id',true),'')::bigint
$$;
CREATE FUNCTION app_access() RETURNS JSONB LANGUAGE sql STABLE AS $$
 SELECT COALESCE(NULLIF(current_setting('app.access',true),'')::jsonb,'{}'::jsonb)
$$;
CREATE FUNCTION app_is_admin() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
 SELECT COALESCE(app_access()->>'role'='admin',false)
$$;
-- The trusted server verifies and locks the platform account and registry before
-- setting this transaction-local snapshot. It keeps those locks through commit.
CREATE FUNCTION app_can_access(pid BIGINT, writing BOOLEAN DEFAULT FALSE) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT pid=NULLIF(current_setting('app.project_id',true),'')::bigint
 AND app_user_id() IS NOT NULL
 AND EXISTS(SELECT 1 FROM project_state WHERE id=pid)
 AND COALESCE(app_access()->>'role' IN ('admin','engineer','viewer'),false)
 AND (NOT writing OR app_is_admin() OR (app_access()->>'role'='engineer'
      AND (app_access()->>'edit_scope'='all' OR jsonb_array_length(COALESCE(app_access()->'grants','[]'::jsonb))>0)))
$$;
CREATE TABLE process_points (
 id BIGSERIAL PRIMARY KEY,
 project_id BIGINT NOT NULL REFERENCES project_state(id),
 board_key TEXT NOT NULL DEFAULT 'DSP' CHECK(board_key ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
 group_key TEXT NOT NULL DEFAULT 'LOCAL' CHECK(group_key ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 300),
 enum_name TEXT NOT NULL CHECK(enum_name ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
 sig_id INT CHECK(sig_id BETWEEN 1 AND 65535),
 internal_type TEXT NOT NULL CHECK(internal_type IN ('U8','U16','S16','U32','S32','F32','STRING')),
 element_count INT NOT NULL DEFAULT 1 CHECK(element_count BETWEEN 1 AND 65535),
 byte_length INT NOT NULL CHECK(byte_length BETWEEN 1 AND 65535),
 unit TEXT NOT NULL DEFAULT '',
 default_value TEXT NOT NULL DEFAULT '', min_value TEXT NOT NULL DEFAULT '', max_value TEXT NOT NULL DEFAULT '',
 boot_restore BOOLEAN NOT NULL DEFAULT FALSE, manual_restore BOOLEAN NOT NULL DEFAULT FALSE,
 process_enabled BOOLEAN NOT NULL DEFAULT TRUE,
 flags TEXT NOT NULL DEFAULT '0', callback TEXT NOT NULL DEFAULT 'NULL', notes TEXT NOT NULL DEFAULT '',
 display_order INT NOT NULL DEFAULT 0 CHECK(display_order>=0),
 source_sheet TEXT NOT NULL DEFAULT '', source_row INT CHECK(source_row>0),
 metadata JSONB NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata)='object'),
 CHECK(byte_length=element_count*CASE internal_type WHEN 'U8' THEN 1 WHEN 'STRING' THEN 1 WHEN 'U16' THEN 2 WHEN 'S16' THEN 2 ELSE 4 END),
 UNIQUE(project_id,id), UNIQUE(project_id,board_key,id),
 UNIQUE(project_id,board_key,group_key,enum_name), UNIQUE(project_id,board_key,group_key,sig_id)
);
CREATE TABLE transmit_points (
 id BIGSERIAL PRIMARY KEY,
 project_id BIGINT NOT NULL REFERENCES project_state(id),
 board_key TEXT NOT NULL DEFAULT 'DSP' CHECK(board_key ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
 process_point_id BIGINT NOT NULL,
 endpoint_key TEXT NOT NULL DEFAULT 'UPP_SERVICE' CHECK(endpoint_key ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 300),
 upp_model INT NOT NULL CHECK(upp_model BETWEEN 0 AND 65535),
 address INT NOT NULL CHECK(address BETWEEN 0 AND 65535),
 wire_type TEXT NOT NULL CHECK(wire_type IN ('U8','U16','S16','U32','S32','F32','STRING')),
 wire_length INT NOT NULL CHECK(wire_length BETWEEN 1 AND 65535),
 scale DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK(scale>0 AND scale<'Infinity'::float8),
 access TEXT NOT NULL DEFAULT 'RO' CHECK(access IN ('RO','RW','WO')),
 byte_order INT NOT NULL DEFAULT 0 CHECK(byte_order BETWEEN 0 AND 3),
 conversion TEXT NOT NULL DEFAULT 'identity' CHECK(conversion IN ('identity','fixed_point','array_bytes')),
 enabled BOOLEAN NOT NULL DEFAULT TRUE,
 display_order INT NOT NULL DEFAULT 0 CHECK(display_order>=0),
 source_sheet TEXT NOT NULL DEFAULT '', source_row INT CHECK(source_row>0),
 CHECK(wire_type='STRING' OR wire_length=CASE wire_type WHEN 'U8' THEN 1 WHEN 'U16' THEN 2 WHEN 'S16' THEN 2 ELSE 4 END),
 CHECK(address+wire_length<=65536),
 UNIQUE(project_id,id),
 FOREIGN KEY(project_id,board_key,process_point_id) REFERENCES process_points(project_id,board_key,id)
);
CREATE INDEX process_points_board ON process_points(project_id,board_key,group_key,display_order,id);
CREATE INDEX transmit_points_board ON transmit_points(project_id,board_key,endpoint_key,upp_model,address,id);
CREATE INDEX transmit_points_process ON transmit_points(project_id,process_point_id);

-- History deliberately does not reference the mutable point record: deletion
-- and project data replacement must not erase earlier operations.
CREATE TABLE point_history (
 id BIGSERIAL PRIMARY KEY,
 project_id BIGINT NOT NULL REFERENCES project_state(id),
 batch_id UUID NOT NULL,
 batch_label TEXT NOT NULL,
 entity_type TEXT NOT NULL CHECK(entity_type IN ('process','transmit')),
 record_id BIGINT NOT NULL,
 board_key TEXT NOT NULL,
 group_key TEXT,
 action TEXT NOT NULL CHECK(action IN ('insert','update','delete')),
 before_data JSONB, after_data JSONB,
 actor_id BIGINT NOT NULL, actor_name TEXT NOT NULL,
 project_revision INT NOT NULL,
 config_snapshot JSONB,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(before_data IS NULL OR jsonb_typeof(before_data)='object'),
 CHECK(after_data IS NULL OR jsonb_typeof(after_data)='object'),
 CHECK((action='insert' AND before_data IS NULL AND after_data IS NOT NULL)
    OR (action='delete' AND before_data IS NOT NULL AND after_data IS NULL)
    OR (action='update' AND before_data IS NOT NULL AND after_data IS NOT NULL))
);
CREATE INDEX point_history_project ON point_history(project_id,id DESC);
CREATE INDEX point_history_record ON point_history(project_id,entity_type,record_id,id DESC);
CREATE INDEX point_history_batch ON point_history(project_id,batch_id);

CREATE TABLE imports (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES project_state(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    report JSONB NOT NULL,
    created_by BIGINT NOT NULL,
    created_by_name TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE releases (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES project_state(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    revision INT NOT NULL,
    snapshot JSONB NOT NULL,
    files JSONB NOT NULL,
    sha256 TEXT NOT NULL,
    created_by BIGINT NOT NULL,
    created_by_name TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(project_id,name)
);
CREATE TABLE audit_logs (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT REFERENCES project_state(id) ON DELETE CASCADE,
    user_id BIGINT,
    actor_name TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    before_data JSONB,
    after_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE import_previews (
 id BIGSERIAL PRIMARY KEY, project_id BIGINT NOT NULL REFERENCES project_state(id), created_by BIGINT NOT NULL,
 filename TEXT NOT NULL, sha256 TEXT NOT NULL, revision INT NOT NULL, payload JSONB NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '1 hour'
);
CREATE TABLE change_previews (
 id BIGSERIAL PRIMARY KEY, project_id BIGINT NOT NULL REFERENCES project_state(id), created_by BIGINT NOT NULL,
 revision INT NOT NULL, change JSONB NOT NULL, merge_base JSONB, merge_patch JSONB,
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '15 minutes'
);
CREATE TABLE project_edit_locks (
 project_id BIGINT PRIMARY KEY REFERENCES project_state(id), user_id BIGINT NOT NULL,
 owner_name TEXT NOT NULL DEFAULT '', owner_username TEXT NOT NULL DEFAULT '', expires_at TIMESTAMPTZ NOT NULL
);
-- The project ID equality still filters each row; authorization is a scalar
-- subquery so PostgreSQL evaluates it once per statement instead of per row.
ALTER TABLE project_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_state FORCE ROW LEVEL SECURITY;
CREATE POLICY state_read ON project_state FOR SELECT USING(id=(SELECT app_project_id()) AND (SELECT app_can_access(app_project_id())));
CREATE POLICY state_write ON project_state FOR UPDATE USING(id=(SELECT app_project_id()) AND (SELECT app_can_access(app_project_id(),true))) WITH CHECK(id=(SELECT app_project_id()) AND (SELECT app_can_access(app_project_id(),true)));
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['process_points','transmit_points','imports','change_previews'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY read_rows ON %I FOR SELECT USING(project_id=(SELECT app_project_id()) AND (SELECT app_can_access(app_project_id())))',t);
  EXECUTE format('CREATE POLICY write_rows ON %I FOR ALL USING(project_id=(SELECT app_project_id()) AND (SELECT app_can_access(app_project_id(),true))) WITH CHECK(project_id=(SELECT app_project_id()) AND (SELECT app_can_access(app_project_id(),true)))',t);
 END LOOP;
END $$;
ALTER TABLE import_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_previews FORCE ROW LEVEL SECURITY;
CREATE POLICY preview_owner ON import_previews USING(created_by=(SELECT app_user_id()) AND project_id=(SELECT app_project_id()) AND (SELECT app_can_access(app_project_id(),true)));
ALTER TABLE project_edit_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_edit_locks FORCE ROW LEVEL SECURITY;
CREATE POLICY lock_read ON project_edit_locks FOR SELECT USING(project_id=(SELECT app_project_id()) AND (SELECT app_can_access(app_project_id())));
CREATE POLICY lock_insert ON project_edit_locks FOR INSERT WITH CHECK(project_id=(SELECT app_project_id()) AND (SELECT app_can_access(app_project_id(),true)) AND user_id=(SELECT app_user_id()));
CREATE POLICY lock_update ON project_edit_locks FOR UPDATE USING(project_id=(SELECT app_project_id()) AND (SELECT app_can_access(app_project_id(),true))) WITH CHECK(project_id=(SELECT app_project_id()) AND (SELECT app_can_access(app_project_id(),true)) AND user_id=(SELECT app_user_id()));
CREATE POLICY lock_delete ON project_edit_locks FOR DELETE USING(project_id=(SELECT app_project_id()) AND (SELECT app_can_access(app_project_id(),true)));
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['point_history','audit_logs','releases'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY read_rows ON %I FOR SELECT USING(project_id=(SELECT app_project_id()) AND (SELECT app_can_access(app_project_id())))',t);
 END LOOP;
END $$;
CREATE POLICY history_insert ON point_history FOR INSERT WITH CHECK(project_id=(SELECT app_project_id()) AND (SELECT app_can_access(app_project_id(),true)) AND actor_id=(SELECT app_user_id()));
CREATE POLICY audit_insert ON audit_logs FOR INSERT WITH CHECK(project_id=(SELECT app_project_id()) AND (SELECT app_can_access(app_project_id())) AND user_id=(SELECT app_user_id()));
CREATE POLICY release_insert ON releases FOR INSERT WITH CHECK(project_id=(SELECT app_project_id()) AND (SELECT app_can_access(app_project_id(),true)) AND created_by=(SELECT app_user_id()));
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
-- Routing validation reveals only this database's immutable project identity.
CREATE FUNCTION app_project_identity() RETURNS TABLE(id BIGINT,config_key TEXT,project_uid TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT id,config_key,project_uid::text FROM project_state
$$;
