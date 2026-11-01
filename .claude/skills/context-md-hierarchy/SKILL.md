---
name: context-md-hierarchy
description: Map a codebase into areas and write layered CLAUDE.md files (root, per-area, path-scoped rules), then lock the structure in so teammates keep following it. Use when asked to add or refresh CLAUDE.md files, or when a session-start notice says the repo has no CLAUDE.md hierarchy.
---

# CLAUDE.md hierarchy builder

Goal: give every area of the codebase the right context at the right scope, so Claude only pays for detail when it is working where that detail matters — and make sure the structure survives new teammates and new areas.

## The layers (broadest to narrowest)

| File | Loads when | Holds | Never holds |
|---|---|---|---|
| `/CLAUDE.md` (root) | Every session | System overview, area map, shared commands (install/build/test/lint), org-wide standards, "do not touch" zones, the hierarchy maintenance rule | Area-specific patterns, API/DB rules, UI conventions |
| `<area>/CLAUDE.md` | Claude works inside that folder | Area purpose, stack, local commands, patterns to follow, gotchas, owners | Anything already in root; anything that applies only to a file type |
| `.claude/rules/<topic>.md` with `paths:` | A file matching its globs is opened | Cross-cutting rules tied to specific files (money handling, route handlers, migrations, components, motion) | General area overview |
| `CLAUDE.local.md` | Every session, gitignored | Personal notes (local URLs, test accounts, preferences) | Team standards |
| `~/.claude/CLAUDE.md` | Every project | The user's personal defaults | **Do not create or edit this file** |

Rule of thumb: if a line would be wasted on most turns at a level, push it one level down. Project-specific style (e.g. this project's motion design) stays in this project's files; it never goes into the skill or the user's global file.

## Workflow

### 1. Survey (read-only)
- List the tree to depth 3, ignoring `node_modules`, `dist`, `build`, `.git`, `vendor`, `.venv`, generated code.
- Find manifests and configs: `package.json`, workspaces, `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Makefile`, `Dockerfile`, CI files, lint/format configs, `CODEOWNERS`, READMEs.
- Find existing `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/`, `.claude/skills/`, `AGENTS.md`, `.cursorrules`. Existing content is the starting point, not something to overwrite.
- Skim recent `git log` for the active areas and naming conventions.

### 2. Define areas
An area deserves its own `CLAUDE.md` when at least one is true:
- It has its own manifest or build/test command (app, service, package).
- It uses a different stack or conventions from its siblings.
- It has a distinct owner in `CODEOWNERS`.
- It contains rules that would be harmful if applied elsewhere (DB access, auth, payments, firmware, infra).

Do **not** create one for thin folders (`utils/`, `types/`, a single component dir). Cross-cutting concerns that follow file types rather than folders become `.claude/rules/` files instead. Always check whether the project has a distinct design/motion/animation area or convention and document it if so.

Present the proposed map to the user before writing anything:
```
CLAUDE.md                         (root)
apps/web/CLAUDE.md                (Next.js app)
services/api/CLAUDE.md            (API + DB)
.claude/rules/migrations.md       paths: services/api/migrations/**
.claude/rules/motion.md           paths: apps/web/src/animations/**
```
If the user is away, proceed with the map and list it at the top of the final report.

### 3. Gather evidence per area
Read 3–6 representative files per area (an entry point, a typical module, a test, a config). Derive conventions from what the code actually does: error handling, data access, validation, state management, naming, test style, logging, animation timing/easing.
- Every command written must exist (check scripts/Makefile targets).
- Never invent a convention. If something is unclear or inconsistent, write `<!-- TODO(owner): ... -->` and list it in the report.
- Prefer pointers over copies: `See src/lib/money.ts for the Money type` beats pasting the code.

### 4. Write the files
Keep them short. Budgets: root ≤ ~150 lines, area ≤ ~80 lines, rule ≤ ~40 lines. Imperative, specific, checkable statements ("Use `Money` for all amounts; never `number`"), not essays.

**Root template**
```markdown
# <Project>

## What this is
<2–4 sentences: product, architecture shape>

## Map
- `apps/web` — <one line> (has its own CLAUDE.md)
- `services/api` — <one line> (has its own CLAUDE.md)

## Commands
- Install: `...`
- Test all: `...`
- Lint/format: `...`

## Standards (everywhere)
- <commit/PR conventions, language/version, typing, logging>

## Do not touch
- <generated code, vendored libs, prod config, migrations already shipped>

## Keeping this context accurate
- When you create a new app, service or package, or a folder with its own conventions, add its CLAUDE.md (or a `.claude/rules/` file) using the `context-md-hierarchy` skill in `.claude/skills/`. Do not write it freehand.
- When you change a command, path or convention described in a CLAUDE.md, update that file in the same change.
- Never repeat a parent file's content in a child file.
```

**Area template**
```markdown
# <area name>

<What this area does and how it fits the system — 2 sentences.>

## Stack
<framework, key libs, versions that matter>

## Commands (run from this folder)
- Dev: `...`  Test: `...`

## How we do things here
- <pattern> — see `<path/to/example>`

## Gotchas
- <non-obvious traps>

## Owners
<team or CODEOWNERS entry>
```

**Rule template** (`.claude/rules/<topic>.md`)
```markdown
---
paths:
  - "services/api/src/payments/**"
  - "**/*money*.ts"
---

# <Topic> rules
- <rule>
- <rule> — example: `<path>`
```

**Personal file**: create `CLAUDE.local.md` only if the user asks.

### 5. De-duplicate
Walk from root down. Any line that appears at a parent level is deleted from the child. Any line in root that only matters to one area moves down to that area. Anything in an area file that only matters to certain file types moves to a rule.

### 6. Existing files
If a file already exists, merge: keep the team's wording, add what is missing, flag contradictions with code as TODOs. Show a diff rather than overwriting. Never delete existing content without asking.

### 7. Lock the structure in (first run in a repo, and verify on every run)
This is what keeps the hierarchy from drifting when teammates add new areas. Do each step only if it is not already in place; never duplicate entries.

1. **Commit this skill into the repo.** Copy this SKILL.md, unchanged, to `.claude/skills/context-md-hierarchy/SKILL.md`. Anyone who clones the repo then has the same method available. This file is also the marker the session-start check looks for. If a copy already exists and differs, show the diff and ask which to keep.
2. **Add the maintenance rule to root.** Ensure the root CLAUDE.md contains the "Keeping this context accurate" section from the root template.
3. **Protect the context files in review.** In `CODEOWNERS` (create `.github/CODEOWNERS` if none exists and the repo is on GitHub; otherwise use the existing location), add:
   ```
   # Context files for Claude
   CLAUDE.md          @<owner>
   **/CLAUDE.md       @<owner>
   /.claude/          @<owner>
   ```
   Ask the user for `<owner>` (their GitHub handle or team). If they are not available, leave `@OWNER-TODO` and list it in the report. Do not add `CLAUDE.local.md`.
4. **Gitignore personal files.** Ensure `CLAUDE.local.md` and `**/CLAUDE.local.md` are in `.gitignore`.
5. **Optional CI check** — offer it, add it only if the user agrees: a small script (`scripts/check-claude-md.sh`) that lists every folder containing a package manifest (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`) outside ignored dirs and fails if any lacks a `CLAUDE.md`, plus a CI step that runs it. Respect an allowlist file `.claude/claude-md-ignore` for folders that intentionally have none.

Do not commit or push; leave the changes as working-tree changes for the user to review in a PR.

### 8. Verify and report
- Re-check every command and every referenced path exists.
- Check rule globs actually match files (`git ls-files` against the patterns).
- Confirm step 7 items are present.
- Report: the final tree of context files (like the map above), one line per file on what it covers, what was added for lock-in (skill copy, root rule, CODEOWNERS, gitignore, CI), the TODOs for owners, and suggest opening a PR.

## Refresh mode
When asked to update rather than create: diff the current code against each CLAUDE.md, fix stale commands/paths, add CLAUDE.md files for new areas, re-run step 7's checks, and leave everything else untouched. If the repo's copy of this skill is older than the one being run, offer to update it.

## Empty or brand-new repos
If there is little or no code yet, write only a root CLAUDE.md (overview from the user, commands that exist, the "Keeping this context accurate" section) and do step 7. Area files come later, once there is code to read.
