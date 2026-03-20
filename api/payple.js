// ohwant-webhook/api/payple.js
// 페이플 결제 완료 웹훅
// ① 구글시트 자동 기록
// ② 고객 감사 이메일 발송
// ③ 앱 화면으로 복귀
//
// Vercel 환경변수 (Settings > Environment Variables):
//   SPREADSHEET_ID         : 구글시트 ID
//   GOOGLE_SERVICE_ACCOUNT : 서비스 계정 JSON 전체
//   GMAIL_USER             : ggorilla11@gmail.com
//   GMAIL_PASS             : Gmail 앱 비밀번호 16자리

const { google } = require('googleapis');
const nodemailer  = require('nodemailer');

const APP_URL = 'https://financial-house-building.vercel.app';

const SERVICE_MAP = {
  FH_MONTH: { name: '금융집짓기 실버 월간구독', sheet: '금융집짓기_구독DB' },
  FH_YEAR:  { name: '금융집짓기 실버 연간구독', sheet: '금융집짓기_구독DB' },
};

module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const data = req.method === 'POST' ? req.body : req.query;

  const rst        = data.PCD_PAY_RST      || '';
  const oid        = data.PCD_PAY_OID      || '';
  const total      = data.PCD_PAY_TOTAL    || '0';
  const msg        = data.PCD_PAY_MSG      || '';
  const cardName   = data.PCD_PAY_CARDNAME || '';
  const cardNum    = data.PCD_PAY_CARDNUM  || '';
  const authDate   = data.PCD_PAY_TIME     || '';
  const payerName  = data.PCD_PAYER_NAME   || data.payer_name  || '';
  const payerEmail = data.PCD_PAYER_EMAIL  || data.payer_email || '';

  console.log('[페이플 웹훅 수신]', { rst, oid, total, payerName, payerEmail });

  // 결제 실패
  if (rst !== 'success') {
    return res.redirect(302,
      `${APP_URL}?pay_result=fail&msg=${encodeURIComponent(msg)}`
    );
  }

  const serviceKey = oid.includes('YEAR') ? 'FH_YEAR' : 'FH_MONTH';
  const service    = SERVICE_MAP[serviceKey];
  const today      = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const maskedCard = cardNum
    ? cardNum.replace(/(\d{4})(\d+)(\d{4})/, '$1-****-****-$3')
    : '';

  // ━━━━━━━━━━━━━━━━━━━━
  // ① 구글시트 기록
  // ━━━━━━━━━━━━━━━━━━━━
  try {
    const saJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
    const auth   = new google.auth.GoogleAuth({
      credentials: saJson,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${service.sheet}!A:J`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          today,        // A: 결제일시
          oid,          // B: 주문번호
          service.name, // C: 서비스명
          total,        // D: 결제금액
          payerName,    // E: 고객명
          payerEmail,   // F: 고객이메일
          cardName,     // G: 카드사
          maskedCard,   // H: 카드번호(마스킹)
          authDate,     // I: 승인일시
          rst,          // J: 결제결과
        ]],
      },
    });
    console.log('[구글시트] 기록 완료:', oid);
  } catch (e) {
    console.error('[구글시트] 기록 실패:', e.message);
  }

  // ━━━━━━━━━━━━━━━━━━━━
  // ② 감사 이메일 발송
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
      const planLabel     = serviceKey === 'FH_YEAR' ? '연간 구독' : '월간 구독';
      const recipientName = payerName || '회원';
      const todayLabel    = new Date().toLocaleDateString('ko-KR', {
        year: 'numeric', month: 'long', day: 'numeric',
      });

      await transporter.sendMail({
        from:    `"오상열 CFP · 금융집짓기®" <${process.env.GMAIL_USER}>`,
        to:      payerEmail,
        subject: `[금융집짓기®] ${recipientName}님, 구독이 완료되었습니다 🏠`,
        html: `
<!DOCTYPE html><html lang="ko">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f0;font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f0;padding:32px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:16px;overflow:hidden;">
  <tr><td style="background:#0B1D3A;padding:28px 32px;text-align:center;">
    <div style="font-size:22px;font-weight:900;color:#C9972A;">🏠 금융집짓기®</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.6);margin-top:4px;">AI 재무설계 시뮬레이터</div>
  </td></tr>
  <tr><td style="padding:32px 32px 0;">
    <div style="font-size:20px;font-weight:900;color:#0B1D3A;margin-bottom:8px;">${recipientName}님, 환영합니다! 🎉</div>
    <div style="font-size:14px;color:#555;line-height:1.7;">
      금융집짓기® ${planLabel}에 가입해 주셔서 진심으로 감사드립니다.<br>
      20년 CFP 노하우를 바탕으로 맞춤형 재무설계를 지원해 드리겠습니다.
    </div>
  </td></tr>
  <tr><td style="padding:20px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f5ee;border-radius:12px;border:1px solid rgba(201,151,42,0.25);">
    <tr><td style="padding:20px 24px;">
      <div style="font-size:11px;font-weight:700;color:#C9972A;margin-bottom:12px;">구독 정보</div>
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="font-size:13px;color:#666;padding-bottom:8px;">구독 플랜</td>
          <td style="font-size:13px;font-weight:700;color:#0B1D3A;text-align:right;padding-bottom:8px;">${planLabel}</td>
        </tr>
        <tr>
          <td style="font-size:13px;color:#666;padding-bottom:8px;">결제 금액</td>
          <td style="font-size:13px;font-weight:700;color:#0B1D3A;text-align:right;padding-bottom:8px;">₩${amountFmt}</td>
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
  <tr><td style="padding:0 32px 20px;">
    <div style="font-size:13px;font-weight:700;color:#0B1D3A;margin-bottom:12px;">지금 바로 이용하실 수 있는 서비스</div>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:6px 0;width:24px;vertical-align:top;">🤖</td>
        <td style="padding:6px 0 6px 8px;">
          <div style="font-size:13px;font-weight:700;color:#0B1D3A;">AI 재무진단 무제한</div>
          <div style="font-size:11px;color:#888;">24시간 언제든지</div>
        </td>
      </tr>
      <tr><td style="padding:6px 0;width:24px;vertical-align:top;">📈</td>
        <td style="padding:6px 0 6px 8px;">
          <div style="font-size:13px;font-weight:700;color:#0B1D3A;">비포 &amp; 에프터 히스토리 대시보드</div>
          <div style="font-size:11px;color:#888;">재무 성장이 눈에 보임</div>
        </td>
      </tr>
      <tr><td style="padding:6px 0;width:24px;vertical-align:top;">🏠</td>
        <td style="padding:6px 0 6px 8px;">
          <div style="font-size:13px;font-weight:700;color:#0B1D3A;">시뮬레이터 7대 영역 전체</div>
          <div style="font-size:11px;color:#888;">은퇴·주택·투자·부채·목돈·세금·보험</div>
        </td>
      </tr>
      <tr><td style="padding:6px 0;width:24px;vertical-align:top;">👨‍💼</td>
        <td style="padding:6px 0 6px 8px;">
          <div style="font-size:13px;font-weight:700;color:#0B1D3A;">CFP 직접 상담 우선 예약</div>
          <div style="font-size:11px;color:#888;">회원 전용 우선 일정</div>
        </td>
      </tr>
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
      본 메일은 금융집짓기® 구독 완료 시 자동 발송됩니다.
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

  // ━━━━━━━━━━━━━━━━━━━━
  // ③ 앱 화면으로 복귀
  // ━━━━━━━━━━━━━━━━━━━━
  return res.redirect(302,
    `${APP_URL}?pay_result=success&oid=${encodeURIComponent(oid)}`
  );
};
