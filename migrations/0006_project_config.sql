-- Project composition is stored as a portable document; tables remain normalized.
ALTER TABLE projects ADD COLUMN topology_config JSONB;
ALTER TABLE projects ADD CONSTRAINT project_config_object
 CHECK(topology_config IS NULL OR jsonb_typeof(topology_config)='object');
