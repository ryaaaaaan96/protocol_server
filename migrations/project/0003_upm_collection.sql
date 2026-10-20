-- UPM owns a local/DSP process template, incoming collection mappings and
-- outgoing UPP/Modbus mappings. Device instances remain in project JSON.
ALTER TABLE points.transmit_points
 ADD COLUMN register_type TEXT NOT NULL DEFAULT 'HOLDING'
   CHECK(register_type IN ('HOLDING','INPUT')),
 ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata)='object');
-- UPM can expose a typed array (e.g. U16 × 2); preserve DSP scalar rules.
DO $$ DECLARE constraint_name TEXT; BEGIN
 SELECT conname INTO constraint_name FROM pg_constraint
 WHERE conrelid='points.transmit_points'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%wire_length%CASE%';
 EXECUTE format('ALTER TABLE points.transmit_points DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE points.transmit_points ADD CONSTRAINT transmit_wire_shape CHECK(
 wire_type='STRING' OR wire_length=CASE wire_type WHEN 'U8' THEN 1 WHEN 'U16' THEN 2 WHEN 'S16' THEN 2 ELSE 4 END
 OR (board_key='UPM' AND wire_length % CASE wire_type WHEN 'U8' THEN 1 WHEN 'U16' THEN 2 WHEN 'S16' THEN 2 ELSE 4 END=0));
-- UPM endpoints may use register units. Apply the minimum span here; the
-- configured endpoint and each device's full address range are checked by the app.
DO $$ DECLARE constraint_name TEXT; BEGIN
 SELECT conname INTO constraint_name FROM pg_constraint
 WHERE conrelid='points.transmit_points'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%address + wire_length%';
 EXECUTE format('ALTER TABLE points.transmit_points DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE points.transmit_points ADD CONSTRAINT transmit_address_span CHECK(
 address + CASE WHEN board_key='UPM' THEN (wire_length+1)/2 ELSE wire_length END <=65536);

CREATE TABLE points.collect_points (
 id BIGSERIAL PRIMARY KEY,
 project_id BIGINT NOT NULL REFERENCES meta.project_state(id),
 board_key TEXT NOT NULL CHECK(board_key ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
 process_point_id BIGINT NOT NULL,
 endpoint_key TEXT NOT NULL CHECK(endpoint_key ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
 upp_model INT NOT NULL CHECK(upp_model BETWEEN 0 AND 65535),
 address INT NOT NULL CHECK(address BETWEEN 0 AND 65535),
 wire_type TEXT NOT NULL CHECK(wire_type IN ('U8','U16','S16','U32','S32','F32','STRING')),
 wire_length INT NOT NULL CHECK(wire_length BETWEEN 1 AND 65535),
 scale DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK(scale>0 AND scale<'Infinity'::float8),
 access TEXT NOT NULL DEFAULT 'RO' CHECK(access IN ('RO','RW','WO')),
 byte_order INT NOT NULL DEFAULT 0 CHECK(byte_order BETWEEN 0 AND 3),
 acquisition_mode TEXT NOT NULL DEFAULT 'poll' CHECK(acquisition_mode IN ('poll','upload')),
 poll_interval INT CHECK(poll_interval BETWEEN 0 AND 65535),
 set_priority INT CHECK(set_priority BETWEEN 0 AND 65535),
 scan_priority INT CHECK(scan_priority BETWEEN 0 AND 65535),
 display_order INT NOT NULL DEFAULT 0 CHECK(display_order>=0),
 source_sheet TEXT NOT NULL DEFAULT '', source_row INT CHECK(source_row>0),
 metadata JSONB NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata)='object'),
 UNIQUE(project_id,id),
 UNIQUE(project_id,board_key,endpoint_key,process_point_id),
 FOREIGN KEY(project_id,board_key,process_point_id)
   REFERENCES points.process_points(project_id,board_key,id),
 CHECK(wire_type='STRING' OR wire_length=CASE wire_type WHEN 'U8' THEN 1 WHEN 'U16' THEN 2 WHEN 'S16' THEN 2 ELSE 4 END),
 CHECK(address+wire_length<=65536)
);
CREATE INDEX collect_points_board ON points.collect_points(project_id,board_key,endpoint_key,display_order,id);
ALTER TABLE points.collect_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE points.collect_points FORCE ROW LEVEL SECURITY;
CREATE POLICY read_rows ON points.collect_points FOR SELECT USING(
 project_id=(SELECT public.app_project_id()) AND (SELECT public.app_can_access(public.app_project_id())));
CREATE POLICY write_rows ON points.collect_points FOR ALL USING(
 project_id=(SELECT public.app_project_id()) AND (SELECT public.app_can_access(public.app_project_id(),true)))
 WITH CHECK(project_id=(SELECT public.app_project_id()) AND (SELECT public.app_can_access(public.app_project_id(),true)));

-- Expand only the point-event entity allowlist; retain all existing checks.
DO $$ DECLARE constraint_name TEXT; definition TEXT; BEGIN
 SELECT conname,pg_get_constraintdef(oid) INTO constraint_name,definition
 FROM pg_constraint WHERE conrelid='history.events'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%entity_type%';
 IF constraint_name IS NULL THEN RAISE EXCEPTION 'Missing point history constraint'; END IF;
 EXECUTE format('ALTER TABLE history.events DROP CONSTRAINT %I',constraint_name);
 EXECUTE format('ALTER TABLE history.events ADD CONSTRAINT %I %s',
   constraint_name,replace(definition,'''transmit''::text','''transmit''::text, ''collect''::text'));
END $$;
DELETE FROM meta.previews;
ALTER TABLE meta.project_state DROP CONSTRAINT project_state_schema_version_check;
ALTER TABLE meta.project_state ALTER COLUMN schema_version SET DEFAULT 6;
UPDATE meta.project_state SET schema_version=6,revision=revision+1,updated_at=now();
ALTER TABLE meta.project_state ADD CONSTRAINT project_state_schema_version_check CHECK(schema_version=6);
