/**
 * weekly-update.js
 * 매주 금요일 GitHub Actions에서 실행 — 매불쇼 유튜브 커뮤니티의 최신 '시네마 지옥' 게시물을 확인해
 * public/index.html의 RAW_DATA에 새 추천작을 자동으로 추가하고 커밋합니다(푸시는 워크플로우가 담당).
 *
 * TMDB에서 개봉연도를 찾지 못하는 작품이 하나라도 있으면 커밋하지 않고
 * 카카오톡(나에게 보내기)으로 알림만 보내고 종료합니다 — 잘못된 데이터가 사이트에 반영되는 것을 막기 위함입니다.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const TMDB_KEY = process.env.TMDB_KEY || 'eeb851ae2777074ea0c4d84f1e21aa12';
const KAKAO_REST_KEY = process.env.KAKAO_REST_API_KEY;
const KAKAO_REFRESH = process.env.KAKAO_REFRESH_TOKEN;

const REPO_ROOT = __dirname;
const INDEX_PATH = path.join(REPO_ROOT, 'public', 'index.html');
const SITEMAP_PATH = path.join(REPO_ROOT, 'public', 'sitemap.xml');

const FIXED_RECOMMENDERS = ['전찬일', '라이너', '거의없다', '최광희'];

// ── HTTP 요청 헬퍼 (notify.js와 동일) ─────────────────────────
function httpRequest(method, hostname, reqPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body || '';
    const req = https.request(
      { hostname, path: reqPath, method, headers: { 'Content-Length': Buffer.byteLength(data), ...headers } },
      (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
          catch { resolve({ status: res.statusCode, body: d }); }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── 카카오톡 나에게 보내기 (notify.js와 동일 패턴) ────────────
async function getKakaoAccessToken() {
  const body = `grant_type=refresh_token&client_id=${KAKAO_REST_KEY}&refresh_token=${KAKAO_REFRESH}`;
  const res = await httpRequest('POST', 'kauth.kakao.com', '/oauth/token', {
    'Content-Type': 'application/x-www-form-urlencoded',
  }, body);
  if (res.body.error) throw new Error('카카오 토큰 갱신 실패: ' + JSON.stringify(res.body));
  return res.body.access_token;
}

async function sendKakaoMessage(text) {
  if (!KAKAO_REST_KEY || !KAKAO_REFRESH) {
    console.log('[카카오 시크릿 미설정 - 알림 생략]\n' + text);
    return;
  }
  const accessToken = await getKakaoAccessToken();
  const templateObj = JSON.stringify({
    object_type: 'text',
    text: text.substring(0, 200),
    link: { web_url: 'https://mbshow.kr', mobile_web_url: 'https://mbshow.kr' }
  });
  const body = 'template_object=' + encodeURIComponent(templateObj);
  const res = await httpRequest('POST', 'kapi.kakao.com', '/v2/api/talk/memo/default/send', {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/x-www-form-urlencoded',
  }, body);
  if (res.body.result_code !== 0) throw new Error('카카오 전송 실패: ' + JSON.stringify(res.body));
  console.log('카카오톡 알림 전송 완료');
}

// ── TMDB 조회 (build-tmdb-cache.js와 동일 검색 전략) ──────────
async function apiFetch(url) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(url);
  return res.json();
}

async function findYear(title) {
  const simplTitle = title.replace(/[:\-–·,]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const type of ['movie', 'tv']) {
    for (const t of [title, simplTitle]) {
      const q = encodeURIComponent(t);
      const data = await apiFetch(`https://api.themoviedb.org/3/search/${type}?api_key=${TMDB_KEY}&query=${q}&language=ko-KR&include_adult=false`);
      const r = (data.results || [])[0];
      if (r) {
        const date = r.release_date || r.first_air_date;
        if (date) return { year: date.slice(0, 4), matchedTitle: r.title || r.name };
      }
    }
  }
  const q = encodeURIComponent(title);
  const data = await apiFetch(`https://api.themoviedb.org/3/search/multi?api_key=${TMDB_KEY}&query=${q}&language=ko-KR&include_adult=false`);
  const r = (data.results || []).find(x => x.media_type === 'movie' || x.media_type === 'tv');
  if (r) {
    const date = r.release_date || r.first_air_date;
    if (date) return { year: date.slice(0, 4), matchedTitle: r.title || r.name };
  }
  return null;
}

// ── 유튜브 커뮤니티에서 최신 시네마지옥 게시물 가져오기 ───────
// 주의: youtubei.js는 비공식 라이브러리라 유튜브 쪽 구조 변경 시 깨질 수 있습니다.
// 실패 시 예외를 던지므로, Actions 로그에서 원인을 확인해 조정하세요.
async function getLatestCinemahellPost() {
  const { Innertube } = await import('youtubei.js');
  const yt = await Innertube.create({ generate_session_locally: true });
  const channel = await yt.getChannel('@maebulshow');
  const community = await channel.getCommunity();

  const items = community?.posts || community?.contents || [];
  for (const item of items) {
    const text = extractPostText(item);
    if (text && text.includes('시네마') && text.includes('지옥')) {
      return text;
    }
  }
  return null;
}

function extractPostText(item) {
  try {
    const content = item.content ?? item.post?.content ?? item?.backstage_attachment?.content;
    if (content?.toString) return content.toString();
    if (typeof content === 'string') return content;
  } catch (e) { /* ignore */ }
  return null;
}

// ── 게시물 텍스트에서 "*이름 - 제목" 라인 파싱 ────────────────
function parsePost(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const entries = [];
  for (const line of lines) {
    const m = line.match(/^\*\s*([^\-]+?)\s*-\s*(.+)$/);
    if (!m) continue;
    const name = m[1].trim();
    const title = m[2].trim().replace(/[.\u2026]+$/, ''); // 끝의 마침표/말줄임 제거
    const isFixed = FIXED_RECOMMENDERS.includes(name);
    entries.push({
      recommender: isFixed ? name : '게스트',
      guestName: isFixed ? null : name,
      rawTitle: title,
    });
  }
  return entries;
}

// ── 오늘 날짜 기준 MM.DD / 연도 ────────────────────────────────
function todayDate() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return { date: `${mm}.${dd}`, year: String(now.getFullYear()) };
}

// ── RAW_DATA 읽기 ──────────────────────────────────────────────
function readRawData(html) {
  const m = html.match(/const RAW_DATA = (\[[\s\S]*?\n\]);/);
  if (!m) throw new Error('RAW_DATA 파싱 실패');
  return eval(m[1]);
}

function buildEntryBlock(entry) {
  return `  {\n    "date": "${entry.date}",\n    "year": "${entry.year}",\n    "recommender": "${entry.recommender}",\n    "title": "${entry.title.replace(/"/g, '\\"')}"\n  },\n`;
}

// ── 메인 ─────────────────────────────────────────────────────
async function main() {
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const rawData = readRawData(html);

  console.log('유튜브 최신 게시물 확인 중...');
  const postText = await getLatestCinemahellPost();
  if (!postText) {
    console.log('시네마지옥 게시물을 찾지 못했습니다. 종료.');
    return;
  }
  console.log('게시물 원문:\n' + postText);

  const { date, year } = todayDate();

  // 이미 오늘 날짜로 등록된 게 있으면 중복으로 보고 종료
  if (rawData.some(r => r.date === date)) {
    console.log(`이미 ${date} 항목이 존재합니다. 종료.`);
    return;
  }

  const parsed = parsePost(postText);
  if (parsed.length === 0) {
    console.log('추천작 라인을 찾지 못했습니다. 종료.');
    return;
  }

  // TMDB 조회
  const unresolved = [];
  const resolvedEntries = [];
  for (const p of parsed) {
    const found = await findYear(p.rawTitle);
    if (!found) {
      unresolved.push(p);
      continue;
    }
    const title = p.recommender === '게스트'
      ? `${p.rawTitle} (${found.year}) - ${p.guestName}`
      : `${p.rawTitle} (${found.year})`;
    resolvedEntries.push({ date, year, recommender: p.recommender, title });
  }

  if (unresolved.length > 0) {
    const msg = `[mbshow.kr 시네마지옥 자동 업데이트 보류]\n\n` +
      `TMDB에서 개봉연도를 찾지 못한 작품이 있어 이번 주는 자동 반영하지 않았습니다:\n` +
      unresolved.map(u => `- ${u.recommender === '게스트' ? u.guestName : u.recommender}: ${u.rawTitle}`).join('\n') +
      `\n\n확인 후 index.html에 직접 추가해 주세요. (나머지 ${resolvedEntries.length}개는 문제없이 찾았지만, 이번 주는 전체를 보류합니다.)`;
    console.log(msg);
    await sendKakaoMessage(msg);
    return; // 커밋하지 않음
  }

  // index.html 수정
  const marker = 'const RAW_DATA = [\n';
  const idx = html.indexOf(marker) + marker.length;
  const newBlock = resolvedEntries.map(buildEntryBlock).join('');
  const newHtml = html.slice(0, idx) + newBlock + html.slice(idx);
  fs.writeFileSync(INDEX_PATH, newHtml, 'utf8');

  // sitemap.xml 수정
  const todayISO = new Date().toISOString().slice(0, 10);
  let sitemap = fs.readFileSync(SITEMAP_PATH, 'utf8');
  sitemap = sitemap.replace(/<lastmod>[\d-]+<\/lastmod>/, `<lastmod>${todayISO}</lastmod>`);
  fs.writeFileSync(SITEMAP_PATH, sitemap, 'utf8');

  console.log(`\u2705 ${resolvedEntries.length}개 항목 추가 완료:`);
  resolvedEntries.forEach(e => console.log(`  - [${e.recommender}] ${e.title}`));

  const doneMsg = `[mbshow.kr] 시네마지옥 ${date} 추천작 ${resolvedEntries.length}편 자동 반영 완료\n` +
    resolvedEntries.map(e => `- [${e.recommender}] ${e.title}`).join('\n');
  await sendKakaoMessage(doneMsg).catch(e => console.error('완료 알림 실패(무시):', e.message));
}

main().catch(e => {
  console.error('실패:', e);
  process.exit(1);
});
