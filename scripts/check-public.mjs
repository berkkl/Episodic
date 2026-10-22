import { execFileSync } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
const names = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const markdown = new Set(['README.md', 'SECURITY.md']);
const issues = [];
for (const name of names) {
  if (/(^|\/)(handoffs|\.agents|\.codex|\.claude|node_modules|\.wrangler|exports|backups)(\/|$)/i.test(name)
    || (/\.md$/i.test(name) && !markdown.has(name))
    || /\.(pem|key|db|sqlite|duckdb|zip|har|csv|bak|log)$/i.test(name)
    || name.startsWith('public/episodic/catalog/')
    || /(^|\/)data\.json/.test(name)
    || (/(^|\/)(\.env|\.dev\.vars)/.test(name) && name !== '.dev.vars.example')) {
    issues.push(`${name}: private or unreviewed file category`); continue;
  }
  if ((await lstat(name)).isSymbolicLink()) { issues.push(`${name}: symlink`); continue; }
  if (/\.(png|jpe?g|webp)$/i.test(name)) {
    if (!['docs/images/watching.jpg', 'docs/images/diary.jpg'].includes(name)) issues.push(`${name}: unreviewed image`);
    continue;
  }
  const text = await readFile(name, 'utf8');
  if (/\.md$/i.test(name) && /[\u00c7\u00e7\u011e\u011f\u0130\u0131\u00d6\u00f6\u015e\u015f\u00dc\u00fc]/.test(text)) issues.push(`${name}: documentation must use English spelling`);
  const personal = new RegExp('/' + 'Users/[^/\\s]+/|[A-Za-z]:\\\\Users\\\\');
  if (personal.test(text)) issues.push(`${name}: personal path`);
}
const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
if (config.kv_namespaces.some(n => n.id !== '0'.repeat(32)) || config.routes || config.account_id || config.vars) issues.push('wrangler.jsonc: deployment-specific configuration');
if (issues.length) { console.error(issues.join('\n')); process.exitCode = 1; }
else console.log(`Public file check passed: ${names.length} files.`);
