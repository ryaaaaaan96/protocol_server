-- Only the current point rows are relational business data. Topology and scopes
-- use stable keys from the applied project JSON. Keep all current IDs/history.
DO $$ DECLARE t TEXT; occupied BOOLEAN; BEGIN
  -- These records have no lossless equivalent in the DSP-only point model.
  -- Refuse the upgrade instead of silently deleting older projects' data.
  FOREACH t IN ARRAY ARRAY[
    'points','devices','platform_signals','boards','data_items','signal_groups',
    'signals','signal_ranges','device_contexts','protocol_fields','signal_bindings',
    'board_links','passthrough_routes','source_records'
  ] LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I)',t) INTO occupied;
    IF occupied THEN
      RAISE EXCEPTION 'Cannot simplify database: legacy table % contains data; migrate/export its records before retrying', t;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM board_models m JOIN projects p ON p.id=m.project_id
    WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(p.topology_config->'board_types','[]'::jsonb)) b
      WHERE b->>'model_code'=m.code
    )
  ) THEN
    RAISE EXCEPTION 'Cannot simplify database: a legacy board model has no applied JSON definition';
  END IF;
  IF EXISTS (
    SELECT 1 FROM endpoints e JOIN protocol_contracts c ON c.id=e.contract_id
    JOIN board_models m ON m.id=e.model_id JOIN projects p ON p.id=e.project_id
    WHERE e.role<>'server' OR c.protocol<>'UPP' OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(p.topology_config->'board_types','[]'::jsonb)) b
      WHERE b->>'model_code'=m.code AND b->>'point_storage'='native'
    )
  ) OR EXISTS (
    SELECT 1 FROM protocol_contracts c
    WHERE NOT EXISTS (SELECT 1 FROM endpoints e WHERE e.contract_id=c.id)
  ) THEN
    RAISE EXCEPTION 'Cannot simplify database: legacy protocol configuration cannot be represented by native UPP endpoints';
  END IF;
  -- point_endpoints stores only code/name/protocol. A board-level mount does
  -- not identify a particular endpoint, so even a matching transport must not
  -- be silently treated as an equivalent endpoint configuration.
  IF EXISTS (
    SELECT 1 FROM endpoints e
    WHERE e.port<>'' OR NOT e.enabled OR e.transport<>'UNSPECIFIED'
  ) OR EXISTS (
    SELECT 1 FROM protocol_contracts c WHERE c.description<>''
  ) THEN
    RAISE EXCEPTION 'Cannot simplify database: legacy endpoint transport/port/disabled state or contract description has no JSON equivalent; migrate its configuration before retrying';
  END IF;
  -- Every existing grant must have an unambiguous, non-broadened key mapping.
  IF EXISTS (
    SELECT 1 FROM project_member_grants g JOIN board_models m ON m.id=g.model_id
    JOIN projects p ON p.id=g.project_id
    WHERE (SELECT count(*) FROM jsonb_array_elements(COALESCE(p.topology_config->'board_types','[]'::jsonb)) b
           WHERE b->>'model_code'=m.code)<>1
       OR (g.scope='protocol' AND NOT EXISTS (
         SELECT 1 FROM endpoints e WHERE e.project_id=g.project_id
           AND e.model_id=g.model_id AND e.contract_id=g.contract_id
       ))
  ) THEN
    RAISE EXCEPTION 'Cannot simplify database: member grants cannot be mapped to JSON board/endpoint keys';
  END IF;
END $$;

-- Preserve explicit endpoint metadata; supplement it from native rows and the
-- compatible old server endpoint definitions before removing their tables.
UPDATE projects p SET topology_config=jsonb_set(p.topology_config,'{board_types}', (
  SELECT jsonb_agg(CASE WHEN b->>'point_storage'='native' THEN
    b || jsonb_build_object('point_endpoints',(
      SELECT jsonb_agg(item ORDER BY item->>'code') FROM (
        SELECT DISTINCT ON (item->>'code') item FROM (
          SELECT item,0 AS priority FROM jsonb_array_elements(COALESCE(b->'point_endpoints','[]'::jsonb)) item
          UNION ALL
          SELECT jsonb_build_object('code',e.code,'name',e.name,'protocol','UPP'),1
          FROM endpoints e JOIN board_models m ON m.id=e.model_id
          WHERE e.project_id=p.id AND m.code=b->>'model_code'
          UNION ALL
          SELECT jsonb_build_object('code',t.endpoint_key,'name',t.endpoint_key,'protocol','UPP'),2
          FROM transmit_points t WHERE t.project_id=p.id AND t.board_key=b->>'code'
          UNION ALL
          SELECT jsonb_build_object('code','UPP_SERVICE','name','UPP 转发表','protocol','UPP'),3
        ) candidates ORDER BY item->>'code',priority
      ) chosen
    )) ELSE b END ORDER BY ord)
  FROM jsonb_array_elements(p.topology_config->'board_types') WITH ORDINALITY board(b,ord)
)) WHERE jsonb_typeof(p.topology_config->'board_types')='array';

CREATE TEMP TABLE migrated_member_grants ON COMMIT DROP AS
SELECT DISTINCT g.project_id,g.user_id,b->>'code' AS board_key,g.scope,
       CASE WHEN g.scope='protocol' THEN e.code END AS endpoint_key
FROM project_member_grants g
JOIN board_models m ON m.project_id=g.project_id AND m.id=g.model_id
JOIN projects p ON p.id=g.project_id
CROSS JOIN LATERAL jsonb_array_elements(p.topology_config->'board_types') b
LEFT JOIN endpoints e ON g.scope='protocol' AND e.project_id=g.project_id
  AND e.model_id=g.model_id AND e.contract_id=g.contract_id
WHERE b->>'model_code'=m.code;

DELETE FROM project_member_grants;
ALTER TABLE project_member_grants DROP COLUMN model_id, DROP COLUMN contract_id;
ALTER TABLE project_member_grants
  ADD COLUMN board_key TEXT NOT NULL CHECK(board_key ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  ADD COLUMN endpoint_key TEXT CHECK(endpoint_key ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  ADD CONSTRAINT member_grant_endpoint_scope CHECK((scope='protocol')=(endpoint_key IS NOT NULL)),
  ADD CONSTRAINT member_grant_keys UNIQUE NULLS NOT DISTINCT(project_id,user_id,board_key,scope,endpoint_key);
INSERT INTO project_member_grants(project_id,user_id,board_key,scope,endpoint_key)
  SELECT project_id,user_id,board_key,scope,endpoint_key FROM migrated_member_grants;

-- Preview baselines refer to the old graph and must not survive this boundary.
DELETE FROM change_previews;
DELETE FROM import_previews;
UPDATE projects SET schema_version=3,revision=revision+1,updated_at=now();
ALTER TABLE projects ALTER COLUMN schema_version SET DEFAULT 3;

DROP VIEW v_transmit,v_collect,v_signal_ranges,v_points;
DROP VIEW v_bindings,v_passthrough_fields,v_topology_links,v_signals,v_protocol_fields;
DROP TABLE board_links,passthrough_routes,signal_bindings;
DROP TABLE device_contexts,signal_ranges,protocol_fields,endpoints;
DROP TABLE signals,signal_groups,boards;
DROP TABLE protocol_contracts,data_items,board_models;
DROP TABLE source_records,points,devices,platform_signals;
