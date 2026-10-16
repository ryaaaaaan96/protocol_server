-- Trusted preview baselines; old previews retain strict revision checking.
ALTER TABLE change_previews ADD COLUMN merge_base JSONB;
ALTER TABLE change_previews ADD COLUMN merge_patch JSONB;
