# Web Machine v9

Stagehand v4(LOCAL 모드) + 로컬 Chromium을 사용한 범용 웹 탐색/파일 다운로드 엔진입니다. 특정 사이트에 종속되지 않고, 어떤 시작 URL과 검색 목표를 주더라도 그 사이트 안에서 목표 파일을 스스로 찾아 다운로드하도록 설계되었습니다. 요청 문구에서 파일 형식(PDF/엑셀/워드/파워포인트/한글/압축파일/이미지/CSV)을 자동으로 감지하며, 특별한 언급이 없으면 특정 형식으로 못박지 않고 알려진 형식 중 실제로 존재하는 걸 그대로 인정합니다(비편향적 기본 동작). Browserbase 클라우드 세션은 사용하지 않고, LLM 호출에는 Groq(무료 API 키)를 기본값으로 사용합니다.

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
   - 사이트를 모를 때는 검색어만으로 실행 (별도 검색 API 키 없이, 기존 브라우저+LLM으로 후보 사이트를 찾아 순서대로 시도):
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

### OpenRouter(또는 다른 OpenAI 호환 엔드포인트) 사용

Stagehand는 OpenRouter를 네이티브로 지원하지 않아서(허용된 프로바이더는 openai/anthropic/google/groq/cerebras뿐), `src/runtime/openaiCompatibleClient.ts`가 Stagehand의 내부 메시지 프로토콜(Anthropic/MCP 스타일 콘텐츠 블록)과 OpenAI 호환 프로토콜(평문 `content` + 별도 `tool_calls`) 사이를 통역하는 어댑터 역할을 합니다. `.env`에 다음을 설정하면 됩니다(설정 시 `STAGEHAND_MODEL`/`GROQ_API_KEY`보다 우선 적용):

```
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=openai/gpt-4o-mini
```

이 어댑터는 OpenRouter뿐 아니라 OpenAI 호환 API를 제공하는 어떤 엔드포인트와도 동작합니다(`createOpenAICompatibleClient({apiKey, model, baseURL})`의 `baseURL`을 바꾸면 됩니다).

## 탐색 전략

시작 사이트가 없으면(`TEST_URL` 미지정), 먼저 자체 검색 레이어(`src/discovery/websearch.ts`)로 후보 사이트를 찾아 순서대로 시도합니다 (`src/discover.ts`). 검색은 브라우저/LLM 없이 순수 HTTP로 Bing → Google을 먼저 시도하고(빠르고 무료), 둘 다 결과가 없을 때만 브라우저 + LLM(`stagehand.extract()`)으로 검색 결과 페이지를 의미적으로 읽어내는 방식으로 폴백합니다. 사이트 방문은 목적이 아니라 원하는 콘텐츠를 얻기 위한 수단이므로, 한 후보 사이트에서 실패하면 다음 후보로 넘어갑니다.

사이트 안에서는 `resolve()`가 특정 사이트 구조를 가정하지 않고, 다음 순서로 일반적인 전략을 시도합니다:

1. **직접 매칭** — 현재 페이지의 원시 HTML(`HtmlMachine`, 브라우저 불필요) 또는 렌더링된 DOM에서 PDF/다운로드/첨부 링크가 바로 보이면 즉시 사용 (LLM 호출 없음)
2. **LLM 판단 (근거 기반, 단기 기억 포함)** — DOM에서 스캔한 링크/버튼 후보(사이트 네비게이션 메뉴 포함)와 이번 세션에서 이미 취한 행동 이력을 근거로 제공하고, 다음에 클릭할 대상이나 검색 기능 사용 여부를 LLM이 판단
3. **기계적 폴백** — LLM 판단이 실패하면 점수가 가장 높은 미방문 후보를 클릭

클릭 이후에는 URL 이동, 새 탭 전환, 브라우저 네이티브 다운로드(파일이 `downloads/`에 바로 저장되는 경우) 세 가지 결과를 모두 감지합니다.

## 중요한 점

- `SHA-256`은 파일 검증/식별용으로만 계산하며, 다른 사이트의 파일과 비교하지 않습니다.
- 특정 사이트의 URL이나 구조를 코드에 하드코딩하지 않았습니다.
- 파일 형식은 `src/discovery/patterns.ts`의 `FILE_TYPES` 레지스트리에서 요청 문구 속 단어(예: "엑셀", "압축파일")로 감지합니다. 새 형식을 지원하려면 이 목록에 항목 하나만 추가하면 됩니다.
- AI는 로그인 해제/삭제/구매/구독 등 비가역적이거나 계정에 영향을 주는 액션은 선택하지 않도록 명시적으로 제한되어 있습니다.
- 다운로드 파일 크기는 100MB로 제한되고, 파일명은 안전한 문자만 남기도록 정제됩니다.
- Codespaces 환경에서는 headless 브라우저(`headless:true`)로 실행됩니다.
- Chromium 실행 파일 경로가 자동으로 안 잡히면 `.env`의 `CHROME_PATH`로 직접 지정할 수 있습니다.

## 로컬(Codespaces 외) 실행

Chrome/Chromium이 설치된 환경이라면 동일하게:
```bash
npm install
npm run install-browser
TEST_URL=https://example.com npm run test -- "찾고 싶은 파일이나 자료 설명"
```

## 단위 테스트

브라우저나 LLM 없이 순수 로직(PDF URL 추출, 파일 검증, 관련성 계산 등)만 검증합니다:
```bash
npm run test:unit
```
CI(GitHub Actions)에서 타입체크와 함께 매 push마다 자동 실행됩니다.
