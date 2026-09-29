import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const excludedDirectories = new Set(['.git','.agents','.codex','node_modules','.next','.open-next','.wrangler','dist','coverage','test-results','playwright-report','.npm-cache','.cache']);
const excludedFile = (name) => name === 'PRIVATE_OSS_PLANNING_NOTES.md' || name === '.DS_Store' || name.endsWith('.tsbuildinfo') || name.endsWith('.local.json');
async function sourceFiles(directory) {
  const files=[];
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    if (excludedDirectories.has(entry.name) || excludedFile(entry.name)) continue;
    const target=path.join(directory,entry.name);
    if(entry.isDirectory())files.push(...await sourceFiles(target));
    else if(entry.isFile())files.push(target);
    else throw new Error('Unexpected nonregular source entry.');
  }
  return files;
}
const files=(await sourceFiles(root)).map(file=>path.relative(root,file).split(path.sep).join('/')).sort();
const digest=createHash('sha256');
for(const relative of files)digest.update(relative+'\0'+createHash('sha256').update(await readFile(path.join(root,relative))).digest('hex')+'\n');
console.log(JSON.stringify({algorithm:'SHA-256 of sorted UTF-8 relative-path + NUL + lowercase SHA-256(file bytes) + LF records',fileCount:files.length,sha256:digest.digest('hex')},null,2));
