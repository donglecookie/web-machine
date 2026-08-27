# GitHub Codespaces
1. 새 GitHub repository에 이 프로젝트를 업로드합니다.
2. GitHub에서 Code → Codespaces → Create codespace on main.
3. Codespace가 생성되면 npm install이 자동 실행됩니다.
4. .env에 OPENAI_API_KEY를 설정합니다.
5. `npm run test -- "2025학년도 9월 모의평가 사회문화 문제 PDF"`를 실행합니다.
성공하면 downloads/에 PDF가 저장되고 URL, 경로, PDF 여부, 크기, SHA-256, 탐색 이력이 출력됩니다.
Browserbase는 사용하지 않고 Stagehand LOCAL + Codespace Chromium을 사용합니다.
