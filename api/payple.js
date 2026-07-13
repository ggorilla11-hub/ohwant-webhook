// ohwant-webhook/api/payple.js
// 페이플 결제 완료 웹훅 v2.1
// ① 구글시트 자동 기록 (브론즈/실버/골드/전문가 4개 플랜)
// ② 빌링키(PCD_PAYER_ID) 저장 (월정기구독 자동 청구용)
// ③ 고객 감사 이메일 발송
// ④ 앱 화면으로 복귀
// ★ v2.1 추가: 강의 결제 완료 감사 카톡+이메일 (PCD_PAY_GOODS에 "강의" 포함 시)
//
// Vercel 환경변수 (Settings > Environment Variables):
//   SPREADSHEET_ID         : 구글시트 ID
//   GOOGLE_SERVICE_ACCOUNT : 서비스 계정 JSON 전체
//   GMAIL_USER             : ggorilla11@gmail.com
//   GMAIL_PASS             : Gmail 앱 비밀번호 16자리

const { google } = require('googleapis');
const nodemailer  = require('nodemailer');
const admin       = require('firebase-admin');

// ── Firebase Admin 초기화 (Firestore paid_users 기록용) ──
// Vercel 환경변수 FIREBASE_SERVICE_ACCOUNT = moneya-72fe6 서비스계정 키 JSON 전체
if (!admin.apps.length && process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  } catch (e) { console.error('[firebase-admin 초기화 실패]', e.message); }
}

// 신규 앱(AI금융집짓기) 결제페이지·빌링 Referer용 도메인
const WEBHOOK_URL = 'https://ohwant-webhook.vercel.app';

// ── ai-moneya (새 앱: AI금융집짓기 정기구독) 전용 Firebase Admin ──
// Vercel 환경변수 FIREBASE_SERVICE_ACCOUNT_AIMONEYA = ai-moneya 서비스계정 키 JSON 전체.
//   ⚠️ 대표가 나중에 Vercel에 직접 입력. 미설정이면 ai-moneya 기록은 조용히 스킵(옛 상품엔 영향 없음).
let aimoneyaDb = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT_AIMONEYA) {
  try {
    const existing = admin.apps.find((a) => a && a.name === 'aimoneya');
    const app = existing || admin.initializeApp(
      { credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_AIMONEYA)) },
      'aimoneya'
    );
    aimoneyaDb = app.firestore();
  } catch (e) { console.error('[ai-moneya admin 초기화 실패]', e.message); }
}

// AI금융집짓기 구독 활성 기록: 앱용 상태 + 서버전용 빌링키(분리 저장)
async function recordAiMoneyaSubscription(uid, opts) {
  const { billingKey, nextBillingAtISO, amount, ok } = opts;
  if (!uid || !aimoneyaDb) { console.log('[ai-moneya 구독] 스킵(uid 또는 서비스계정 미설정)'); return; }
  const FV = admin.firestore.FieldValue;
  try {
    // 앱이 읽는 상태(보안규칙: 본인만 read) — 빌링키는 넣지 않음
    await aimoneyaDb.doc(`users/${uid}/subscription/current`).set({
      status: ok ? 'active' : 'past_due',
      plan: 'premium_monthly', price: amount || 9900, currency: 'KRW',
      startedAt: FV.serverTimestamp(),
      nextBillingAt: nextBillingAtISO || null,
      lastPaidAt: ok ? FV.serverTimestamp() : null,
      updatedAt: FV.serverTimestamp(),
    }, { merge: true });
    // 서버 전용(보안규칙: 클라이언트 접근 전면 차단) — 매월 청구용 빌링키
    await aimoneyaDb.doc(`billing/${uid}`).set({
      billingKey: billingKey || '',
      cstId: process.env.PAYPLE_CST_ID || 'ohwant',
      status: ok ? 'active' : 'past_due',
      nextBillingAt: nextBillingAtISO || null,
      retryCount: 0, lastResult: ok ? 'first_charge_ok' : 'first_charge_fail',
      updatedAt: FV.serverTimestamp(),
    }, { merge: true });
    console.log('[ai-moneya 구독] 기록 완료 uid=', uid, 'ok=', ok);
  } catch (e) { console.error('[ai-moneya 구독] 기록 실패:', e.message); }
}

// AI재무진단 결제자 → Firestore paid_users 자동 기록 (DESIRE 게이트용)
async function recordPaidUser(email, oid, goods) {
  if (!email || !admin.apps.length) { console.log('[paid_users] 스킵(이메일 또는 admin 없음)'); return; }
  try {
    await admin.firestore().collection('paid_users').doc(email).set({
      email:  email,
      paidAt: new Date().toISOString(),
      oid:    oid || '',
      goods:  goods || '',
      memo:   'AI재무진단'
    }, { merge: true });
    console.log('[paid_users] 결제자 기록 완료:', email);
  } catch (e) { console.error('[paid_users] 기록 실패:', e.message); }
}

const APP_URL = 'https://financial-house-building.vercel.app';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// make.com 웹훅 (유료결제 완료 → 카톡+이메일)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const MAKE_WEBHOOK_URL = 'https://hook.eu1.make.com/ap0haywvwzdanu3x0yp6ewvh76x3khuk';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 플랜 매핑 (주문번호 prefix → 플랜 정보)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const PLAN_MAP = {
  // 브론즈
  'BRONZE_SINGLE': { name: '브론즈 단일진단 1회',    label: '브론즈',  type: 'single',  credit: 10, amount: 9900,   sheet: '금융집짓기_구독DB' },
  // 실버
  'SILVER_MONTH':  { name: '실버 월정기구독',         label: '실버',    type: 'monthly', credit: 20, amount: 9900,   sheet: '금융집짓기_구독DB' },
  'SILVER_YEAR':   { name: '실버 연회비',             label: '실버',    type: 'annual',  credit: 20, amount: 99000,  sheet: '금융집짓기_구독DB' },
  // 골드
  'GOLD_MONTH':    { name: '골드 월정기구독',         label: '골드',    type: 'monthly', credit: 40, amount: 19900,  sheet: '금융집짓기_구독DB' },
  'GOLD_YEAR':     { name: '골드 연회비',             label: '골드',    type: 'annual',  credit: 40, amount: 199000, sheet: '금융집짓기_구독DB' },
  // 전문가
  'EXPERT_MONTH':  { name: '전문가(FC) 월정기구독',   label: '전문가',  type: 'monthly', credit: 40, amount: 29900,  sheet: '금융집짓기_구독DB' },
  'EXPERT_YEAR':   { name: '전문가(FC) 연회비',       label: '전문가',  type: 'annual',  credit: 40, amount: 299000, sheet: '금융집짓기_구독DB' },
  // 구버전 호환
  'SINGLE':        { name: '단일상담 1회',            label: '단일',    type: 'single',  credit: 10, amount: 9900,   sheet: '금융집짓기_구독DB' },
  'MONTH':         { name: '월정기구독',              label: '실버',    type: 'monthly', credit: 20, amount: 9900,   sheet: '금융집짓기_구독DB' },
  'YEAR':          { name: '연회비구독',              label: '실버',    type: 'annual',  credit: 20, amount: 199000, sheet: '금융집짓기_구독DB' },
  // planParam 직접 참조 (AUTH 방식)
  'silver-month':  { name: '실버 월정기구독',         label: '실버',    type: 'monthly', credit: 20, amount: 9900,   sheet: '금융집짓기_구독DB' },
  'silver-year':   { name: '실버 연회비',             label: '실버',    type: 'annual',  credit: 20, amount: 99000,  sheet: '금융집짓기_구독DB' },
  'gold-month':    { name: '골드 월정기구독',         label: '골드',    type: 'monthly', credit: 40, amount: 19900,  sheet: '금융집짓기_구독DB' },
  'gold-year':     { name: '골드 연회비',             label: '골드',    type: 'annual',  credit: 40, amount: 199000, sheet: '금융집짓기_구독DB' },
  'expert-month':  { name: 'FC브론즈 월정기구독',     label: 'FC브론즈', type: 'monthly', credit: 60, amount: 33000,  sheet: '금융집짓기_구독DB' },
  'expert-year':   { name: 'FC브론즈 연회비',         label: 'FC브론즈', type: 'annual',  credit: 60, amount: 330000, sheet: '금융집짓기_구독DB' },
  'expert-silver': { name: 'FC실버 월정기구독',       label: 'FC실버',  type: 'monthly', credit: 60, amount: 55000,  sheet: '금융집짓기_구독DB' },
  'expert-gold':   { name: 'FC골드 월정기구독',       label: 'FC골드',  type: 'monthly', credit: 60, amount: 99000,  sheet: '금융집짓기_구독DB' },
};

// 주문번호에서 플랜 정보 추출
function getPlanInfo(oid) {
  const match = oid.replace(/^FH_/, '').replace(/_\d+$/, '');
  // ★ FC 플랜 OID 매핑
  const fcMap = {
    'FC_BRONZE_MONTH': 'expert-month',
    'FC_SILVER_MONTH': 'expert-silver',
    'FC_GOLD_MONTH':   'expert-gold',
  };
  if (fcMap[match]) return PLAN_MAP[fcMap[match]];
  return PLAN_MAP[match] || PLAN_MAP['SINGLE'];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ★ 강의 결제 감사 처리 (make.com → 카톡+이메일)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleLecturePayment(data, payerName, payerPhone, payerEmail, total) {
  const goods = data.PCD_PAY_GOODS || '';
  const oid   = data.PCD_PAY_OID   || '';

  // 강의명 판별
  const isGenLecture = goods.includes('일반인강의') || goods.includes('일반인 강의');
  const isProLecture = goods.includes('전문가강의') || goods.includes('전문가 강의');
  const planLabel    = isGenLecture ? '일반인강의(55만원)' : isProLecture ? '전문가강의(110만원)' : goods;

  console.log('[강의결제] 감사 처리 시작:', { goods, planLabel, payerName, payerPhone, payerEmail });

  // make.com 웹훅 → 카톡 알림 + 감사 이메일 자동 발송
  try {
    const resp = await fetch(MAKE_WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type:              'lecture_payment',   // make.com에서 강의 결제건 식별용
        name:              payerName,
        phone:             payerPhone,
        email:             payerEmail,
        plan:              planLabel,
        amount:            total,
        orderId:           oid,
        sendThankYouKakao: true,
        sendThankYouEmail: true,
        timestamp:         new Date().toISOString()
      })
    });
    console.log('[강의결제] make.com 웹훅 전송 완료:', resp.status);
  } catch (e) {
    console.error('[강의결제] make.com 웹훅 실패:', e.message);
  }

  // 구글시트 강의DB 기록
  try {
    const saJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
    const auth   = new google.auth.GoogleAuth({ credentials: saJson, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const today  = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

    // 강의 결제 완료 → 해당 시트 상태 업데이트 (일반인강의DB / 전문가강의DB)
    const sheetName = isGenLecture ? '일반인강의DB' : isProLecture ? '전문가강의DB' : '일반인강의DB';

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${sheetName}!A:H`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          today,       // A: 결제완료일시
          payerName,   // B: 이름
          payerPhone,  // C: 연락처
          payerEmail,  // D: 이메일
          planLabel,   // E: 서비스명
          total,       // F: 금액
          '결제완료',   // G: 상태
          oid          // H: 주문번호
        ]]
      }
    });
    console.log('[강의결제] 구글시트 기록 완료:', sheetName);
  } catch (e) {
    console.error('[강의결제] 구글시트 기록 실패:', e.message);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ★ 재무상담(연금진단) 결제 완료 처리
//   시트·메일을 직접 하지 않고, 이미 검증된 우리 Apps Script 웹앱(연금진단리드)으로
//   "결제완료" 신호만 넘긴다 → Apps Script가 대표님 계정으로 N→Y + 감사메일(MailApp) 처리.
//   (남의 서비스계정 권한/GMAIL 자격 문제를 우회. 무료신청에서 이미 작동 검증된 통로)
//   기존 구독/강의/AI머니야/AI재무진단 로직과 완전 분리.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const CONSULT_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbxphDSQuXO8N07k7OWnO5hDZyXoH5Br7WB14mDCbsq1u7tvcO0GBCWxinQOAPUEd8xgyw/exec';
const CONSULT_PRODUCTS = {
  '9900':    '전화 상담',
  '150000':  '비대면 화상',
  '550000':  '대면 상담',
  '1100000': '자산가 상담',
};
function _digits(s){ return String(s == null ? '' : s).replace(/[^0-9]/g, ''); }

async function handleConsultPayment(payerName, payerPhone, payerEmail, total) {
  const amountNum   = Number(_digits(total)) || 0;
  const productName = CONSULT_PRODUCTS[String(amountNum)] || '재무상담';
  console.log('[재무상담] Apps Script로 결제완료 전달:', { productName, amountNum, payerName, payerPhone, payerEmail });
  try {
    const resp = await fetch(CONSULT_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind:    'payment_complete',
        name:    payerName || '',
        phone:   payerPhone || '',
        email:   payerEmail || '',
        amount:  amountNum,
        product: productName,
        oid:     '',
        ts:      new Date().toISOString(),
      }),
    });
    console.log('[재무상담] Apps Script 전달 완료:', resp.status);
  } catch (e) {
    console.error('[재무상담] Apps Script 전달 실패:', e.message);
  }
}

module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // POST 바디 + URL 쿼리 파라미터 병합
  const body  = req.method === 'POST' ? (req.body || {}) : {};
  const query = req.query || {};
  const data  = Object.assign({}, query, body);

  const rst        = data.PCD_PAY_RST      || '';
  const oid        = data.PCD_PAY_OID      || '';
  const total      = data.PCD_PAY_TOTAL    || '0';
  const msg        = data.PCD_PAY_MSG      || '';
  const cardName   = data.PCD_PAY_CARDNAME || '';
  const cardNum    = data.PCD_PAY_CARDNUM  || '';
  const authDate   = data.PCD_PAY_TIME     || '';
  const payGoods   = data.PCD_PAY_GOODS    || '';  // ★ 상품명 (강의 판별용)
  // ★ 빌링키 (AUTH 방식 카드등록 후 발급)
  const payerId    = data.PCD_PAYER_ID     || '';
  const payWork    = data.PCD_PAY_WORK     || query.work || '';
  // 고객 정보
  const payerName  = query.payer_name  || data.PCD_PAYER_NAME  || '';
  const payerEmail = query.payer_email || data.PCD_PAYER_EMAIL || '';
  const payerPhone = query.payer_phone || data.PCD_PAYER_HP    || '';
  const payerUid   = query.uid         || '';
  const planParam  = query.plan        || '';

  console.log('[페이플 웹훅 수신]', { rst, oid, total, payWork, payGoods, payerName, payerEmail, payerPhone, payerId: payerId ? '***발급됨***' : '없음' });

  // ★ AUTH 방식: 카드등록 완료 (빌링키만 발급)
  const isAuthMode = (payWork === 'AUTH');  // ★ 단건 오판 방지: 명시적 AUTH(구독)만 정기 처리.

  // ══════════════════════════════════════════════════════════════
  // ★ 신규 앱(AI금융집짓기) 정기구독 — OID prefix로 옛 상품과 완전 분리
  //   옛 상품(구글시트·moneya-72fe6)은 이 블록 아래로 내려가지 않음.
  // ══════════════════════════════════════════════════════════════
  const AIMONEYA_OID_PREFIX = 'FH_AIMONEYA_SUB_';
  const isAiMoneyaSub = oid.startsWith(AIMONEYA_OID_PREFIX);
  // ★ OID prefix만으로 항상 처리(브라우저 콜백이 PCD_PAY_WORK/PCD_PAYER_ID를 항상 담지 않아도 기록 누락 방지).
  if (isAiMoneyaSub) {
    // uid 복원: PCD_PAYER_NO(커스텀) → query.uid → OID에서 추출
    const uid = data.PCD_PAYER_NO || payerUid ||
                (oid.match(/^FH_AIMONEYA_SUB_(.+?)_\d+$/) || [])[1] || '';
    // 카드등록/결제 성공 판정: RST success 또는 빌링키 발급이면 성공으로 본다.
    const regOk = (rst === 'success' || data.PCD_PAY_RST === 'success' || !!payerId);
    console.log('[ai-moneya 구독] 콜백:', { uid, payWork, rst, payerId: payerId ? '있음' : '없음', regOk });

    // 빌링키가 있으면 첫 9,900원 결제 시도(실패해도 구독 활성은 진행 — 다음 달 크론이 재청구).
    let charged = false;
    if (payerId) {
      try {
        const r = await fetch('https://cpay.payple.kr/php/SimplePayCardAct.php?ACT_=PAYM', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Referer': WEBHOOK_URL },
          body: JSON.stringify({
            PCD_CST_ID: data.PCD_CST_ID || '', PCD_CUST_KEY: data.PCD_CUST_KEY || '',
            PCD_AUTH_KEY: data.PCD_AUTH_KEY || '', PCD_PAY_TYPE: 'card',
            PCD_PAYER_ID: payerId, PCD_PAY_GOODS: 'AI금융집짓기 프리미엄 구독',
            PCD_PAY_TOTAL: '9900', PCD_PAY_OID: 'BILL_AIMONEYA_' + Date.now(),
            PCD_SIMPLE_FLAG: 'Y', PCD_PAYER_NO: uid,
            PCD_PAYER_NAME: payerName, PCD_PAYER_HP: payerPhone, PCD_PAYER_EMAIL: payerEmail,
          })
        });
        const j = await r.json();
        charged = (j.PCD_PAY_RST === 'success');
        console.log('[ai-moneya 구독] 첫 결제 응답:', j.PCD_PAY_RST, j.PCD_PAY_MSG || '');
      } catch (e) { console.error('[ai-moneya 구독] 첫 결제 오류:', e.message); }
    }

    // 카드등록/결제가 됐으면 구독 활성(자물쇠 해제). 빌링키는 매월 청구용으로 저장.
    const active = regOk;
    const nb = new Date(); nb.setMonth(nb.getMonth() + 1);
    await recordAiMoneyaSubscription(uid, {
      billingKey: payerId, nextBillingAtISO: nb.toISOString().slice(0, 10), amount: 9900, ok: active,
    });
    console.log('[ai-moneya 구독] 기록 요청 완료 uid=', uid, 'active=', active, 'charged=', charged);

    // 앱으로 딥링크 복귀 (WebView가 이 스킴을 감지 → 앱 화면). FH_AIMONEYA_SUB_은 절대 옛 로직으로 안 감.
    return res.redirect(302, `aimoneya://sub/done?ok=${active ? '1' : '0'}`);
  }

  // ★ 강의 결제 감지 (PCD_PAY_GOODS에 "강의" 포함)
  const isLecturePayment = payGoods.includes('강의') || oid.includes('LECTURE') || planParam.includes('강의');

  if (isAuthMode && payerId) {
    console.log('[AUTH] 카드등록 완료 — 빌링키 발급:', payerId ? '***' : '없음');

    const planInfo = getPlanInfo(planParam || 'silver-month');
    const now = new Date();
    const today = now.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    const nextBill = new Date(now);
    nextBill.setMonth(nextBill.getMonth() + 1);
    nextBill.setDate(15);
    const nextBillStr = nextBill.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });

    try {
      const saJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
      const auth   = new google.auth.GoogleAuth({ credentials: saJson, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
      const sheets = google.sheets({ version: 'v4', auth });

      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: '빌링키_구독DB!A:J',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[
          today, payerName, payerPhone, payerEmail,
          payerId, planInfo.name, planInfo.amount || '',
          '활성', nextBillStr, 'AUTH_' + Date.now()
        ]] }
      });

      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: `${planInfo.sheet}!A:M`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[
          today, 'AUTH_' + Date.now(), planInfo.name + ' (카드등록)',
          '0', payerName, payerPhone, payerEmail,
          '', '', '', 'auth_success', payerId, nextBillStr
        ]] }
      });
      console.log('[AUTH] 구글시트 저장 완료');
    } catch(e) {
      console.error('[AUTH] 구글시트 저장 실패:', e.message);
    }

    // ★ 빌링키로 첫 실결제 API 호출
    let billingSuccess = false;
    const billingAmount = planInfo.amount || 9900;
    try {
      console.log('[AUTH→실결제] 빌링키로', billingAmount, '원 결제 시도');
      const billingRes = await fetch('https://cpay.payple.kr/php/SimplePayCardAct.php?ACT_=PAYM', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Referer': APP_URL },
        body: JSON.stringify({
          PCD_CST_ID: data.PCD_CST_ID || '',
          PCD_CUST_KEY: data.PCD_CUST_KEY || '',
          PCD_AUTH_KEY: data.PCD_AUTH_KEY || '',
          PCD_PAY_TYPE: 'card',
          PCD_PAYER_ID: payerId,
          PCD_PAY_GOODS: data.PCD_PAY_GOODS || planInfo.name,
          PCD_PAY_TOTAL: String(billingAmount),
          PCD_PAY_OID: 'BILL_' + (planParam || 'month') + '_' + Date.now(),
          PCD_SIMPLE_FLAG: 'Y',
          PCD_PAYER_NAME: payerName,
          PCD_PAYER_HP: payerPhone,
          PCD_PAYER_EMAIL: payerEmail
        })
      });
      const billingData = await billingRes.json();
      console.log('[AUTH→실결제] 응답:', billingData.PCD_PAY_RST, billingData.PCD_PAY_MSG || '');
      if (billingData.PCD_PAY_RST === 'success') {
        billingSuccess = true;
        console.log('[AUTH→실결제] ✅ 성공!', billingAmount, '원');
      } else {
        console.error('[AUTH→실결제] ❌ 실패:', billingData.PCD_PAY_MSG || '알 수 없는 오류');
      }
    } catch(billingErr) {
      console.error('[AUTH→실결제] 에러:', billingErr.message);
    }
    return res.redirect(302,
      `${APP_URL}?pay_result=${billingSuccess ? 'success' : 'fail'}&plan=${encodeURIComponent(planInfo.label)}&auth=1`
    );
  }

  // 결제 실패
  if (rst !== 'success') {
    console.log('[페이플] 결제 실패:', msg);
    return res.redirect(302,
      `${APP_URL}?pay_result=fail&msg=${encodeURIComponent(msg)}`
    );
  }

  // ★ AI재무진단 단건결제 완료 → DESIRE paid_users 자동 기록 후 종료
  if (payGoods.includes('AI재무진단')) {
    console.log('[AI재무진단] 결제 완료 감지:', payerEmail, oid);
    await recordPaidUser(payerEmail, oid, payGoods);
    // 결제 완료 → DESIRE 로드맵으로 이동 (브라우저가 RST_URL로 왔을 때 JSON 대신 리다이렉트)
    return res.redirect(302, 'https://ohwant-class.netlify.app/desire.html?pay=success');
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ★ 강의 결제 완료 처리 (별도 분기)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (isLecturePayment) {
    console.log('[강의결제] 강의 결제 완료 감지:', payGoods);
    await handleLecturePayment(data, payerName, payerPhone, payerEmail, total);
    // 강의 결제는 앱으로 복귀하지 않고 200 응답 (페이플 링크 방식)
    return res.status(200).json({ result: 'ok', type: 'lecture', plan: payGoods });
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ★ 재무상담(연금진단) 결제 완료 처리 (별도 분기) — 상품명에 '재무상담' 또는 '전화상담'
  //   전화상담(9,900)·비대면(15만)·대면(55만)·자산가(110만) 4개 모두 여기로.
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const isConsultPayment = payGoods.includes('재무상담') || payGoods.includes('전화상담');
  if (isConsultPayment) {
    console.log('[재무상담] 결제 완료 감지:', payGoods, total);
    await handleConsultPayment(payerName, payerPhone, payerEmail, total);
    // 페이플 링크 방식 → 앱 복귀 없이 200 응답
    return res.status(200).json({ result: 'ok', type: 'consult', goods: payGoods });
  }

  // 일반 결제 (단일/연회비)
  if (!oid) {
    return res.status(200).json({ result: 'ignored', reason: 'no_oid' });
  }

  // 플랜 정보 추출
  const planInfo = getPlanInfo(oid);
  const isMonthly = (planInfo.type === 'monthly');

  const now        = new Date();
  const today      = now.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const maskedCard = cardNum
    ? cardNum.replace(/(\d{4})(\d+)(\d{4})/, '$1-****-****-$3')
    : '';

  if (!oid) {
    return res.status(200).json({ result: 'ignored', reason: 'no_oid' });
  }

  try {
    const saJsonCheck = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
    const authCheck   = new google.auth.GoogleAuth({
      credentials: saJsonCheck,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheetsCheck = google.sheets({ version: 'v4', auth: authCheck });
    const existing = await sheetsCheck.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${planInfo.sheet}!B:B`,
    });
    const rows = (existing.data.values || []).flat();
    if (rows.includes(oid)) {
      console.log('[중복방지] 이미 처리된 주문번호:', oid);
      return res.redirect(302, `${APP_URL}?pay_result=success&oid=${encodeURIComponent(oid)}`);
    }
  } catch(e) {
    console.log('[중복방지] 확인 실패 (계속 진행):', e.message);
  }

  // ① 구글시트 기록
  try {
    const saJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
    const auth   = new google.auth.GoogleAuth({
      credentials: saJson,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    const nextBillDate = isMonthly
      ? (() => {
          const d = new Date(now);
          d.setMonth(d.getMonth() + 1);
          d.setDate(15);
          return d.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
        })()
      : '-';

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${planInfo.sheet}!A:M`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          today, oid, planInfo.name, total,
          payerName, payerPhone, payerEmail,
          cardName, maskedCard, authDate, rst,
          payerId || '-', nextBillDate,
        ]],
      },
    });
    console.log('[구글시트] 기록 완료:', oid, '플랜:', planInfo.name);
  } catch (e) {
    console.error('[구글시트] 기록 실패:', e.message);
  }

  // ② 빌링키 별도 시트 저장
  if (isMonthly && payerId) {
    try {
      const saJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
      const auth   = new google.auth.GoogleAuth({
        credentials: saJson,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const sheets = google.sheets({ version: 'v4', auth });

      const nextBill = new Date(now);
      nextBill.setMonth(nextBill.getMonth() + 1);
      nextBill.setDate(15);
      const nextBillStr = nextBill.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });

      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: '빌링키_구독DB!A:J',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[
            today, payerName, payerPhone, payerEmail,
            payerId, planInfo.name, total, '활성', nextBillStr, oid,
          ]],
        },
      });
      console.log('[빌링키DB] 저장 완료');
    } catch (e) {
      console.error('[빌링키DB] 저장 실패:', e.message);
    }
  }

  // ③ 감사 이메일 발송
  if (payerEmail) {
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.GMAIL_USER,
          pass: process.env.GMAIL_PASS,
        },
      });

      const amountFmt     = Number(total).toLocaleString('ko-KR');
      const recipientName = payerName || '회원';
      const todayLabel    = now.toLocaleDateString('ko-KR', {
        timeZone: 'Asia/Seoul',
        year: 'numeric', month: 'long', day: 'numeric',
      });
      const creditLabel = planInfo.credit + '분';
      const typeLabel   = isMonthly ? '월정기구독 (매월 15일 자동 결제)'
                        : planInfo.type === 'annual' ? '연회비 구독'
                        : '단일 이용권';

      await transporter.sendMail({
        from:    `"오상열 CFP · AI머니야" <${process.env.GMAIL_USER}>`,
        to:      payerEmail,
        subject: `[AI머니야] ${recipientName}님, ${planInfo.label} 플랜 결제가 완료되었습니다 🎉`,
        html: `
<!DOCTYPE html><html lang="ko">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f0;font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f0;padding:32px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:16px;overflow:hidden;">
  <tr><td style="background:#0B1D3A;padding:28px 32px;text-align:center;">
    <div style="font-size:22px;font-weight:900;color:#C9972A;">🏠 AI머니야</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.6);margin-top:4px;">금융집짓기® AI 재무진단</div>
  </td></tr>
  <tr><td style="padding:32px 32px 0;">
    <div style="font-size:20px;font-weight:900;color:#0B1D3A;margin-bottom:8px;">${recipientName}님, 환영합니다! 🎉</div>
    <div style="font-size:14px;color:#555;line-height:1.7;">
      AI머니야 <strong>${planInfo.label} 플랜</strong>에 가입해 주셔서 진심으로 감사드립니다.<br>
      오상열 CFP 20년 노하우를 담은 AI 재무진단을 바로 이용하실 수 있습니다.
    </div>
  </td></tr>
  <tr><td style="padding:20px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f5ee;border-radius:12px;border:1px solid rgba(201,151,42,0.25);">
    <tr><td style="padding:20px 24px;">
      <div style="font-size:11px;font-weight:700;color:#C9972A;margin-bottom:12px;">결제 정보</div>
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="font-size:13px;color:#666;padding-bottom:8px;">플랜</td>
          <td style="font-size:13px;font-weight:700;color:#0B1D3A;text-align:right;padding-bottom:8px;">${planInfo.label} (${planInfo.name})</td>
        </tr>
        <tr>
          <td style="font-size:13px;color:#666;padding-bottom:8px;">결제 유형</td>
          <td style="font-size:13px;font-weight:700;color:#0B1D3A;text-align:right;padding-bottom:8px;">${typeLabel}</td>
        </tr>
        <tr>
          <td style="font-size:13px;color:#666;padding-bottom:8px;">결제 금액</td>
          <td style="font-size:13px;font-weight:700;color:#0B1D3A;text-align:right;padding-bottom:8px;">₩${amountFmt}</td>
        </tr>
        <tr>
          <td style="font-size:13px;color:#666;padding-bottom:8px;">AI 음성 크레딧</td>
          <td style="font-size:13px;font-weight:700;color:#C9972A;text-align:right;padding-bottom:8px;">${creditLabel}</td>
        </tr>
        <tr>
          <td style="font-size:13px;color:#666;padding-bottom:8px;">가입일</td>
          <td style="font-size:13px;font-weight:700;color:#0B1D3A;text-align:right;padding-bottom:8px;">${todayLabel}</td>
        </tr>
        <tr>
          <td style="font-size:13px;color:#666;">주문번호</td>
          <td style="font-size:11px;color:#999;text-align:right;">${oid}</td>
        </tr>
      </table>
    </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:0 32px 28px;">
    <div style="background:#EFF6FF;border-radius:10px;padding:14px 18px;">
      <div style="font-size:12px;color:#0B1D3A;line-height:1.7;">
        📞 문의사항이 있으시면 언제든지 연락 주세요.<br>
        <strong>오상열 CFP</strong> &nbsp;|&nbsp; 010-5424-5332 &nbsp;|&nbsp; ggorilla11@gmail.com
      </div>
    </div>
  </td></tr>
  <tr><td style="background:#0B1D3A;padding:20px 32px;text-align:center;">
    <div style="font-size:11px;color:rgba(255,255,255,0.4);line-height:1.8;">
      오원트금융연구소 &nbsp;|&nbsp; 대표: 오상열 CFP<br>
      본 메일은 AI머니야 결제 완료 시 자동 발송됩니다.
    </div>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`,
      });
      console.log('[감사이메일] 발송 완료 →', payerEmail);
    } catch (e) {
      console.error('[감사이메일] 발송 실패:', e.message);
    }
  }

  // ④ 앱 화면으로 복귀
  return res.redirect(302,
    `${APP_URL}?pay_result=success&oid=${encodeURIComponent(oid)}&plan=${encodeURIComponent(planInfo.label)}`
  );
};
