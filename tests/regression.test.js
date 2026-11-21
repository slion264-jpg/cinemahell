const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../public/index.html'),'utf8');
const { readRows, generate } = require('../generate-seo');
function setup() {
  const storage = new Map();
  const elements = new Map();
  const el = id => {if (!elements.has(id)) elements.set(id,{value:'',textContent:'',hidden:false,style:{},classList:{toggle(){}},setAttribute(){}});return elements.get(id);};
  const rows = [
    { title:'같은 영화 (2020)',year:'2026',date:'11.13',recommender:'라이너'},
    { title:'같은 영화 (2020) - 게스트',year:'2025',date:'01.01',recommender:'게스트'},
    { title:'같은 영화 (1990)',year:'2026',date:'11.13',recommender:'전찬일'},
    { title:'같은 영화 시즌 2 (2020)',year:'2026',date:'11.13',recommender:'전찬일'},
    { title:'미상',year:'2026',date:'11.13',recommender:'전찬일'},
    { title:'미상',year:'2025',date:'11.13',recommender:'전찬일'}];
  const c = vm.createContext({ console, RAW_DATA: rows, CANONICAL_DATA: rows, shellScope(){}, window:{ addEventListener(){} }, alert(){throw Error('unexpected alert');}, renderGrid(){},closePickerModal(){this.closed=(this.closed||0)+1;},document:{getElementById:el},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)}, state:{excludedMovies:new Set(),exclusionUid:null,excludeMarked:true,filters:{recommender:'전체',year:'전체',genre:'전체',platform:'전체'},bookmarks:new Set(),myRatings:{},movieCache:{}} });
  c.shellIsWatched = m => !!c.state.myRatings[c.getMovieKey(m)];
  c.closePickerModal = () => { c.closed = (c.closed || 0) + 1; };
  const names=['parseTitle','getMovieKey','exclusionStorageKey','readExcludedMovies','getExclusionKey','isMovieExcluded','toggleMovieExcluded','toggleExcludeMarked','updateFilterBadge','filterMovies'];
  for (const name of names) {
    const start=html.indexOf('function '+name+'('); assert(start>=0);
    const end=html.indexOf('\n}',start)+2;
    vm.runInContext(html.slice(start,end),c);
  }
  vm.runInContext(html.match(/window\._setExclusionScope = function\(uid\) \{[\s\S]*?\n\};/)[0],c);
  return {c, rows,storage,el};
}
test('canonical SEO is up-to-date, escaped, deterministic and independent of exclusions',()=>{
 assert(readRows(html).length >= 1119);
 assert.equal(generate(html),html);
 assert(html.match(/data-latest-date="([^"]+)"/)[1] >= "2026-11-13");
 assert.match(html,/<details id="seoContent"/);
 const withTitle=html.replace('세크리터리 (2002)','<script>& &test');
 assert.match(generate(withTitle),/&lt;script&gt;&amp; &amp;test/);
});
test('SEO rejects empty, damaged and invalid input without producing replacement',()=>{
 assert.throws(()=>generate('missing'));
 assert.throws(()=>generate(html.replace(/const RAW_DATA = \[[\s\S]*?\n\];/,'const RAW_DATA = [\n];')));
 assert.throws(()=>generate(html.replace('"11.13"','"13.99"')));
 assert.throws(()=>generate(html.replace('id="seoContent"','id="missingArchive"')));
});
test('exclude unrated work hides repeat recommendations but keeps remake and season',()=>{
 const {c,rows}=setup(); c.toggleMovieExcluded(c.getMovieKey(rows[0]));
 assert.equal(c.filterMovies().length,4);
 assert.equal(c.isMovieExcluded(rows[1]),true);
 assert.equal(c.isMovieExcluded(rows[2]),false);
 assert.equal(c.isMovieExcluded(rows[3]),false);
 assert.equal(Object.keys(c.state.myRatings).length,0);
});
test('filter defaults on; off permits grid, search, bookmarks and picker; X restores',()=>{
 const {c,rows,el}=setup(); c.toggleMovieExcluded(c.getMovieKey(rows[0]));
 el('searchInput').value='같은 영화'; assert.equal(c.filterMovies().length,2);
 c.state.bookmarks.add(c.getMovieKey(rows[0]));c.state.showBookmarksOnly=true;
 assert.equal(c.filterMovies().length,0);
 c.toggleExcludeMarked();assert.equal(c.filterMovies().length,1);assert.equal(c.filterMovies(true).length,1);
 assert(c.isMovieExcluded(rows[0]));c.toggleMovieExcluded(c.getMovieKey(rows[0]));
 assert(!c.isMovieExcluded(rows[0]));c.toggleExcludeMarked();assert.equal(c.filterMovies().length,1);
 c.state.excludeWatched=true;c.state.myRatings[c.getMovieKey(rows[0])]=4;assert.equal(c.filterMovies().length,0);
});
test('filter badge includes default on and disappears when off; compact controls',()=>{
 const {c,el}=setup();c.updateFilterBadge();assert.equal(el('filterActiveCount').textContent,1);
 c.toggleExcludeMarked();c.updateFilterBadge();assert.equal(el('filterActiveCount').style.display,'none');
 assert.match(html,/excludeMarked: true/);assert.match(html,/id="excludeMarkedBtn"/);
 assert(!html.includes('id="excludedToggle"'));assert(!html.includes('exclude-movie-btn'));
 assert.match(html,/class="bookmark-btn exclude-icon/);assert.match(html,/aria-label="\$\{isMovieExcluded/);
});
test('saved exclusions survive reload and are separated between accounts and guest',()=>{
 const {c,rows,storage}=setup();c.toggleMovieExcluded(c.getMovieKey(rows[0]));
 assert.equal(c.readExcludedMovies(null).size,1);
 c.window._setExclusionScope('A');assert.equal(c.state.excludedMovies.size,0);
 c.toggleMovieExcluded(c.getMovieKey(rows[2]));
 c.window._setExclusionScope('B');assert.equal(c.state.excludedMovies.size,0);
 c.window._setExclusionScope('A');assert(c.isMovieExcluded(rows[2]));assert(!c.isMovieExcluded(rows[0]));
 c.window._setExclusionScope(null);assert(c.isMovieExcluded(rows[0]));assert(!c.isMovieExcluded(rows[2]));
 c.toggleMovieExcluded(c.getMovieKey(rows[0]));assert.equal(c.readExcludedMovies(null).size,0);
 storage.set(c.exclusionStorageKey('bad'),'broken JSON');assert.equal(c.readExcludedMovies('bad').size,0);
});
test('missing release year does not conflate recommendations; existing watched and bookmark keys unchanged',()=>{
 const {c,rows}=setup();c.toggleMovieExcluded(c.getMovieKey(rows[4]));assert(!c.isMovieExcluded(rows[5]));
 c.state.myRatings[c.getMovieKey(rows[0])]=4;c.state.excludeWatched=true;
 assert(!c.filterMovies().includes(rows[0]));assert(c.filterMovies().includes(rows[1]));
 const promoted={...rows[0],recommender:'곽수산',legacyRecommender:'게스트'};
 assert.equal(c.getMovieKey(promoted),'같은 영화 (2020)__게스트__2026__11.13');
});
test('inline executable scripts parse',()=>{
 for(const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
  if(!/application\/ld\+json|src=/.test(m[1])) new vm.Script(m[2]);
 }
});

test('exclusion changes and account switches invalidate the running picker',()=>{
 const {c,rows}=setup();c.toggleMovieExcluded(c.getMovieKey(rows[0]));assert.equal(c.closed,1);
 c.window._setExclusionScope('A');assert.equal(c.closed,2);
 assert.match(html,/if \(pickerResultTimer\) \{ clearTimeout\(pickerResultTimer\)/);
 assert(html.includes("pickerPhase === 'anim' && !(state.excludeMarked && isMovieExcluded(picked))"));
 assert(html.includes('if (state.excludeMarked && isMovieExcluded(m)) { closePickerModal(); return; }'));
});

test('touch and narrow layouts expose compact actions despite later base overlay rules',()=>{
 assert.match(html, /@media \(max-width: 640px\) \{\s*\/\* 오버레이 항상 표시 \(모바일\) \*\/\s*\.movie-card \.card-overlay \{ opacity: 1; pointer-events: auto;/);
 assert.match(html, /@media \(hover: none\) \{ \.movie-card \.card-overlay \{ opacity: 1; pointer-events: auto;/);
});

test('reviewed dated page is linked, sitemap-listed and crawlable without scripts',()=>{
 const episode='/broadcasts/2026-11-20.html';
 const canonical='https://mbshow.kr'+episode;
 const page=fs.readFileSync(require('node:path').join(__dirname,'../public',episode),'utf8');
 const {generateBroadcastPage}=require('../generate-seo');
 assert.equal(page,generateBroadcastPage(html,'2026-11-20'));
 assert.match(html,/<a href="\/broadcasts\/2026-11-20\.html">/);
 assert.match(html,/<li><strong>2026년 11월 20일 방송<\/strong>[^\n]+브레이킹 배드 \(2008\) · TV 드라마/);
 assert.doesNotMatch(html,/<li><strong>2026년 11월 20일 방송<\/strong>[^\n]+브레이킹 배드 \(2019\)/);
 const sitemap=fs.readFileSync(require('node:path').join(__dirname,'../public/sitemap.xml'),'utf8');
 assert(sitemap.includes('<loc>'+canonical+'</loc>'));
 assert(page.includes('<link rel="canonical" href="'+canonical+'">'));
 assert.match(page,/<h1>2026년 11월 20일 시네마지옥 추천작/);
 assert.match(page,/브레이킹 배드 \(2008\).*TV 드라마.*거의없다 추천/);
 assert.match(page,/youtube\.com\/watch\?v=YVSmXv4Pv74&amp;t=11776s/);
 const graph=JSON.parse(page.match(/<script type="application\/ld\+json">([^\n]+)<\/script>/)[1]);
 assert.equal(graph.mainEntity.itemListElement[1].item['@type'],'TVSeries');
 assert.equal(graph.mainEntity.itemListElement[1].item.startDate,'2008-01-20');
 assert.equal(graph.mainEntity.itemListElement[1].item.sameAs.includes('https://www.netflix.com/kr/title/70143836'),true);
});
