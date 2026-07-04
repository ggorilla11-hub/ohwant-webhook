// api/payple-diag.js  — 임시 진단 전용(끝나면 삭제).
// Payple 공식 테스트 계정으로 AUTH 인증을 실제 호출해 "코드 문제 vs 라이브 계정 문제"를 가른다.
//   테스트 통과(AUTH0004 안 남) → 우리 코드/요청 방식은 정상 → 문제는 라이브 계정(도메인/정기결제 권한).
//   테스트도 AUTH0004 → 코드/요청 방식 문제.
// 옛 상품 코드·라이브 설정은 건드리지 않는다. 값은 Payple 공개 테스트값만 사용.
//   ?fmt=form|json (기본 form), ?testref=<url> (기본 ohwant-webhook)

module.exports = async function handler(req, res) {
  const q = req.query || {};
  const referer = q.testref || 'https://ohwant-webhook.vercel.app';
  const fmt = (q.fmt === 'json') ? 'json' : 'form';

  const fields = {
    cst_id: 'test',
    custKey: 'abcd1234567890',
    PCD_PAY_TYPE: 'card',
    PCD_PAY_WORK: 'AUTH',
    PCD_CARD_VER: '01',
    PCD_PAY_GOODS: '진단 테스트',
    PCD_PAY_TOTAL: '1000',
    PCD_PAY_OID: 'DIAG_' + Date.now(),
    PCD_REGULER_FLAG: 'Y',
    PCD_SIMPLE_FLAG: 'Y',
  };

  const headers = { 'Referer': referer };
  let body;
  if (fmt === 'json') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(fields);
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(fields).toString();
  }

  try {
    const r = await fetch('https://democpay.payple.kr/php/auth.php', { method: 'POST', headers, body });
    const text = await r.text();
    let payple; try { payple = JSON.parse(text); } catch (e) { payple = { parse_fail: text.slice(0, 400) }; }
    const code = (payple && payple.result_msg) ? payple.result_msg : (payple && payple.result) || '';
    const verdict = /AUTH0004/.test(JSON.stringify(payple))
      ? '코드/요청 방식 문제 가능 (테스트도 AUTH0004)'
      : (payple && payple.result === 'success') ? '코드 정상 (테스트 통과) → 라이브 계정 문제'
      : '기타 응답 — 아래 payple 확인';
    return res.status(200).json({ env: 'TEST democpay', fmt, referer_used: referer, http: r.status, verdict, payple });
  } catch (e) {
    return res.status(200).json({ env: 'TEST democpay', fmt, referer_used: referer, error: e.message });
  }
};
