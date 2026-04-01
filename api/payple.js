// ohwant-webhook/api/payple.js
// 페이플 결제 완료 웹훅 v2.0
// ① 구글시트 자동 기록 (브론즈/실버/골드/전문가 4개 플랜)
// ② 빌링키(PCD_PAYER_ID) 저장 (월정기구독 자동 청구용)
// ③ 고객 감사 이메일 발송
// ④ 앱 화면으로 복귀
//
// Vercel 환경변수 (Settings > Environment Variables):
//   SPREADSHEET_ID         : 구글시트 ID
//   GOOGLE_SERVICE_ACCOUNT : 서비스 계정 JSON 전체
//   GMAIL_USER             : ggorilla11@gmail.com
//   GMAIL_PASS             : Gmail 앱 비밀번호 16자리

const { google } = require('googleapis');
const nodemailer  = require('nodemailer');

const APP_URL = 'https://financial-house-building.vercel.app';

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
  'expert-month':  { name: '전문가 월정기구독',       label: '전문가',  type: 'monthly', credit: 40, amount: 29900,  sheet: '금융집짓기_구독DB' },
  'expert-year':   { name: '전문가 연회비',           label: '전문가',  type: 'annual',  credit: 40, amount: 299000, sheet: '금융집짓기_구독DB' },
};

// 주문번호에서 플랜 정보 추출
function getPlanInfo(oid) {
  // FH_GOLD_MONTH_1234567 → GOLD_MONTH
  const match = oid.replace(/^FH_/, '').replace(/_\d+$/, '');
  return PLAN_MAP[match] || PLAN_MAP['SINGLE'];
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
  // ★ 빌링키 (AUTH 방식 카드등록 후 발급)
  const payerId    = data.PCD_PAYER_ID     || '';
  const payWork    = data.PCD_PAY_WORK     || query.work || '';
  // 고객 정보
  const payerName  = query.payer_name  || data.PCD_PAYER_NAME  || '';
  const payerEmail = query.payer_email || data.PCD_PAYER_EMAIL || '';
  const payerPhone = query.payer_phone || data.PCD_PAYER_HP    || '';
  const payerUid   = query.uid         || '';
  const planParam  = query.plan        || '';

  console.log('[페이플 웹훅 수신]', { rst, oid, total, payWork, payerName, payerEmail, payerPhone, payerId: payerId ? '***발급됨***' : '없음' });

  // ★ AUTH 방식: 카드등록 완료 (빌링키만 발급, 실결제 없음)
  // rst='success', PCD_PAY_OID는 비어있을 수 있음
  const isAuthMode = (payWork === 'AUTH' || (!oid && payerId));

  if (isAuthMode && payerId) {
    console.log('[AUTH] 카드등록 완료 — 빌링키 발급:', payerId ? '***' : '없음');

    // 빌링키 구글시트 저장
    const planInfo = getPlanInfo(planParam || 'silver-month');
    const now = new Date();
    const today = now.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    const nextBill = new Date(now);
    nextBill.setMonth(nextBill.getMonth() + 1);
    nextBill.setDate(15);
    const nextBillStr = nextBill.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });

    try {
      const { google } = require('googleapis');
      const saJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
      const auth   = new google.auth.GoogleAuth({ credentials: saJson, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
      const sheets = google.sheets({ version: 'v4', auth });

      // 빌링키_구독DB 저장
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

      // 금융집짓기_구독DB에도 기록
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

    // 앱으로 복귀 (결제 성공으로 처리)
    return res.redirect(302,
      `${APP_URL}?pay_result=success&plan=${encodeURIComponent(planInfo.label)}&auth=1`
    );
  }

  // 결제 실패
  if (rst !== 'success') {
    console.log('[페이플] 결제 실패:', msg);
    return res.redirect(302,
      `${APP_URL}?pay_result=fail&msg=${encodeURIComponent(msg)}`
    );
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

  // ━━━━━━━━━━━━━━━━━━━━
  // 중복 처리 방지
  // ━━━━━━━━━━━━━━━━━━━━
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

  // ━━━━━━━━━━━━━━━━━━━━
  // ① 구글시트 기록 (A~M 13컬럼)
  // ━━━━━━━━━━━━━━━━━━━━
  try {
    const saJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
    const auth   = new google.auth.GoogleAuth({
      credentials: saJson,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    // 다음 결제일 계산 (월정기: 다음달 15일)
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
          today,           // A: 결제일시
          oid,             // B: 주문번호
          planInfo.name,   // C: 플랜명
          total,           // D: 결제금액
          payerName,       // E: 고객명
          payerPhone,      // F: 전화번호
          payerEmail,      // G: 이메일
          cardName,        // H: 카드사
          maskedCard,      // I: 카드번호(마스킹)
          authDate,        // J: 승인일시
          rst,             // K: 결제결과
          payerId || '-',  // L: 빌링키 (월정기구독)
          nextBillDate,    // M: 다음 결제일
        ]],
      },
    });
    console.log('[구글시트] 기록 완료:', oid, '플랜:', planInfo.name, '빌링키:', payerId ? '있음' : '없음');
  } catch (e) {
    console.error('[구글시트] 기록 실패:', e.message);
  }

  // ━━━━━━━━━━━━━━━━━━━━
  // ② 빌링키 별도 시트 저장 (월정기구독 자동 청구용)
  // ━━━━━━━━━━━━━━━━━━━━
  if (isMonthly && payerId) {
    try {
      const saJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
      const auth   = new google.auth.GoogleAuth({
        credentials: saJson,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const sheets = google.sheets({ version: 'v4', auth });

      // 다음 결제일
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
            today,           // A: 등록일시
            payerName,       // B: 고객명
            payerPhone,      // C: 전화번호
            payerEmail,      // D: 이메일
            payerId,         // E: 빌링키 (PCD_PAYER_ID)
            planInfo.name,   // F: 플랜명
            total,           // G: 월 결제금액
            '활성',          // H: 구독상태
            nextBillStr,     // I: 다음 결제일
            oid,             // J: 최초 주문번호
          ]],
        },
      });
      console.log('[빌링키DB] 저장 완료:', payerName, payerId.slice(0,8) + '...');
    } catch (e) {
      console.error('[빌링키DB] 저장 실패:', e.message);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━
  // ③ 감사 이메일 발송
  // ━━━━━━━━━━━━━━━━━━━━
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

      // 플랜별 크레딧 안내
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
