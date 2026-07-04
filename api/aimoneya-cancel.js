// api/aimoneya-cancel.js
// AI금융집짓기 정기구독 해지 — 신규 앱 전용.
// 하는 일: 앱에서 로그인한 본인이 해지 요청 → 다음 결제일부터 미청구(당월은 그대로 유지).
//   - billing/{uid}.status = 'canceled'  (billing-run이 다음 결제일에 만료 처리)
//   - subscription/current.cancelAtPeriodEnd = true (status는 active 유지 → 당월 프리미엄 그대로)
//
// 보안: Firebase ID 토큰을 검증해 "본인만" 자기 구독을 해지할 수 있게 한다(uid 위조 차단).
// 옛 상품 로직과 무관(ai-moneya만).
//
// Vercel 환경변수: FIREBASE_SERVICE_ACCOUNT_AIMONEYA (미설정이면 501로 응답).

const admin = require('firebase-admin');

function getAiMoneyaApp() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_AIMONEYA) return null;
  try {
    const existing = admin.apps.find((a) => a && a.name === 'aimoneya');
    return existing || admin.initializeApp(
      { credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_AIMONEYA)) },
      'aimoneya'
    );
  } catch (e) { console.error('[aimoneya-cancel] admin 초기화 실패:', e.message); return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ result: 'fail', message: 'Method Not Allowed' });

  const app = getAiMoneyaApp();
  if (!app) return res.status(501).json({ result: 'skip', message: 'ai-moneya 서비스계정 미설정' });

  // ID 토큰: Authorization: Bearer <token> 또는 body.idToken
  const bearer  = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const idToken = bearer || (req.body && req.body.idToken) || '';
  if (!idToken) return res.status(401).json({ result: 'fail', message: '로그인 토큰이 필요합니다.' });

  let uid;
  try { uid = (await app.auth().verifyIdToken(idToken)).uid; }
  catch (e) { return res.status(401).json({ result: 'fail', message: '유효하지 않은 로그인입니다.' }); }

  const db = app.firestore();
  const FV = admin.firestore.FieldValue;
  try {
    // billing: 다음 결제일부터 미청구 (billing-run이 그날 만료 처리)
    await db.doc(`billing/${uid}`).set({ status: 'canceled', canceledAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() }, { merge: true });
    // subscription: 당월은 프리미엄 유지 (status active 유지, 해지예약 표시만)
    await db.doc(`users/${uid}/subscription/current`).set({ cancelAtPeriodEnd: true, updatedAt: FV.serverTimestamp() }, { merge: true });
    console.log('[aimoneya-cancel] 해지 예약 uid=', uid);
    return res.status(200).json({ result: 'success', message: '해지 예약 완료 — 다음 결제일부터 청구되지 않아요(당월은 그대로 이용).' });
  } catch (e) {
    console.error('[aimoneya-cancel] 실패:', e.message);
    return res.status(200).json({ result: 'error', message: e.message });
  }
};
