import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { activeOwnedGroupMembers, bounded, ownedDirectory, validateOwnedDirectory, removeOwnedDirectory, stopOwnedGroup } from './runner-lifecycle.mjs';

test('owned group inspection ignores zombie rows and rejects foreign live members', () => {
  const groupId = 1234, uid = 501;
  assert.deepEqual(activeOwnedGroupMembers('100 1234 501 Z\n101 1234 501 Z+\n102 9876 501 S', groupId, uid), []);
  assert.deepEqual(activeOwnedGroupMembers('100 1234 501 Z\n101 1234 501 S', groupId, uid), [101]);
  assert.throws(() => activeOwnedGroupMembers('101 1234 0 S', groupId, uid), /another user/);
});

const fixture = `
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
const state = process.env.BABYMONKEY_RUNTIME_SCRATCH ?? process.env.BABYMONKEY_DEMO_PARENT_STATE;
await mkdir(path.join(state,'synthetic-d1'));await writeFile(path.join(state,'synthetic-d1/sentinel'),'synthetic');
await writeFile(path.join(state,'private-worker.json'),'synthetic config');await writeFile(path.join(state,'key.pem'),'synthetic certificate fixture');
const descendant = spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
const server = createServer(socket=>socket.end());
await new Promise(resolve=>server.listen(process.env.FIXTURE_KIND==='demo'?3000:0,'127.0.0.1',resolve));
console.log('FIXTURE_LISTENING:'+JSON.stringify({state,port:server.address().port,pids:[process.pid,descendant.pid]}));
process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});
if(process.env.FIXTURE_MODE==='failure')process.exit(1);
if(!['before','timeout'].includes(process.env.FIXTURE_MODE))process.send({ready:true,tokens:['synthetic-one','synthetic-two']});
if(process.env.FIXTURE_KIND==='production'){
 if(process.env.FIXTURE_MODE==='normal')setTimeout(()=>process.exit(0),100);
 else if(process.env.FIXTURE_MODE==='during')console.log('FIXTURE_TEST_STARTED');
}
`;
const browserFixture = `console.log('FIXTURE_TEST_STARTED');if(process.env.FIXTURE_MODE==='normal')process.exit(0);process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setInterval(()=>{},1000);`;
const alive = pid => {try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
async function assertPortFree(port) {
  const server=createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  await new Promise(resolve=>server.close(resolve));
}
async function exercise(kind,mode,signal) {
  const scratch=await mkdtemp(path.join(await realpath(os.tmpdir()),'runner-lifecycle-fixture-'));
  const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  let runner;
  const owned=[];
  try {
    await mkdir(path.join(scratch,'scripts'));
    for(const name of ['runner-lifecycle.mjs','run-demo-browser-tests.mjs','run-cloudflare-browser-tests.mjs'])await writeFile(path.join(scratch,'scripts',name),await readFile(path.join('scripts',name)));
    await writeFile(path.join(scratch,'scripts',kind==='demo'?'run-development-preview.mjs':'production-browser-runtime.mjs'),fixture);
    await mkdir(path.join(scratch,'node_modules/@playwright/test'),{recursive:true});
    await writeFile(path.join(scratch,'node_modules/@playwright/test/cli.js'),browserFixture);
    const sentinel=path.join(scratch,'unrelated-state');await writeFile(sentinel,'preserve');
    runner=spawn(process.execPath,[path.join(scratch,'scripts',kind==='demo'?'run-demo-browser-tests.mjs':'run-cloudflare-browser-tests.mjs')],{cwd:scratch,stdio:['ignore','pipe','pipe'],env:{...process.env,FIXTURE_KIND:kind,FIXTURE_MODE:mode}});
    let output='';let trigger;
    const started=new Promise(resolve=>{trigger=resolve;});
    const collect=chunk=>{
      output+=chunk;
      for(const line of String(chunk).split('\n'))if(line.startsWith('FIXTURE_LISTENING:'))owned.push(JSON.parse(line.slice('FIXTURE_LISTENING:'.length)));
      if(mode==='during'?output.includes('FIXTURE_TEST_STARTED'):output.includes('FIXTURE_LISTENING:'))trigger();
    };
    runner.stdout.on('data',collect);runner.stderr.on('data',collect);
    const completion=new Promise(resolve=>runner.once('close',(code,termination)=>resolve({code,termination})));
    await bounded(started,10_000,'Fixture did not start.');
    if(signal)runner.kill(signal);
    const result=await bounded(completion,mode==='timeout'?130_000:15_000,'Runner cleanup exceeded its bound.');
    assert.equal(result.termination,null,output);
    assert.equal(result.code,signal==='SIGINT'?130:signal==='SIGTERM'?143:mode==='normal'?0:1,output);
    if(mode==='timeout')assert.match(output,/startup timed out/);
    for(const item of owned){await assert.rejects(readFile(path.join(item.state,'private-worker.json')),/ENOENT/);await assertPortFree(item.port);}
    await bounded((async()=>{while(owned.some(item=>item.pids.some(alive)))await new Promise(resolve=>setTimeout(resolve,25));})(),2_000,'Owned descendant remained after cleanup.');
    assert.equal(await readFile(sentinel,'utf8'),'preserve');assert.equal(alive(unrelated.pid),true);
  } finally {
    if (runner && runner.exitCode === null) { runner.kill('SIGTERM'); await new Promise(resolve => setTimeout(resolve, 3_000)); runner.kill('SIGKILL'); }
    for (const item of owned) {
      await stopOwnedGroup({ pid: item.pids[0] });
      await removeOwnedDirectory(item.state).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    unrelated.kill('SIGTERM');
    await rm(scratch,{recursive:true,force:true});
  }
}
for(const kind of ['demo','production']) {
  test(`${kind}: normal completion cleans only owned descendants/state`,{timeout:25_000},()=>exercise(kind,'normal'));
  test(`${kind}: startup failure cleans owned state`,{timeout:20_000},()=>exercise(kind,'failure'));
  for(const mode of ['before','during'])for(const signal of ['SIGINT','SIGTERM'])test(`${kind}: ${signal} ${mode} readiness/test cleans owned groups/state`,{timeout:20_000},()=>exercise(kind,mode,signal));
}
test('both runners: real startup timeout cleans owned groups/state without an unbounded wait',{timeout:140_000},async()=>{const results=await Promise.allSettled(['demo','production'].map(kind=>exercise(kind,'timeout')));for(const result of results)if(result.status==='rejected')throw result.reason;});

test('owned directory validation rejects redirected and unrelated roots before mutation',async()=>{
  const unrelated=await mkdtemp(path.join(await realpath(os.tmpdir()),'runner-unrelated-'));
  const owned=await ownedDirectory('babymonkey-demo-run-');
  const link=owned+'-link';
  try {
    await writeFile(path.join(unrelated,'sentinel'),'preserve');
    await assert.rejects(validateOwnedDirectory(unrelated),/unowned/);
    await symlink(unrelated,link);
    await assert.rejects(validateOwnedDirectory(link),/unowned/);
    assert.equal(await readFile(path.join(unrelated,'sentinel'),'utf8'),'preserve');
    await validateOwnedDirectory(owned);
  }finally{await rm(link,{force:true});await removeOwnedDirectory(owned);await rm(unrelated,{recursive:true});}
});
