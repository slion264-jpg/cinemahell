/**
 * build-tmdb-cache.js
 * 모든 RAW_DATA 작품의 TMDB 데이터를 수집해 tmdb-cache.json으로 저장합니다.
 * 사용법: node build-tmdb-cache.js
 */

const fs = require('fs');
const path = require('path');

const TMDB_KEY = process.env.TMDB_KEY || 'eeb851ae2777074ea0c4d84f1e21aa12';
// GitHub Actions: __dirname = 저장소 루트 → public/tmdb-cache.json
// 로컬: __dirname = cinemahell/ → github/cinemahell/public/tmdb-cache.json
const isCI = !!process.env.GITHUB_ACTIONS;
const OUT_PATH = isCI
  ? path.join(__dirname, 'public', 'tmdb-cache.json')
  : path.join(__dirname, 'github', 'cinemahell', 'public', 'tmdb-cache.json');

const TMDB_ID_MAP = {
  '삼체__2024':           { id: 108545, type: 'tv' },
  '탄생__2022':           { id: 881677, type: 'movie' },
  '헌트__2022':           { id: 727340, type: 'movie' },
  'The 8 Show__2024':     { id: 156484, type: 'tv' },
  '빌리 엘리어트__2000':  { id: 71,      type: 'movie' },
  '모래그릇__1974':       { id: 29268,   type: 'movie' },
  '워스__2020':           { id: 649394,  type: 'movie' },
  '직장상사 길들이기__2026': { id: 1198994, type: 'movie' },
};

const genreMap = {28:'액션',12:'어드벤처',16:'애니메이션',35:'코미디',80:'범죄',99:'다큐멘터리',18:'드라마',10751:'가족',14:'판타지',36:'역사',27:'공포',10402:'음악',9648:'미스터리',10749:'로맨스',878:'SF',10770:'TV영화',53:'스릴러',10752:'전쟁',37:'서부'};

// RAW_DATA를 index.html에서 추출 (eval 방식으로 안전하게 파싱)
const HTML_PATH = isCI
  ? path.join(__dirname, 'public', 'index.html')
  : path.join(__dirname, 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');
const match = html.match(/const RAW_DATA = (\[[\s\S]*?\n\];)/);
if (!match) { console.error('RAW_DATA 파싱 실패'); process.exit(1); }
let RAW_DATA;
try {
  RAW_DATA = eval(match[1]);
} catch(e) {
  console.error('RAW_DATA eval 실패:', e.message);
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseTitle(raw) {
  if (!raw) return { cleanTitle: '', releaseYear: null };
  let t = raw.replace(/\s*-\s*[^-]+$/, '').trim(); // 게스트명 제거
  const m = t.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  if (m) return { cleanTitle: m[1].trim(), releaseYear: m[2] };
  return { cleanTitle: t, releaseYear: null };
}

function getMovieKey(m) {
  const { cleanTitle, releaseYear } = parseTitle(m.title);
  return `${cleanTitle}__${releaseYear || m.year}`;
}

async function apiFetch(url) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(url);
  return res.json();
}

async function getOttList(tmdbId, mediaType) {
  try {
    const data = await apiFetch(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}/watch/providers?api_key=${TMDB_KEY}`);
    const kr = data.results?.KR;
    if (!kr) return [];
    const providers = [...(kr.flatrate||[]), ...(kr.buy||[]), ...(kr.rent||[])];
    const seen = new Set();
    return providers.filter(p => { if (seen.has(p.provider_id)) return false; seen.add(p.provider_id); return true; })
      .map(p => ({ id: p.provider_id, name: p.provider_name, logo: `https://image.tmdb.org/t/p/original${p.logo_path}` }));
  } catch { return []; }
}

async function fetchTMDB(title, year) {
  const cacheKey = `${title}__${year}`;
  const mapEntry = TMDB_ID_MAP[cacheKey];

  async function buildResult(m, type) {
    const poster = m.poster_path ? `https://image.tmdb.org/t/p/w342${m.poster_path}` : null;
    const rating = m.vote_average ? Math.round(m.vote_average * 10) / 10 : null;
    const genres = (m.genres || m.genre_ids || []).map(g => typeof g === 'object' ? g.name : (genreMap[g] || '')).filter(Boolean).slice(0,3);
    const releaseDate = m.release_date || m.first_air_date || null;
    const id = m.id;
    const ottList = await getOttList(id, type);
    return { poster, rating, voteCount: m.vote_count || 0, overview: m.overview || '', genres, tmdbId: id, mediaType: type, releaseDate, ottList };
  }

  // 0차: 수동 매핑
  if (mapEntry) {
    const data = await apiFetch(`https://api.themoviedb.org/3/${mapEntry.type}/${mapEntry.id}?api_key=${TMDB_KEY}&language=ko-KR`);
    return buildResult(data, mapEntry.type);
  }

  async function searchAndBuild(searchTitle, searchYear, type) {
    const q = encodeURIComponent(searchTitle);
    const yearParam = searchYear ? (type === 'tv' ? `&first_air_date_year=${searchYear}` : `&year=${searchYear}`) : '';
    const data = await apiFetch(`https://api.themoviedb.org/3/search/${type}?api_key=${TMDB_KEY}&query=${q}${yearParam}&language=ko-KR&include_adult=false`);
    return data.results || [];
  }

  const simplTitle = title.replace(/[:\-–·,]/g,' ').replace(/\s+/g,' ').trim();

  // 1~3차: movie
  for (const [t, y] of [[title,year],[title,null],[simplTitle,null]]) {
    const r = await searchAndBuild(t, y, 'movie');
    if (r.length) return buildResult(r[0], 'movie');
  }
  // 4~6차: tv
  for (const [t, y] of [[title,year],[title,null],[simplTitle,null]]) {
    const r = await searchAndBuild(t, y, 'tv');
    if (r.length) return buildResult(r[0], 'tv');
  }
  // 7차: multi
  const q = encodeURIComponent(title);
  const data = await apiFetch(`https://api.themoviedb.org/3/search/multi?api_key=${TMDB_KEY}&query=${q}&language=ko-KR&include_adult=false`);
  const results = (data.results || []).filter(r => r.media_type === 'movie' || r.media_type === 'tv');
  if (results.length) return buildResult(results[0], results[0].media_type);

  return null;
}

async function main() {
  // 기존 캐시 로드 (증분 업데이트용)
  let existing = {};
  if (fs.existsSync(OUT_PATH)) {
    existing = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    console.log(`기존 캐시 로드: ${Object.keys(existing).length}개`);
  }

  const keys = new Set();
  const toFetch = [];

  for (const m of RAW_DATA) {
    if (m.tmdbSkip) continue;
    const key = getMovieKey(m);
    if (keys.has(key)) continue;
    keys.add(key);
    if (existing[key]) continue; // 이미 캐시된 항목 건너뜀
    toFetch.push(m);
  }

  console.log(`신규 수집 대상: ${toFetch.length}개 / 전체: ${keys.size}개`);

  let done = 0;
  for (const m of toFetch) {
    const key = getMovieKey(m);
    const { cleanTitle, releaseYear } = parseTitle(m.title);
    try {
      const info = await fetchTMDB(cleanTitle, releaseYear);
      existing[key] = info || null;
      done++;
      process.stdout.write(`\r진행: ${done}/${toFetch.length} - ${cleanTitle}`);
    } catch(e) {
      console.error(`\n오류: ${cleanTitle}`, e.message);
      existing[key] = null;
    }
    await sleep(250); // TMDB API rate limit 방지
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(existing, null, 2), 'utf8');
  console.log(`\n\n✅ 완료: ${Object.keys(existing).length}개 항목 → ${OUT_PATH}`);
}

main().catch(e => {
  console.error('캐시 빌드 실패 (기존 캐시 유지):', e.message);
  process.exit(0); // 배포는 계속 진행
});
