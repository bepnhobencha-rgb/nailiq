-- MQA-0182: browser roles must never receive table-control privileges that
-- bypass or reconfigure row-level tenant isolation. TRUNCATE does not invoke
-- RLS; REFERENCES/TRIGGER are schema-control privileges, not application DML.

REVOKE TRUNCATE, REFERENCES, TRIGGER
ON ALL TABLES IN SCHEMA public
FROM anon, authenticated;
-- Tables created by later migrations must start from the same deny posture.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES
FROM anon, authenticated;
