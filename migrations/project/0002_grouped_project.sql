-- Keep one project in one database; schemas group business data, retained
-- history, and operational metadata without introducing compatibility tables.
CREATE SCHEMA points;
CREATE SCHEMA history;
CREATE SCHEMA meta;
REVOKE CREATE ON SCHEMA points,history,meta,public FROM PUBLIC;

ALTER TABLE public.process_points SET SCHEMA points;
ALTER TABLE public.transmit_points SET SCHEMA points;
ALTER TABLE public.releases SET SCHEMA history;
ALTER TABLE public.project_state SET SCHEMA meta;

ALTER TABLE meta.project_state
 ADD COLUMN edit_owner_id BIGINT,
 ADD COLUMN edit_owner_name TEXT,
 ADD COLUMN edit_owner_username TEXT,
 ADD COLUMN edit_expires_at TIMESTAMPTZ,
 ADD CONSTRAINT project_state_edit_lease CHECK(
  (edit_owner_id IS NULL AND edit_owner_name IS NULL AND edit_owner_username IS NULL AND edit_expires_at IS NULL)
  OR (edit_owner_id IS NOT NULL AND edit_owner_name IS NOT NULL AND edit_owner_username IS NOT NULL AND edit_expires_at IS NOT NULL)
 );
UPDATE meta.project_state s SET edit_owner_id=l.user_id,
 edit_owner_name=l.owner_name,edit_owner_username=l.owner_username,edit_expires_at=l.expires_at
FROM public.project_edit_locks l WHERE s.id=l.project_id;

CREATE TABLE history.events (
 id BIGSERIAL PRIMARY KEY,
 project_id BIGINT NOT NULL REFERENCES meta.project_state(id),
 kind TEXT NOT NULL CHECK(kind IN ('point','audit','import')),
 action TEXT NOT NULL CHECK(length(action)>0),
 entity TEXT NOT NULL DEFAULT '',
 entity_type TEXT, record_id BIGINT, board_key TEXT, group_key TEXT,
 batch_id UUID, batch_label TEXT,
 before_data JSONB, after_data JSONB,
 actor_id BIGINT, actor_name TEXT NOT NULL DEFAULT '',
 project_revision INT CHECK(project_revision>0), config_snapshot JSONB,
 metadata JSONB NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata)='object'),
 legacy_source TEXT, legacy_id BIGINT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK((legacy_source IS NULL AND legacy_id IS NULL)
    OR (legacy_source IN ('point_history','audit_logs','imports') AND legacy_id IS NOT NULL)),
 CHECK(kind<>'point' OR (entity_type IN ('process','transmit') AND entity_type IS NOT NULL
  AND record_id IS NOT NULL AND board_key IS NOT NULL AND batch_id IS NOT NULL AND batch_label IS NOT NULL
  AND actor_id IS NOT NULL AND project_revision IS NOT NULL
  AND (before_data IS NULL OR jsonb_typeof(before_data)='object')
  AND (after_data IS NULL OR jsonb_typeof(after_data)='object')
  AND ((action='insert' AND before_data IS NULL AND after_data IS NOT NULL)
    OR (action='delete' AND before_data IS NOT NULL AND after_data IS NULL)
    OR (action='update' AND before_data IS NOT NULL AND after_data IS NOT NULL)))),
 CHECK(kind<>'import' OR (actor_id IS NOT NULL AND action='import.complete'
  AND metadata ?& ARRAY['filename','sha256','report']
  AND jsonb_typeof(metadata->'filename')='string' AND jsonb_typeof(metadata->'sha256')='string'))
);
CREATE UNIQUE INDEX events_legacy_identity ON history.events(legacy_source,legacy_id)
 WHERE legacy_source IS NOT NULL;
CREATE INDEX events_project ON history.events(project_id,id DESC);
CREATE INDEX events_kind ON history.events(project_id,kind,id DESC);
CREATE INDEX events_record ON history.events(project_id,entity_type,record_id,id DESC) WHERE kind='point';
CREATE INDEX events_batch ON history.events(project_id,batch_id) WHERE batch_id IS NOT NULL;

-- Preserve point-history IDs so existing point-history links remain valid.
INSERT INTO history.events(id,project_id,kind,action,entity,entity_type,record_id,board_key,group_key,
 batch_id,batch_label,before_data,after_data,actor_id,actor_name,project_revision,config_snapshot,
 legacy_source,legacy_id,created_at)
SELECT id,project_id,'point',action,entity_type,entity_type,record_id,board_key,group_key,
 batch_id,batch_label,before_data,after_data,actor_id,actor_name,project_revision,config_snapshot,
 'point_history',id,created_at FROM public.point_history;
-- A rolled-back insertion can leave the sequence ahead of the visible rows.
SELECT setval('history.events_id_seq',GREATEST(
 (SELECT last_value FROM public.point_history_id_seq),
 COALESCE((SELECT max(id) FROM history.events),1)),true);
INSERT INTO history.events(project_id,kind,action,entity,before_data,after_data,actor_id,actor_name,
 legacy_source,legacy_id,created_at)
SELECT COALESCE(project_id,(SELECT id FROM meta.project_state)),'audit',action,entity,
 before_data,after_data,user_id,actor_name,'audit_logs',id,created_at FROM public.audit_logs ORDER BY id;
INSERT INTO history.events(project_id,kind,action,entity,actor_id,actor_name,metadata,
 legacy_source,legacy_id,created_at)
SELECT project_id,'import','import.complete','workbook',created_by,created_by_name,
 jsonb_build_object('filename',filename,'sha256',sha256,'report',report),
 'imports',id,created_at FROM public.imports ORDER BY id;

CREATE TABLE meta.previews (
 id BIGSERIAL PRIMARY KEY,
 project_id BIGINT NOT NULL REFERENCES meta.project_state(id),
 kind TEXT NOT NULL CHECK(kind IN ('change','import')),
 created_by BIGINT NOT NULL, revision INT NOT NULL CHECK(revision>0),
 payload JSONB NOT NULL, merge_base JSONB, merge_patch JSONB,
 filename TEXT, sha256 TEXT,
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '15 minutes',
 CHECK(kind<>'import' OR (filename IS NOT NULL AND sha256 IS NOT NULL))
);
CREATE INDEX previews_owner ON meta.previews(project_id,created_by,kind);
CREATE INDEX previews_expiry ON meta.previews(expires_at);
-- Pending payloads describe the old schema. Invalidate all of them and never
-- reuse an old preview ID, including IDs consumed by rolled-back insertions.
SELECT setval('meta.previews_id_seq',GREATEST(
 (SELECT last_value FROM public.change_previews_id_seq),
 (SELECT last_value FROM public.import_previews_id_seq),
 COALESCE((SELECT max(id) FROM public.change_previews),1),
 COALESCE((SELECT max(id) FROM public.import_previews),1)),true);
ALTER TABLE meta.project_state DROP CONSTRAINT project_state_schema_version_check;
ALTER TABLE meta.project_state ALTER COLUMN schema_version SET DEFAULT 5;
UPDATE meta.project_state SET schema_version=5,revision=revision+1,updated_at=now();
ALTER TABLE meta.project_state ADD CONSTRAINT project_state_schema_version_check CHECK(schema_version=5);

-- Replace string-body functions after moving their tables. Schema-qualify all
-- application references and keep pg_temp last to prevent temporary shadowing.
CREATE OR REPLACE FUNCTION public.app_can_access(pid BIGINT,writing BOOLEAN DEFAULT FALSE)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT pid=NULLIF(current_setting('app.project_id',true),'')::bigint
 AND public.app_user_id() IS NOT NULL
 AND EXISTS(SELECT 1 FROM meta.project_state WHERE id=pid)
 AND COALESCE(public.app_access()->>'role' IN ('admin','engineer','viewer'),false)
 AND (NOT writing OR public.app_is_admin() OR (public.app_access()->>'role'='engineer'
  AND (public.app_access()->>'edit_scope'='all' OR jsonb_array_length(COALESCE(public.app_access()->'grants','[]'::jsonb))>0)))
$$;
CREATE OR REPLACE FUNCTION public.app_project_identity()
RETURNS TABLE(id BIGINT,config_key TEXT,project_uid TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT id,config_key,project_uid::text FROM meta.project_state
$$;
CREATE OR REPLACE FUNCTION public.app_is_admin() RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT COALESCE(public.app_access()->>'role'='admin',false)
$$;

ALTER TABLE history.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE history.events FORCE ROW LEVEL SECURITY;
CREATE POLICY events_read ON history.events FOR SELECT USING(
 project_id=(SELECT public.app_project_id()) AND (SELECT public.app_can_access(public.app_project_id())));
CREATE POLICY events_insert ON history.events FOR INSERT WITH CHECK(
 project_id=(SELECT public.app_project_id()) AND actor_id=(SELECT public.app_user_id())
 AND (SELECT public.app_can_access(public.app_project_id()))
 AND (kind='audit' OR (SELECT public.app_can_access(public.app_project_id(),true)))
 AND legacy_source IS NULL AND legacy_id IS NULL);
ALTER TABLE meta.previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta.previews FORCE ROW LEVEL SECURITY;
CREATE POLICY previews_owner ON meta.previews USING(
 created_by=(SELECT public.app_user_id()) AND project_id=(SELECT public.app_project_id())
 AND (SELECT public.app_can_access(public.app_project_id(),true))) WITH CHECK(
 created_by=(SELECT public.app_user_id()) AND project_id=(SELECT public.app_project_id())
 AND (SELECT public.app_can_access(public.app_project_id(),true)));

DROP TABLE public.point_history,public.audit_logs,public.imports,
 public.change_previews,public.import_previews,public.project_edit_locks;
