# skill-view

*[English](README.md)*

내 Claude Code에서 지금 부를 수 있는 스킬을 전부 스캔해서 **이름 / 하는 일 / 사용 예시 /
설치·삭제 방법**을 담은 **HTML 카탈로그**로 만들어 주는 스킬입니다.

스킬을 여기저기서 설치하다 보면 "지금 뭐가 깔려 있는지", "이건 어떻게 쓰는 건지"가 금방
흐려집니다. 이름과 한 줄 설명만 봐서는 *그래서 뭐라고 치라는 거냐*가 안 풀리고, 플러그인으로
들어온 스킬은 개별 삭제가 안 되는데 그게 어디에도 안 보입니다. 매 실행마다 새로 스캔하므로
설치·삭제가 잦아도 항상 현재 상태입니다.

## 카탈로그에 들어가는 것

카드 한 장이 스킬 하나입니다.

- **호출 커맨드** — `argument-hint`까지 붙여 실제로 치는 형태 그대로
- **사용 예시 2~4개** — `"이 PDF에서 표만 뽑아줘"` → *표를 읽어 텍스트나 표 형식으로*.
  직접 부를 일이 없는 스킬(디자인 가이드 같은 것)은 그렇다고 밝힙니다
- **설치 · 삭제 · 위치** — 두 방법을 같은 무게로. 이건 카탈로그이지 정리 도구가 아니라서
  삭제를 앞세우지 않습니다
- 페이지 안에 **검색창과 출처 필터**가 있어 스킬이 수십 개여도 바로 좁혀집니다

출처는 네 가지입니다.

| 출처 | 어디서 찾나 |
|---|---|
| 개인 | `~/.claude/skills/` |
| 프로젝트 | `<프로젝트>/.claude/skills/` |
| 플러그인 | `~/.claude/plugins/cache/` — `plugin@marketplace`로 역추적해 정확한 명령 제시 |
| Anthropic 기본 | 디스크에 없음. 세션 목록을 넘겨받아 표시 (아래 참고) |

**비활성 플러그인**은 배지로 구분합니다. 설치돼 있어도 호출되지 않는 스킬을 찾을 때 여기부터
보면 됩니다. **중복**도 잡습니다 — 같은 스킬이 개인 설치본과 플러그인 양쪽에 있으면 한쪽을
지워도 남습니다.

## 설치

```bash
git clone https://github.com/minidice/skill-view.git ~/.claude/skills/skill-view
```

Windows PowerShell:

```powershell
git clone https://github.com/minidice/skill-view.git "$env:USERPROFILE\.claude\skills\skill-view"
```

Claude Code를 재시작하면 `/skill-view`로 잡힙니다. 특정 프로젝트에서만 쓰려면
`~/.claude/skills/` 대신 `<프로젝트>/.claude/skills/`에 두면 됩니다.

## 사용

Claude Code 안에서:

```
/skill-view                            전체
/skill-view pdf                        이름·설명·예시에 pdf가 든 것만
/skill-view 문서                        한글 검색도 됩니다
/skill-view --source personal          직접 넣은 개인 스킬만
/skill-view --source builtin 문서       검색어와 출처를 함께
```

Claude가 스캔 결과를 HTML로 만들어 Artifact로 게시하고 링크를 줍니다. 이미 열린 페이지에서
목록을 좁힐 거면 커맨드를 다시 치는 것보다 페이지 안의 검색창이 빠릅니다.

스크립트를 직접 부를 수도 있습니다:

```bash
node scripts/scan-skills.mjs --html out.html    # HTML 카탈로그
node scripts/scan-skills.mjs                    # 마크다운 표
node scripts/scan-skills.mjs --json             # 원본 데이터
node scripts/scan-skills.mjs --help
```

**Node 18+ 이면 되고 외부 의존성은 없습니다.** 표준 모듈만 씁니다.

## 언어

UI 라벨은 한국어와 영어로 들어 있고 `--lang ko|en`으로 고릅니다. 기본값은 시스템 로케일이지만,
Claude가 부를 때는 **사용자가 대화에서 실제로 쓰는 언어**를 넘깁니다. 영어 Windows를 쓴다고
영어 페이지를 원하는 건 아니니까요.

`--lang`은 **라벨만** 바꿉니다 (`설치`/`Install`, `이렇게 쓰면`/`How to use it`, 출처 이름).
스킬 설명과 예시는 호출자가 쓰는 내용이라 호출자의 언어로 들어갑니다. 언어를 추가하려면
`scripts/scan-skills.mjs` 맨 위 `STRINGS`에 항목을 하나 넣으면 됩니다 — 모든 라벨이 거기를
거칩니다.

## Anthropic 기본 스킬과 사용 예시

`docx`, `code-review`, `design` 같은 기본 제공 스킬은 **디스크에 `SKILL.md`로 존재하지
않습니다.** 세션이 직접 들고 있어서 파일 스캔으로는 잡을 수 없습니다. 사용 예시도 마찬가지로
frontmatter에서 뽑을 수 있는 정보가 아닙니다.

그래서 이 둘을 JSON 하나로 넘깁니다:

```bash
node scripts/scan-skills.mjs --html out.html --bundled bundled.json
```

```json
[
  {
    "name": "docx",
    "namespace": "anthropic-skills",
    "description": "Word 문서(.docx, .dotx)를 만들고 읽고 편집한다.",
    "examples": [
      { "say": "이 내용으로 Word 보고서 만들어줘", "does": "목차·서식이 잡힌 .docx 파일이 나옵니다" },
      { "say": "report.docx 읽고 요약해줘", "does": "문서의 글과 표를 뽑아 정리합니다" }
    ]
  }
]
```

- 디스크에 **같은 이름의 스킬이 이미 있으면** 카드를 새로 만들지 않고 `examples`만 얹습니다.
  그래서 설치된 스킬에도 같은 방식으로 예시를 붙일 수 있습니다.
- `namespace`는 커맨드에 접두사가 붙는 스킬만 넣습니다 (`/anthropic-skills:docx`).
- 예시 문구도 검색 대상입니다. 설명에 없는 단어로도 찾힙니다.

이 목록을 코드에 하드코딩하지 않는 이유는, Anthropic이 스킬을 추가하거나 없앨 때마다 낡기
때문입니다. `SKILL.md`가 Claude에게 "매번 세션 목록을 보고 새로 적으라"고 지시합니다.

## 설명 번역에 대해

설치된 스킬의 description은 대부분 영어이고 깁니다. 스크립트는 **원문을 그대로 출력하고**, Claude가
읽을 때 한국어 요약을 덧붙입니다. 번역 사전을 코드에 넣지 않는 이유는 새 스킬을 설치하면 바로
누락되기 때문입니다 — "항상 최신 상태"라는 목적과 충돌합니다.

반복 실행의 토큰 비용이 신경 쓰이면 `--cache <경로>`로 번역 캐시 JSON을 지정할 수 있습니다.
`{ "<description의 sha256 앞 16자>": "한국어 설명" }` 형태이고, 원문이 바뀌면 키가 달라져
자동으로 무효화됩니다.

## 동작 방식

각 `SKILL.md`의 frontmatter 블록만 읽고 즉시 중단합니다. YAML 파서도 쓰지 않아 의존성이 0이고,
100개 가까운 스킬도 1초 안에 끝납니다. 네트워크 호출은 없습니다.

**스킬 디렉터리는 읽기만 합니다.** 쓰는 파일은 `--html`로 지정한 출력 하나뿐이고, 아무것도
지우지 않습니다.

생성된 HTML은 자체 완결형입니다. 폰트만 Google Fonts에서 받고 나머지 CSS·JS는 파일 안에
들어 있어, 브라우저로 바로 열어도 되고 Artifact로 게시해도 됩니다. 라이트/다크 테마 양쪽을
지원합니다.

플러그인 메타데이터는 다음에서 읽습니다:

- `~/.claude/plugins/installed_plugins.json` — 설치 경로 → `plugin@marketplace` 매핑
- `~/.claude/settings.json`의 `enabledPlugins` — 활성/비활성 (프로젝트 설정이 우선)

## 라이선스

MIT
