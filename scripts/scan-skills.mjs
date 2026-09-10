#!/usr/bin/env node
/**
 * 로컬에 설치된 Claude Code 스킬을 스캔한다.
 *
 * SKILL.md의 frontmatter만 읽으므로 네트워크 호출이 없고 빠르다.
 * 외부 의존성 없이 Node 표준 모듈만 사용한다.
 *
 * 사용법:
 *   node scan-skills.mjs --html out.html    # HTML 카탈로그 (기본 형식)
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

/**
 * Anthropic 기본/번들 스킬 목록을 JSON 파일에서 읽는다.
 *
 * 이 스킬들은 디스크에 SKILL.md로 설치돼 있지 않아 스캔이 불가능하다.
 * 대신 세션에 떠 있는 목록을 호출자가 적어서 넘긴다. 하드코딩해 두면
 * Anthropic이 스킬을 추가할 때마다 낡으므로 데이터를 안 들고 있는다.
 *
 * 형식: [{ "name": "docx", "description": "...", "namespace": "anthropic-skills" }]
 */
/** 카드에 붙일 사용 예시. 형식이 어긋난 항목은 조용히 버린다. */
function parseExamples(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((ex) => ({ say: String(ex?.say ?? "").trim(), does: String(ex?.does ?? "").trim() }))
    .filter((ex) => ex.say)
    .slice(0, 4);
}

function loadBundled(cachePath, installedNames) {
  const empty = { entries: [], annotations: new Map() };
  if (!cachePath) return empty;
  const payload = readJson(cachePath);
  const list = Array.isArray(payload) ? payload : payload?.skills;
  if (!Array.isArray(list)) return empty;

  const entries = [];
  const annotations = new Map();
  const seen = new Set();

  for (const item of list) {
    const name = String(item?.name ?? "").trim();
    if (!name) continue;
    const examples = parseExamples(item.examples);

    // 디스크에 같은 이름이 있으면 그쪽이 실제 설치본이다. 카드를 새로 만들지 않고
    // 예시만 얹는다 — 목록에 같은 스킬이 두 번 나오면 안 되기 때문이다.
    if (installedNames.has(name)) {
      if (examples.length) annotations.set(name, examples);
      continue;
    }

    const ns = String(item.namespace ?? "").trim();
    // 네임스페이스가 다르면 이름이 같아도 다른 스킬이므로 커맨드 기준으로 구분한다.
    const key = ns ? `${ns}:${name}` : name;
    if (seen.has(key)) continue;
    seen.add(key);

    entries.push({
      name,
      description: String(item.description ?? "").trim(),
      argument_hint: "",
      command: ns ? `/${ns}:${name}` : `/${name}`,
      source: "builtin",
      path: "",
      plugin: null,
      namespace: ns || null,
      examples,
    });
  }

  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { entries, annotations };
}

function removalHint(source, plugin, dir) {
  if (source === "plugin" && plugin) return `claude plugin uninstall ${plugin.ref}`;
  return `디렉터리 삭제: ${dir}`;
}

/**
 * 이미 설치된 스킬이라도 "어디에 무엇을 두면 설치되는가"를 같이 보여준다.
 * 다른 PC로 옮기거나 프로젝트↔개인 위치를 바꿀 때 쓰는 정보다.
 */
function installHint(source, plugin, dir) {
  if (source === "plugin" && plugin) {
    return `claude plugin install ${plugin.ref}${plugin.enabled ? "" : ` → claude plugin enable ${plugin.ref}`}`;
  }
  return `SKILL.md가 든 폴더를 ${path.dirname(dir)} 아래에 두면 설치됩니다`;
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
      const root = source === "project" ? path.join(projectDir, ".claude", "skills") : path.join(claudeHome, "skills");
      out.push(`> 설치: \`${root}\` 아래에 SKILL.md가 든 폴더를 둡니다. · 삭제: 그 폴더를 지웁니다.`, "");
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
        `> 설치: \`claude plugin install ${ref}\` · 삭제: \`claude plugin uninstall ${ref}\` ` +
          `(개별 스킬만 지울 수는 없고 아래 ${group.length}개가 함께 움직입니다)`,
        "",
      );
      out.push(...renderTable(group, translations, full));
      out.push("");
    }
  }

  const builtins = entries.filter((e) => e.source === "builtin");
  out.push(`## Anthropic 기본 — ${builtins.length}개`, "");
  if (builtins.length === 0) {
    out.push("_없음_", "");
  } else {
    out.push("> 세션에 기본 제공되는 스킬입니다. 디스크에 파일로 없어 설치·삭제 대상이 아닙니다.", "");
    out.push(...renderTable(builtins, translations, full));
    out.push("");
  }

  const dupes = [...byName.entries()].filter(([, g]) => g.filter((e) => e.source !== "builtin").length > 1);
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
// HTML 카탈로그
// ---------------------------------------------------------------------------

const SOURCE_LABEL = { project: "프로젝트", personal: "개인", plugin: "플러그인", builtin: "Anthropic 기본" };

function esc(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * 카드 하나. 설치와 삭제를 같은 무게로 아래쪽에 조용히 붙인다.
 *
 * 이 스킬의 목적은 "무엇이 깔려 있는지 보기"이지 정리가 아니므로
 * 삭제 명령을 카드 본문이나 섹션 머리말로 올리지 않는다.
 */
function skillCard(entry, translations) {
  const desc = translations.get(descKey(entry.description)) ?? entry.description;
  const haystack = [
    entry.name,
    entry.command,
    desc,
    entry.plugin ? entry.plugin.ref : "",
    ...(entry.examples ?? []).map((ex) => `${ex.say} ${ex.does}`),
  ]
    .join(" ")
    .toLowerCase();

  const badges = [`<span class="badge src-${entry.source}">${SOURCE_LABEL[entry.source]}</span>`];
  if (entry.plugin) {
    badges.push(`<span class="badge plain">${esc(entry.plugin.ref)}</span>`);
    if (!entry.plugin.enabled) badges.push('<span class="badge warn">비활성</span>');
  }

  // 설명만으로는 "그래서 뭐라고 치라는 거냐"가 안 풀린다. 실제 문장과 그 결과를 붙인다.
  const examples = entry.examples ?? [];
  const uses = examples.length
    ? [
        '  <div class="uses">',
        '    <p class="uses-label">이렇게 쓰면</p>',
        `    <ul>${examples
          .map(
            (ex) =>
              `<li><span class="say">${esc(ex.say)}</span>` +
              (ex.does ? `<span class="does">${esc(ex.does)}</span>` : "") +
              "</li>",
          )
          .join("")}</ul>`,
        "  </div>",
      ]
    : [];

  // 기본 스킬은 설치한 적이 없으니 설치·삭제 줄을 붙이지 않는다.
  const howto =
    entry.source === "builtin"
      ? ['  <p class="bundled-note">Claude Code에 기본 제공 — 따로 설치하거나 지울 수 없습니다.</p>']
      : [
          '  <dl class="howto">',
          `    <dt>설치</dt><dd>${esc(entry.install)}</dd>`,
          `    <dt>삭제</dt><dd>${esc(entry.removal)}</dd>`,
          `    <dt>위치</dt><dd class="path">${esc(entry.path)}</dd>`,
          "  </dl>",
        ];

  return [
    `<article class="card" data-source="${entry.source}" data-search="${esc(haystack)}">`,
    '  <div class="card-head">',
    `    <h3>${esc(entry.name)}</h3>`,
    `    <div class="badges">${badges.join("")}</div>`,
    "  </div>",
    `  <p class="cmd"><code>${esc(entry.command)}</code></p>`,
    `  <p class="desc">${esc(desc) || "<span class=\"none\">설명 없음</span>"}</p>`,
    ...uses,
    ...howto,
    "</article>",
  ].join("\n");
}

function renderHtml(entries, translations, projectDir, claudeHome) {
  const counts = {
    project: entries.filter((e) => e.source === "project").length,
    personal: entries.filter((e) => e.source === "personal").length,
    plugin: entries.filter((e) => e.source === "plugin").length,
    builtin: entries.filter((e) => e.source === "builtin").length,
  };
  const installed = entries.length - counts.builtin;

  const byName = new Map();
  for (const e of entries) {
    if (!byName.has(e.name)) byName.set(e.name, []);
    byName.get(e.name).push(e);
  }
  // 기본 스킬은 네임스페이스가 다르면 이름이 겹쳐도 별개다 (/schedule vs /anthropic-skills:schedule).
  // 여기서 경고할 중복은 "지워도 다른 쪽이 남는" 설치본끼리의 충돌뿐이다.
  const dupes = [...byName.entries()].filter(([, g]) => g.filter((e) => e.source !== "builtin").length > 1);

  const sections = [];

  for (const [source, root] of [
    ["personal", path.join(claudeHome, "skills")],
    ["project", path.join(projectDir, ".claude", "skills")],
  ]) {
    const group = entries.filter((e) => e.source === source);
    sections.push(
      `<section class="group" data-source="${source}">`,
      `  <div class="group-head"><h2>${SOURCE_LABEL[source]}</h2><span class="count">${group.length}</span>` +
        `<code class="root">${esc(root)}</code></div>`,
      group.length
        ? `  <div class="grid">${group
            .sort((a, b) => (a.name < b.name ? -1 : 1))
            .map((e) => skillCard(e, translations))
            .join("\n")}</div>`
        : '  <p class="empty">이 위치에는 설치된 스킬이 없습니다.</p>',
      "</section>",
    );
  }

  const plugins = entries.filter((e) => e.source === "plugin");
  const grouped = new Map();
  for (const e of plugins) {
    if (!grouped.has(e.plugin.ref)) grouped.set(e.plugin.ref, []);
    grouped.get(e.plugin.ref).push(e);
  }

  sections.push(
    '<section class="group" data-source="plugin">',
    `  <div class="group-head"><h2>플러그인</h2><span class="count">${plugins.length}</span>` +
      `<code class="root">${esc(path.join(claudeHome, "plugins", "cache"))}</code></div>`,
  );
  if (!plugins.length) {
    sections.push('  <p class="empty">설치된 플러그인 스킬이 없습니다.</p>');
  } else {
    for (const ref of [...grouped.keys()].sort()) {
      const group = grouped.get(ref);
      const plugin = group[0].plugin;
      const notes = [`v${plugin.version}`, `스킬 ${group.length}개`];
      if (!plugin.registered) notes.push("설치 목록에 없음");
      if (!plugin.enabled) notes.push("비활성 — 지금은 호출되지 않습니다");
      sections.push(
        '  <div class="plugin-head">',
        `    <h3>${esc(ref)}</h3><span class="note">${esc(notes.join(" · "))}</span>`,
        `    <p class="bundle">이 플러그인의 스킬은 개별로 설치·삭제되지 않고 ${group.length}개가 함께 움직입니다.</p>`,
        "  </div>",
        `  <div class="grid">${group
          .sort((a, b) => (a.name < b.name ? -1 : 1))
          .map((e) => skillCard(e, translations))
          .join("\n")}</div>`,
      );
    }
  }
  sections.push("</section>");

  const builtins = entries.filter((e) => e.source === "builtin");
  if (builtins.length) {
    const namespaces = [...new Set(builtins.map((e) => e.namespace).filter(Boolean))].sort();
    sections.push(
      '<section class="group" data-source="builtin">',
      `  <div class="group-head"><h2>Anthropic 기본</h2><span class="count">${builtins.length}</span>` +
        '<span class="root">설치 위치 없음 — 세션에 기본 제공</span></div>',
      '  <p class="group-note">Claude Code가 들고 있는 스킬이라 디스크에 파일로 없고, 설치·삭제 대상도 아닙니다. ' +
        `커맨드만 알아 두면 바로 부를 수 있습니다.${
          namespaces.length ? ` <code>${esc(namespaces.join(", "))}</code> 네임스페이스는 커맨드에 접두사가 붙습니다.` : ""
        }</p>`,
      `  <div class="grid">${builtins.map((e) => skillCard(e, translations)).join("\n")}</div>`,
      "</section>",
    );
  }

  if (dupes.length) {
    const rows = dupes
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([name, group]) => {
        const origins = group.map((e) => (e.plugin ? e.plugin.ref : SOURCE_LABEL[e.source])).sort();
        return `<li><strong>${esc(name)}</strong><span>${esc(origins.join(" ↔ "))}</span></li>`;
      });
    sections.push(
      '<section class="dupes">',
      `  <h2>이름이 겹치는 스킬 ${dupes.length}종</h2>`,
      "  <p>같은 이름이 여러 곳에 설치돼 있습니다. 한쪽을 지워도 다른 쪽은 그대로 남습니다.</p>",
      `  <ul>${rows.join("")}</ul>`,
      "</section>",
    );
  }

  const scannedAt = new Date().toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });

  const css = `
:root {
  --ground: #f6f7f9;
  --surface: #ffffff;
  --ink: #171b21;
  --muted: #5d6774;
  --faint: #8b95a3;
  --line: #e1e6ec;
  --line-strong: #cbd3dd;
  --accent: #2f5d7c;
  --personal: #2f5d7c;
  --project: #3d7355;
  --plugin: #8a5b2c;
  --builtin: #6b6480;
  --warn-ink: #8a5b2c;
  --warn-bg: #f6ecdd;
  --radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground: #13161a;
    --surface: #1b1f25;
    --ink: #e7eaef;
    --muted: #9aa4b1;
    --faint: #77828f;
    --line: #2a3037;
    --line-strong: #3a424c;
    --accent: #8ab6d6;
    --personal: #8ab6d6;
    --project: #86bfa0;
    --plugin: #d5a978;
    --builtin: #a9a2c0;
    --warn-ink: #e0b483;
    --warn-bg: #33291d;
  }
}
:root[data-theme="dark"] {
  --ground: #13161a;
  --surface: #1b1f25;
  --ink: #e7eaef;
  --muted: #9aa4b1;
  --faint: #77828f;
  --line: #2a3037;
  --line-strong: #3a424c;
  --accent: #8ab6d6;
  --personal: #8ab6d6;
  --project: #86bfa0;
  --plugin: #d5a978;
  --builtin: #a9a2c0;
  --warn-ink: #e0b483;
  --warn-bg: #33291d;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: "IBM Plex Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif;
  font-size: 15px;
  line-height: 1.65;
}
code, .mono { font-family: "IBM Plex Mono", ui-monospace, "Cascadia Mono", Consolas, monospace; }

.wrap { max-width: 1080px; margin: 0 auto; padding: 40px 24px 72px; display: flex; flex-direction: column; gap: 28px; }

header.top { display: flex; flex-direction: column; gap: 10px; }
header.top h1 { margin: 0; font-size: 27px; font-weight: 600; letter-spacing: -0.015em; text-wrap: balance; }
header.top .lede { margin: 0; color: var(--muted); max-width: 62ch; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 12.5px; color: var(--faint); font-family: "IBM Plex Mono", monospace; }

.tally { display: flex; flex-wrap: wrap; gap: 10px; }
.tally b {
  display: inline-flex; align-items: baseline; gap: 7px;
  border: 1px solid var(--line); border-radius: 999px; background: var(--surface);
  padding: 4px 13px; font-weight: 500; font-size: 13px; color: var(--muted);
}
.tally b span { font-family: "IBM Plex Mono", monospace; font-variant-numeric: tabular-nums; color: var(--ink); font-weight: 600; }

.controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; position: sticky; top: 0; z-index: 5;
  background: var(--ground); padding: 10px 0; border-bottom: 1px solid var(--line); }
#q {
  flex: 1 1 240px; min-width: 180px; padding: 9px 13px; border-radius: var(--radius);
  border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink);
  font: inherit; font-size: 14px;
}
#q::placeholder { color: var(--faint); }
#q:focus-visible, .chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.chip {
  border: 1px solid var(--line-strong); background: var(--surface); color: var(--muted);
  border-radius: 999px; padding: 7px 14px; font: inherit; font-size: 13px; cursor: pointer;
}
.chip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--surface); }

.group { display: flex; flex-direction: column; gap: 14px; }
.group-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; padding-bottom: 8px; border-bottom: 2px solid var(--line-strong); }
.group-head h2 { margin: 0; font-size: 17px; font-weight: 600; }
.count { font-family: "IBM Plex Mono", monospace; font-variant-numeric: tabular-nums; color: var(--muted); font-size: 13px; }
.root { margin-left: auto; font-size: 12px; color: var(--faint); overflow-wrap: anywhere; }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
.card {
  display: flex; flex-direction: column; gap: 9px;
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 17px;
}
.card-head { display: flex; align-items: baseline; gap: 9px; flex-wrap: wrap; }
.card-head h3 { margin: 0; font-size: 16px; font-weight: 600; font-family: "IBM Plex Mono", monospace; }
.badges { display: flex; gap: 5px; flex-wrap: wrap; margin-left: auto; }
.badge { font-size: 11px; letter-spacing: 0.04em; padding: 2px 8px; border-radius: 4px; border: 1px solid currentColor; white-space: nowrap; }
.src-personal { color: var(--personal); }
.src-project { color: var(--project); }
.src-plugin { color: var(--plugin); }
.src-builtin { color: var(--builtin); }
.badge.plain { color: var(--faint); font-family: "IBM Plex Mono", monospace; }
.badge.warn { color: var(--warn-ink); background: var(--warn-bg); border-color: transparent; }

.cmd { margin: 0; }
.cmd code { font-size: 12.5px; color: var(--accent); overflow-wrap: anywhere; }
.desc { margin: 0; color: var(--muted); font-size: 13.5px; line-height: 1.6; }
.none { color: var(--faint); font-style: italic; }

.uses { margin-top: 2px; }
.uses-label {
  margin: 0 0 6px; font-family: "IBM Plex Mono", monospace; font-size: 10.5px;
  letter-spacing: 0.09em; text-transform: uppercase; color: var(--faint);
}
.uses ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 7px; }
.uses li { display: flex; flex-direction: column; gap: 1px; border-left: 2px solid var(--line-strong); padding-left: 9px; }
.uses .say { font-size: 12.5px; color: var(--ink); }
.uses .does { font-size: 11.5px; color: var(--faint); line-height: 1.5; }

.howto {
  margin: 4px 0 0; padding-top: 11px; border-top: 1px dashed var(--line);
  display: grid; grid-template-columns: auto 1fr; gap: 3px 12px;
  font-size: 12px; color: var(--faint);
}
.howto dt { font-family: "IBM Plex Mono", monospace; letter-spacing: 0.05em; }
.howto dd { margin: 0; overflow-wrap: anywhere; }
.howto dd.path { font-family: "IBM Plex Mono", monospace; font-size: 11.5px; }

.plugin-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; }
.plugin-head h3 { margin: 0; font-size: 15px; font-family: "IBM Plex Mono", monospace; font-weight: 600; }
.plugin-head .note { font-size: 12.5px; color: var(--faint); }
.plugin-head .bundle { flex-basis: 100%; margin: 0; font-size: 12.5px; color: var(--muted); }

.empty { margin: 0; color: var(--faint); font-size: 13.5px; }
.group-note { margin: 0; color: var(--muted); font-size: 13px; max-width: 74ch; }
.group-note code { font-size: 12px; color: var(--builtin); }
.bundled-note {
  margin: 4px 0 0; padding-top: 11px; border-top: 1px dashed var(--line);
  font-size: 12px; color: var(--faint);
}

.dupes { border: 1px solid var(--line-strong); border-radius: var(--radius); padding: 18px 20px; background: var(--surface); }
.dupes h2 { margin: 0 0 6px; font-size: 16px; }
.dupes p { margin: 0 0 12px; color: var(--muted); font-size: 13.5px; }
.dupes ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
.dupes li { display: flex; gap: 12px; flex-wrap: wrap; font-size: 13.5px; font-family: "IBM Plex Mono", monospace; }
.dupes li span { color: var(--faint); }

#noresult { display: none; color: var(--muted); }
body.filtered #noresult.on { display: block; }

@media (max-width: 620px) {
  .wrap { padding: 28px 16px 56px; }
  .root { margin-left: 0; flex-basis: 100%; }
  .badges { margin-left: 0; }
}
`.trim();

  const js = `
(function () {
  var q = document.getElementById('q');
  var chips = Array.prototype.slice.call(document.querySelectorAll('.chip'));
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  var groups = Array.prototype.slice.call(document.querySelectorAll('.group'));
  var none = document.getElementById('noresult');

  function active() {
    var on = chips.filter(function (c) { return c.getAttribute('aria-pressed') === 'true'; });
    return on.map(function (c) { return c.dataset.filter; });
  }

  function apply() {
    var needle = q.value.trim().toLowerCase();
    var sources = active();
    var shown = 0;
    cards.forEach(function (card) {
      var ok = (sources.length === 0 || sources.indexOf(card.dataset.source) !== -1) &&
        (needle === '' || card.dataset.search.indexOf(needle) !== -1);
      card.hidden = !ok;
      if (ok) shown++;
    });
    groups.forEach(function (g) {
      var any = g.querySelector('.card:not([hidden])');
      var filtering = needle !== '' || sources.length > 0;
      g.hidden = filtering && !any;
    });
    none.className = shown === 0 ? 'on' : '';
    document.body.classList.toggle('filtered', true);
  }

  q.addEventListener('input', apply);
  chips.forEach(function (c) {
    c.addEventListener('click', function () {
      c.setAttribute('aria-pressed', c.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
      apply();
    });
  });
})();
`.trim();

  return `<title>Claude Code 스킬 카탈로그</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans+KR:wght@400;500;600&display=swap">
<style>
${css}
</style>

<div class="wrap">
  <header class="top">
    <h1>스킬 카탈로그</h1>
    <p class="lede">지금 이 세션에서 부를 수 있는 스킬 ${entries.length}개입니다. 각 카드에 무엇을 하는 스킬인지와 호출 커맨드가 적혀 있고, 직접 설치한 스킬에는 설치·삭제 방법이 함께 붙어 있습니다.</p>
    <div class="tally">
      <b>전체 <span>${entries.length}</span></b>
      <b>직접 설치 <span>${installed}</span></b>
      <b>개인 <span>${counts.personal}</span></b>
      <b>프로젝트 <span>${counts.project}</span></b>
      <b>플러그인 <span>${counts.plugin}</span></b>
      <b>Anthropic 기본 <span>${counts.builtin}</span></b>
    </div>
    <div class="meta">
      <span>스캔 ${esc(scannedAt)}</span>
      <span>프로젝트 ${esc(projectDir)}</span>
      <span>Claude 홈 ${esc(claudeHome)}</span>
    </div>
  </header>

  <div class="controls">
    <input id="q" type="search" placeholder="이름·설명·커맨드 검색" aria-label="스킬 검색">
    <button class="chip" type="button" data-filter="personal" aria-pressed="false">개인</button>
    <button class="chip" type="button" data-filter="project" aria-pressed="false">프로젝트</button>
    <button class="chip" type="button" data-filter="plugin" aria-pressed="false">플러그인</button>
    <button class="chip" type="button" data-filter="builtin" aria-pressed="false">Anthropic 기본</button>
  </div>
  <p id="noresult">조건에 맞는 스킬이 없습니다.</p>

${sections.join("\n")}
</div>

<script>
${js}
</script>
`;
}

// ---------------------------------------------------------------------------

const USAGE = `사용법: node scan-skills.mjs [검색어] [옵션]

로컬 Claude Code 스킬 스캐너

  검색어                      이름/설명 검색 (대소문자 무시)
  --source <출처>             project|personal|plugin|builtin. 여러 번 지정 가능
  --bundled <경로>            Anthropic 기본 스킬 목록 JSON
                              [{ "name", "description", "namespace" }]
  --enabled-only              비활성 플러그인의 스킬은 제외
  --full                      마크다운에서 설명을 자르지 않음
  --html <경로>               HTML 카탈로그를 그 경로에 쓴다 (기본 출력 형식)
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
    html: null,
    bundled: null,
  };
  const valid = new Set(["project", "personal", "plugin", "builtin"]);

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
          console.error(`오류: --source 는 project|personal|plugin|builtin 중 하나여야 합니다 (받은 값: ${v})`);
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
      case "--html":
        opts.html = next();
        break;
      case "--bundled":
        opts.bundled = next();
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

  const bundled = loadBundled(
    opts.bundled ? path.resolve(expandHome(opts.bundled)) : null,
    new Set(entries.map((e) => e.name)),
  );
  for (const e of entries) {
    e.examples = bundled.annotations.get(e.name) ?? [];
  }
  entries.push(...bundled.entries);

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
    if (e.source === "builtin") continue;
    e.install = installHint(e.source, e.plugin, e.path);
    e.removal = removalHint(e.source, e.plugin, e.path);
  }

  const translations = loadTranslations(opts.cache ? path.resolve(expandHome(opts.cache)) : null);

  if (opts.html) {
    const target = path.resolve(expandHome(opts.html));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, renderHtml(entries, translations, projectDir, claudeHome), "utf8");
    process.stdout.write(`HTML 카탈로그 ${entries.length}개 항목 → ${target}\n`);
  } else if (opts.json) {
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
