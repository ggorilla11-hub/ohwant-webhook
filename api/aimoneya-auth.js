// api/aimoneya-auth.js
// AI금융집짓기(ai-moneya) 정기구독 인증 엔드포인트 — 신규 앱 전용.
// 옛 payple-auth.js 는 건드리지 않는다(옛 웹상품용, 그대로 유지).
// 하는 일: 앱 uid 를 받아 PCD_PAYER_NO·OID(FH_AIMONEYA_SUB_)에 실어 Payple 빌링 AUTH 요청.
//
// Vercel 환경변수 (대표가 직접 입력):
//   PAYPLE_CST_ID   : ohwant
//   PAYPLE_CUST_KEY : (비밀) custKey  ← placeholder, 미설정이면 Payple가 인증 실패로 응답

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET: 헬스체크
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'OK', service: 'AI금융집짓기 정기구독 인증' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const uid = (req.body && req.body.uid) || (req.query && req.query.uid) || '';
    if (!uid) return res.status(400).json({ result: 'fail', message: 'uid 없음 — 로그인 후 이용해 주세요.' });

    // 주문번호에 uid 인코딩 → 웹훅이 이 prefix로 신규 앱 결제를 옛 상품과 분리
    const order_id = `FH_AIMONEYA_SUB_${uid}_${Date.now()}`;

    // Payple 정기결제(빌링) 파트너 인증 — form-urlencoded
    const params = new URLSearchParams({
      cst_id: process.env.PAYPLE_CST_ID || '',
      custKey: process.env.PAYPLE_CUST_KEY || '',
      PCD_PAY_TYPE: 'card',
      PCD_PAY_WORK: 'AUTH',           // 카드등록(빌링키 발급)
      PCD_CARD_VER: '01',
      PCD_PAY_GOODS: 'AI금융집짓기 프리미엄 구독',
      PCD_PAY_TOTAL: '9900',
      PCD_PAY_OID: order_id,
      PCD_PAYER_NO: uid,              // ★ 커스텀 회원식별 — 웹훅이 그대로 돌려받아 uid 매칭
      PCD_REGULER_FLAG: 'Y',          // 정기결제(빌링)
      PCD_SIMPLE_FLAG: 'Y',
    });

    const authResponse = await fetch('https://cpay.payple.kr/php/auth.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Payple 도메인 검사(AUTH0004) 통과용 Referer. 같은 계정(ohwant)에서 이미 등록·작동 중인
        // 옛 상품 도메인을 재사용 → 새 도메인 등록 없이 인증 통과. (옛 결제와 동일 도메인)
        'Referer': 'https://financial-house-building.vercel.app',
      },
      body: params.toString(),
    });

    const authText = await authResponse.text();
    console.log('[aimoneya-auth 응답]', authText.substring(0, 200));

    let authData;
    try { authData = JSON.parse(authText); }
    catch (e) {
      return res.status(200).json({ result: 'fail', message: '페이플 응답 파싱 실패: ' + authText.substring(0, 120) });
    }

    if (authData.result === 'success') {
      // 클라이언트(subscribe.html)가 Payple JS에 넘길 인증정보 전체 + 주문번호
      return res.status(200).json({ result: 'success', order_id, uid, auth: authData });
    }
    return res.status(200).json({ result: 'fail', message: authData.PCD_PAY_MSG || authData.message || '인증 실패', raw: authData });

  } catch (error) {
    console.error('[aimoneya-auth 에러]', error.message);
    return res.status(200).json({ result: 'error', message: error.message });
  }
};
