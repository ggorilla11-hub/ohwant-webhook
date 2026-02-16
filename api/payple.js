const { google } = require('googleapis');

// ============================================================
// 오원트금융연구소 페이플 웹훅 서버
// 9가지 서비스 결제(일회성 + 정기결제) 통합 처리
// ============================================================

// 서비스 매핑 테이블
const SERVICE_MAP = {
  // 서비스코드: { name, tab, type }
  'LECTURE_PRO': { name: '전문가 대면강의', tab: '전문가강의DB', type: 'onetime', price: 1100000 },
  'LECTURE_GEN': { name: '일반인 비대면강의', tab: '일반인강의DB', type: 'onetime', price: 550000 },
  'CONSULT_ONLINE': { name: '일반인 상담(비대면)', tab: '상담DB', type: 'onetime', price: 330000 },
  'CONSULT_OFFLINE': { name: '일반인 상담(대면)', tab: '상담DB', type: 'onetime', price: 550000 },
  'CONSULT_VIP': { name: '자산가 상담', tab: '상담DB', type: 'onetime', price: 1100000 },
  'COURSE_ONLINE': { name: '온라인 강의', tab: '온라인강의DB', type: 'onetime', price: 29000 },
  'EBOOK': { name: '전자책', tab: '전자책DB', type: 'onetime', price: 12900 },
  'SUB_GENERAL_BASIC': { name: '머니야 일반인 구독(베이직)', tab: '구독DB', type: 'subscription', price: 12900 },
  'SUB_GENERAL_STANDARD': { name: '머니야 일반인 구독(스탠다드)', tab: '구독DB', type: 'subscription', price: 29000 },
  'SUB_GENERAL_PREMIUM': { name: '머니야 일반인 구독(프리미엄)', tab: '구독DB', type: 'subscription', price: 59000 },
  'SUB_PRO_BASIC': { name: '머니야 전문가 구독(베이직)', tab: '구독DB', type: 'subscription', price: 33000 },
  'SUB_PRO_STANDARD': { name: '머니야 전문가 구독(스탠다드)', tab: '구독DB', type: 'subscription', price: 59000 },
  'SUB_PRO_PREMIUM': { name: '머니야 전문가 구독(프리미엄)', tab: '구독DB', type: 'subscription', price: 99000 },
  'SEMINAR_ONLINE': { name: '온라인 세미나', tab: '세미나신청', type: 'onetime', price: 10000 },
  'SEMINAR_OFFLINE': { name: '오프라인 세미나', tab: '세미나신청', type: 'onetime', price: 100000 },
};

// 금액으로 서비스 추정 (서비스코드가 없을 때 fallback)
const PRICE_TO_SERVICE = {
  1100000: 'LECTURE_PRO',  // 또는 CONSULT_VIP - 추가 정보 필요
  550000: 'LECTURE_GEN',   // 또는 CONSULT_OFFLINE
  330000: 'CONSULT_ONLINE',
  29000: 'COURSE_ONLINE',  // 또는 SUB_GENERAL_STANDARD
  12900: 'EBOOK',          // 또는 SUB_GENERAL_BASIC
  33000: 'SUB_PRO_BASIC',
  59000: 'SUB_GENERAL_PREMIUM', // 또는 SUB_PRO_STANDARD
  99000: 'SUB_PRO_PREMIUM',
  10000: 'SEMINAR_ONLINE',
  100000: 'SEMINAR_OFFLINE',
};

// 구글시트 인증
async function getGoogleSheets() {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  return sheets;
}

// 구글시트에 행 추가
async function appendToSheet(tabName, values) {
  const sheets = await getGoogleSheets();
  const spreadsheetId = process.env.SPREADSHEET_ID;

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tabName}!A:Z`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [values],
    },
  });
}

// 구글시트에서 행 검색 및 업데이트 (정기결제 갱신용)
async function findAndUpdateRow(tabName, searchCol, searchValue, updateCol, updateValue) {
  const sheets = await getGoogleSheets();
  const spreadsheetId = process.env.SPREADSHEET_ID;

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A:Z`,
  });

  const rows = response.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][searchCol] === searchValue) {
      const range = `${tabName}!${String.fromCharCode(65 + updateCol)}${i + 1}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[updateValue]] },
      });
      return true;
    }
  }
  return false;
}

// 결제 로그 기록 (모든 결제 건)
async function logPayment(data, serviceInfo, status) {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  await appendToSheet('결제로그', [
    now,                                    // 수신시간
    data.PCD_PAY_OID || '',                // 주문번호
    data.PCD_PAYER_NAME || '',             // 결제자명
    data.PCD_PAYER_HP || '',               // 연락처
    data.PCD_PAYER_EMAIL || '',            // 이메일
    serviceInfo?.name || '미분류',          // 서비스명
    serviceInfo?.type || '',               // 결제유형
    data.PCD_PAY_TOTAL || '',              // 결제금액
    data.PCD_PAY_RST || '',                // 결제결과
    data.PCD_PAY_MSG || '',                // 결과메시지
    data.PCD_PAY_TYPE || '',               // 결제방식 (card/transfer)
    data.PCD_PAY_COFURL || '',             // 카드영수증 URL
    data.PCD_REGULER_FLAG || '',           // 정기결제 여부
    data.PCD_PAY_CARDNAME || '',           // 카드사
    data.PCD_PAY_CARDNUM || '',            // 카드번호
    status,                                 // 처리상태
    JSON.stringify(data).substring(0, 500), // 원본데이터 (500자)
  ]);
}

// 서비스 식별
function identifyService(data) {
  // 1. 주문번호에 서비스코드 포함된 경우 (권장 방식)
  // 예: SEMINAR_OFFLINE_20260216_001
  const orderId = data.PCD_PAY_OID || '';
  for (const [code, info] of Object.entries(SERVICE_MAP)) {
    if (orderId.startsWith(code)) {
      return { code, ...info };
    }
  }

  // 2. 상품명으로 매칭
  const goodsName = data.PCD_PAY_GOODS || '';
  for (const [code, info] of Object.entries(SERVICE_MAP)) {
    if (goodsName.includes(info.name)) {
      return { code, ...info };
    }
  }

  // 3. 금액으로 추정 (fallback)
  const amount = parseInt(data.PCD_PAY_TOTAL) || 0;
  const serviceCode = PRICE_TO_SERVICE[amount];
  if (serviceCode) {
    return { code: serviceCode, ...SERVICE_MAP[serviceCode] };
  }

  // 미식별
  return null;
}

// 일회성 결제 처리
async function handleOnetimePayment(data, serviceInfo) {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const tabName = serviceInfo.tab;

  if (tabName === '세미나신청') {
    // 세미나: 기존 신청 행의 결제상태 업데이트
    const phone = (data.PCD_PAYER_HP || '').replace(/-/g, '');
    const updated = await findAndUpdateRow(tabName, 1, phone, 4, '결제완료');
    
    if (!updated) {
      // 신청 데이터가 없으면 새 행 추가
      await appendToSheet(tabName, [
        data.PCD_PAYER_NAME || '',
        phone,
        now,
        '결제완료',
        data.PCD_PAY_TOTAL || '',
        data.PCD_PAY_OID || '',
        serviceInfo.name,
      ]);
    }
  } else {
    // 기타 일회성 서비스: 해당 탭에 새 행 추가
    await appendToSheet(tabName, [
      now,
      data.PCD_PAYER_NAME || '',
      data.PCD_PAYER_HP || '',
      data.PCD_PAYER_EMAIL || '',
      serviceInfo.name,
      data.PCD_PAY_TOTAL || '',
      '결제완료',
      data.PCD_PAY_OID || '',
      data.PCD_PAY_CARDNAME || '',
      data.PCD_PAY_COFURL || '',
    ]);
  }
}

// 정기결제 처리
async function handleSubscriptionPayment(data, serviceInfo) {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const isRenewal = data.PCD_REGULER_FLAG === 'Y' && data.PCD_PAY_WORK === 'AUTOB';

  if (isRenewal) {
    // 정기결제 자동갱신
    const phone = (data.PCD_PAYER_HP || '').replace(/-/g, '');
    const updated = await findAndUpdateRow('구독DB', 2, phone, 7, now); // 최근갱신일 업데이트
    
    if (updated) {
      // 갱신횟수 증가는 별도 로직 필요 시 추가
      console.log(`구독 갱신 완료: ${phone}`);
    } else {
      // 갱신이지만 기존 데이터 없으면 새로 추가
      await appendToSheet('구독DB', [
        now,
        data.PCD_PAYER_NAME || '',
        data.PCD_PAYER_HP || '',
        data.PCD_PAYER_EMAIL || '',
        serviceInfo.name,
        data.PCD_PAY_TOTAL || '',
        '구독중',
        now,   // 최근갱신일
        '1',   // 갱신횟수
        data.PCD_PAY_OID || '',
        data.PCD_REGULER_FLAG || '',
      ]);
    }
  } else {
    // 최초 정기결제
    await appendToSheet('구독DB', [
      now,
      data.PCD_PAYER_NAME || '',
      data.PCD_PAYER_HP || '',
      data.PCD_PAYER_EMAIL || '',
      serviceInfo.name,
      data.PCD_PAY_TOTAL || '',
      '구독중',
      now,   // 최근갱신일
      '1',   // 갱신횟수
      data.PCD_PAY_OID || '',
      data.PCD_REGULER_FLAG || '',
    ]);
  }
}

// 정기결제 실패 처리
async function handleSubscriptionFailure(data, serviceInfo) {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const phone = (data.PCD_PAYER_HP || '').replace(/-/g, '');
  
  // 구독 상태를 '결제실패'로 변경
  await findAndUpdateRow('구독DB', 2, phone, 6, '결제실패');
  
  // 실패 로그
  await appendToSheet('결제실패로그', [
    now,
    data.PCD_PAYER_NAME || '',
    phone,
    serviceInfo?.name || '미분류',
    data.PCD_PAY_TOTAL || '',
    data.PCD_PAY_MSG || '',
    data.PCD_PAY_OID || '',
  ]);
}

// ============================================================
// 메인 핸들러
// ============================================================
module.exports = async function handler(req, res) {
  // CORS 허용
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // OPTIONS (preflight)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // GET 요청 시 헬스체크
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'OK',
      service: '오원트금융연구소 페이플 웹훅 서버',
      version: '2.0.0',
      timestamp: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
      endpoints: {
        webhook: 'POST /api/payple',
        health: 'GET /api/payple',
      },
    });
  }

  // POST 외 메소드 거부
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // POST: 페이플 웹훅 처리
  try {
    const data = req.body;
    console.log('[웹훅 수신]', JSON.stringify(data).substring(0, 500));

    // 결제 결과 확인
    const payResult = data.PCD_PAY_RST || '';
    const serviceInfo = identifyService(data);

    // 1. 모든 건 로그 기록
    await logPayment(data, serviceInfo, payResult === 'success' ? '성공' : '실패');

    // 2. 결제 성공 처리
    if (payResult === 'success') {
      if (!serviceInfo) {
        console.log('[경고] 서비스 미식별 결제:', data.PCD_PAY_OID, data.PCD_PAY_TOTAL);
        // 미식별이어도 로그는 이미 기록됨
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

    // 3. 결제 실패 처리
    if (payResult === 'error' || payResult === 'fail') {
      if (serviceInfo?.type === 'subscription') {
        await handleSubscriptionFailure(data, serviceInfo);
      }
      console.log(`[결제 실패] ${data.PCD_PAY_MSG}`);
      return res.status(200).json({ result: 'fail_logged' });
    }

    // 4. 기타 (환불 등)
    console.log(`[기타 이벤트] RST: ${payResult}`);
    return res.status(200).json({ result: 'logged' });

  } catch (error) {
    console.error('[에러]', error.message);
    // 에러가 나도 200 응답 (페이플이 재시도하지 않도록)
    return res.status(200).json({ result: 'error', message: error.message });
  }
};
