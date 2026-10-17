CREATE TABLE project_edit_locks (
 project_id BIGINT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 user_id BIGINT NOT NULL REFERENCES users(id),
 expires_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE project_edit_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_edit_locks FORCE ROW LEVEL SECURITY;
CREATE POLICY edit_lock_read ON project_edit_locks FOR SELECT USING(app_can_access(project_id));
CREATE POLICY edit_lock_insert ON project_edit_locks FOR INSERT WITH CHECK(app_can_access(project_id,true) AND user_id=app_user_id());
CREATE POLICY edit_lock_update ON project_edit_locks FOR UPDATE USING(app_can_access(project_id,true)) WITH CHECK(app_can_access(project_id,true) AND user_id=app_user_id());
CREATE POLICY edit_lock_delete ON project_edit_locks FOR DELETE USING(app_can_access(project_id,true));
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='protocol_app') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON project_edit_locks TO protocol_app;
 END IF;
END $$;
