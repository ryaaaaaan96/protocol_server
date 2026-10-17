-- Bounds describe numbers. A STRING signal may inherit its default value and byte
-- length, but must not inherit numeric bounds from a shared data definition.
-- Preserve historical stored values; explicit edits clear obsolete overrides via
-- the normal preview/audit workflow. This migration changes no business records.
CREATE OR REPLACE VIEW v_signals WITH (security_invoker=true) AS
 SELECT s.id,s.project_id,s.group_id,s.data_item_id,s.name,s.enum_name,s.sig_id,s.sig_symbol,
 s.flags,s.callback,s.internal_type,s.process_enabled,
 g.model_id,g.name AS group_name,g.code AS group_code,
 COALESCE(s.internal_type,d.data_type) AS data_type,d.byte_length,d.unit,d.notes,d.source_sheet,d.source_row,
 COALESCE(s.sig_id,ps.signal_id) AS resolved_sig_id,
 COALESCE(r.default_value,d.default_value) AS default_value,
 CASE WHEN COALESCE(s.internal_type,d.data_type)='STRING' THEN '' ELSE COALESCE(r.min_value,d.min_value) END AS min_value,
 CASE WHEN COALESCE(s.internal_type,d.data_type)='STRING' THEN '' ELSE COALESCE(r.max_value,d.max_value) END AS max_value,
 COALESCE(r.boot_restore,FALSE) AS boot_restore,COALESCE(r.manual_restore,FALSE) AS manual_restore
 FROM signals s JOIN signal_groups g ON g.id=s.group_id JOIN data_items d ON d.id=s.data_item_id
 LEFT JOIN platform_signals ps ON ps.project_id=s.project_id AND ps.symbol=s.sig_symbol
 LEFT JOIN signal_ranges r ON r.signal_id=s.id;
