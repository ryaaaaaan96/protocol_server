-- Replaces SUMIF / FILTER / VSTACK / XLOOKUP / TOCOL in the workbook.
-- Keep SQL in version control: one row per source point, device expansion by JOIN.
CREATE VIEW v_points WITH (security_invoker = true) AS
WITH ordered AS (
  SELECT p.*,
    COALESCE(SUM(byte_length) OVER(PARTITION BY project_id,scope ORDER BY ordinal,id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)::bigint AS preceding_bytes,
    COALESCE(SUM(byte_length) OVER(PARTITION BY project_id,scope,upp_model ORDER BY ordinal,id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)::bigint AS model_preceding_bytes,
    COUNT(*) FILTER(WHERE modbus_address IS NOT NULL) OVER(PARTITION BY project_id,scope ORDER BY ordinal,id) AS address_group
  FROM points p
), resolved AS (
  SELECT o.*,
    CASE WHEN o.signal_id ~ '^[0-9]{1,5}$' THEN NULLIF(o.signal_id::int,0) ELSE s.signal_id END AS resolved_signal_id,
    ((o.byte_length + 1) / 2)::int AS register_length,
    CASE o.access WHEN 'RO' THEN '3x' WHEN 'RW' THEN '4x' WHEN 'WO' THEN '4x' END AS register_type,
    CASE WHEN o.address_mode='manual' THEN o.modbus_address::bigint
         WHEN o.address_mode='auto' AND o.scope='DSP' THEN o.preceding_bytes / 2
         WHEN o.address_mode='auto' AND o.scope='LOCAL' THEN
           MAX(o.modbus_address) OVER(PARTITION BY o.project_id,o.scope,o.address_group)
           + (o.preceding_bytes - MIN(o.preceding_bytes) OVER(PARTITION BY o.project_id,o.scope,o.address_group))/2
    END AS resolved_address,
    COALESCE(o.upp_offset::bigint,6+o.model_preceding_bytes) AS resolved_upp_offset
  FROM ordered o LEFT JOIN platform_signals s ON s.project_id=o.project_id AND s.symbol=o.signal_id
)
SELECT r.*,
  CASE WHEN r.resolved_signal_id IS NOT NULL THEN r.resolved_signal_id::bigint
       ELSE 29999+COUNT(*) FILTER(WHERE r.resolved_signal_id IS NULL) OVER(PARTITION BY r.project_id,r.scope ORDER BY r.ordinal,r.id)
  END AS collect_signal_id
FROM resolved r;

CREATE VIEW v_transmit WITH (security_invoker = true) AS
SELECT p.project_id,p.id AS point_id,p.name,p.enum_name,p.scope,p.ordinal,
       p.resolved_signal_id AS signal_id,d.code AS device_code,d.name AS device_name,
       p.register_type,CASE p.access WHEN 'RO' THEN 4 ELSE 3 END AS function_code,
       p.resolved_address+d.base_address AS register_address,
       p.register_length,p.data_type,p.access,p.unit,p.scale,
       d.base_address,d.end_address
FROM v_points p JOIN devices d ON d.project_id=p.project_id AND d.scope=p.scope
WHERE p.resolved_signal_id IS NOT NULL AND p.resolved_address IS NOT NULL;

CREATE VIEW v_collect WITH (security_invoker = true) AS
SELECT project_id,id AS point_id,name,enum_name,upp_model,
       resolved_upp_offset AS upp_offset,byte_length,data_type,access,
       collect_signal_id AS signal_id,scale,poll_interval,set_priority,scan_priority
FROM v_points WHERE scope='DSP';

CREATE VIEW v_signal_ranges WITH (security_invoker = true) AS
SELECT project_id,id AS point_id,scope,name,enum_name,resolved_signal_id AS signal_id,
       data_type,byte_length,default_value,min_value,max_value
FROM v_points WHERE resolved_signal_id IS NOT NULL
AND (default_value<>'' OR min_value<>'' OR max_value<>'');
