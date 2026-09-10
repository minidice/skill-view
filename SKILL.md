---
name: skill-view
description: 로컬에 설치된 Claude Code 스킬을 스캔해서 이름, 하는 일, 실행 커맨드, 삭제 방법을 한국어 표로 정리한다. "무슨 스킬 깔려 있지", "스킬 목록 보여줘", "스킬 정리", "이 스킬 어떻게 지워", "what skills do I have" 같은 요청에 사용한다. 스킬을 새로 만들거나 편집할 때는 쓰지 않는다.
argument-hint: "[검색어] [--source personal|project|plugin] [--enabled-only]"
---

# Skill View

설치된 스킬을 스캔해 한국어 카탈로그로 보여준다. 설치·삭제가 잦아도 매번 새로 훑으므로
항상 현재 상태를 반영한다.

## 실행

스크립트는 **이 SKILL.md와 같은 디렉터리의 `scripts/scan-skills.mjs`**다. 실행 시 작업 디렉터리는
스킬 디렉터리가 아니라 사용자의 프로젝트이므로 상대 경로로 부르면 안 된다.

이 스킬이 로드될 때 함께 주어지는 **`Base directory for this skill:` 경로**를 쓴다.

```bash
node "<base directory>/scripts/scan-skills.mjs" [검색어] [옵션]
```

그 값이 보이지 않으면 `~/.claude/skills/skill-view/scripts/scan-skills.mjs`를 쓰고,
없으면 `<프로젝트>/.claude/skills/skill-view/scripts/scan-skills.mjs`를 쓴다.
(`$CLAUDE_PLUGIN_ROOT`는 플러그인으로 설치했을 때만 설정되므로 의존하지 않는다.)

**작업 디렉터리는 바꾸지 않는다.** 스크립트가 현재 디렉터리를 프로젝트 루트로 보고
`.claude/skills`를 찾기 때문이다. 다른 프로젝트를 보려면 `cd` 대신 `--project <경로>`를 쓴다.

| 옵션 | 용도 |
|---|---|
| `검색어` | 이름·설명에서 부분 일치 검색 (대소문자 무시) |
| `--source personal\|project\|plugin` | 출처 필터. 여러 번 지정 가능 |
| `--enabled-only` | 비활성 플러그인의 스킬 제외 |
| `--full` | 설명을 200자에서 자르지 않음 |
| `--json` | 원본 데이터. description 전문과 `removal` 필드 포함 |
| `--cache <경로>` | 번역 캐시 JSON이 있으면 설명을 한국어로 치환 |

기본은 마크다운 표다. 사용자가 "전체 목록"을 원하면 옵션 없이, 특정 스킬을 물으면 검색어를 준다.

## 출력 규칙

1. **스크립트가 만든 표를 그대로 사용한다.** 행을 임의로 지우거나 순서를 바꾸지 않는다.
2. **설명은 대부분 영어로 나온다.** 각 표 아래(또는 사용자가 물어본 스킬에 한해) 한국어 한 줄
   요약을 덧붙인다. 원문 표를 한국어로 덮어쓰지 말고 요약을 따로 붙인다 — 원문 용어가
   검색에 필요하다.
3. **삭제 방법은 안내만 하고 실행하지 않는다.** 사용자가 명시적으로 지우라고 해야 실행한다.
4. 플러그인 스킬은 **개별 삭제가 불가능**하다는 점을 반드시 같이 말한다. `claude plugin uninstall`은
   그 플러그인의 스킬 전부를 제거한다.
5. `⏸ 비활성`으로 표시된 플러그인의 스킬은 지금 호출되지 않는다. 사용자가 "왜 이 스킬이 안 뜨지"라고
   물으면 여기부터 확인한다.
6. `⚠ 중복` 섹션이 있으면 언급한다. 한쪽만 지워도 다른 쪽이 남아서 계속 보인다.

## 스캔 대상

| 출처 | 경로 | 삭제 |
|---|---|---|
| 프로젝트 | `<프로젝트>/.claude/skills/<이름>/SKILL.md` | 디렉터리 삭제 |
| 개인 | `~/.claude/skills/<이름>/SKILL.md` | 디렉터리 삭제 |
| 플러그인 | `~/.claude/plugins/cache/<마켓>/<플러그인>/<버전>/skills/<이름>/SKILL.md` | `claude plugin uninstall <플러그인>@<마켓>` |

각 SKILL.md의 frontmatter만 읽고 중단하므로 수백 개여도 1초 안에 끝난다. 네트워크 호출은 없다.

`~/.claude/plugins/marketplaces/`는 마켓플레이스 저장소 클론일 뿐 설치본이 아니라서 스캔하지 않는다.
실제 활성 스킬은 `cache/` 아래에 있다.

## 주의

- 스크립트가 읽기만 하므로 안전하다. 파일을 쓰거나 지우지 않는다.
- 커맨드 열은 frontmatter의 `name`과 `argument-hint`로 조합한 것이다. 스킬이 슬래시 커맨드를
  따로 등록해 두면 실제 호출명이 다를 수 있다.
