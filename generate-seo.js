'use strict';
const fs = require('node:fs');
const path = require('node:path');
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
    const [month,day] = row.date.split('.').map(Number);
    const date = `${row.year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(row);
  }
  const dates = [...groups.keys()].sort().reverse();
  const items = dates.map(date => {
    const [year,month,day] = date.split('-');
    return `    <li><strong>${year}년 ${+month}월 ${+day}일 방송</strong>: ${groups.get(date).map(row => `${escapeHtml(row.title)} (${escapeHtml(row.recommender)} 추천)`).join(', ')}</li>`;
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
function main() {
  const file = path.join(__dirname, 'public/index.html');
  const original = fs.readFileSync(file, 'utf8');
  const output = generate(original);
  if (process.argv.includes('--check')) {
    if (output !== original) throw new Error('SEO is stale. Run node generate-seo.js');
  } else if (output !== original) fs.writeFileSync(file, output);
  console.log(`SEO ${process.argv.includes('--check') ? 'verified' : 'generated'}: ${readRows(output).length} recommendation records`);
}
module.exports = { readRows, generate, escapeHtml };
if (require.main === module) main();
