-- Host-plane reserved namespace (ADR-0146).
-- Copy-only: seed `@opensip-cli/host-plane:<tool>` rows from legacy ordinary
-- (tool, governance|audit|entitlements) candidates without deleting or
-- overwriting either identity. ON CONFLICT DO NOTHING preserves an already-
-- present reserved row; legacy ordinary rows remain authoritative for the
-- ordinary tool namespace.
INSERT INTO `tool_state` (`tool`, `key`, `payload`, `updated_at`)
SELECT
  '@opensip-cli/host-plane:' || `tool`,
  `key`,
  `payload`,
  `updated_at`
FROM `tool_state`
WHERE `key` IN ('governance', 'audit', 'entitlements')
  AND `tool` NOT LIKE '@opensip-cli/host-plane:%'
ON CONFLICT DO NOTHING;
