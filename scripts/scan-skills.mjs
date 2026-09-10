#!/usr/bin/env node
/**
 * 로컬에 설치된 Claude Code 스킬을 스캔한다.
 *
 * SKILL.md의 frontmatter만 읽으므로 네트워크 호출이 없고 빠르다.
 * 외부 의존성 없이 Node 표준 모듈만 사용한다.
 *
 * 사용법:
 *   node scan-skills.mjs                    # 마크다운 표
 *   node scan-skills.mjs --json             # 원본 데이터 (description 전문 포함)
 *   node scan-skills.mjs ralph              # 이름/설명 검색
 *   node scan-skills.mjs --source personal  # 출처 필터
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// frontmatter에서 실제로 쓰는 키만 뽑는다. 나머지는 무시.
const WANTED_KEYS = new Set(["name", "description", "argument-hint"]);

// 마크다운 표에 넣을 설명 길이. 원문 전체는 --json으로 받는다.
const DESC_LIMIT = 200;

// frontmatter는 항상 파일 맨 앞에 있으므로 앞부분만 읽는다.
const HEAD_BYTES = 8192;

// 캐시 아래를 훑을 때의 최대 깊이. 무한히 깊은 트리를 방어한다.
const MAX_DEPTH = 8;

// ---------------------------------------------------------------------------
// frontmatter 파싱
// ---------------------------------------------------------------------------

function readHead(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 닫기 실패는 무시한다 */
      }
    }
  }
}

function unquote(value) {
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * SKILL.md 맨 위 --- 블록만 읽는다.
 *
 * YAML 파서를 쓰지 않는 이유는 의존성을 0으로 유지하기 위함이다.
 * `key: value`와 들여쓴 이어쓰기 줄만 처리하면 스킬 frontmatter에는 충분하다.
 */
function parseFrontmatter(file) {
  const head = readHead(file);
  if (head === null) return null;

  const lines = head.split(/\r?\n/);
  if (lines[0].trim() !== "---") return null;

  const data = new Map();
  let key = null;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim();
    if (stripped === "---" || stripped === "...") break;

    // 들여쓴 줄이거나 콜론이 없으면 직전 키의 이어쓰기로 본다.
    const isContinuation = /^[ \t]/.test(line) || !stripped.includes(":");
    if (key && isContinuation && stripped) {
      data.set(key, `${data.get(key)} ${stripped}`.trim());
      continue;
    }

    const colon = stripped.indexOf(":");
    if (colon === -1) continue;

    key = stripped.slice(0, colon).trim();
    data.set(key, unquote(stripped.slice(colon + 1).trim()));
  }

  const out = {};
  for (const [k, v] of data) {
    if (WANTED_KEYS.has(k) && v) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 설치 위치
// ---------------------------------------------------------------------------

/** 플러그인 경로 비교용. Windows 대소문자/구분자 차이를 흡수한다. */
function norm(p) {
  const normalized = path.normalize(String(p));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * installed_plugins.json에서 installPath -> 플러그인 정보를 만든다.
 *
 * 이게 있어야 캐시 경로를 `plugin@marketplace`로 되돌려 삭제 명령을 만들 수 있다.
 */
function loadPluginIndex(claudeHome) {
  const index = new Map();
  const payload = readJson(path.join(claudeHome, "plugins", "installed_plugins.json"));
  if (!payload) return index;

  for (const [ref, installs] of Object.entries(payload.plugins ?? {})) {
    for (const install of installs ?? []) {
      if (!install?.installPath) continue;
      index.set(norm(install.installPath), {
        ref,
        version: install.version || "unknown",
        scope: install.scope || "unknown",
      });
    }
  }
  return index;
}

/**
 * settings.json의 enabledPlugins를 모은다.
 *
 * 설치돼 있어도 비활성이면 스킬이 실제로는 안 뜨므로 구분해서 보여줘야 한다.
 * 프로젝트 설정이 사용자 설정보다 우선하도록 나중에 덮어쓴다.
 */
function loadEnabledPlugins(claudeHome, projectDir) {
  const enabled = new Map();
  const files = [
    path.join(claudeHome, "settings.json"),
    path.join(claudeHome, "settings.local.json"),
    path.join(projectDir, ".claude", "settings.json"),
    path.join(projectDir, ".claude", "settings.local.json"),
  ];

  for (const file of files) {
    const payload = readJson(file);
    if (!payload) continue;
    for (const [ref, value] of Object.entries(payload.enabledPlugins ?? {})) {
      enabled.set(ref, Boolean(value));
    }
  }
  return enabled;
}

function buildEntry(front, directory, source, plugin) {
  const name = front.name || path.basename(directory);
  const hint = front["argument-hint"] || "";

  let command = plugin ? `/${plugin.name}:${name}` : `/${name}`;
  if (hint) command = `${command} ${hint}`;

  return {
    name,
    description: front.description || "",
    argument_hint: hint,
    command,
    source,
    path: directory,
    plugin,
  };
}

/** `<root>/<스킬명>/SKILL.md` 형태 (개인/프로젝트 스킬). */
function scanFlatDir(root, source) {
  const entries = [];
  let children;
  try {
    children = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return entries;
  }

  for (const child of children.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!child.isDirectory() && !child.isSymbolicLink()) continue;
    const dir = path.join(root, child.name);
    const skillFile = path.join(dir, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    const front = parseFrontmatter(skillFile);
    if (front === null) continue;
    entries.push(buildEntry(front, dir, source, null));
  }
  return entries;
}

/** 디렉터리를 재귀로 훑어 SKILL.md 경로를 모은다. */
function findSkillFiles(root, depth = 0) {
  const found = [];
  if (depth > MAX_DEPTH) return found;

  let children;
  try {
    children = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const child of children) {
    const full = path.join(root, child.name);
    if (child.isDirectory()) {
      found.push(...findSkillFiles(full, depth + 1));
    } else if (child.name === "SKILL.md") {
      found.push(full);
    }
  }
  return found;
}

/**
 * `cache/<마켓플레이스>/<플러그인>/<버전>/skills/<스킬>/SKILL.md` 형태.
 *
 * 플러그인마다 구조가 조금씩 달라 재귀로 훑는다.
 */
function scanPluginCache(claudeHome, index, enabled) {
  const entries = [];
  const cache = path.join(claudeHome, "plugins", "cache");
  if (!fs.existsSync(cache)) return entries;

  for (const skillFile of findSkillFiles(cache).sort()) {
    const front = parseFrontmatter(skillFile);
    if (front === null) continue;

    const rel = path.relative(cache, skillFile).split(path.sep);
    if (rel.length < 5) continue;
    // `commands/SKILL.md` 같은 슬래시 커맨드 파일이 섞여 들어오므로
    // 버전 아래에 `skills` 세그먼트가 있는 것만 실제 스킬로 본다.
    if (!rel.slice(3, -1).includes("skills")) continue;

    const [marketplace, pluginName, version] = rel;
    const installRoot = path.join(cache, marketplace, pluginName, version);
    const info = index.get(norm(installRoot));
    const ref = info ? info.ref : `${pluginName}@${marketplace}`;

    entries.push(
      buildEntry(front, path.dirname(skillFile), "plugin", {
        name: pluginName,
        marketplace,
        version: info ? info.version : version,
        ref,
        scope: info ? info.scope : "unknown",
        registered: info !== undefined,
        enabled: enabled.get(ref) ?? false,
      }),
    );
  }
  return entries;
}

function removalHint(source, plugin, dir) {
  if (source === "plugin" && plugin) return `claude plugin uninstall ${plugin.ref}`;
  return `디렉터리 삭제: ${dir}`;
}

// ---------------------------------------------------------------------------
// 번역 캐시 (선택)
// ---------------------------------------------------------------------------

/** 원문이 바뀌면 캐시가 자동으로 무효화되도록 해시를 키로 쓴다. */
function descKey(description) {
  return createHash("sha256").update(description, "utf8").digest("hex").slice(0, 16);
}

function loadTranslations(cachePath) {
  if (!cachePath) return new Map();
  const payload = readJson(cachePath);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return new Map();
  return new Map(Object.entries(payload));
}

// ---------------------------------------------------------------------------
// 출력
// ---------------------------------------------------------------------------

/** 마크다운 표 셀로 안전하게 만든다. */
function cell(text, limit = DESC_LIMIT) {
  let flat = String(text).split(/\s+/).filter(Boolean).join(" ");
  if (limit && flat.length > limit) flat = `${flat.slice(0, limit - 1).trimEnd()}…`;
  return flat.replaceAll("|", "\\|");
}

function renderTable(entries, translations, full) {
  const limit = full ? null : DESC_LIMIT;
  const lines = ["| 스킬 | 커맨드 | 하는 일 |", "|---|---|---|"];
  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const desc = translations.get(descKey(e.description)) ?? e.description;
    lines.push(`| ${cell(e.name, null)} | \`${cell(e.command, null)}\` | ${cell(desc, limit)} |`);
  }
  return lines;
}

function renderMarkdown(entries, translations, projectDir, claudeHome, full) {
  const byName = new Map();
  for (const e of entries) {
    if (!byName.has(e.name)) byName.set(e.name, []);
    byName.get(e.name).push(e);
  }

  const out = [`# 설치된 스킬 ${entries.length}개 (이름 기준 ${byName.size}종)`, ""];

  const flat = [
    ["project", `프로젝트 — \`${path.join(projectDir, ".claude", "skills")}\``],
    ["personal", `개인 — \`${path.join(claudeHome, "skills")}\``],
  ];
  for (const [source, title] of flat) {
    const group = entries.filter((e) => e.source === source);
    out.push(`## ${title} — ${group.length}개`, "");
    if (group.length === 0) {
      out.push("_없음_");
    } else {
      out.push("> 삭제: 해당 스킬 디렉터리를 지우면 됩니다.", "");
      out.push(...renderTable(group, translations, full));
    }
    out.push("");
  }

  const plugins = entries.filter((e) => e.source === "plugin");
  out.push(`## 플러그인 — ${plugins.length}개`, "");
  if (plugins.length === 0) {
    out.push("_없음_", "");
  } else {
    const grouped = new Map();
    for (const e of plugins) {
      if (!grouped.has(e.plugin.ref)) grouped.set(e.plugin.ref, []);
      grouped.get(e.plugin.ref).push(e);
    }

    for (const ref of [...grouped.keys()].sort()) {
      const group = grouped.get(ref);
      const plugin = group[0].plugin;
      const flags = [];
      if (!plugin.registered) flags.push("⚠ 설치 목록에 없음");
      if (!plugin.enabled) flags.push("⏸ 비활성");
      const suffix = flags.length ? ` — ${flags.join(", ")}` : "";

      out.push(`### ${ref} (v${plugin.version}, ${group.length}개)${suffix}`, "");
      if (!plugin.enabled) {
        out.push(`> 비활성 상태라 아래 스킬은 지금 호출되지 않습니다. 켜기: \`claude plugin enable ${ref}\``);
      }
      out.push(
        `> 삭제: \`claude plugin uninstall ${ref}\` — 개별 스킬만 지울 수는 없고 아래 ${group.length}개가 함께 사라집니다.`,
        "",
      );
      out.push(...renderTable(group, translations, full));
      out.push("");
    }
  }

  const dupes = [...byName.entries()].filter(([, g]) => g.length > 1);
  if (dupes.length) {
    // 스킬 하나씩 나열하면 수십 줄이 되므로, 겹치는 출처 조합끼리 묶는다.
    // 대부분 "개인 설치본 + 같은 걸 담은 플러그인" 한 덩어리로 떨어진다.
    const byOrigin = new Map();
    for (const [name, group] of dupes) {
      const origins = group
        .map((e) => (e.plugin ? e.plugin.ref : e.source))
        .sort()
        .join(" ↔ ");
      if (!byOrigin.has(origins)) byOrigin.set(origins, []);
      byOrigin.get(origins).push(name);
    }

    out.push(`## ⚠ 중복 — ${dupes.length}종`, "");
    out.push("같은 이름이 여러 곳에 설치돼 있습니다. 한쪽을 지워도 다른 쪽이 남습니다.", "");
    for (const origins of [...byOrigin.keys()].sort()) {
      const names = byOrigin.get(origins).sort();
      out.push(`- **${origins}** — ${names.length}종: ${names.join(", ")}`);
    }
    out.push("");
  }

  return `${out.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------

const USAGE = `사용법: node scan-skills.mjs [검색어] [옵션]

로컬 Claude Code 스킬 스캐너

  검색어                      이름/설명 검색 (대소문자 무시)
  --source <출처>             project|personal|plugin. 여러 번 지정 가능
  --enabled-only              비활성 플러그인의 스킬은 제외
  --full                      마크다운에서 설명을 자르지 않음
  --json                      원본 데이터 출력 (description 전문 포함)
  --project <경로>            프로젝트 루트 (기본: 현재 디렉터리)
  --claude-home <경로>        Claude 홈 (기본: ~/.claude)
  --cache <경로>              번역 캐시 JSON (있으면 한국어 설명으로 치환)
  -h, --help                  이 도움말
`;

function parseArgs(argv) {
  const opts = {
    query: null,
    sources: [],
    json: false,
    enabledOnly: false,
    full: false,
    project: process.cwd(),
    claudeHome: path.join(os.homedir(), ".claude"),
    cache: null,
  };
  const valid = new Set(["project", "personal", "plugin"]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) {
        console.error(`오류: ${arg} 에 값이 필요합니다.`);
        process.exit(2);
      }
      return v;
    };

    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      case "--json":
        opts.json = true;
        break;
      case "--enabled-only":
        opts.enabledOnly = true;
        break;
      case "--full":
        opts.full = true;
        break;
      case "--source": {
        const v = next();
        if (!valid.has(v)) {
          console.error(`오류: --source 는 project|personal|plugin 중 하나여야 합니다 (받은 값: ${v})`);
          process.exit(2);
        }
        opts.sources.push(v);
        break;
      }
      case "--project":
        opts.project = next();
        break;
      case "--claude-home":
        opts.claudeHome = next();
        break;
      case "--cache":
        opts.cache = next();
        break;
      default:
        if (arg.startsWith("-")) {
          console.error(`오류: 알 수 없는 옵션 ${arg}\n\n${USAGE}`);
          process.exit(2);
        }
        if (opts.query === null) opts.query = arg;
        break;
    }
  }
  return opts;
}

function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const projectDir = path.resolve(expandHome(opts.project));
  const claudeHome = path.resolve(expandHome(opts.claudeHome));

  const index = loadPluginIndex(claudeHome);
  const enabled = loadEnabledPlugins(claudeHome, projectDir);

  let entries = [
    ...scanFlatDir(path.join(projectDir, ".claude", "skills"), "project"),
    ...scanFlatDir(path.join(claudeHome, "skills"), "personal"),
    ...scanPluginCache(claudeHome, index, enabled),
  ];

  if (opts.enabledOnly) {
    entries = entries.filter((e) => !e.plugin || e.plugin.enabled);
  }
  if (opts.sources.length) {
    const allowed = new Set(opts.sources);
    entries = entries.filter((e) => allowed.has(e.source));
  }
  if (opts.query) {
    const needle = opts.query.toLowerCase();
    entries = entries.filter(
      (e) => e.name.toLowerCase().includes(needle) || e.description.toLowerCase().includes(needle),
    );
  }

  for (const e of entries) {
    e.removal = removalHint(e.source, e.plugin, e.path);
  }

  const translations = loadTranslations(opts.cache ? path.resolve(expandHome(opts.cache)) : null);

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        { project_dir: projectDir, claude_home: claudeHome, count: entries.length, skills: entries },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(renderMarkdown(entries, translations, projectDir, claudeHome, opts.full));
  }
}

main();
