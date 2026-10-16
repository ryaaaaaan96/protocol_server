ALTER TABLE endpoints DROP CONSTRAINT endpoints_transport_check;
ALTER TABLE endpoints ADD CONSTRAINT endpoints_transport_check
    CHECK (transport IN ('CAN', 'CANFD', 'RS485', 'TCP', 'UNSPECIFIED'));
