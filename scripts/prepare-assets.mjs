import { mkdir, writeFile } from 'node:fs/promises';
const dir = new URL('../public/episodic/catalog/', import.meta.url);
await mkdir(dir, { recursive: true });
const files = { 'popular.json': { updated: null, lists: [] }, 'ai-pool.json': { updated: null, shows: [] } };
for (const key of ['hbo', 'disney', 'prime', 'netflix']) files[`tr-${key}.json`] = { region: 'TR', platform: key, updated: null, shows: [] };
for (const [name, value] of Object.entries(files)) {
  try { await writeFile(new URL(name, dir), JSON.stringify(value), { flag: 'wx' }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
}
