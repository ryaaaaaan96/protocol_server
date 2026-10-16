-- Stable binding to a portable project directory; display names may change.
ALTER TABLE projects ADD COLUMN config_key TEXT UNIQUE
    CHECK (config_key ~ '^[a-z][a-z0-9_-]{0,63}$');
