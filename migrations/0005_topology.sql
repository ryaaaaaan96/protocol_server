-- Source definitions, local identities and protocol contracts are separate.
-- Keep the original flat tables as a migration archive; only the v2 graph is writable.
ALTER TABLE projects ADD COLUMN schema_version INT NOT NULL DEFAULT 1;
ALTER TABLE projects ALTER COLUMN schema_version SET DEFAULT 2;
ALTER TABLE platform_signals ADD COLUMN id BIGSERIAL;
ALTER TABLE platform_signals ADD UNIQUE(project_id,id);

CREATE TABLE board_models (
 id BIGSERIAL PRIMARY KEY, project_id BIGINT NOT NULL REFERENCES projects(id),
 name TEXT NOT NULL, code TEXT NOT NULL CHECK(code ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
 description TEXT NOT NULL DEFAULT '', firmware_profile TEXT NOT NULL DEFAULT 'contract' CHECK(firmware_profile IN ('contract','aidc')),
 UNIQUE(project_id,id), UNIQUE(project_id,code)
);
CREATE TABLE boards (
 id BIGSERIAL PRIMARY KEY, project_id BIGINT NOT NULL, model_id BIGINT NOT NULL,
 name TEXT NOT NULL, code TEXT NOT NULL CHECK(code ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
 UNIQUE(project_id,id), UNIQUE(project_id,code),
 FOREIGN KEY(project_id,model_id) REFERENCES board_models(project_id,id)
);
CREATE TABLE data_items (
 id BIGSERIAL PRIMARY KEY, project_id BIGINT NOT NULL REFERENCES projects(id),
 name TEXT NOT NULL, data_type TEXT NOT NULL CHECK(data_type IN ('U8','U16','S16','U32','S32','F32','STRING')),
 byte_length INT NOT NULL CHECK(byte_length BETWEEN 1 AND 65535),
 unit TEXT NOT NULL DEFAULT '', default_value TEXT NOT NULL DEFAULT '',
 min_value TEXT NOT NULL DEFAULT '', max_value TEXT NOT NULL DEFAULT '',
 notes TEXT NOT NULL DEFAULT '', source_sheet TEXT NOT NULL DEFAULT '', source_row INT,
 raw_json JSONB NOT NULL DEFAULT '{}', UNIQUE(project_id,id)
);
CREATE TABLE signal_groups (
 id BIGSERIAL PRIMARY KEY, project_id BIGINT NOT NULL, model_id BIGINT NOT NULL,
 name TEXT NOT NULL, code TEXT NOT NULL CHECK(code ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
 UNIQUE(project_id,id), UNIQUE(model_id,code),
 FOREIGN KEY(project_id,model_id) REFERENCES board_models(project_id,id)
);
CREATE TABLE signals (
 id BIGSERIAL PRIMARY KEY, project_id BIGINT NOT NULL, group_id BIGINT NOT NULL, data_item_id BIGINT NOT NULL,
 name TEXT NOT NULL, enum_name TEXT NOT NULL CHECK(enum_name ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
 sig_id INT CHECK(sig_id BETWEEN 1 AND 65535), sig_symbol TEXT,
 flags TEXT NOT NULL DEFAULT '0', callback TEXT NOT NULL DEFAULT 'NULL',
 internal_type TEXT CHECK(internal_type IN ('U8','U16','S16','U32','S32','F32','STRING')),
 process_enabled BOOLEAN NOT NULL DEFAULT TRUE,
 UNIQUE(project_id,id), UNIQUE(group_id,enum_name), UNIQUE(group_id,sig_id),
 CHECK(sig_id IS NULL OR sig_symbol IS NULL),
 FOREIGN KEY(project_id,group_id) REFERENCES signal_groups(project_id,id),
 FOREIGN KEY(project_id,data_item_id) REFERENCES data_items(project_id,id),
 FOREIGN KEY(project_id,sig_symbol) REFERENCES platform_signals(project_id,symbol)
);
CREATE TABLE signal_ranges (
 id BIGSERIAL PRIMARY KEY, project_id BIGINT NOT NULL, signal_id BIGINT NOT NULL UNIQUE,
 default_value TEXT, min_value TEXT, max_value TEXT,
 boot_restore BOOLEAN NOT NULL DEFAULT FALSE, manual_restore BOOLEAN NOT NULL DEFAULT FALSE,
 UNIQUE(project_id,id), FOREIGN KEY(project_id,signal_id) REFERENCES signals(project_id,id)
);
CREATE TABLE device_contexts (
 id BIGSERIAL PRIMARY KEY, project_id BIGINT NOT NULL, model_id BIGINT NOT NULL, group_id BIGINT,
 name TEXT NOT NULL, code TEXT NOT NULL CHECK(code ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
 dev_id INT NOT NULL CHECK(dev_id BETWEEN 1 AND 255),
 kind TEXT NOT NULL CHECK(kind IN ('local','proxy','virtual')),
 UNIQUE(project_id,id), UNIQUE(model_id,dev_id), UNIQUE(model_id,code),
 FOREIGN KEY(project_id,model_id) REFERENCES board_models(project_id,id),
 FOREIGN KEY(project_id,group_id) REFERENCES signal_groups(project_id,id)
);
CREATE TABLE protocol_contracts (
 id BIGSERIAL PRIMARY KEY, project_id BIGINT NOT NULL REFERENCES projects(id),
 name TEXT NOT NULL, code TEXT NOT NULL CHECK(code ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
 protocol TEXT NOT NULL CHECK(protocol IN ('MODBUS','UPP')),
 description TEXT NOT NULL DEFAULT '', UNIQUE(project_id,id), UNIQUE(project_id,code)
);
CREATE TABLE protocol_fields (
 id BIGSERIAL PRIMARY KEY, project_id BIGINT NOT NULL, contract_id BIGINT NOT NULL, data_item_id BIGINT NOT NULL,
 name TEXT NOT NULL, ordinal INT NOT NULL DEFAULT 0 CHECK(ordinal>=0),
 access TEXT NOT NULL DEFAULT 'RO' CHECK(access IN ('RO','RW','WO')),
 address_mode TEXT NOT NULL DEFAULT 'auto' CHECK(address_mode IN ('auto','manual')),
 address INT CHECK(address BETWEEN 0 AND 65535), model INT NOT NULL DEFAULT 0 CHECK(model BETWEEN 0 AND 65535),
 register_type INT NOT NULL DEFAULT 4 CHECK(register_type IN (3,4)),
 wire_type TEXT CHECK(wire_type IN ('U8','U16','S16','U32','S32','F32','STRING')),
 wire_length INT CHECK(wire_length BETWEEN 1 AND 65535),
 scale DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK(scale>0 AND scale<'Infinity'::float8),
 byte_order INT NOT NULL DEFAULT 0 CHECK(byte_order BETWEEN 0 AND 3),
 UNIQUE(project_id,id), CHECK(address_mode<>'manual' OR address IS NOT NULL),
 FOREIGN KEY(project_id,contract_id) REFERENCES protocol_contracts(project_id,id),
 FOREIGN KEY(project_id,data_item_id) REFERENCES data_items(project_id,id)
);
CREATE TABLE endpoints (
 id BIGSERIAL PRIMARY KEY, project_id BIGINT NOT NULL, model_id BIGINT NOT NULL, contract_id BIGINT NOT NULL,
 name TEXT NOT NULL, code TEXT NOT NULL CHECK(code ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
 role TEXT NOT NULL CHECK(role IN ('client','server')),
 transport TEXT NOT NULL CHECK(transport IN ('CAN','RS485','TCP','UNSPECIFIED')),
 port TEXT NOT NULL DEFAULT '', enabled BOOLEAN NOT NULL DEFAULT TRUE,
 UNIQUE(project_id,id), UNIQUE(model_id,code),
 FOREIGN KEY(project_id,model_id) REFERENCES board_models(project_id,id),
 FOREIGN KEY(project_id,contract_id) REFERENCES protocol_contracts(project_id,id)
);
CREATE TABLE signal_bindings (
 id BIGSERIAL PRIMARY KEY, project_id BIGINT NOT NULL, endpoint_id BIGINT NOT NULL,
 context_id BIGINT NOT NULL, field_id BIGINT NOT NULL, signal_id BIGINT NOT NULL,
 poll_interval INT NOT NULL DEFAULT 0 CHECK(poll_interval BETWEEN 0 AND 255),
 set_priority INT NOT NULL DEFAULT 0 CHECK(set_priority BETWEEN 0 AND 3),
 scan_priority INT NOT NULL DEFAULT 0 CHECK(scan_priority BETWEEN 0 AND 1),
 UNIQUE(project_id,id), UNIQUE(endpoint_id,context_id,field_id),
 FOREIGN KEY(project_id,endpoint_id) REFERENCES endpoints(project_id,id),
 FOREIGN KEY(project_id,context_id) REFERENCES device_contexts(project_id,id),
 FOREIGN KEY(project_id,field_id) REFERENCES protocol_fields(project_id,id),
 FOREIGN KEY(project_id,signal_id) REFERENCES signals(project_id,id)
);
CREATE TABLE board_links (
 id BIGSERIAL PRIMARY KEY, project_id BIGINT NOT NULL, name TEXT NOT NULL,
 client_board_id BIGINT NOT NULL, client_endpoint_id BIGINT NOT NULL, client_context_id BIGINT NOT NULL,
 server_board_id BIGINT NOT NULL, server_endpoint_id BIGINT NOT NULL,
 remote_address INT NOT NULL CHECK(remote_address BETWEEN 0 AND 65535),
 dev_code INT NOT NULL DEFAULT 0 CHECK(dev_code BETWEEN 0 AND 65535),
 UNIQUE(project_id,id), UNIQUE(client_board_id,client_endpoint_id,client_context_id),
 CHECK(client_board_id<>server_board_id),
 FOREIGN KEY(project_id,client_board_id) REFERENCES boards(project_id,id),
 FOREIGN KEY(project_id,server_board_id) REFERENCES boards(project_id,id),
 FOREIGN KEY(project_id,client_endpoint_id) REFERENCES endpoints(project_id,id),
 FOREIGN KEY(project_id,server_endpoint_id) REFERENCES endpoints(project_id,id),
 FOREIGN KEY(project_id,client_context_id) REFERENCES device_contexts(project_id,id)
);
CREATE TABLE passthrough_routes (
 id BIGSERIAL PRIMARY KEY, project_id BIGINT NOT NULL, name TEXT NOT NULL,
 server_endpoint_id BIGINT NOT NULL, client_endpoint_id BIGINT NOT NULL, context_id BIGINT NOT NULL,
 base_address INT NOT NULL CHECK(base_address BETWEEN 0 AND 65535),
 end_address INT NOT NULL CHECK(end_address BETWEEN base_address AND 65535),
 register_type INT NOT NULL DEFAULT 3 CHECK(register_type IN (3,4)),
 writable BOOLEAN NOT NULL DEFAULT FALSE, callback TEXT NOT NULL DEFAULT '', UNIQUE(project_id,id),
 FOREIGN KEY(project_id,server_endpoint_id) REFERENCES endpoints(project_id,id),
 FOREIGN KEY(project_id,client_endpoint_id) REFERENCES endpoints(project_id,id),
 FOREIGN KEY(project_id,context_id) REFERENCES device_contexts(project_id,id)
);
CREATE TABLE source_records (
 id BIGSERIAL PRIMARY KEY, project_id BIGINT NOT NULL REFERENCES projects(id),
 sheet TEXT NOT NULL, row_number INT NOT NULL, cells JSONB NOT NULL,
 classification TEXT NOT NULL DEFAULT 'reference', UNIQUE(project_id,id), UNIQUE(project_id,sheet,row_number)
);
CREATE TABLE change_previews (
 id BIGSERIAL PRIMARY KEY, project_id BIGINT NOT NULL REFERENCES projects(id), created_by BIGINT NOT NULL REFERENCES users(id),
 revision INT NOT NULL, change JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '15 minutes'
);

CREATE VIEW v_signals WITH (security_invoker=true) AS
 SELECT s.*, g.model_id, g.name AS group_name, g.code AS group_code,
 COALESCE(s.internal_type,d.data_type) AS data_type,d.byte_length,d.unit,d.notes,d.source_sheet,d.source_row,
 COALESCE(s.sig_id,ps.signal_id) AS resolved_sig_id,
 COALESCE(r.default_value,d.default_value) AS default_value,
 COALESCE(r.min_value,d.min_value) AS min_value, COALESCE(r.max_value,d.max_value) AS max_value,
 COALESCE(r.boot_restore,FALSE) AS boot_restore,COALESCE(r.manual_restore,FALSE) AS manual_restore
 FROM signals s JOIN signal_groups g ON g.id=s.group_id JOIN data_items d ON d.id=s.data_item_id
 LEFT JOIN platform_signals ps ON ps.project_id=s.project_id AND ps.symbol=s.sig_symbol
 LEFT JOIN signal_ranges r ON r.signal_id=s.id;

-- Automatic offsets restart at each explicit anchor, per contract/model/register bank.
-- UPP addresses are bytes, Modbus addresses are 16-bit registers.
CREATE VIEW v_protocol_fields WITH (security_invoker=true) AS
 WITH shape AS (
 SELECT f.*, c.protocol,c.name AS contract_name,c.code AS contract_code,
 COALESCE(f.wire_type,d.data_type) AS effective_type,
 COALESCE(f.wire_length,d.byte_length) AS effective_length,d.unit,
 CASE WHEN c.protocol='UPP' THEN COALESCE(f.wire_length,d.byte_length)
 ELSE (COALESCE(f.wire_length,d.byte_length)+1)/2 END AS address_length,
 CASE WHEN c.protocol='UPP' THEN 0 ELSE f.register_type END AS bank
 FROM protocol_fields f JOIN protocol_contracts c ON c.id=f.contract_id JOIN data_items d ON d.id=f.data_item_id
 ), ordered AS (
 SELECT s.*,COALESCE(sum(address_length) OVER w,0)::bigint AS preceding,
 count(*) FILTER(WHERE address_mode='manual') OVER (PARTITION BY contract_id,model,bank ORDER BY ordinal,id) AS anchor_group
 FROM shape s WINDOW w AS (PARTITION BY contract_id,model,bank ORDER BY ordinal,id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
 )
 SELECT o.*,CASE WHEN address_mode='manual' THEN address::bigint ELSE
 COALESCE(max(address) FILTER(WHERE address_mode='manual') OVER a,CASE WHEN protocol='UPP' THEN 6 ELSE 0 END)
 + preceding-min(preceding) OVER a END AS effective_address
 FROM ordered o WINDOW a AS (PARTITION BY contract_id,model,bank,anchor_group);

CREATE VIEW v_bindings WITH (security_invoker=true) AS
 SELECT b.*,e.model_id,e.name AS endpoint_name,e.role,e.enabled,e.transport,e.port,
 c.name AS context_name,c.code AS context_code,c.dev_id,
 s.name AS signal_name,s.enum_name,s.resolved_sig_id,s.process_enabled,s.data_type,s.byte_length,
 f.name AS field_name,f.contract_id,f.protocol,f.model AS upp_model,f.effective_address,f.address_length,
 f.effective_type,f.effective_length,f.register_type,f.access,f.scale,f.byte_order
 FROM signal_bindings b JOIN endpoints e ON e.id=b.endpoint_id JOIN device_contexts c ON c.id=b.context_id
 JOIN v_signals s ON s.id=b.signal_id JOIN v_protocol_fields f ON f.id=b.field_id;

CREATE VIEW v_passthrough_fields WITH (security_invoker=true) AS
 SELECT r.project_id,r.id AS route_id,r.name AS route_name,e.model_id,r.server_endpoint_id,r.client_endpoint_id,r.context_id,
 r.base_address,r.end_address,r.register_type,r.writable,f.id AS field_id,f.name,f.model AS upp_model,
 f.effective_address AS upp_offset,f.effective_type,f.effective_length,f.access,
 r.base_address+COALESCE(sum((f.effective_length+1)/2) OVER (
 PARTITION BY r.id ORDER BY f.model,f.ordinal,f.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)::bigint AS register_address,
 (f.effective_length+1)/2 AS register_length
 FROM passthrough_routes r JOIN endpoints e ON e.id=r.client_endpoint_id
 JOIN v_protocol_fields f ON f.contract_id=e.contract_id;

CREATE VIEW v_topology_links WITH (security_invoker=true) AS
 SELECT l.*,cb.name AS client_board,sb.name AS server_board,ce.name AS client_endpoint,se.name AS server_endpoint,
 pc.name AS contract_name,pc.protocol,ce.transport,dc.code AS context_code,dc.dev_id
 FROM board_links l JOIN boards cb ON cb.id=l.client_board_id JOIN boards sb ON sb.id=l.server_board_id
 JOIN endpoints ce ON ce.id=l.client_endpoint_id JOIN endpoints se ON se.id=l.server_endpoint_id
 JOIN protocol_contracts pc ON pc.id=ce.contract_id JOIN device_contexts dc ON dc.id=l.client_context_id;

DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['board_models','boards','data_items','signal_groups','signals','signal_ranges','device_contexts','protocol_contracts','protocol_fields','endpoints','signal_bindings','board_links','passthrough_routes','source_records','change_previews'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY read_rows ON %I FOR SELECT USING(app_can_access(project_id))',t);
 EXECUTE format('CREATE POLICY write_rows ON %I FOR ALL USING(app_can_access(project_id,true)) WITH CHECK(app_can_access(project_id,true))',t);
 EXECUTE format('CREATE INDEX ON %I(project_id)',t);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='protocol_app') THEN
 GRANT SELECT,INSERT,UPDATE,DELETE ON board_models,boards,data_items,signal_groups,signals,signal_ranges,device_contexts,protocol_contracts,protocol_fields,endpoints,signal_bindings,board_links,passthrough_routes,source_records,change_previews TO protocol_app;
 GRANT SELECT ON v_signals,v_protocol_fields,v_bindings,v_passthrough_fields,v_topology_links TO protocol_app;
 GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO protocol_app;
 REVOKE INSERT,UPDATE,DELETE ON points,devices FROM protocol_app;
 END IF;
END $$;
