// ============================================================
// 금융집짓기® 페이플 인증 엔드포인트
// api/payple-auth.js — ohwant-webhook 서버에 추가
// 키가 서버에만 있고 HTML에 절대 노출 안 됨
// ============================================================

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { service_code, payer_name, payer_hp, payer_email } = req.body;

    // 서비스 코드 검증
    const VALID_SERVICES = ['FH_SILVER'];
    if (!VALID_SERVICES.includes(service_code)) {
      return res.status(400).json({ error: '유효하지 않은 서비스 코드' });
    }

    // 주문번호 생성
    const order_id = `${service_code}_${Date.now()}`;

    // 페이플 인증 요청 (서버에서 키 사용)
    const authResponse = await fetch('https://cpay.payple.kr/php/auth.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Referer': 'https://financial-house-building.vercel.app' },
      body: JSON.stringify({
        cst_id: process.env.PAYPLE_CST_ID,        // 환경변수 (절대 HTML 노출 안 함)
        custKey: process.env.PAYPLE_CUST_KEY,      // 환경변수
        PCD_PAY_TYPE: 'card',
        PCD_PAY_WORK: 'AUTH',
        PCD_CARD_VER: '01',
        PCD_PAYER_NAME: payer_name || '',
        PCD_PAYER_HP: payer_hp || '',
        PCD_PAYER_EMAIL: payer_email || '',
        PCD_PAY_GOODS: '금융집짓기® 실버 구독',
        PCD_PAY_TOTAL: '9900',
        PCD_PAY_OID: order_id,
        PCD_REGULER_FLAG: 'Y',                     // 정기결제
        PCD_SIMPLE_FLAG: 'Y',
      }),
    });

    const authData = await authResponse.json();

    if (authData.result === 'success') {
      return res.status(200).json({
        result: 'success',
        order_id,
        PCD_PAY_URL: authData.PCD_PAY_URL,         // 결제창 URL — HTML에 전달
        PCD_PAY_OID: order_id,
      });
    } else {
      return res.status(200).json({
        result: 'fail',
        message: authData.PCD_PAY_MSG || '인증 실패',
      });
    }

  } catch (error) {
    console.error('[페이플 인증 에러]', error.message);
    return res.status(200).json({ result: 'error', message: error.message });
  }
};
