// ohwant-webhook/api/payple.js
// 페이플 결제 완료 웹훅 수신 + 구글시트 기록 + 앱으로 리다이렉트
//
// 환경변수 (Vercel > Settings > Environment Variables):
//   SPREADSHEET_ID        : 구글시트 ID
//   GOOGLE_SERVICE_ACCOUNT: 서비스 계정 JSON 전체

const { google } = require('googleapis');

// 결제 완료 후 돌아갈 앱 URL
const APP_URL = 'https://financial-house-building.vercel.app';

// 서비스 식별 맵
const SERVICE_MAP = {
  'FH_MONTH': { name: '금융집짓기 실버 월간구독', sheet: '금융집짓기_구독DB' },
  'FH_YEAR':  { name: '금융집짓기 실버 연간구독', sheet: '금융집짓기_구독DB' },
};

module.exports = async function handler(req, res) {

  // ── GET / POST 모두 수신 (페이플은 POST로 전송)
  const data = req.method === 'POST' ? req.body : req.query;

  const rst      = data.PCD_PAY_RST   || '';
  const oid      = data.PCD_PAY_OID   || '';
  const total    = data.PCD_PAY_TOTAL || '0';
  const msg      = data.PCD_PAY_MSG   || '';
  const cardName = data.PCD_PAY_CARDNAME || '';
  const cardNum  = data.PCD_PAY_CARDNUM  || '';
  const authDate = data.PCD_PAY_TIME     || new Date().toISOString();

  console.log('[페이플 웹훅]', { rst, oid, total, msg });

  // ── 결제 실패 → 앱으로 리다이렉트 (실패 파라미터 포함)
  if (rst !== 'success') {
    const failUrl = `${APP_URL}?pay_result=fail&msg=${encodeURIComponent(msg)}`;
    return res.redirect(302, failUrl);
  }

  // ── 서비스 식별
  let serviceKey = 'FH_MONTH';
  if (oid.includes('YEAR')) serviceKey = 'FH_YEAR';
  const service = SERVICE_MAP[serviceKey] || SERVICE_MAP['FH_MONTH'];

  // ── 구글시트 기록
  try {
    const saJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
    const auth = new google.auth.GoogleAuth({
      credentials: saJson,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${service.sheet}!A:H`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
          oid,
          service.name,
          total,
          cardName,
          cardNum ? cardNum.replace(/(\d{4})(\d+)(\d{4})/, '$1-****-****-$3') : '',
          authDate,
          rst,
        ]],
      },
    });
    console.log('[구글시트] 기록 완료:', oid);
  } catch (e) {
    // 구글시트 실패해도 결제는 성공 처리 (로그만)
    console.error('[구글시트] 기록 실패:', e.message);
  }

  // ── 결제 성공 → 앱으로 리다이렉트 (성공 파라미터 포함)
  // index.html의 onPaypleResult가 callbackFunction으로 이미 실행되므로
  // 리다이렉트는 팝업이 닫힐 때 부모 창에 영향 없음
  // (페이플 팝업 방식에서는 callbackFunction이 우선 실행됨)
  const successUrl = `${APP_URL}?pay_result=success&oid=${encodeURIComponent(oid)}&service=${encodeURIComponent(service.name)}`;
  return res.redirect(302, successUrl);
};
