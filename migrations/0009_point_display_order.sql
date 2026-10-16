-- Presentation order is separate from signal identity and protocol address layout.
ALTER TABLE signals ADD COLUMN display_order BIGINT CHECK (display_order >= 0);
ALTER TABLE signal_bindings ADD COLUMN display_order BIGINT CHECK (display_order >= 0);
