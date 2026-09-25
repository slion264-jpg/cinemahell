/**
 * weekly-update.js
 * 매주 금요일 GitHub Actions에서 실행 — 매불쇼 유튜브 커뮤니티의 최신 '시네마 지옥' 게시물을 확인해
 * public/index.html의 RAW_DATA에 새 추천작을 자동으로 추가하고 커밋합니다(푸시는 워크플로우가 담당).
 *
 * TMDB에서 개봉연도를 찾지 못하는 작품이 하나라도 있으면 아무것도 반영하지 않고 로그만 남긴 채 종료합니다
 * — 잘못된 데이터가 사이트에 반영되는 것을 막기 위함입니다. (Actions 로그에서 확인 후 index.html에 직접 추가)
 */

const fs = require('fs');
const path = require('path');

const TMDB_KEY = process.env.TMDB_KEY;
const FINAL_ATTEMPT = process.env.FINAL_ATTEMPT === 'true';

if (!TMDB_KEY) {
  throw new Error('TMDB_KEY GitHub Secret이 설정되어 있지 않습니다.');
}

const REPO_ROOT = __dirname;
const INDEX_PATH = path.join(REPO_ROOT, 'public', 'index.html');
const SITEMAP_PATH = path.join(REPO_ROOT, 'public', 'sitemap.xml');

const FIXED_RECOMMENDERS = ['전찬일', '라이너', '거의없다', '최광희'];

// ── TMDB 조회 (build-tmdb-cache.js와 동일 검색 전략) ──────────
async function apiFetch(url) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(url);
  return res.json();
}

function normalizeTitle(title) {
  return title
    .replace(/\s*[\(\[]\s*\d+\s*부작\s*[\)\]]\s*$/i, '')
    .replace(/\s*[\(\[]\s*(?:시리즈|드라마|영화|다큐(?:멘터리)?)\s*[\)\]]\s*$/i, '')
    .trim();
}

async function findYear(title) {
  const normalizedTitle = normalizeTitle(title);
  const simplTitle = normalizedTitle.replace(/[:\-–·,]/g, ' ').replace(/\s+/g, ' ').trim();
  const candidates = [...new Set([title, normalizedTitle, simplTitle].filter(Boolean))];
  for (const type of ['movie', 'tv']) {
    for (const t of candidates) {
      const q = encodeURIComponent(t);
      const data = await apiFetch(`https://api.themoviedb.org/3/search/${type}?api_key=${TMDB_KEY}&query=${q}&language=ko-KR&include_adult=false`);
      const r = (data.results || [])[0];
      if (r) {
        const date = r.release_date || r.first_air_date;
        if (date) return { year: date.slice(0, 4), matchedTitle: r.title || r.name };
      }
    }
  }
  const q = encodeURIComponent(normalizedTitle);
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
//
// getChannel()은 핸들(@maebulshow)이 아니라 browseId(UC...)를 받으므로
// resolveURL로 먼저 핸들 → browseId 변환이 필요합니다.
async function getLatestCinemahellPost() {
  const { Innertube, YTNodes } = await import('youtubei.js');
  const yt = await Innertube.create({ generate_session_locally: true });

  const resolved = await yt.resolveURL('https://www.youtube.com/@maebulshow');
  const browseId = resolved?.payload?.browseId;
  if (!browseId) {
    throw new Error('채널 ID 확인 실패 (resolveURL 응답에 browseId 없음): ' + JSON.stringify(resolved));
  }
  console.log('채널 browseId:', browseId);

  const channel = await yt.getChannel(browseId);
  const community = await channel.getCommunity();

  const threads = community?.memo?.getType(YTNodes.BackstagePostThread) || [];
  console.log(`커뮤니티 게시물 ${threads.length}건 확인`);

  for (const thread of threads) {
    const post = thread.post || thread;
    const text = extractPostText(post);
    if (text && text.includes('시네마') && text.includes('지옥')) {
      const published = post?.published?.toString?.() || '';
      return { text, published };
    }
  }
  return null;
}

function extractPostText(post) {
  try {
    const content = post?.content;
    if (content?.toString) return content.toString();
    if (typeof content === 'string') return content;
  } catch (e) { /* ignore */ }
  return null;
}

// ── 게시물의 "N일 전" / "N주 전" / "N시간 전" 등을 실제 날짜로 환산 ─
function resolveDate(publishedText) {
  const now = new Date();
  const d = new Date(now);
  const dayMatch = publishedText.match(/(\d+)\s*(?:일\s*전|days?\s+ago)/i);
  const weekMatch = publishedText.match(/(\d+)\s*(?:주\s*전|weeks?\s+ago)/i);
  const monthMatch = publishedText.match(/(\d+)\s*(?:개월\s*전|months?\s+ago)/i);
  if (monthMatch) d.setMonth(d.getMonth() - parseInt(monthMatch[1], 10));
  else if (weekMatch) d.setDate(d.getDate() - parseInt(weekMatch[1], 10) * 7);
  else if (dayMatch) d.setDate(d.getDate() - parseInt(dayMatch[1], 10));
  // "N시간 전", "N분 전"이면 오늘 날짜 그대로 사용
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return { date: `${mm}.${dd}`, year: String(d.getFullYear()) };
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
function dateParts(d) {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return { date: `${mm}.${dd}`, year: String(d.getUTCFullYear()) };
}

function todayDate() {
  return dateParts(new Date());
}

// KST 기준 가장 최근 금요일을 해당 회차의 방송일로 사용합니다.
// YouTube 커뮤니티 글은 방송일보다 1~2일 먼저 올라올 수 있어 게시일을 방송일로 쓰지 않습니다.
function targetBroadcastDate() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const daysSinceFriday = (kst.getUTCDay() + 2) % 7;
  kst.setUTCDate(kst.getUTCDate() - daysSinceFriday);
  return dateParts(kst);
}

function toUtcDate(parts) {
  const [month, day] = parts.date.split('.').map(Number);
  return Date.UTC(Number(parts.year), month - 1, day);
}

function isCurrentWeekPost(postDate, targetDate) {
  const daysBeforeBroadcast = Math.round((toUtcDate(targetDate) - toUtcDate(postDate)) / 86400000);
  return daysBeforeBroadcast >= 0 && daysBeforeBroadcast <= 4;
}

function deferOrFail(message) {
  console.log(message);
  if (FINAL_ATTEMPT) {
    throw new Error('자정 최종 확인 실패: ' + message);
  }
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

  const target = targetBroadcastDate();

  if (rawData.some(r => r.date === target.date && String(r.year) === target.year)) {
    console.log(`이미 ${target.year}년 ${target.date} 항목이 존재합니다. 종료.`);
    return;
  }

  console.log('유튜브 최신 게시물 확인 중...');
  const post = await getLatestCinemahellPost();
  if (!post) {
    deferOrFail('시네마지옥 게시물을 찾지 못했습니다.');
    return;
  }
  const { text: postText, published } = post;
  console.log('게시물 게시 시점:', published || '(알 수 없음 - 오늘 날짜로 대체)');
  console.log('게시물 원문:\n' + postText);

  const postPublishedDate = published ? resolveDate(published) : todayDate();
  if (!isCurrentWeekPost(postPublishedDate, target)) {
    deferOrFail(`최신 게시물이 이번 주 방송분이 아닙니다. 게시=${postPublishedDate.year}.${postPublishedDate.date}, 방송=${target.year}.${target.date}`);
    return;
  }
  const { date, year } = target;

  // 연도와 날짜를 함께 비교해 다른 해의 같은 MM.DD와 충돌하지 않도록 합니다.
  if (rawData.some(r => r.date === date && String(r.year) === String(year))) {
    console.log(`이미 ${year}년 ${date} 항목이 존재합니다. 종료.`);
    return;
  }

  const parsed = parsePost(postText);
  if (parsed.length === 0) {
    deferOrFail('추천작 라인을 찾지 못했습니다.');
    return;
  }

  // TMDB 조회
  const unresolved = [];
  const resolvedEntries = [];
  for (const p of parsed) {
    const cleanTitle = normalizeTitle(p.rawTitle);
    const found = await findYear(cleanTitle);
    if (!found) {
      unresolved.push(p);
      continue;
    }
    const title = p.recommender === '게스트'
      ? `${cleanTitle} (${found.year}) - ${p.guestName}`
      : `${cleanTitle} (${found.year})`;
    resolvedEntries.push({ date, year, recommender: p.recommender, title });
  }

  if (unresolved.length > 0) {
    console.log(`[시네마지옥 자동 업데이트 보류] TMDB에서 개봉연도를 찾지 못한 작품이 있어 이번 주는 자동 반영하지 않았습니다:`);
    unresolved.forEach(u => console.log(`  - ${u.recommender === '게스트' ? u.guestName : u.recommender}: ${u.rawTitle}`));
    const message = `확인 후 index.html에 직접 추가해 주세요. (나머지 ${resolvedEntries.length}개는 문제없이 찾았지만, 이번 주는 전체를 보류합니다.)`;
    deferOrFail(message);
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
}

main().catch(e => {
  console.error('실패:', e);
  process.exit(1);
});
