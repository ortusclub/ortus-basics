import { existsSync, readFileSync, copyFileSync, writeFileSync, renameSync } from 'node:fs';
import { dataPath } from './paths.js';
import { ensureCampaignIdentity, listConfigs } from './campaign-configs.js';

// Idempotent, before request handling or store caches are initialized. Original
// files remain available for rollback. Existing IDs are never changed.
export function migrateCampaignIdentities() {
  listConfigs(); // migrate the registry first
  const files = ['drafts.json', 'queued-campaigns.json', 'history.json', 'schedules.json'];
  for (const file of files) {
    const path = dataPath(file);
    if (!existsSync(path)) continue;
    const rows = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(rows)) throw new Error(`Cannot migrate ${file}: expected a list`);
    let changed = false;
    for (const row of rows) {
      if (row.campaignId) {
        for (const key of ['config', 'settings']) if (row[key] && row[key].campaignId !== row.campaignId) { row[key].campaignId = row.campaignId; changed = true; }
        continue;
      }
      const identity = ensureCampaignIdentity({ name: row.name || row.config?.name || row.settings?.name, config: row.config || row.settings || {}, listed: file !== 'drafts.json' });
      row.campaignId = identity.campaignId;
      for (const key of ['config', 'settings']) if (row[key]) row[key].campaignId = row.campaignId;
      changed = true;
    }
    if (changed) {
      if (!existsSync(`${path}.before-ids.bak`)) copyFileSync(path, `${path}.before-ids.bak`);
      writeFileSync(`${path}.tmp`, JSON.stringify(rows, null, 2) + '\n');
      renameSync(`${path}.tmp`, path);
    }
  }
  for (const file of ['last-run-settings.json', 'monitoring-campaign.json', 'runtime-interruption.json']) {
    const path = dataPath(file);
    if (!existsSync(path)) continue;
    const row = JSON.parse(readFileSync(path, 'utf8'));
    if (!row || typeof row !== 'object') continue;
    const key = file === 'runtime-interruption.json' ? 'permanentCampaignId' : 'campaignId';
    if (row[key]) continue;
    const identity = ensureCampaignIdentity({ name: row.name, config: row });
    row[key] = identity.campaignId;
    if (!existsSync(`${path}.before-ids.bak`)) copyFileSync(path, `${path}.before-ids.bak`);
    writeFileSync(`${path}.tmp`, JSON.stringify(row, null, 2) + '\n');
    renameSync(`${path}.tmp`, path);
  }

}
