# 오원트 페이플 웹훅 서버

## 배포 방법 (Vercel)

### 1. GitHub에 새 레포 생성
- 레포 이름: `ohwant-webhook`
- Public 또는 Private

### 2. 코드 업로드
이 폴더의 파일들을 레포에 업로드:
- api/payple.js
- package.json
- vercel.json

### 3. Vercel에서 프로젝트 생성
- vercel.com → New Project → GitHub 레포 연결
- Framework Preset: Other

### 4. 환경변수 설정 (Vercel > Settings > Environment Variables)

**SPREADSHEET_ID**: 구글시트 AI머니야_마케팅DB의 ID
(URL에서 추출: https://docs.google.com/spreadsheets/d/{여기가ID}/edit)

**GOOGLE_SERVICE_ACCOUNT**: 구글 서비스 계정 JSON (전체)

### 5. 배포 후 URL
https://ohwant-webhook.vercel.app/api/payple

### 6. 페이플 관리자에서 웹훅 URL 등록
파트너 관리자 > 상점정보 > 기본정보 > 웹훅 URL:
https://ohwant-webhook.vercel.app/api/payple
