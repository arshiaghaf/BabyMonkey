import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const artifact = path.join(root, '.open-next');
const client = path.join(artifact, 'assets', '_next', 'static');
async function filesBelow(dir) {
  const items = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(items.map(async (item) => item.isDirectory()
    ? filesBelow(path.join(dir,item.name)) : item.isFile() ? [path.join(dir,item.name)] : []))).flat();
}
const all = await filesBelow(artifact);
const staticFiles = await filesBelow(path.join(artifact,'assets'));
if (!(await filesBelow(client)).length) throw new Error('Missing client artifacts.');
const forbiddenBuild = ['BABYMONKEY_LOCAL_DEMO', 'BABYMONKEY_FAKE_DELIVERY'];
const presentationSource = await readFile(path.join(root,'server/protected/presentation.ts'),'utf8');
const presentationStart = presentationSource.indexOf('export const protectedPresentation =');
const presentationEnd = presentationSource.indexOf('export function isProtectedAssetId');
if (presentationStart < 0 || presentationEnd <= presentationStart) throw new Error('Protected presentation boundary missing.');
const forbiddenClient = [...new Set([...presentationSource.slice(presentationStart,presentationEnd).matchAll(/'([^'\n]+)'/g)].map(match => match[1]).filter(value => value.length >= 10 && !value.startsWith('/media/') && !/^[A-Za-z0-9]{32}$/.test(value)))];
for (const file of all) {
  const data = await readFile(file);
  for (const marker of forbiddenBuild) if (data.includes(marker)) throw new Error('Development fake authority in production artifact.');
}
for (const file of staticFiles) {
  if (file.endsWith('.map')) throw new Error('Client source map in production artifact.');
  const data = await readFile(file);
  for (const marker of forbiddenClient) if (data.includes(marker)) throw new Error('Protected copy in client asset.');
}
for (const file of [...await filesBelow(path.join(root,'protected-assets')), ...await filesBelow(path.join(root,'public'))]) {
  if (!file.endsWith('.png')) continue;
  const data = await readFile(file);
  if (!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Invalid PNG asset.');
  let offset = 8;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const kind = data.toString('ascii', offset+4, offset+8);
    if (['tEXt','zTXt','iTXt','eXIf','iCCP'].includes(kind)) throw new Error('Candidate PNG retains text or EXIF metadata.');
    offset += length + 12;
  }
  if (offset !== data.length) throw new Error('Invalid PNG chunk boundary.');
}
console.log('All packaged public text, protected copy fragments, source maps, executable fake branch markers, and PNG metadata checks passed. Worker guard flag names may appear only in the separately packaged outer entrypoint.');
