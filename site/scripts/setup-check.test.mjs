import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { checkSetup } from './setup-check.mjs';
import { validProductionOrigin } from '../trusted-origin.mjs';
const root = process.cwd();
mkdirSync(path.join(root,'.open-next/assets'), { recursive: true });
const configPath = '/tmp/owner-private/worker.json';
const complete = () => {
  const config = JSON.parse(readFileSync('wrangler.production.example.jsonc','utf8'));
  config.name='synthetic-app'; config.main=path.join(root,'worker.ts');
  config.alias['server-only']=path.join(root,'node_modules/server-only/empty.js');
  config.assets.directory=path.join(root,'.open-next/assets');
  config.d1_databases[0]={ binding:'DB',database_name:'synthetic-db',database_id:'12345678-1234-4123-8123-123456789abc',remote:false,migrations_dir:path.join(root,'migrations') };
  config.mtls_certificates[0].certificate_id='12345678-1234-4123-8123-123456789abd';
  config.routes[0].pattern='app.owner-domain.net';
  config.vars={BABYMONKEY_RP_ID:'app.owner-domain.net',BABYMONKEY_ORIGIN:'https://app.owner-domain.net',BABYMONKEY_RELAY_ORIGIN:'https://relay.owner-domain.net'};
  return config;
};
test('external private config resolves every application path', () => assert.deepEqual(checkSetup(complete(),configPath),[]));
test('rejects nonobject roots and effective configuration overrides', () => {
  for(const value of [null,false,0,'',[],{...complete(),env:{production:{assets:{directory:'protected-assets'}}}},{...complete(),build:{command:'other'}}]) assert.ok(checkSetup(value,configPath).length);
});
test('rejects unguarded assets and wrong entrypoint, alias, migration paths', () => {
  for(const mutate of [c=>c.assets.directory=path.join(root,'protected-assets'),c=>c.assets.run_worker_first=false,c=>c.main='worker.ts',c=>c.alias['server-only']='empty.js',c=>c.d1_databases[0].migrations_dir='../migrations',c=>c.assets.experimental_serve_directly=true]) {const c=complete();mutate(c);assert.ok(checkSetup(c,configPath).length);}
});
test('canonical trusted HTTPS origins reject local/IP/reserved/malformed inputs', () => {
  for(const origin of ['https://127.0.0.1','https://[::1]','https://localhost','https://app..owner.net','https://app.example','https://app.invalid','https://app.test','https://app.local','https://app.internal','https://app.example.com','https://app.owner.net/','https://APP.owner.net','https://app.owner.net:443','https://u@app.owner.net','http://app.owner.net','https://-app.owner.net','https://app.owner-.net']) assert.equal(validProductionOrigin(origin),false,origin);
  assert.equal(validProductionOrigin('https://app.owner-domain.net'),true);
});
