// ============================================================
// 금융집짓기® 페이플 인증 엔드포인트 v2
// 페이플은 form-urlencoded 방식으로 인증 요청
// ============================================================

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET: 헬스체크
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'OK', service: '금융집짓기 페이플 인증' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { service_code } = req.body || {};
    const order_id = `FH_SILVER_${Date.now()}`;

    // 페이플 인증 - form-urlencoded 방식
    const params = new URLSearchParams({
      cst_id: process.env.PAYPLE_CST_ID,
      custKey: process.env.PAYPLE_CUST_KEY,
      PCD_PAY_TYPE: 'card',
      PCD_PAY_WORK: 'AUTH',
      PCD_CARD_VER: '01',
      PCD_PAY_GOODS: '금융집짓기 실버 구독',
      PCD_PAY_TOTAL: '9900',
      PCD_PAY_OID: order_id,
      PCD_REGULER_FLAG: 'Y',
      PCD_SIMPLE_FLAG: 'Y',
    });

    const authResponse = await fetch('https://cpay.payple.kr/php/auth.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://financial-house-building.vercel.app',
      },
      body: params.toString(),
    });

    const authText = await authResponse.text();
    console.log('[페이플 응답]', authText);

    let authData;
    try {
      authData = JSON.parse(authText);
    } catch(e) {
      console.error('[파싱 에러]', authText);
      return res.status(200).json({
        result: 'fail',
        message: '페이플 응답 파싱 실패: ' + authText.substring(0, 100),
      });
    }

    if (authData.result === 'success') {
      return res.status(200).json({
        result: 'success',
        order_id,
        PCD_PAY_URL: authData.PCD_PAY_URL,
        PCD_PAY_OID: order_id,
      });
    } else {
      return res.status(200).json({
        result: 'fail',
        message: authData.PCD_PAY_MSG || authData.message || '인증 실패',
        raw: authData,
      });
    }

  } catch (error) {
    console.error('[페이플 인증 에러]', error.message);
    return res.status(200).json({ result: 'error', message: error.message });
  }
};
