CREATE TABLE import_previews (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    created_by BIGINT NOT NULL REFERENCES users(id),
    filename TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    revision INT NOT NULL,
    payload JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '1 hour'
);
ALTER TABLE import_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_previews FORCE ROW LEVEL SECURITY;
CREATE POLICY preview_owner ON import_previews USING(created_by=app_user_id() AND app_can_access(project_id,true));
