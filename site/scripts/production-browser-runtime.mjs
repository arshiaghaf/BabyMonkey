import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer as createHTTPServer } from 'node:http';
import { createServer as createHTTPSServer } from 'node:https';
import { connect } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { checkSetup } from './setup-check.mjs';
import { validateOwnedDirectory } from './runner-lifecycle.mjs';
const root=process.cwd();
const scratch=process.env.BABYMONKEY_RUNTIME_SCRATCH;
await validateOwnedDirectory(scratch);
const origin='https://app.owner-domain.net';
let mf,tls,proxy,test;
const run=(cmd,args)=>{const result=spawnSync(cmd,args,{cwd:root,encoding:'utf8',env:{...process.env,CLOUDFLARE_CF_FETCH_ENABLED:'false',WRANGLER_SEND_METRICS:'false',WRANGLER_SEND_ERROR_REPORTS:'false'}});if(result.status!==0)throw new Error(result.stderr||result.stdout);return result.stdout;};
const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});
const stop=server=>server?new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve);}):undefined;
try {
  const config=JSON.parse(await readFile('wrangler.production.example.jsonc','utf8'));
  config.name='synthetic-browser-app';config.main=path.join(root,'worker.ts');config.alias['server-only']=path.join(root,'node_modules/server-only/empty.js');config.assets.directory=path.join(root,'.open-next/assets');
  config.routes[0].pattern='app.owner-domain.net';config.vars={BABYMONKEY_RP_ID:'app.owner-domain.net',BABYMONKEY_ORIGIN:origin,BABYMONKEY_RELAY_ORIGIN:'https://relay.owner-domain.net'};
  config.d1_databases[0]={binding:'DB',database_name:'synthetic-browser-db',database_id:'12345678-1234-4123-8123-123456789abc',remote:false,migrations_dir:path.join(root,'migrations')};config.mtls_certificates[0].certificate_id='12345678-1234-4123-8123-123456789abd';
  const configPath=path.join(scratch,'private-worker.json');await writeFile(configPath,JSON.stringify(config));assert.deepEqual(checkSetup(config,configPath),[]);
  const output=run(path.join(root,'node_modules/.bin/wrangler'),['deploy','--dry-run','--config',configPath,'--outdir',path.join(scratch,'artifact')]);
  assert.match(output,/dry.run/i);console.log('External private config: static validation and offline Wrangler packaging passed.');
  const appOptions={name:'application',routes:['app.owner-domain.net/*'],modules: (await readdir(path.join(scratch,'artifact'))).filter(name=>name.endsWith('.js')||name.endsWith('.wasm')).sort((a,b)=>a==='worker.js'?-1:b==='worker.js'?1:a.localeCompare(b)).map(name=>({type:name.endsWith('.wasm')?'CompiledWasm':'ESModule',path:path.join(scratch,'artifact',name)})),modulesRoot:path.join(scratch,'artifact'),compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,bindings:config.vars,d1Databases:{DB:'synthetic-browser-db'},assets:{directory:config.assets.directory,binding:'ASSETS',run_worker_first:true},serviceBindings:{BABYMONKEY_RELAY_MTLS:'fake-relay'},outboundService:'blocked-network'};
  const auxiliary=[{name:'fake-relay',modules:true,script:`export default {fetch(){return new Response('{"v":1,"outcome":"definitive-failure"}',{headers:{'content-type':'application/vnd.babymonkey.fixed-notification.v1+json'}})}}`},{name:'blocked-network',modules:true,script:`export default {fetch(){return new Response('External network disabled',{status:403})}}`}];
  const options={cf:false,telemetry:{enabled:false},resourceTmpPath:path.join(scratch,'runtime-tmp'),resourcePersistencePath:path.join(scratch,'d1'),workers:[appOptions,...auxiliary]};
  mf=new Miniflare(convertV4MiniflareOptions(options));const db=await mf.getD1Database('DB');
  for(const name of (await readdir('migrations')).filter(n=>/^000[1-5].*\.sql$/.test(n)).sort()) {const sql=await readFile(path.join(root,'migrations',name),'utf8');await db.exec(sql.replace(/--[^\n]*/g,'').replace(/\n/g,' '));}
  assert.equal((await db.prepare('SELECT enabled FROM notification_control WHERE singleton=1').first()).enabled,0);
  const token=randomBytes(32).toString('base64url'),hash=createHash('sha256').update(token).digest('hex'),now=Date.now();
  await db.prepare(`INSERT INTO invitations (invitation_id,token_hash,principal_slot,purpose,required_generation,created_at_ms,expires_at_ms) VALUES ('synthetic-browser-invite',?,1,'initial',NULL,?,?)`).bind(hash,now,now+3600000).run();
  // Fake external transport is a harness binding, never application code or a production flag.
  await db.prepare('UPDATE notification_control SET enabled=1,revision=2,updated_at_ms=? WHERE singleton=1').bind(now).run();
  for(const flags of [{BABYMONKEY_LOCAL_DEMO:'1'},{BABYMONKEY_FAKE_DELIVERY:'confirmed'},{BABYMONKEY_RP_ID:'localhost',BABYMONKEY_ORIGIN:'http://localhost:3000'}]) {
    const rejected=new Miniflare(convertV4MiniflareOptions({cf:false,telemetry:{enabled:false},resourceTmpPath:path.join(scratch,'rejected-runtime-'+Object.keys(flags)[0]),workers:[{...appOptions,bindings:{...config.vars,...flags}},...auxiliary]}));
    try {const response=await (await rejected.getWorker('application')).fetch(origin); if(response.status!==404)console.error(await response.text());assert.equal(response.status,404);} finally {await rejected.dispose();}
  }
  console.log('Correct production bindings accepted; local authority flags and local origins rejected by actual artifact.');
  run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(scratch,'key.pem'),'-out',path.join(scratch,'cert.pem'),'-days','1','-subj','/CN=app.owner-domain.net']);
  tls=createHTTPSServer({key:await readFile(path.join(scratch,'key.pem')),cert:await readFile(path.join(scratch,'cert.pem'))},async(req,res)=>{
    try {if(req.headers.host!=='app.owner-domain.net'){res.writeHead(404);res.end();return;}
      const body=['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(await Array.fromAsync(req));
      const response=await (await mf.getWorker('application')).fetch(origin+req.url,{method:req.method,headers:req.headers,body,redirect:'manual'});
      res.statusCode=response.status;response.headers.forEach((value,key)=>{if(!['set-cookie','content-encoding','content-length','transfer-encoding'].includes(key))res.setHeader(key,value);});
      const cookies=response.headers.getSetCookie();if(cookies.length)res.setHeader('set-cookie',cookies);
      // Browser cancellation must cancel the workerd response too, so disposal
      // does not wait forever for an unread response paused by backpressure.
      if(response.body)await pipeline(Readable.fromWeb(response.body),res);else res.end();
    }catch(error){if(res.destroyed)return;console.error(error);res.writeHead(500);res.end();}
  });const tlsPort=await listen(tls);
  proxy=createHTTPServer((_req,res)=>{res.writeHead(403);res.end();});const sockets=new Set();
  proxy.on('connect',(req,socket,head)=>{if(req.url!=='app.owner-domain.net:443'){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}const upstream=connect(tlsPort,'127.0.0.1',()=>{if(socket.destroyed){upstream.destroy();return;}socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});sockets.add(socket);sockets.add(upstream);socket.on('close',()=>{sockets.delete(socket);upstream.destroy();});socket.on('error',()=>upstream.destroy());upstream.on('close',()=>sockets.delete(upstream));upstream.on('error',()=>socket.destroy());});const proxyPort=await listen(proxy);
  process.send?.({ready:true});
  test=spawn(process.execPath,[path.join(root,'node_modules/@playwright/test/cli.js'),'test','--config','playwright.cloudflare.config.ts',...process.argv.slice(2)],{cwd:root,stdio:'inherit',env:{...process.env,BABYMONKEY_TEST_PROXY:`http://127.0.0.1:${proxyPort}`,BABYMONKEY_TEST_INVITATION:token,BABYMONKEY_TEST_ORIGIN:origin}});
  process.exitCode=await new Promise(resolve=>test.once('exit',code=>resolve(code??1)));
  for(const socket of sockets)socket.destroy();
} finally {
  try {
    test?.kill('SIGTERM');
    console.log('Closing production browser proxy.'); await stop(proxy);
    console.log('Closing production browser TLS server.'); await stop(tls);
    console.log('Disposing production browser workerd/D1.'); await mf?.dispose();
    console.log('Production browser runtime cleanup completed.');
  } finally {
    // Readiness has already been delivered; release the parent channel after cleanup.
    if (process.connected) process.disconnect();
  }
}
