import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, readdir, rename } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { createDemoSeed } from './demo-seed.mjs';
test('fresh disposable D1 never resets project D1, KV or redirected ancestors', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'demo-safety-'));
  const external=await mkdtemp(path.join(os.tmpdir(),'demo-sentinel-'));
  let one,two;
  try {
    await mkdir(path.join(root,'node_modules/.bin'),{recursive:true});
    await writeFile(path.join(root,'node_modules/.bin/wrangler'),'#!/bin/sh\nexit 0\n',{mode:0o700});
    await writeFile(path.join(root,'wrangler.jsonc'),await readFile('wrangler.jsonc'));
    await mkdir(path.join(external,'state/v3/kv'),{recursive:true});
    await mkdir(path.join(external,'state/v3/d1'),{recursive:true});
    for(const type of ['kv','d1']) await writeFile(path.join(external,'state/v3',type,'sentinel'),'preserve');
    await mkdir(path.join(root,'.wrangler/state/v3/kv'),{recursive:true});
    await writeFile(path.join(root,'.wrangler/state/v3/kv/sentinel'),'preserve-project');
    one=await createDemoSeed(root); two=await createDemoSeed(root);
    assert.notEqual(one.stateDir,two.stateDir);
    for(const type of ['kv','d1']) assert.equal(await readFile(path.join(external,'state/v3',type,'sentinel'),'utf8'),'preserve');
    assert.equal(await readFile(path.join(root,'.wrangler/state/v3/kv/sentinel'),'utf8'),'preserve-project');
    await rename(path.join(root,'.wrangler'),path.join(root,'preserved-state'));
    await symlink(external,path.join(root,'.wrangler'));
    await assert.rejects(createDemoSeed(root),/redirected/);
    for(const type of ['kv','d1']) assert.equal(await readFile(path.join(external,'state/v3',type,'sentinel'),'utf8'),'preserve');
    assert.equal((await readdir(external)).join(','),'state');
  } finally { await one?.dispose();await two?.dispose();await rm(root,{recursive:true,force:true});await rm(external,{recursive:true,force:true}); }
});
test('occupied port receives no requests and fails before demo startup', async () => {
  let requests=0;
  const server=createServer((_req,res)=>{requests++;res.end('unrelated synthetic server');});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(3000,'127.0.0.1',resolve);});
  try {
    const child=spawn(process.execPath,['scripts/run-demo-browser-tests.mjs'],{stdio:'pipe'});
    let output='';child.stderr.on('data',data=>output+=data);
    const code=await new Promise(resolve=>child.once('exit',resolve));
    assert.notEqual(code,0);assert.match(output,/EADDRINUSE/);assert.equal(requests,0);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
