const { google } = require('googleapis');

const SERVICE_MAP = {
  'FH_SUB_MONTHLY': { name: '금융집짓기 실버 월간구독', tab: '구독DB', type: 'subscription', price: 9900 },
  'FH_SUB_ANNUAL':  { name: '금융집짓기 실버 연간구독', tab: '구독DB', type: 'onetime',      price: 99000 },
  'LECTURE_PRO':          { name: '전문가 대면강의',           tab: '전문가강의DB', type: 'onetime',      price: 1100000 },
  'LECTURE_GEN':          { name: '일반인 비대면강의',         tab: '일반인강의DB', type: 'onetime',      price: 550000 },
  'CONSULT_ONLINE':       { name: '일반인 상담(비대면)',        tab: '상담DB',       type: 'onetime',      price: 330000 },
  'CONSULT_OFFLINE':      { name: '일반인 상담(대면)',          tab: '상담DB',       type: 'onetime',      price: 550000 },
  'CONSULT_VIP':          { name: '자산가 상담',               tab: '상담DB',       type: 'onetime',      price: 1100000 },
  'COURSE_ONLINE':        { name: '온라인 강의',               tab: '온라인강의DB', type: 'onetime',      price: 29000 },
  'EBOOK':                { name: '전자책',                    tab: '전자책DB',     type: 'onetime',      price: 12900 },
  'SUB_GENERAL_BASIC':    { name: '머니야 일반인 구독(베이직)',  tab: '구독DB',       type: 'subscription', price: 12900 },
  'SUB_GENERAL_STANDARD': { name: '머니야 일반인 구독(스탠다드)',tab: '구독DB',       type: 'subscription', price: 29000 },
  'SUB_GENERAL_PREMIUM':  { name: '머니야 일반인 구독(프리미엄)',tab: '구독DB',       type: 'subscription', price: 59000 },
  'SUB_PRO_BASIC':        { name: '머니야 전문가 구독(베이직)', tab: '구독DB',       type: 'subscription', price: 33000 },
  'SUB_PRO_STANDARD':     { name: '머니야 전문가 구독(스탠다드)',tab: '구독DB',       type: 'subscription', price: 59000 },
  'SUB_PRO_PREMIUM':      { name: '머니야 전문가 구독(프리미엄)',tab: '구독DB',       type: 'subscription', price: 99000 },
  'SEMINAR_ONLINE':       { name: '온라인 세미나',             tab: '세미나신청',   type: 'onetime',      price: 10000 },
  'SEMINAR_OFFLINE':      { name: '오프라인 세미나',           tab: '세미나신청',   type: 'onetime',      price: 100000 },
};

const PRICE_TO_SERVICE = {
  9900: 'FH_SUB_MONTHLY', 99000: 'FH_SUB_ANNUAL',
  1100000: 'LECTURE_PRO', 550000: 'LECTURE_GEN',
  330000: 'CONSULT_ONLINE', 29000: 'COURSE_ONLINE',
  12900: 'EBOOK', 33000: 'SUB_PRO_BASIC',
  59000: 'SUB_GENERAL_PREMIUM', 10000: 'SEMINAR_ONLINE',
  100000: 'SEMINAR_OFFLINE',
};

async function getGoogleSheets() {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({ credentials: serviceAccount, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

async function appendToSheet(tabName, values) {
  const sheets = await getGoogleSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${tabName}!A:Z`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] },
  });
}

async function findAndUpdateRow(tabName, searchCol, searchValue, updateCol, updateValue) {
  const sheets = await getGoogleSheets();
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: `${tabName}!A:Z` });
  const rows = response.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][searchCol] === searchValue) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: `${tabName}!${String.fromCharCode(65 + updateCol)}${i + 1}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[updateValue]] },
      });
      return true;
    }
  }
  return false;
}

async function logPayment(data, serviceInfo, status) {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  await appendToSheet('결제로그', [
    now, data.PCD_PAY_OID||'', data.PCD_PAYER_NAME||'', data.PCD_PAYER_HP||'',
    data.PCD_PAYER_EMAIL||'', serviceInfo?.name||'미분류', serviceInfo?.type||'',
    data.PCD_PAY_TOTAL||'', data.PCD_PAY_RST||'', data.PCD_PAY_MSG||'',
    data.PCD_PAY_TYPE||'', data.PCD_PAY_COFURL||'', data.PCD_REGULER_FLAG||'',
    data.PCD_PAY_CARDNAME||'', data.PCD_PAY_CARDNUM||'', status,
    JSON.stringify(data).substring(0, 500),
  ]);
}

function identifyService(data) {
  const orderId = data.PCD_PAY_OID || '';
  for (const [code, info] of Object.entries(SERVICE_MAP)) {
    if (orderId.startsWith(code)) return { code, ...info };
  }
  const goodsName = data.PCD_PAY_GOODS || '';
  for (const [code, info] of Object.entries(SERVICE_MAP)) {
    if (goodsName.includes(info.name) || goodsName.includes('금융집짓기')) return { code, ...info };
  }
  const amount = parseInt(data.PCD_PAY_TOTAL) || 0;
  const serviceCode = PRICE_TO_SERVICE[amount];
  if (serviceCode) return { code: serviceCode, ...SERVICE_MAP[serviceCode] };
  return null;
}

async function handleOnetimePayment(data, serviceInfo) {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  await appendToSheet(serviceInfo.tab, [
    now, data.PCD_PAYER_NAME||'', data.PCD_PAYER_HP||'', data.PCD_PAYER_EMAIL||'',
    serviceInfo.name, data.PCD_PAY_TOTAL||'', '결제완료', data.PCD_PAY_OID||'',
    data.PCD_PAY_CARDNAME||'', data.PCD_PAY_COFURL||'',
  ]);
}

async function handleSubscriptionPayment(data, serviceInfo) {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const isRenewal = data.PCD_REGULER_FLAG === 'Y' && data.PCD_PAY_WORK === 'AUTOB';
  if (isRenewal) {
    const phone = (data.PCD_PAYER_HP||'').replace(/-/g, '');
    const updated = await findAndUpdateRow('구독DB', 2, phone, 7, now);
    if (updated) return;
  }
  await appendToSheet('구독DB', [
    now, data.PCD_PAYER_NAME||'', data.PCD_PAYER_HP||'', data.PCD_PAYER_EMAIL||'',
    serviceInfo.name, data.PCD_PAY_TOTAL||'', '구독중', now, '1',
    data.PCD_PAY_OID||'', data.PCD_REGULER_FLAG||'',
  ]);
}

async function handleSubscriptionFailure(data, serviceInfo) {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const phone = (data.PCD_PAYER_HP||'').replace(/-/g, '');
  await findAndUpdateRow('구독DB', 2, phone, 6, '결제실패');
  await appendToSheet('결제실패로그', [now, data.PCD_PAYER_NAME||'', phone, serviceInfo?.name||'미분류', data.PCD_PAY_TOTAL||'', data.PCD_PAY_MSG||'', data.PCD_PAY_OID||'']);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') return res.status(200).json({ status: 'OK', version: '2.1.0' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const data = req.body;
    console.log('[웹훅 수신]', JSON.stringify(data).substring(0, 500));
    const payResult = data.PCD_PAY_RST || '';
    const serviceInfo = identifyService(data);
    await logPayment(data, serviceInfo, payResult === 'success' ? '성공' : '실패');

    if (payResult === 'success') {
      if (!serviceInfo) {
        console.log('[경고] 서비스 미식별:', data.PCD_PAY_OID, data.PCD_PAY_TOTAL);
        return res.status(200).json({ result: 'logged', message: '서비스 미식별 - 로그만 기록' });
      }
      if (serviceInfo.type === 'subscription') {
        await handleSubscriptionPayment(data, serviceInfo);
      } else {
        await handleOnetimePayment(data, serviceInfo);
      }
      console.log(`[처리 완료] ${serviceInfo.name} - ${data.PCD_PAY_TOTAL}원`);
      return res.status(200).json({ result: 'success', service: serviceInfo.name });
    }
    if (payResult === 'error' || payResult === 'fail') {
      if (serviceInfo?.type === 'subscription') await handleSubscriptionFailure(data, serviceInfo);
      return res.status(200).json({ result: 'fail_logged' });
    }
    return res.status(200).json({ result: 'logged' });
  } catch (error) {
    console.error('[에러]', error.message);
    return res.status(200).json({ result: 'error', message: error.message });
  }
};
