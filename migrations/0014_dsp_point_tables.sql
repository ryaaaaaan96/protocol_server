-- Native point storage. JSON owns board/group definitions; these keys identify
-- the applied configuration. Legacy boards continue using the original graph.
CREATE TABLE process_points (
 id BIGSERIAL PRIMARY KEY,
 project_id BIGINT NOT NULL REFERENCES projects(id),
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
 project_id BIGINT NOT NULL REFERENCES projects(id),
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
 project_id BIGINT NOT NULL REFERENCES projects(id),
 batch_id UUID NOT NULL,
 batch_label TEXT NOT NULL,
 entity_type TEXT NOT NULL CHECK(entity_type IN ('process','transmit')),
 record_id BIGINT NOT NULL,
 board_key TEXT NOT NULL,
 group_key TEXT,
 action TEXT NOT NULL CHECK(action IN ('insert','update','delete')),
 before_data JSONB, after_data JSONB,
 actor_id BIGINT NOT NULL REFERENCES users(id), actor_name TEXT NOT NULL,
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

DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['process_points','transmit_points'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY read_rows ON %I FOR SELECT USING(app_can_access(project_id))',t);
  EXECUTE format('CREATE POLICY write_rows ON %I FOR ALL USING(app_can_access(project_id,true)) WITH CHECK(app_can_access(project_id,true))',t);
 END LOOP;
END $$;
ALTER TABLE point_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE point_history FORCE ROW LEVEL SECURITY;
CREATE POLICY history_read ON point_history FOR SELECT USING(app_can_access(project_id));
CREATE POLICY history_insert ON point_history FOR INSERT WITH CHECK(app_can_access(project_id,true) AND actor_id=app_user_id());
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='protocol_app') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON process_points,transmit_points TO protocol_app;
  GRANT SELECT,INSERT ON point_history TO protocol_app;
  REVOKE UPDATE,DELETE,TRUNCATE ON point_history FROM protocol_app;
  GRANT USAGE,SELECT ON SEQUENCE process_points_id_seq,transmit_points_id_seq,point_history_id_seq TO protocol_app;
 END IF;
END $$;
