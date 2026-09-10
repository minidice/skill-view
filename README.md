# skill-view

*[한국어 문서](README.ko.md)*

Scans every skill you can call in Claude Code and builds a browsable **HTML catalog** —
what each one does, **how to actually use it**, and where it came from.

Install skills from a few places and it gets hazy fast: what's actually here, and what do I
type to use it? A name and a one-line description don't answer the second question. Plugin
skills can't be removed individually, and nothing tells you that either. Every run rescans,
so the catalog is never stale.

## What's on a card

One card per skill.

- **The command** — with its `argument-hint`, exactly as you'd type it
- **2–4 usage examples** — `"pull just the tables out of this PDF"` → *reads the tables and
  returns them as text or a table*. Skills you never invoke directly (design guides and the
  like) say so instead of pretending otherwise
- **Install · Remove · Path** — both directions, equal weight. This is a catalog, not a
  cleanup tool, so removal doesn't lead
- The page carries its own **search box and source filters**, so dozens of skills stay workable

Four sources are covered:

| Source | Where it looks |
|---|---|
| Personal | `~/.claude/skills/` |
| Project | `<project>/.claude/skills/` |
| Plugin | `~/.claude/plugins/cache/` — traced back to `plugin@marketplace` for the exact command |
| Anthropic built-in | Not on disk. Supplied by the caller (see below) |

**Disabled plugins** get a badge — start there when a skill isn't showing up. **Duplicate
names** are flagged too: if the same skill sits in both a personal install and a plugin,
removing one leaves the other.

## Install

```bash
git clone https://github.com/minidice/skill-view.git ~/.claude/skills/skill-view
```

Windows PowerShell:

```powershell
git clone https://github.com/minidice/skill-view.git "$env:USERPROFILE\.claude\skills\skill-view"
```

Restart Claude Code and `/skill-view` picks it up. To scope it to one project, put it in
`<project>/.claude/skills/` instead of `~/.claude/skills/`.

## Use

Inside Claude Code:

```
/skill-view                            everything
/skill-view pdf                        only skills whose name, description or examples mention pdf
/skill-view --source personal          only what you installed yourself
/skill-view --source builtin docx      combine a query with a source
```

Claude scans, builds the HTML, publishes it as an Artifact and hands you the link. To narrow
a page that's already open, the search box on the page beats re-running the command.

You can also drive the script directly:

```bash
node scripts/scan-skills.mjs --html out.html    # HTML catalog
node scripts/scan-skills.mjs                    # markdown table
node scripts/scan-skills.mjs --json             # raw data
node scripts/scan-skills.mjs --help
```

**Node 18+, no dependencies.** Standard library only.

## Language

UI labels ship in English and Korean; `--lang ko|en` picks one, defaulting to the system
locale. Claude passes the language you're actually writing in, which is not always the same
thing — an English Windows install doesn't mean you want an English page.

`--lang` covers **labels only** (`Install`, `How to use it`, source names). Skill descriptions
and examples are written by the caller, in the caller's language. To add a language, drop an
entry into `STRINGS` at the top of `scripts/scan-skills.mjs`; every label goes through it.

## Built-in skills and usage examples

Built-ins like `docx`, `code-review` and `design` have **no `SKILL.md` on disk** — the session
carries them, so a file scan can't see them. Usage examples aren't in frontmatter either.

Both arrive through one JSON file:

```bash
node scripts/scan-skills.mjs --html out.html --bundled bundled.json
```

```json
[
  {
    "name": "docx",
    "namespace": "anthropic-skills",
    "description": "Creates, reads and edits Word documents (.docx, .dotx).",
    "examples": [
      { "say": "turn this into a Word report", "does": "a .docx with a table of contents and styling" },
      { "say": "read report.docx and summarize it", "does": "pulls the text and tables out" }
    ]
  }
]
```

- If a skill of that name **is already installed on disk**, no second card is created — the
  `examples` are merged onto the existing one. That's how installed skills get examples too.
- `namespace` is only for skills whose command takes a prefix (`/anthropic-skills:docx`).
- Example text is searchable, so a skill can be found by a word that appears nowhere in its
  description.

The list isn't hardcoded because it would go stale every time Anthropic adds or drops a skill.
`SKILL.md` tells Claude to read the current session list and write it fresh each time.

## Description translation

Descriptions on installed skills are usually English and often long. The script prints them
**verbatim** and Claude summarizes when it reads the output. No translation dictionary is
baked in — a new skill would be missing from it immediately, which defeats the point of
rescanning.

If repeated runs cost more tokens than you'd like, `--cache <path>` takes a translation cache:
`{ "<first 16 chars of the description's sha256>": "translated text" }`. Change the source
description and the key no longer matches, so the cache invalidates itself.

## How it works

Reads only the frontmatter block at the top of each `SKILL.md`, then stops. No YAML parser, so
zero dependencies, and ~100 skills finish well under a second. No network calls.

**Skill directories are read-only to this tool.** The one file it writes is the `--html`
output, and it deletes nothing.

The generated HTML is self-contained: fonts come from Google Fonts, everything else lives in
the file. Open it in a browser or publish it as an Artifact. Light and dark themes both work.

Plugin metadata comes from:

- `~/.claude/plugins/installed_plugins.json` — install path → `plugin@marketplace`
- `enabledPlugins` in `~/.claude/settings.json` — enabled/disabled, project settings winning

## License

MIT
