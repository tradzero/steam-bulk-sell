import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
test('release permissions and CSP stay within the documented boundary',async()=>{
  const m=JSON.parse(await readFile(new URL('../dist/manifest.json',import.meta.url),'utf8'));
  assert.deepEqual(m.permissions,['activeTab','scripting','storage']);
  for(const field of ['host_permissions','optional_host_permissions','content_scripts','externally_connectable','web_accessible_resources','update_url'])assert.equal(m[field],undefined);
  assert.match(m.content_security_policy.extension_pages,/connect-src 'none'/);assert.doesNotMatch(m.content_security_policy.extension_pages,/unsafe-eval|unsafe-inline/);
});
test('release has no sell requests, secret reads, remote executable code or DOM HTML sinks',async()=>{
  const path=new URL('../dist/',import.meta.url),files=await readdir(path);
  assert.ok(!files.includes('demo.js'),'demo adapter must not ship in extension');
  const js=(await Promise.all(files.filter(f=>f.endsWith('.js')).map(f=>readFile(new URL(f,path),'utf8')))).join('\n');
  for(const pattern of [/\/market\/sellitem/,/method:\s*['"]POST/,/document\.cookie/,/chrome\.cookies/,/g_sessionID/,/steamLoginSecure/,/identity_secret/,/shared_secret/,/\.innerHTML\s*=/,/\beval\(/,/new Function\(/,/https?:\/\/[^'"\s]+\.js/])assert.doesNotMatch(js,pattern);
});
