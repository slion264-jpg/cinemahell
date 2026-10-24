const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const post = `시네마 지옥
*예지원 - 노매드랜드
*최욱 - 100일의 거짓말
*곽수산 - 뤼팽 파트 4
*전찬일 - 여전히 찬란하게
*라이너 - 와일드 로봇
*거의없다 - 이블 데드 번`;

function loadScript(filename, files = {}) {
  const writes = [];
  const fakeFs = {
    readFileSync: p => files[path.basename(p)] || 'const RAW_DATA = [\n];',
    writeFileSync: (p, data) => { files[path.basename(p)] = data; writes.push(p); },
  };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : ['2026-10-24T11:00:00Z'])); }
    static now() { return Date.parse('2026-10-24T11:00:00Z'); }
  }
  const context = vm.createContext({
    require: name => name === 'fs' ? fakeFs : require(name),
    __dirname, console: { log() {}, error() {} }, Date: FixedDate,
    process: { env: { TMDB_KEY: 'test-only', FINAL_ATTEMPT: 'true', GITHUB_ACTIONS: 'true' } },
  });
  // Load the real functions without invoking their network/CLI entry point.
  const source = fs.readFileSync(path.join(__dirname, filename), 'utf8');
  const entryPoint = source.lastIndexOf('\nmain().catch(');
  assert.ok(entryPoint > 0);
  vm.runInContext(source.slice(0, entryPoint), context);
  return { context, files, writes, run: code => vm.runInContext(code, context) };
}

test('verified part keeps 2026 rather than the series debut; other parts remain unresolved', async () => {
  const app = loadScript('weekly-update.js');
  app.run('apiFetch = async () => ({ results: [] });');
  assert.equal((await app.run("findYear('뤼팽 파트 4')")).year, '2026');
  assert.equal((await app.run("findYear('뤼팽 파트 4 (드라마)')")).year, '2026');
  assert.equal(await app.run("findYear('뤼팽 파트 5')"), null);
  assert.equal(await app.run("findYear('알 수 없는 작품')"), null);
});

test('all six recommendations are written together and a second run is idempotent', async () => {
  const app = loadScript('weekly-update.js', { 'sitemap.xml': '<lastmod>2026-10-16</lastmod>' });
  app.context.post = post;
  // Other titles use a deliberately generic fixture year, not production metadata.
  app.run(`getLatestCinemahellPost = async () => ({ text: post, published: '1 day ago' });
    apiFetch = async () => ({ results: [{ release_date: '2000-01-01', title: 'fixture' }] });`);
  await app.run('main()');
  const entries = app.run('readRawData(fs.readFileSync(INDEX_PATH))');
  assert.equal(entries.length, 6);
  assert.ok(entries.every(e => e.date === '10.23' && e.year === '2026'));
  assert.equal(entries[2].title, '뤼팽 파트 4 (2026) - 곽수산');
  assert.equal(app.files['sitemap.xml'], '<lastmod>2026-10-24</lastmod>');
  assert.equal(app.writes.length, 2);
  await app.run('main()');
  assert.equal(app.writes.length, 2);
});

test('an unresolved recommendation still blocks every write', async () => {
  const app = loadScript('weekly-update.js');
  app.context.post = post.replace('뤼팽 파트 4', '뤼팽 파트 5');
  app.run(`getLatestCinemahellPost = async () => ({ text: post, published: '1 day ago' });
    apiFetch = async url => ({ results: decodeURIComponent(url).includes('뤼팽') ? [] : [{ release_date: '2000-01-01' }] });`);
  await assert.rejects(app.run('main()'), /전체를 보류/);
  assert.equal(app.writes.length, 0);
});

test('TMDB cache uses the verified series ID but preserves the part release date', async () => {
  const app = loadScript('build-tmdb-cache.js');
  app.context.urls = [];
  app.run(`apiFetch = async url => {
    urls.push(url);
    return url.includes('/watch/providers') ? { results: {} } :
      { id: 96677, name: '뤼팽', first_air_date: '2021-01-08', genre_ids: [] };
  };`);
  const result = await app.run("fetchTMDB('뤼팽 파트 4', '2026')");
  assert.equal(result.tmdbId, 96677);
  assert.equal(result.mediaType, 'tv');
  assert.equal(result.releaseDate, '2026-10-23');
  assert.ok(app.context.urls.every(url => url.includes('/tv/96677')));
  assert.equal(app.context.urls.length, 2);
});
