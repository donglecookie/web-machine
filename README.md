# Web Machine v9

Stagehand v4(LOCAL 모드) + 로컬 Chromium을 사용한 범용 웹 탐색/파일 다운로드 엔진입니다. 특정 사이트에 종속되지 않고, 어떤 시작 URL과 검색 목표를 주더라도 그 사이트 안에서 목표 파일(주로 PDF)을 스스로 찾아 다운로드하도록 설계되었습니다. Browserbase 클라우드 세션은 사용하지 않고, LLM 호출에는 Groq(무료 API 키)를 기본값으로 사용합니다.

## GitHub Codespaces에서 실행

1. 저장소 페이지에서 **Code → Codespaces → Create codespace on main**
2. Codespace 생성 시 `npm install`과 Playwright Chromium 설치가 자동으로 실행됩니다.
3. `.env` 파일 생성:
   ```bash
   cp .env.example .env
   ```
4. [console.groq.com](https://console.groq.com)에서 무료 API 키를 발급받아 `.env`의 `GROQ_API_KEY`에 채워 넣습니다.
5. 실행:
   - 특정 사이트를 지정해서 그 안에서 찾기:
     ```bash
     TEST_URL=https://example.com npm run test -- "찾고 싶은 파일이나 자료 설명"
     ```
   - 사이트를 모를 때는 검색어만으로 실행 (웹 검색으로 후보 사이트를 찾아 순서대로 시도):
     ```bash
     npm run test -- "찾고 싶은 파일이나 자료 설명"
     ```

성공하면 `downloads/`에 파일이 저장되고, 콘솔에 URL, 파일 경로, PDF 여부, SHA-256, 탐색 이력이 출력됩니다.

## 다른 LLM 프로바이더 사용

Groq 대신 Google/OpenAI/Anthropic을 쓰려면 `.env`에 해당 API 키를 채우고 `STAGEHAND_MODEL`을 다음 형식으로 지정하세요:

```
STAGEHAND_MODEL=google/gemini-3.6-flash
STAGEHAND_MODEL=openai/gpt-4o-mini
STAGEHAND_MODEL=anthropic/claude-sonnet-4-6
```

## 탐색 전략

시작 사이트가 없으면(`TEST_URL` 미지정), 먼저 웹 검색으로 후보 사이트를 찾아 순서대로 시도합니다 (`src/discover.ts`). 사이트 방문은 목적이 아니라 원하는 콘텐츠를 얻기 위한 수단이므로, 한 후보 사이트에서 실패하면 다음 후보로 넘어갑니다.

사이트 안에서는 `resolve()`가 특정 사이트 구조를 가정하지 않고, 다음 순서로 일반적인 전략을 시도합니다:

1. **직접 매칭** — 현재 페이지에서 PDF/다운로드/첨부 링크가 바로 보이면 즉시 사용 (LLM 호출 없음)
2. **LLM 판단 (근거 기반)** — DOM에서 스캔한 링크/버튼 후보(사이트 네비게이션 메뉴 포함)를 근거로 제공하고, 다음에 클릭할 대상이나 검색 기능 사용 여부를 LLM이 판단
3. **기계적 폴백** — LLM 판단이 실패하면 점수가 가장 높은 미방문 후보를 클릭

## 중요한 점

- `SHA-256`은 파일 검증/식별용으로만 계산하며, 다른 사이트의 파일과 비교하지 않습니다.
- 특정 사이트의 URL이나 구조를 코드에 하드코딩하지 않았습니다.
- Codespaces 환경에서는 headless 브라우저(`headless:true`)로 실행됩니다.
- Chromium 실행 파일 경로가 자동으로 안 잡히면 `.env`의 `CHROME_PATH`로 직접 지정할 수 있습니다.

## 로컬(Codespaces 외) 실행

Chrome/Chromium이 설치된 환경이라면 동일하게:
```bash
npm install
npm run install-browser
TEST_URL=https://example.com npm run test -- "찾고 싶은 파일이나 자료 설명"
```
