-- Existing engineers retain their permissions; new assignments can be restricted.
ALTER TABLE project_members ADD COLUMN edit_scope TEXT NOT NULL DEFAULT 'all'
 CHECK(edit_scope IN ('all','scoped'));
CREATE TABLE project_member_grants (
 project_id BIGINT NOT NULL,
 user_id BIGINT NOT NULL,
 model_id BIGINT NOT NULL,
 scope TEXT NOT NULL CHECK(scope IN ('board','internal','protocol')),
 contract_id BIGINT,
 CHECK((scope='protocol')=(contract_id IS NOT NULL)),
 FOREIGN KEY(project_id,user_id) REFERENCES project_members(project_id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,model_id) REFERENCES board_models(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,contract_id) REFERENCES protocol_contracts(project_id,id) ON DELETE CASCADE,
 UNIQUE NULLS NOT DISTINCT(project_id,user_id,model_id,scope,contract_id)
);
ALTER TABLE project_member_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_member_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY grant_read ON project_member_grants FOR SELECT USING(app_can_access(project_id));
CREATE POLICY grant_write ON project_member_grants FOR ALL
 USING(app_is_admin() AND app_can_access(project_id))
 WITH CHECK(app_is_admin() AND app_can_access(project_id));
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='protocol_app') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON project_member_grants TO protocol_app;
 END IF;
END $$;
