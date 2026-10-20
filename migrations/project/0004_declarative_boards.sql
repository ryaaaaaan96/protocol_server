-- Replace board-name-specific constraints with common storage invariants.
ALTER TABLE points.transmit_points DROP CONSTRAINT transmit_wire_shape;
ALTER TABLE points.transmit_points ADD CONSTRAINT transmit_wire_shape CHECK (
 wire_type='STRING' OR wire_length % CASE wire_type WHEN 'U8' THEN 1 WHEN 'U16' THEN 2 WHEN 'S16' THEN 2 ELSE 4 END=0);
ALTER TABLE points.transmit_points DROP CONSTRAINT transmit_address_span;
ALTER TABLE points.transmit_points ADD CONSTRAINT transmit_address_span CHECK(address+(wire_length+1)/2<=65536);
DO $$ DECLARE cname TEXT; BEGIN
 SELECT conname INTO cname FROM pg_constraint WHERE conrelid='points.collect_points'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%wire_length%CASE%';
 EXECUTE format('ALTER TABLE points.collect_points DROP CONSTRAINT %I',cname);
END $$;
ALTER TABLE points.collect_points ADD CONSTRAINT collect_wire_shape CHECK (
 wire_type='STRING' OR wire_length % CASE wire_type WHEN 'U8' THEN 1 WHEN 'U16' THEN 2 WHEN 'S16' THEN 2 ELSE 4 END=0);
-- One-time upgrade of applied configuration. Never infer rules from names at runtime.
UPDATE meta.project_state SET topology_config=jsonb_set(topology_config,'{board_types}',
 (SELECT jsonb_agg(CASE WHEN b->>'code'='UPM' AND b->>'point_storage'='native' THEN b || '{"point_rules": {"raw_representation": true, "inherit_name": true, "source_range_warnings": true, "warn_missing_sig_id": true, "null_callbacks": ["0"]}, "workbook_import": "workbook.json"}'::jsonb ELSE b END ORDER BY n)
 FROM jsonb_array_elements(topology_config->'board_types') WITH ORDINALITY AS a(b,n)))
 WHERE topology_config ? 'board_types';
UPDATE meta.project_state SET topology_config=jsonb_set(topology_config,'{board_types}',
 (SELECT jsonb_agg(CASE WHEN b->>'code'='DSP' AND b->>'point_storage'='native' THEN b || '{"point_rules": {"sheet_layout": true, "inherit_name": true, "category_models": {"系统参数1": 1, "系统参数2": 2, "任务级观测量": 99, "中断级观测量": 100, "控制参数设置": 102, "任务级标定量": 103}, "value_options": {"access": ["RO", "RW"], "ram": ["Y", "N"], "flash": ["Y", "N"], "eeprom": ["Y", "N"], "calibration": ["Y", "N"], "cpu": ["CPU1", "CPU2"], "upload_level": ["0：不上传", "1：上传至UPM", "2：UPM进行轮询", "3：CSU进行轮询"]}}, "workbook_import": "workbook.json"}'::jsonb ELSE b END ORDER BY n)
 FROM jsonb_array_elements(topology_config->'board_types') WITH ORDINALITY AS a(b,n)))
 WHERE topology_config ? 'board_types';
UPDATE meta.project_state SET topology_config=jsonb_set(topology_config,'{board_types}',
 (SELECT jsonb_agg(CASE WHEN b->>'code' IN ('DSP','UPM') AND b->>'point_storage'='native' THEN jsonb_set(b,'{point_groups}',
 (SELECT jsonb_agg(g || jsonb_build_object('collect_enabled',g->>'code'<>'LOCAL') ORDER BY gn) FROM jsonb_array_elements(b->'point_groups') WITH ORDINALITY AS gs(g,gn))) ELSE b END ORDER BY n)
 FROM jsonb_array_elements(topology_config->'board_types') WITH ORDINALITY AS a(b,n)))
 WHERE topology_config ? 'board_types';
DELETE FROM meta.previews;
ALTER TABLE meta.project_state DROP CONSTRAINT project_state_schema_version_check;
ALTER TABLE meta.project_state ALTER COLUMN schema_version SET DEFAULT 7;
UPDATE meta.project_state SET schema_version=7,revision=revision+1,updated_at=now();
ALTER TABLE meta.project_state ADD CONSTRAINT project_state_schema_version_check CHECK(schema_version=7);
