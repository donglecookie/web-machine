# Web Machine v9 — Replit E2E
Stagehand LOCAL + local Chromium + Web Machine을 한 프로젝트로 묶은 실행 가능한 테스트 프로젝트입니다.
Browserbase API는 사용하지 않습니다. Stagehand의 LOCAL 환경으로 로컬 Chromium을 실행하고, AI 동작에는 `OPENAI_API_KEY`를 사용합니다. Stagehand 공식 문서도 `env: "LOCAL"`과 `localBrowserLaunchOptions`를 통한 로컬 Chrome/Chromium 실행을 지원합니다.

## Replit에서 실행
1. 이 ZIP을 Replit 새 Node.js 프로젝트에 업로드하고 압축을 풉니다.
2. Shell에서:
```bash
npm install
npm run install-browser
```
3. Secrets에 `OPENAI_API_KEY`를 추가합니다.
4. 필요하면 `STAGEHAND_MODEL`을 변경합니다.
5. 테스트:
```bash
npm run test -- "2025학년도 9월 모의평가 사회문화 문제 PDF"
```
또는:
```bash
npm start
```
6. 성공하면 `downloads/`에 PDF가 생성되고 콘솔에 실제 URL, 파일 경로, PDF 여부, SHA-256이 표시됩니다.

## 중요한 점
- `SHA-256`은 파일 검증/식별용으로만 계산합니다. 다른 사이트의 파일과 비교하지 않습니다.
- 호랭이닷컴 URL을 코드에 정답으로 하드코딩하지 않았습니다.
- 엔진은 현재 페이지에서 PDF/첨부/다운로드 후보를 찾고, 필요하면 관련 버튼/링크를 따라간 뒤 다시 탐색합니다.
- Replit의 실행 환경에서 GUI 브라우저 창은 보이지 않을 수 있으므로 `headless:true`로 테스트합니다.
- `CHROME_PATH`가 필요할 경우 Secrets/Environment에 Chromium 실행 파일 경로를 지정할 수 있습니다.

## 로컬 테스트
Chrome/Chromium이 설치된 환경에서는:
```bash
npm install
npm run test -- "2025학년도 9월 모의평가 사회문화 문제 PDF"
```
Stagehand은 Node.js 환경을 권장하고, LOCAL 모드는 로컬 Chrome/Chromium을 사용합니다.
