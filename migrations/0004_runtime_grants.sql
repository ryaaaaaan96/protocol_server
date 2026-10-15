-- Deployment creates this LOGIN role before migrations; it never owns tables.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='protocol_app') THEN
    GRANT USAGE ON SCHEMA public TO protocol_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO protocol_app;
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO protocol_app;
    REVOKE ALL ON _sqlx_migrations FROM protocol_app;
    REVOKE UPDATE,DELETE ON audit_logs,releases FROM protocol_app;
  END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
