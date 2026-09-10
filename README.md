# skill-view

로컬에 설치된 Claude Code 스킬을 스캔해 **이름 / 하는 일 / 실행 커맨드 / 삭제 방법**을
한국어 표로 정리해 주는 Claude Code 스킬입니다.

스킬을 여기저기서 설치하다 보면 "지금 뭐가 깔려 있는지", "이건 어떻게 지우는지"가
금방 흐려집니다. 특히 플러그인으로 들어온 스킬은 개별 삭제가 안 되는데 그게 어디에도
안 보입니다. 이 스킬은 매 실행마다 새로 스캔해서 그걸 한눈에 보여줍니다.

## 무엇을 알려주나

- 프로젝트 / 개인 / 플러그인 **세 곳을 모두** 스캔
- 플러그인 스킬은 `plugin@marketplace`로 역추적해 **정확한 삭제 명령** 제시
  (개별 스킬만 지울 수 없다는 경고 포함)
- **비활성 플러그인** 표시 — 설치돼 있어도 호출되지 않는 스킬을 구분
- **중복 감지** — 같은 스킬이 개인 설치본과 플러그인 양쪽에 있으면 한쪽을 지워도 남습니다

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
/skill-view
/skill-view ralph
/skill-view --source plugin
```

또는 스크립트를 직접:

```bash
node scripts/scan-skills.mjs            # 마크다운 표
node scripts/scan-skills.mjs --json     # 원본 데이터
node scripts/scan-skills.mjs --help
```

**Node 18+ 이면 되고 외부 의존성은 없습니다.** 표준 모듈만 씁니다. Claude Code를 쓰는 환경이면 대개 이미 갖춰져 있습니다.

## 출력 예시

```markdown
# 설치된 스킬 92개 (이름 기준 56종)

## 개인 — `C:\Users\you\.claude\skills` — 36개

> 삭제: 해당 스킬 디렉터리를 지우면 됩니다.

| 스킬 | 커맨드 | 하는 일 |
|---|---|---|
| ralph | `/ralph [--no-deslop] <task>` | Self-referential loop until task completion... |

## 플러그인 — 56개

### telegram@claude-plugins-official (v0.0.4, 2개) — ⏸ 비활성

> 비활성 상태라 아래 스킬은 지금 호출되지 않습니다. 켜기: `claude plugin enable telegram@...`
> 삭제: `claude plugin uninstall telegram@...` — 개별 스킬만 지울 수는 없고 아래 2개가 함께 사라집니다.

## ⚠ 중복 — 36종

- **oh-my-claudecode@omc ↔ personal** — 36종: ai-slop-cleaner, ask, autopilot, ...
```

## 설명 번역에 대해

스킬 description은 대부분 영어입니다. 스크립트는 **원문을 그대로 출력하고**, Claude가 읽을 때
한국어 요약을 덧붙입니다. 번역 사전을 코드에 넣지 않는 이유는, 새 스킬을 설치하면 바로
누락되기 때문입니다 — "항상 최신 상태"라는 목적과 충돌합니다.

반복 실행의 토큰 비용이 신경 쓰이면 `--cache <경로>`로 번역 캐시 JSON을 지정할 수 있습니다.
`{ "<description의 sha256 앞 16자>": "한국어 설명" }` 형태이고, 원문이 바뀌면 키가 달라져
자동으로 무효화됩니다.

## 동작 방식

각 `SKILL.md`의 frontmatter 블록만 읽고 즉시 중단합니다. YAML 파서도 쓰지 않아
의존성이 0이고, 100개 가까운 스킬도 1초 안에 끝납니다. **읽기 전용이라
파일을 쓰거나 지우지 않습니다.**

플러그인 메타데이터는 다음에서 읽습니다:

- `~/.claude/plugins/installed_plugins.json` — 설치 경로 → `plugin@marketplace` 매핑
- `~/.claude/settings.json`의 `enabledPlugins` — 활성/비활성 (프로젝트 설정이 우선)

## 라이선스

MIT
