'use strict';
const fs = require('node:fs');
const path = require('node:path');
const BASE = 'https://mbshow.kr';
const REVIEWED_BROADCASTS = {
  '2026-11-20': {
    replay: 'https://www.youtube.com/watch?v=YVSmXv4Pv74&t=11776s',
    work: 'https://www.sonypictures.com/tv/breakingbad',
    netflix: 'https://www.netflix.com/kr/title/70143836',
    amc: 'https://www.amcglobalmedia.com/2008/05/07/amc-renews-critically-acclaimed-original-series-breaking-bad-for-a-second-season/'
  }
};
function episodePath(date) { return '/broadcasts/' + date + '.html'; }
function dateOf(row) {
  const [month,day] = row.date.split('.').map(Number);
  return `${row.year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}
function koreanDate(date) {
  const [year,month,day] = date.split('-');
  return `${year}년 ${+month}월 ${+day}일`;
}
function archiveWork(row) {
  const type = row.mediaType === 'tv' ? ' · TV 드라마' : '';
  return `${escapeHtml(row.title)}${type} (${escapeHtml(row.recommender)} 추천)`;
}
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function readRows(html) {
  const match = html.match(/const RAW_DATA = (\[[\s\S]*?\n\]);/);
  if (!match) throw new Error('RAW_DATA not found; existing SEO preserved');
  // Canonical source is a JavaScript array and contains historical trailing commas.
  const rows = require('node:vm').runInNewContext('(' + match[1] + ')', Object.create(null), { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
  if (!Array.isArray(rows) || !rows.length) throw new Error('Empty recommendation data; existing SEO preserved');
  for (const row of rows) {
    if (!row || typeof row.title !== 'string' || !row.title.trim() || typeof row.recommender !== 'string' || !/^\d{4}$/.test(String(row.year)) || !/^\d{1,2}\.\d{1,2}\.?$/.test(row.date)) throw new Error('Invalid recommendation; existing SEO preserved');
    const [month, day] = row.date.split('.').map(Number);
    const date = new Date(Date.UTC(+row.year, month-1, day));
    if (date.getUTCFullYear() !== +row.year || date.getUTCMonth() !== month-1 || date.getUTCDate() !== day) throw new Error('Invalid broadcast date; existing SEO preserved');
  }
  return rows;
}
function generate(html) {
  const rows = readRows(html);
  const groups = new Map();
  for (const row of rows) {
    const date = dateOf(row);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(row);
  }
  const dates = [...groups.keys()].sort().reverse();
  const items = dates.map(date => {
    const heading = `${koreanDate(date)} 방송`;
    const episodeLink = REVIEWED_BROADCASTS[date] ? ` · <a href="${episodePath(date)}">추천작·방송 출처 보기</a>` : '';
    return `    <li><strong>${heading}</strong>: ${groups.get(date).map(archiveWork).join(', ')}${episodeLink}</li>`;
  }).join('\n');
  const content = `<details id="seoContent" data-record-count="${rows.length}" data-latest-date="${dates[0]}">
  <summary>방송별 전체 추천 기록 (${rows.length.toLocaleString('en-US')}건)</summary>
  <h2>매불쇼 시네마지옥 주말 영화 추천 아카이브</h2>
  <p>전체 ${rows.length.toLocaleString('en-US')}건의 방송별 추천 기록입니다. 같은 작품이 여러 번 추천될 수 있습니다. 최근 방송: ${dates[0]}. 위 카드에서 검색, 추천자 필터 및 OTT 시청처를 확인할 수 있습니다.</p>
  <ul>
${items}
  </ul>
</details>`;
  const existing = /<(?:div|details)\b[^>]*\bid="seoContent"[^>]*>[\s\S]*?<\/(?:div|details)>/g;
  if ([...html.matchAll(existing)].length !== 1) throw new Error('Expected one SEO archive; existing file preserved');
  return html.replace(existing, () => content);
}
function generateBroadcastPage(html, date) {
  const sources = REVIEWED_BROADCASTS[date];
  if (!sources) throw new Error('Unreviewed broadcast page: ' + date);
  const rows = readRows(html).filter(row => dateOf(row) === date);
  const tv = rows.find(row => row.mediaType === 'tv' && row.tmdbId === 1396);
  if (!tv || !rows.length) throw new Error('Reviewed broadcast data missing: ' + date);
  const url = BASE + episodePath(date);
  const title = koreanDate(date) + ' 시네마지옥 추천작 · 매불쇼';
  const summary = `매불쇼 시네마지옥 ${koreanDate(date)} 방송의 주말 추천작: ${rows.map(row => row.title).join(', ')}. 추천인과 방송 원문 출처를 확인할 수 있습니다.`;
  const items = rows.map((row, i) => {
    const guest = row.recommender === '게스트' && row.title.match(/^(.+?)\s+-\s+([^-]+)$/);
    const name = guest ? guest[1] : row.title;
    const recommender = guest ? guest[2] + ' (게스트)' : row.recommender;
    return { row, name, recommender, position: i + 1 };
  });
  const graph = {
    '@context': 'https://schema.org', '@type': 'CollectionPage', name: title, url, inLanguage: 'ko',
    citation: sources.replay,
    mainEntity: { '@type': 'ItemList', numberOfItems: items.length, itemListElement: items.map(({ row, name, position }) => ({
      '@type': 'ListItem', position, item: row === tv
        ? { '@type': 'TVSeries', name: '브레이킹 배드', alternateName: 'Breaking Bad', startDate: '2008-01-20', image: row.posterOverride, sameAs: [sources.work, sources.netflix] }
        : { '@type': 'Movie', name }
    })) }
  };
  const json = JSON.stringify(graph).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(summary)}">
<meta name="robots" content="index, follow, max-image-preview:large">
<link rel="canonical" href="${url}">
<script type="application/ld+json">${json}</script>
<style>body{margin:0 auto;max-width:44rem;padding:1.5rem;font:1rem/1.7 system-ui,sans-serif;color:#eee;background:#121212}a{color:#f5cf79}li{margin-block:1rem}h1,h2{line-height:1.3}time{color:#ddd}figure{margin:1rem 0}img{display:block;max-width:100%;height:auto;border-radius:.4rem}</style>
</head>
<body>
<nav aria-label="사이트"><a href="/">시네마지옥 홈</a></nav>
<main>
<h1>${escapeHtml(title)}</h1>
<p><time datetime="${date}">${koreanDate(date)} 방송</time>에 소개된 주말 추천작 ${items.length}편입니다.</p>
<ul>
${items.map(({ row, name, recommender }) => `  <li><strong>${escapeHtml(name)}</strong> · ${row === tv ? '미국 TV 드라마' : '영화'} · ${escapeHtml(recommender)} 추천</li>`).join('\n')}
</ul>
<h2>브레이킹 배드는 어떤 작품인가요?</h2>
<figure><img src="${escapeHtml(tv.posterOverride)}" width="342" height="513" loading="lazy" decoding="async" alt="브레이킹 배드 TV 드라마 포스터"></figure>
<p><strong>브레이킹 배드 (Breaking Bad)</strong>는 2008년 시작한 미국 TV 드라마입니다. 2019년 영화 《엘 카미노: 브레이킹 배드 무비》와는 별개의 작품입니다.</p>
<p>작품 정보: <a href="${sources.work}">소니 픽처스</a> · <a href="${sources.amc}">AMC 당시 발표</a> · <a href="${sources.netflix}">넷플릭스 작품 페이지</a></p>
<h2>추천 출처</h2>
<p>매불쇼 방송 채널의 해당 회차 주말 추천작 목록에 근거했습니다. <a href="${escapeHtml(sources.replay)}">공식 다시보기의 추천 구간</a>에서 방송을 확인할 수 있습니다.</p>
</main>
</body>
</html>
`;
}
function main() {
  const file = path.join(__dirname, 'public/index.html');
  const original = fs.readFileSync(file, 'utf8');
  const output = generate(original);
  const check = process.argv.includes('--check');
  function outputFile(filename, next) {
    const previous = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : null;
    if (previous === next) return;
    if (check) throw new Error('SEO artifact is stale: ' + path.relative(__dirname, filename) + '. Run node generate-seo.js');
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, next);
  }
  outputFile(file, output);
  for (const date of Object.keys(REVIEWED_BROADCASTS)) {
    outputFile(path.join(__dirname, 'public', episodePath(date)), generateBroadcastPage(output, date));
  }
  console.log(`SEO ${check ? 'verified' : 'generated'}: ${readRows(output).length} recommendation records`);
}
module.exports = { readRows, generate, escapeHtml, generateBroadcastPage };
if (require.main === module) main();
