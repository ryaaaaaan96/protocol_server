-- Group platform responsibilities without changing rows, identifiers, leases,
-- permissions, or the separate project database schemas.
CREATE SCHEMA auth;
CREATE SCHEMA meta;
CREATE SCHEMA history;
REVOKE CREATE ON SCHEMA auth,meta,history,public FROM PUBLIC;

ALTER TABLE public.users SET SCHEMA auth;
ALTER TABLE public.sessions SET SCHEMA auth;
ALTER TABLE public.login_attempts SET SCHEMA auth;
ALTER TABLE public.projects SET SCHEMA meta;
ALTER TABLE public.project_members SET SCHEMA meta;
ALTER TABLE public.project_member_grants SET SCHEMA meta;
ALTER TABLE public.audit_logs SET SCHEMA history;

-- ALTER TABLE preserves row types, foreign keys, sequences, policies and table
-- grants. String-body functions need qualified references after the move.
CREATE OR REPLACE FUNCTION public.app_is_admin() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM auth.users
  WHERE id=public.app_user_id() AND active AND is_admin)
$$;
CREATE OR REPLACE FUNCTION public.app_can_access(pid BIGINT,writing BOOLEAN DEFAULT FALSE)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT (NULLIF(current_setting('app.project_id',true),'') IS NULL
  OR pid=NULLIF(current_setting('app.project_id',true),'')::bigint)
 AND (public.app_is_admin() OR EXISTS(
  SELECT 1 FROM meta.project_members m JOIN auth.users u ON u.id=m.user_id
  WHERE m.project_id=pid AND u.id=public.app_user_id() AND u.active
  AND (NOT writing OR m.role='engineer')))
$$;
CREATE OR REPLACE FUNCTION public.app_project_registry(pid BIGINT)
RETURNS SETOF meta.projects LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT * FROM meta.projects WHERE id=pid
$$;
CREATE OR REPLACE FUNCTION public.app_lock_project(pid BIGINT)
RETURNS SETOF meta.projects LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT * FROM meta.projects WHERE id=pid AND public.app_can_access(id) FOR SHARE
$$;
