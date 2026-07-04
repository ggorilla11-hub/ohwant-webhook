// api/aimoneya-check.js — 진단/복구(임시). 옛 상품과 무관, ai-moneya만.
//   GET ?uid=XXX            → 읽기전용 진단: 서비스계정 설정·DB init·구독문서 존재 여부(비밀값 반환 없음)
//   GET ?uid=XXX&key=SECRET → CRON_SECRET 일치 시, 이미 결제한 계정을 subscription active로 복구(재청구 없음)
// 확인 끝나면 삭제.

const admin = require('firebase-admin');

module.exports = async function handler(req, res) {
  const q = req.query || {};
  const uid = q.uid || '';
  const envSet = !!process.env.FIREBASE_SERVICE_ACCOUNT_AIMONEYA;
  let dbOk = false, subscriptionExists = null, subscriptionStatus = null, reconciled = false, err = null;

  try {
    if (envSet) {
      const existing = admin.apps.find((a) => a && a.name === 'aimoneya');
      const app = existing || admin.initializeApp(
        { credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_AIMONEYA)) },
        'aimoneya'
      );
      const db = app.firestore();
      dbOk = true;

      if (uid) {
        const ref = db.doc(`users/${uid}/subscription/current`);
        const snap = await ref.get();
        subscriptionExists = snap.exists;
        subscriptionStatus = snap.exists ? (snap.get('status') || null) : null;

        // 복구: CRON_SECRET 일치 시에만. 이미 결제 성공한 계정을 active로(재청구 안 함).
        const secret = process.env.CRON_SECRET || '';
        if (secret && q.key === secret) {
          const FV = admin.firestore.FieldValue;
          const nb = new Date(); nb.setMonth(nb.getMonth() + 1);
          await ref.set({
            status: 'active', plan: 'premium_monthly', price: 9900, currency: 'KRW',
            startedAt: FV.serverTimestamp(), nextBillingAt: nb.toISOString().slice(0, 10),
            updatedAt: FV.serverTimestamp(), reconciled: true,
          }, { merge: true });
          reconciled = true;
          subscriptionStatus = 'active';
          subscriptionExists = true;
        }
      }
    }
  } catch (e) { err = e.message; }

  return res.status(200).json({ envSet, dbOk, uid, subscriptionExists, subscriptionStatus, reconciled, err });
};
