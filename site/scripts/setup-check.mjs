import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validProductionHostname, validProductionOrigin } from '../trusted-origin.mjs';
const site = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export function checkSetup(config, configPath, maintenance) {
  const errors = [];
  const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(config)) return ['production config must be an object'];
  const permitted = ['$schema','name','main','alias','compatibility_date','compatibility_flags','workers_dev','preview_urls','upload_source_maps','assets','routes','vars','mtls_certificates','d1_databases'];
  if (Object.keys(config).some((key) => !permitted.includes(key))) errors.push('unsupported production overrides');
  const placeholder = (value) => typeof value !== 'string' || !value || /REPLACE|PLACEHOLDER/i.test(value);
  const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
  const canonicalPath = (value, expected) => {
    if (placeholder(value)) return false;
    try { return realpathSync(path.resolve(path.dirname(configPath), value)) === realpathSync(path.join(site, expected)); }
    catch { return false; }
  };
  const exactKeys = (value, keys) => record(value) && Object.keys(value).sort().join(',') === keys.sort().join(',');
  if (placeholder(config.name) || !/^[a-z0-9-]+$/.test(config.name)) errors.push('worker name');
  if (!record(config.vars)) errors.push('vars object');
  const vars = record(config.vars) ? config.vars : {};
  const rp = vars.BABYMONKEY_RP_ID, origin = vars.BABYMONKEY_ORIGIN, relay = vars.BABYMONKEY_RELAY_ORIGIN;
  if (!validProductionHostname(rp) || origin !== `https://${rp}`) errors.push('exact HTTPS origin');
  if (!validProductionOrigin(relay) || relay === origin) errors.push('DNS-only relay origin');
  if (!exactKeys(vars, ['BABYMONKEY_RP_ID','BABYMONKEY_ORIGIN','BABYMONKEY_RELAY_ORIGIN'])) errors.push('production variables');
  if (!Array.isArray(config.routes) || config.routes.length !== 1 || !exactKeys(config.routes[0], ['pattern','custom_domain']) || config.routes[0].pattern !== rp || config.routes[0].custom_domain !== true) errors.push('single custom domain');
  const db = Array.isArray(config.d1_databases) && config.d1_databases.length === 1 ? config.d1_databases[0] : null;
  if (!record(db) || db.binding !== 'DB' || placeholder(db.database_name) || !uuid(db.database_id) || db.remote !== false || !canonicalPath(db.migrations_dir, 'migrations')) errors.push('D1 binding, database and migration path');
  const cert = Array.isArray(config.mtls_certificates) && config.mtls_certificates.length === 1 ? config.mtls_certificates[0] : null;
  if (!exactKeys(cert, ['binding','certificate_id']) || cert.binding !== 'BABYMONKEY_RELAY_MTLS' || !uuid(cert.certificate_id)) errors.push('mTLS binding and certificate');
  if (config.workers_dev !== false || config.preview_urls !== false || config.upload_source_maps !== false) errors.push('public preview/source-map policy');
  if (!canonicalPath(config.main, 'worker.ts')) errors.push('guarded Worker entrypoint path');
  if (!exactKeys(config.alias, ['server-only']) || !canonicalPath(config.alias['server-only'], 'node_modules/server-only/empty.js')) errors.push('server-only alias path');
  if (!exactKeys(config.assets, ['directory','binding','run_worker_first']) || config.assets.binding !== 'ASSETS' || config.assets.run_worker_first !== true || !canonicalPath(config.assets.directory, '.open-next/assets')) errors.push('guarded packaged assets path');
  if (config.compatibility_date !== '2026-08-23' || !Array.isArray(config.compatibility_flags) || config.compatibility_flags.join(',') !== 'nodejs_compat') errors.push('tested runtime compatibility');
  if (maintenance !== undefined && (!record(maintenance) || maintenance.schemaVersion !== 1 || maintenance.origin !== origin || maintenance.databaseId !== db?.database_id || !/^[0-9a-f]{32}$/.test(maintenance.accountId ?? '') || !exactKeys(maintenance, ['schemaVersion','accountId','databaseId','origin']))) errors.push('maintenance origin/database/account consistency');
  return errors;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = process.argv[2];
  if (!configPath) { console.error('Usage: npm run setup:check -- /absolute/path/to/private-wrangler.json [/absolute/path/to/maintenance.json]'); process.exit(2); }
  let errors;
  try { errors = checkSetup(JSON.parse(readFileSync(configPath, 'utf8')), path.resolve(configPath), process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : undefined); }
  catch { errors = ['configuration must be readable JSON']; }
  if (errors.length) { console.error('Setup check failed: ' + errors.join('; ')); process.exit(1); }
  console.log('Static setup check passed. Provider state, DNS, TLS, and delivery remain unverified.');
}
