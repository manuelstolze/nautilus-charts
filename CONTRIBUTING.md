# Contributing to nautilus-charts

nautilus-charts is the system catalog of Nautilus. Read [the README](./README.md) and [the structure](./docs/structure.md) before contributing.

## Scope and change discipline

- Keep changes small, focused, and easy to review.
- Read the relevant instructions, skills, templates, and documents before changing them.
- Keep the module within its responsibilities in the README. Work that belongs to another module goes there.
- Update documentation when a change affects how the module is used.
- Check changes with commands or examples suited to the files changed.
- Do not commit credentials, secrets, personal settings, or machine-specific paths.

## Branches and pull requests

Use a branch for changes that will be shared for review. Use this branch format:

```text
<type>/<optional-issue-number>-<short-description>
```

Use a lowercase, hyphen-separated description. Omit the issue number when there is no issue.

Examples:

```text
feat/add-external-entries
fix/12-check-missing-path
docs/explain-dependencies
```

When using a shared remote, open a pull request before merging. Keep it focused and explain why the change is needed. List the checks you ran and any known limitations.

## Commit messages

Use an emoji-prefixed conventional commit header:

```text
<emoji> <type>(<scope>): <imperative subject>
```

Examples:

```text
✨ feat(charts): add rdeps command
🐛 fix(charts): report missing local path
📝 docs(skill): explain dependency entries
```

Use this type and emoji mapping:

| Emoji | Type | Use for |
| --- | --- | --- |
| ✨ | `feat` | A new feature |
| 🐛 | `fix` | A bug fix |
| 📝 | `docs` | Documentation-only changes |
| ✏️ | `fix` | A typo or wording fix in content, used instead of 🐛 |
| 💄 | `style` | Formatting changes without logic changes |
| ♻️ | `refactor` | Code restructuring without a feature or fix |
| ⚡️ | `perf` | Performance improvements |
| ✅ | `test` | Adding or updating tests |
| 🏗️ | `build` | Build-system or dependency changes |
| 👷 | `ci` | Automated check or release workflow changes |
| 🔧 | `chore` | Maintenance and tooling changes |
| ⏪️ | `revert` | Reverting an earlier change |
| 🔒️ | `security` | Security fixes |
| 🚀 | `deploy` | Deployment-related changes |

Include exactly one matching emoji and type. Use `charts` as the scope, or a narrower one such as `skill` or `docs`. Keep each commit focused. Keep the header at 72 characters or fewer, including the emoji and scope. Keep body lines at 72 characters or fewer. Use a command in the subject, such as `add` or `fix`, and do not end it with a period. Explain why the change is needed in the body when the subject does not make it clear.

## Catalog entries

Read [docs/structure.md](./docs/structure.md) for entry types, fields, and ID rules. Follow the [charts skill](./.agents/skills/charts/SKILL.md) when finding or changing entries or resolving a local repository path.

Use the templates in `templates/` when adding entries. Keep one entry per file. The file name is the ID. Use only tags listed in `tags.toml`. Store machine-specific paths only in `local/paths.toml`, which Git ignores. Do not put credentials in remote links. Removing an entry never deletes a repository or its files.

## Skills

Skills live in `.agents/skills/`. For Claude Code, link them into the ignored `.claude/skills/`:

```bash
mkdir -p .claude/skills
for skill in .agents/skills/charts .agents/skills/engineering/*; do
  ln -sfn "../../$skill" ".claude/skills/$(basename "$skill")"
done
```

## Tooling

The tooling is written in TypeScript. It needs Node 20 or later. Install dependencies once with:

```bash
npm install
```

Keep scripts under `scripts/` and tests under `tests/`. Use `node:test` for tests. Add a runtime dependency only when the standard library is not enough, and commit `package-lock.json` with it.

## Validation

Run checks that match the files you changed. From the repository root, check for whitespace errors with:

```bash
git diff --check
```

Run the type check, the tests, and the charts check with:

```bash
npm run check
```

`charts check` validates IDs, references, tags, local paths, and remotes. For skill, template, or documentation changes, check links and examples and exercise the changed instructions when practical. Record the checks and results when requesting review. Explain any unrelated failures.

## Pull request checklist

Before requesting review, confirm that:

- [ ] The change is limited to the required files.
- [ ] Relevant instructions, templates, and documentation are up to date.
- [ ] Checks suited to the change have been run, or missing checks are explained.
- [ ] `npm run check` passes, and `local/paths.toml` is not committed.
- [ ] No credentials, personal settings, or machine-specific paths are included.
- [ ] The pull request lists checks, results, and known limitations.
