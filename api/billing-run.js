// api/billing-run.js
// AI금융집짓기(ai-moneya) 정기구독 매월 자동청구 — Vercel Cron(하루 1회)이 호출.
//
// 하는 일(매일 1회):
//   1) 오늘이 결제일(nextBillingAt <= 오늘)인 billing/{uid} 문서만 조회
//   2) 빌링키(PCD_PAYER_ID)로 9,900원 재결제
//        - 성공: nextBillingAt +1개월, users/{uid}/subscription/current = active 갱신
//        - 실패: 3일 뒤 재시도(최대 3회, 그동안 프리미엄 유예 유지)
//                3회째도 실패 → 구독 정지 + subscription = past_due (앱이 무료로 강등)
//   3) 해지(status=canceled): 청구하지 않고 당월 만료 처리(subscription=canceled)
//
// ★ 옛 상품(구글시트·강의·moneya-72fe6·financial-house-building) 로직은 전혀 건드리지 않는다.
//    이 파일은 신규 앱 구독(billing 컬렉션, ai-moneya)만 다룬다.
//
// Vercel 환경변수 (대표가 직접 입력 — 값은 나만 입력):
//   CRON_SECRET                       : 크론 보호 시크릿. Vercel Cron이 Authorization: Bearer 로 자동 전송.
//   PAYPLE_CST_ID / PAYPLE_CUST_KEY   : 페이플 가맹점 인증(placeholder면 결제는 인증실패로 응답 → 안전).
//   FIREBASE_SERVICE_ACCOUNT_AIMONEYA : ai-moneya 서비스계정 JSON 전체. 미설정이면 조용히 스킵.

const admin = require('firebase-admin');

const WEBHOOK_URL = 'https://ohwant-webhook.vercel.app';
const PRICE       = 9900;
const MAX_RETRY   = 3;   // 실패 시 최대 재시도 횟수
const RETRY_DAYS  = 3;   // 재시도 간격(일)
const FAR_FUTURE  = '9999-12-31'; // 종료된 구독은 조회 창에서 빠지도록

// ── ai-moneya 전용 firebase-admin (payple.js와 동일 패턴, 이름 'aimoneya'로 중복 init 방지) ──
function getAiMoneyaDb() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_AIMONEYA) return null;
  try {
    const existing = admin.apps.find((a) => a && a.name === 'aimoneya');
    const app = existing || admin.initializeApp(
      { credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_AIMONEYA)) },
      'aimoneya'
    );
    return app.firestore();
  } catch (e) { console.error('[billing-run] ai-moneya admin 초기화 실패:', e.message); return null; }
}

const ymd       = (d) => d.toISOString().slice(0, 10);
const addMonths = (base, n) => { const d = new Date(base); d.setMonth(d.getMonth() + n); return d; };
const addDays   = (base, n) => { const d = new Date(base); d.setDate(d.getDate() + n); return d; };

// 페이플 파트너 인증 → 재결제용 AUTH_KEY 발급 (빌링키 결제 1단계)
async function paypleAuth() {
  const params = new URLSearchParams({
    cst_id:  process.env.PAYPLE_CST_ID  || '',
    custKey: process.env.PAYPLE_CUST_KEY || '',
    PCD_PAY_WORK: 'PUSERINFO', // 등록된 빌링키로 재결제(정기) 인증
  });
  const r = await fetch('https://cpay.payple.kr/php/auth.php', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': WEBHOOK_URL },
    body:    params.toString(),
  });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch (e) { return { ok: false, msg: '인증 응답 파싱 실패: ' + txt.slice(0, 120) }; }
  if (j.result !== 'success') return { ok: false, msg: j.PCD_PAY_MSG || j.message || '인증 실패' };
  return { ok: true, auth: j };
}

// 빌링키로 실결제 (2단계)
async function paypleCharge(auth, { billingKey, uid, oid }) {
  const host   = auth.PCD_PAY_HOST || 'https://cpay.payple.kr';
  const actUrl = auth.return_url || auth.PCD_PAY_URL || (host + '/php/SimplePayCardAct.php?ACT_=PAYM');
  const r = await fetch(actUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Referer': WEBHOOK_URL },
    body: JSON.stringify({
      PCD_CST_ID:   auth.cst_id,
      PCD_CUST_KEY: auth.custKey,
      PCD_AUTH_KEY: auth.AuthKey || auth.PCD_AUTH_KEY,
      PCD_PAY_TYPE: 'card',
      PCD_PAYER_ID: billingKey,           // 등록된 빌링키
      PCD_PAY_GOODS: 'AI금융집짓기 프리미엄 구독',
      PCD_PAY_TOTAL: String(PRICE),
      PCD_PAY_OID:   oid,
      PCD_SIMPLE_FLAG: 'Y',
      PCD_PAYER_NO:  uid,
    }),
  });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch (e) { return { ok: false, msg: '결제 응답 파싱 실패' }; }
  return { ok: j.PCD_PAY_RST === 'success', msg: j.PCD_PAY_MSG || '' };
}

module.exports = async function handler(req, res) {
  // ── 크론 보안: CRON_SECRET 확인 (Vercel Cron이 Authorization: Bearer 로 자동 전송) ──
  const secret = process.env.CRON_SECRET || '';
  const bearer = req.headers.authorization || '';
  const keyQ   = (req.query && (req.query.key || req.query.secret)) || '';
  if (!secret || (bearer !== `Bearer ${secret}` && keyQ !== secret)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const db = getAiMoneyaDb();
  if (!db) return res.status(200).json({ result: 'skip', reason: 'ai-moneya 서비스계정 미설정' });

  const FV       = admin.firestore.FieldValue;
  const now      = new Date();
  const todayStr = ymd(now);
  const summary  = { checked: 0, charged: 0, retried: 0, stopped: 0, canceled: 0, skipped: 0, errors: 0 };

  // 오늘이 결제일인(또는 지난) 구독만 (단일 부등호 → Firestore 자동 인덱스)
  let snap;
  try { snap = await db.collection('billing').where('nextBillingAt', '<=', todayStr).get(); }
  catch (e) { return res.status(200).json({ result: 'error', message: e.message }); }

  let authRes = null; // 파트너 인증은 배치당 1회만

  for (const doc of snap.docs) {
    summary.checked++;
    const uid    = doc.id;
    const b      = doc.data() || {};
    const status = b.status || 'active';

    // 해지: 청구하지 않고 당월 만료 처리
    if (status === 'canceled') {
      summary.canceled++;
      await doc.ref.set({ status: 'expired', nextBillingAt: FAR_FUTURE, updatedAt: FV.serverTimestamp() }, { merge: true });
      await db.doc(`users/${uid}/subscription/current`).set({ status: 'canceled', updatedAt: FV.serverTimestamp() }, { merge: true });
      continue;
    }
    if (status === 'stopped' || status === 'expired') { summary.skipped++; continue; }
    if (!b.billingKey) { summary.skipped++; continue; }

    // 파트너 인증 확보(최초 1회). 인증 자체가 실패면 이번 배치 중단(다음 크론에서 재시도).
    if (!authRes) authRes = await paypleAuth();
    if (!authRes.ok) { summary.errors++; console.error('[billing-run] 파트너 인증 실패:', authRes.msg); break; }

    const oid = `BILL_AIMONEYA_${uid}_${now.getTime()}`;
    let charge;
    try { charge = await paypleCharge(authRes.auth, { billingKey: b.billingKey, uid, oid }); }
    catch (e) { charge = { ok: false, msg: e.message }; }

    if (charge.ok) {
      // 성공 → 다음 결제일 +1개월
      const next = ymd(addMonths(now, 1));
      summary.charged++;
      await doc.ref.set({
        status: 'active', retryCount: 0, lastResult: 'charged',
        nextBillingAt: next, lastChargedAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(),
      }, { merge: true });
      await db.doc(`users/${uid}/subscription/current`).set({
        status: 'active', nextBillingAt: next, lastPaidAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(),
      }, { merge: true });
    } else {
      const retryCount = (b.retryCount || 0) + 1;
      if (retryCount >= MAX_RETRY) {
        // 3회째도 실패 → 구독 정지 + 앱 무료 강등
        summary.stopped++;
        await doc.ref.set({
          status: 'stopped', retryCount, lastResult: 'failed_stopped', lastError: charge.msg || '',
          nextBillingAt: FAR_FUTURE, updatedAt: FV.serverTimestamp(),
        }, { merge: true });
        await db.doc(`users/${uid}/subscription/current`).set({
          status: 'past_due', updatedAt: FV.serverTimestamp(),
        }, { merge: true });
      } else {
        // 3일 뒤 재시도 (그동안 프리미엄 유지 = 유예)
        summary.retried++;
        await doc.ref.set({
          status: 'active', retryCount, lastResult: 'retry_' + retryCount, lastError: charge.msg || '',
          nextBillingAt: ymd(addDays(now, RETRY_DAYS)), updatedAt: FV.serverTimestamp(),
        }, { merge: true });
      }
    }
  }

  console.log('[billing-run] 완료', todayStr, summary);
  return res.status(200).json({ result: 'ok', date: todayStr, summary });
};
