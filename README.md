# Web Machine v9

Stagehand v4(LOCAL 모드) + 로컬 Chromium을 사용한 실행 가능한 웹 탐색/PDF 다운로드 테스트 프로젝트입니다. Browserbase 클라우드 세션은 사용하지 않고, LLM 호출에는 Groq(무료 API 키)를 기본값으로 사용합니다.

## GitHub Codespaces에서 실행

1. 저장소 페이지에서 **Code → Codespaces → Create codespace on main**
2. Codespace 생성 시 `npm install`과 Playwright Chromium 설치가 자동으로 실행됩니다.
3. `.env` 파일 생성:
   ```bash
   cp .env.example .env
   ```
4. [console.groq.com](https://console.groq.com)에서 무료 API 키를 발급받아 `.env`의 `GROQ_API_KEY`에 채워 넣습니다.
5. 실행:
   ```bash
   npm run test -- "2025학년도 9월 모의평가 사회문화 문제 PDF"
   ```

성공하면 `downloads/`에 파일이 저장되고, 콘솔에 URL, 파일 경로, PDF 여부, SHA-256, 탐색 이력이 출력됩니다.

## 다른 LLM 프로바이더 사용

Groq 대신 Google/OpenAI/Anthropic을 쓰려면 `.env`에 해당 API 키를 채우고 `STAGEHAND_MODEL`을 다음 형식으로 지정하세요:

```
STAGEHAND_MODEL=google/gemini-3.6-flash
STAGEHAND_MODEL=openai/gpt-4o-mini
STAGEHAND_MODEL=anthropic/claude-sonnet-4-6
```

## 중요한 점

- `SHA-256`은 파일 검증/식별용으로만 계산하며, 다른 사이트의 파일과 비교하지 않습니다.
- 특정 사이트의 URL을 코드에 정답으로 하드코딩하지 않았습니다.
- 엔진은 현재 페이지에서 PDF/첨부/다운로드 후보를 DOM에서 먼저 찾고, 없으면 LLM으로 의미적 탐색을 시도한 뒤, 관련 버튼/링크를 따라가며 재탐색합니다.
- Codespaces 환경에서는 headless 브라우저(`headless:true`)로 실행됩니다.
- Chromium 실행 파일 경로가 자동으로 안 잡히면 `.env`의 `CHROME_PATH`로 직접 지정할 수 있습니다.

## 로컬(Codespaces 외) 실행

Chrome/Chromium이 설치된 환경이라면 동일하게:
```bash
npm install
npm run install-browser
npm run test -- "2025학년도 9월 모의평가 사회문화 문제 PDF"
```
