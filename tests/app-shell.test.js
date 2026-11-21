const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');const html=fs.readFileSync('public/index.html','utf8'),code=fs.readFileSync('public/app-shell.js','utf8'),css=fs.readFileSync('public/app-shell.css','utf8');const canonical=require('../generate-seo').readRows(html);
function setup({canonicalRows=canonical,overlayRows=canonicalRows.slice(-2)}={}){const storage=new Map(),els=new Map();const el=id=>{if(!els.has(id))els.set(id,{innerHTML:'',hidden:false,value:'',setAttribute(){}});return els.get(id)};const c=vm.createContext({CANONICAL_DATA:JSON.parse(JSON.stringify(canonicalRows)),RAW_DATA:JSON.parse(JSON.stringify(overlayRows)),state:{myRatings:{},bookmarks:new Set(),excludedMovies:new Set(),excludeMarked:true,movieCache:{},exclusionUid:null},document:{getElementById:el,querySelectorAll:()=>[],addEventListener(){}},window:{addEventListener(){}},location:{hash:'',search:''},history:{pushState(){}},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},fetchTMDB:()=>null,posterImageStyle:()=>'object-fit:contain',renderGrid(){},alert(){throw Error('alert')},URLSearchParams});for(const name of ['parseTitle','getMovieKey','getExclusionKey','isMovieExcluded']){const a=html.indexOf('function '+name+'('),b=html.indexOf('\n}',a)+2;vm.runInContext(html.slice(a,b),c);}vm.runInContext(code,c);return {c,el,storage,run:s=>vm.runInContext(s,c)};}
test('canonical snapshot precedes edit overlay; original data/SEO contract preserved',()=>{
  const snapshot=html.indexOf('const CANONICAL_DATA'),overlay=html.indexOf('(function loadEdits');
  assert(snapshot>=0&&overlay>snapshot);
  assert(html.includes("localStorage.getItem('cinemaEdits')"));
  const seo=[...html.matchAll(/id="seoContent" data-record-count="(\d+)" data-latest-date="([^"]+)"/g)];
  assert.equal((html.match(/id="seoContent"/g)||[]).length,1);
  assert.equal(seo.length,1);
  assert.equal(Number(seo[0][1]),canonical.length);
  const latest=canonical.map(({year,date})=>year+'-'+date.split('.').slice(0,2).map(x=>x.padStart(2,'0')).join('-')).sort().at(-1);
  assert.equal(seo[0][2],latest);
  assert(canonical.some(m=>m.title==='세크리터리 (2002) - 양윤호'&&String(m.year)==='2026'&&m.date==='11.13'));
});
test('home ignores old cinemaEdits and never falls back when all latest excluded',()=>{
  const older={title:'이전 방송 영화 (2010)',year:'2040',date:'01.03',recommender:'라이너'};
  const latest={title:'이번 방송 영화 (2011)',year:'2040',date:'01.10',recommender:'거의없다'};
  const {run,el}=setup({canonicalRows:[older,latest],overlayRows:[older]});
  run('renderShell()');
  let home=el('shellHome').innerHTML;
  assert.match(home,/<time>2040-01-10<\/time>/);assert.match(home,/>이번 방송 영화<\/a>/);assert.doesNotMatch(home,/이전 방송 영화/);
  run('shellRecent(CANONICAL_DATA).rows.forEach(m=>state.excludedMovies.add(getExclusionKey(m)));renderShell()');
  home=el('shellHome').innerHTML;
  assert.match(home,/모두 제거/);assert.doesNotMatch(home,/class="shell-card"|이전 방송 영화/);
});
test('next broadcast dynamically becomes home without invented review',()=>{
  const older={title:'세크리터리 (2002)',year:'2040',date:'01.03',recommender:'라이너'};
  const {run,el}=setup({canonicalRows:[older],overlayRows:[older]});
  run('renderShell()');
  let home=el('shellHome').innerHTML;
  assert.match(home,/<time>2040-01-03<\/time>/);assert.match(home,/>세크리터리<\/a>/);assert.match(home,/shell-review/);
  run('CANONICAL_DATA.push({title:"다음 방송 영화 (2026)",year:"2040",date:"01.10",recommender:"라이너"});renderShell()');
  home=el('shellHome').innerHTML;
  assert.match(home,/<time>2040-01-10<\/time>/);assert.match(home,/>다음 방송 영화<\/a>/);
  assert.doesNotMatch(home,/세크리터리|shell-review/);
});
test('watched additive override infers ratings until explicit change; no bookmark/rating deletion',()=>{const {run}=setup();run('const m=CANONICAL_DATA[0];state.myRatings[getMovieKey(m)]=4;state.bookmarks.add(getMovieKey(m))');assert.equal(run('shellIsWatched(m)'),true);run('shellToggleWatched(getMovieKey(m))');assert.equal(run('shellIsWatched(m)'),false);assert.equal(run('state.myRatings[getMovieKey(m)]'),4);assert.equal(run('state.bookmarks.has(getMovieKey(m))'),true);});
test('watched state survives scope switch and guest/A/B/logout separation',()=>{const {run}=setup();run('const m=CANONICAL_DATA[0];shellToggleWatched(getMovieKey(m));shellScope("A")');assert.equal(run('shellIsWatched(m)'),false);run('shellToggleWatched(getMovieKey(m));shellScope("B")');assert.equal(run('shellIsWatched(m)'),false);run('shellScope("A")');assert.equal(run('shellIsWatched(m)'),true);run('shellScope(null)');assert.equal(run('shellIsWatched(m)'),true);});
test('inline explore keeps original inputs and IDs, query selects explore',()=>{const {run,c,el}=setup();c.location.search='?q=호루몽';run('shellInit()');assert.equal(el('searchInput').value,'호루몽');assert.equal(el('shellExplore').hidden,false);assert.equal(el('shellHome').hidden,true);for(const id of ['movieGrid','searchInput','searchInputPC','filterDrawer'])assert.equal((html.match(new RegExp('id="'+id+'"','g'))||[]).length,1);assert(!html.includes('<iframe'));});
test('search path override and independent source/footer links',()=>{const {run}=setup();assert.equal(run('shellSearch({title:"A (2002)",searchSuffix:""})'),'https://www.google.com/search?q='+encodeURIComponent('A (2002)'));assert.equal(run('shellSearch({title:"A",searchUrl:"https://example.com/approved"})'),'https://example.com/approved');const s=run('shellCard(CANONICAL_DATA[0])');assert(s.includes('data-shell-action="exclude"'));assert(!s.includes('onclick='));assert(s.indexOf('data-shell-action="exclude"')<s.indexOf('data-shell-action="bookmark"'));assert.match(css,/height:61px;flex:0 0 61px/);});
test('2–6 recent records and long titles keep fixed footer; hidden navigation accessible',()=>{const {run}=setup();for(const n of [2,3,4,5,6]){assert.equal(run(`shellRecent(Array.from({length:${n}},()=>({title:'긴 제목 '.repeat(20),year:'2026',date:'11.13'}))).rows.length`),n);}assert.match(css,/\[hidden\]\{display:none!important\}/);assert.match(css,/@media\(max-width:760px\)/);});

test('manual art and fit preserved; tmdbSkip/infoOverride honored',()=>{const {run}=setup();const s=run('shellCard({...CANONICAL_DATA[0],posterOverride:"https://example.com/manual.jpg",posterFit:"contain",tmdbSkip:true})');assert.match(s,/manual.jpg/);assert.match(s,/object-fit:contain/);const info=run('shellCard({...CANONICAL_DATA[0],infoOverride:{poster:"https://example.com/info.jpg"}})');assert.match(info,/info.jpg/);});
test('effective watched state controls Explore and picker without deleting rating',()=>{const {run,c}=setup();const a=html.indexOf('function filterMovies('),b=html.indexOf('\n}',a)+2;c.state.filters={recommender:'전체',year:'전체',genre:'전체',platform:'전체'};vm.runInContext(html.slice(a,b),c);run('const m=RAW_DATA[0];state.excludeWatched=true;shellToggleWatched(getMovieKey(m))');assert(!run('filterMovies().includes(m)'));assert(!run('filterMovies(true).includes(m)'));run('state.myRatings[getMovieKey(m)]=4;shellToggleWatched(getMovieKey(m))');assert(run('filterMovies().includes(m)'));assert.equal(run('state.myRatings[getMovieKey(m)]'),4);run('state.excludeWatched=false;state.showWatchedOnly=true');assert(!run('filterMovies().includes(m)'));});
test('tab navigation adds history and mobile scroll control avoids tab bar',()=>{assert.match(code,/history.pushState/);assert.match(code,/addEventListener\('popstate'/);assert.match(css,/#scrollTopBtn\{bottom:88px!important\}/);});

test('hashchange and popstate use identical query-aware resolver',()=>{const {run,c}=setup();c.location.search='?q=foo';c.location.hash='#my';assert.equal(run('shellRoute()'),'my');c.location.hash='';assert.equal(run('shellRoute()'),'explore');assert.match(code,/addEventListener\('hashchange',\(\)=>shellSelect\(shellRoute\(\),false\)\)/);assert.match(code,/addEventListener\('popstate',\(\)=>shellSelect\(shellRoute\(\),false\)\)/);c.location.search='';assert.equal(run('shellRoute()'),'home');});

test('My Cinema orders wanted above watched with independent collapsed shelves',()=>{const {run,el}=setup();run('state.bookmarks.add(getMovieKey(CANONICAL_DATA[0]));renderShell()');let s=el('shellMy').innerHTML;assert(s.indexOf('보고 싶은 영화')<s.indexOf('본 영화'));assert.match(s,/aria-controls="shell-wanted-list" aria-expanded="false"/);assert.match(s,/aria-controls="shell-watched-list" aria-expanded="false"/);run('shellState.expanded.wanted=true;renderShell()');s=el('shellMy').innerHTML;assert.match(s,/aria-controls="shell-wanted-list" aria-expanded="true"/);assert.match(s,/aria-controls="shell-watched-list" aria-expanded="false"/);assert.match(s,/>원복<\/button>/);run('shellState.expanded.wanted=false;renderShell()');assert.match(el('shellMy').innerHTML,/aria-controls="shell-wanted-list" aria-expanded="false"/);assert.equal(run('state.bookmarks.size'),1);});
test('shelf dimensions mirror Explore grid minimums and available width',()=>{const {run,c}=setup();let size;const rail={clientWidth:1126,style:{setProperty:(k,v)=>size=v}};c.document.querySelectorAll=()=>[rail];c.window.innerWidth=1174;run('shellSizeShelves()');assert.equal(size,'209.2px');rail.clientWidth=370;c.window.innerWidth=390;run('shellSizeShelves()');assert.equal(size,'180px');assert.match(css,/grid-template-columns:repeat\(auto-fill,minmax\(200px,1fr\)\)/);assert.match(css,/@media\(max-width:640px\)/);assert.match(css,/grid-template-columns:repeat\(auto-fill,minmax\(140px,1fr\)\)/);assert.match(css,/\.shell-nav\{position:sticky;top:56px;z-index:90/);assert.match(css,/\.shell-nav\{top:52px\}/);assert(!css.includes('position:fixed'));});
test('compact My cards retain poster search, X, bookmark, watched actions without long critic blocks',()=>{const {run}=setup();const s=run('shellCard(CANONICAL_DATA[0],true)');for(const action of ['exclude','bookmark','watched'])assert.match(s,new RegExp('data-shell-action="'+action+'"'));assert(!s.includes('shell-review'));assert.match(s,/target="_blank"/);});

test('expanded My lists retain source-backed reviews while collapsed shelves stay compact',()=>{
  const reviewed={title:'세크리터리 (2002) - 양윤호',year:'2040',date:'01.03',recommender:'게스트'};
  const unreviewed={title:'평론 없는 영화 (2040)',year:'2040',date:'01.10',recommender:'라이너'};
  const {run,el}=setup({canonicalRows:[unreviewed,reviewed],overlayRows:[]});
  run('CANONICAL_DATA.forEach(m=>state.bookmarks.add(getMovieKey(m)));renderShell()');
  let shelf=el('shellMy').innerHTML;
  assert.match(shelf,/>세크리터리<\/a>/);assert.match(shelf,/>평론 없는 영화<\/a>/);assert.doesNotMatch(shelf,/shell-review/);
  run('shellState.expanded.wanted=true;renderShell()');
  shelf=el('shellMy').innerHTML;
  assert.equal((shelf.match(/class="shell-review"/g)||[]).length,1);
  assert.match(shelf,/https:\/\/www\.rottentomatoes\.com\/m\/secretary/);
});
