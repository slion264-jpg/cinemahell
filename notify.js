/**
 * notify.js
 * GitHub Actions에서 1시간마다 실행 — 새 게시글 / 신규 로그인을 감지해 카카오톡 알림 전송
 */

const https = require('https');

const KAKAO_REST_KEY    = process.env.KAKAO_REST_API_KEY;
const KAKAO_REFRESH     = process.env.KAKAO_REFRESH_TOKEN;
const SERVICE_ACCOUNT   = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const OWNER_EMAIL       = 'slion264@gmail.com'; // 본인 계정 — 로그인 알림 제외

// ── HTTP 요청 헬퍼 ──────────────────────────────────────────────
function httpRequest(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body || '';
    const req = https.request(
      { hostname, path, method, headers: { 'Content-Length': Buffer.byteLength(data), ...headers } },
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

// ── 카카오 access_token 갱신 ──────────────────────────────────
async function getKakaoAccessToken() {
  const body = `grant_type=refresh_token&client_id=${KAKAO_REST_KEY}&refresh_token=${KAKAO_REFRESH}`;
  const res = await httpRequest('POST', 'kauth.kakao.com', '/oauth/token', {
    'Content-Type': 'application/x-www-form-urlencoded',
  }, body);
  if (res.body.error) throw new Error('카카오 토큰 갱신 실패: ' + JSON.stringify(res.body));
  console.log('카카오 토큰 갱신 성공');
  return res.body.access_token;
}

// ── 카카오톡 나에게 보내기 ────────────────────────────────────
async function sendKakaoMessage(accessToken, text) {
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
  if (res.body.result_code !== 0) {
    throw new Error('카카오 전송 실패: ' + JSON.stringify(res.body));
  }
  console.log('카카오톡 전송 완료');
}

// ── Firebase Admin SDK 초기화 ────────────────────────────────
async function initFirebase() {
  const { initializeApp, cert } = require('firebase-admin/app');
  const { getFirestore }        = require('firebase-admin/firestore');
  const { getAuth }             = require('firebase-admin/auth');
  const app = initializeApp({ credential: cert(SERVICE_ACCOUNT) });
  return { db: getFirestore(app), auth: getAuth(app) };
}

// ── 새 게시글 확인 ────────────────────────────────────────────
async function checkNewPosts(db, since) {
  const snap = await db.collection('posts')
    .where('createdAt', '>', since)
    .orderBy('createdAt', 'desc')
    .get();
  if (snap.empty) return null;

  const lines = snap.docs.map(d => {
    const content = (d.data().content || '').replace(/\n/g, ' ');
    return `"${content.length > 40 ? content.substring(0, 40) + '…' : content}"`;
  });
  return `📝 새 게시글 ${snap.size}건\n${lines.join('\n')}`;
}

// ── 신규 로그인 확인 (본인 제외) ──────────────────────────────
async function checkNewLogins(auth, since) {
  const result = await auth.listUsers(100);
  const loginUsers = result.users.filter(u => {
    if (u.email === OWNER_EMAIL) return false; // 본인 제외
    const lastLogin = u.metadata.lastSignInTime
      ? new Date(u.metadata.lastSignInTime).getTime()
      : 0;
    return lastLogin > since;
  });
  if (loginUsers.length === 0) return null;

  const lines = loginUsers.map(u => u.email || u.uid);
  return `👤 로그인 ${loginUsers.length}건\n${lines.join('\n')}`;
}

// ── 메인 ─────────────────────────────────────────────────────
async function main() {
  const ONE_HOUR_AGO = Date.now() - 60 * 60 * 1000;

  console.log('Firebase 연결 중...');
  const { db, auth } = await initFirebase();

  const [postsMsg, loginMsg] = await Promise.all([
    checkNewPosts(db, ONE_HOUR_AGO),
    checkNewLogins(auth, ONE_HOUR_AGO),
  ]);

  const parts = [postsMsg, loginMsg].filter(Boolean);
  if (parts.length === 0) {
    console.log('지난 1시간 새 활동 없음 — 알림 생략');
    return;
  }

  const message = `[mbshow.kr]\n\n${parts.join('\n\n')}`;
  console.log('발송 메시지:\n' + message);

  const accessToken = await getKakaoAccessToken();
  await sendKakaoMessage(accessToken, message);
}

main().catch(e => { console.error(e); process.exit(1); });
