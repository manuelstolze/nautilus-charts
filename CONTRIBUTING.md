# Contributing to nautilus-charts

nautilus-charts is the system catalog of Nautilus. Read [the README](./README.md), [the constitution](./CONSTITUTION.md), and [the structure](./docs/structure.md) before contributing. The constitution's rules are mandatory; this guide holds the conventions.

## Scope and change discipline

- Keep changes small, focused, and easy to review.
- Read the relevant instructions, skills, templates, and documents before changing them.
- Update documentation when a change affects how the module is used.
- Check changes with commands or examples suited to the files changed.
- Do not commit credentials, secrets, personal settings, machine-specific paths, or catalog entries.

## Branches and merge requests

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

When using a shared remote, open a merge request (a GitHub pull request) before merging. Keep it focused and explain why the change is needed. List the checks you ran and any known limitations.

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

Entries in `systems/`, `repositories/`, and `externals/` are the catalog owner's own catalog and stay private, as [rule I of the constitution](./CONSTITUTION.md#i-the-catalog-stays-private) sets out.

Read [docs/structure.md](./docs/structure.md) for entry types, fields, and ID rules. Follow the [charts skill](./.agents/skills/charts/SKILL.md) when finding or changing entries or resolving a local repository path.

Use the templates in `templates/` when adding entries. Keep one entry per file. The file name is the ID. Use only tags listed in `tags.toml`. Store machine-specific paths only in `local/paths.toml`, which Git ignores.

## Skills

Skills live in `.agents/skills/`. For Claude Code, link them into the ignored `.claude/skills/`:

```bash
mkdir -p .claude/skills
for skill in .agents/skills/charts .agents/skills/engineering/*; do
  ln -sfn "../../$skill" ".claude/skills/$(basename "$skill")"
done
```

The engineering skills in `.agents/skills/engineering/` are copies from nautilus-bridge. Change them in the Bridge first, then copy the folder unchanged from the Charts root:

```bash
rsync -a --delete "$NAUTILUS_HOME/nautilus-bridge/.agents/skills/engineering/" .agents/skills/engineering/
```

`grill-me` and `grill-with-docs` are shortcuts for the catalog owner: `grill-me` calls `grilling`, and `grill-with-docs` calls `grilling` with `domain-modeling`. Agents cannot invoke them.

## Tooling

The tooling is written in TypeScript. It needs Node 26 or later, which runs the TypeScript files directly by stripping their types. Use only syntax that Node can strip: `tsconfig.json` sets `erasableSyntaxOnly`, so the type check rejects, for example, enums and parameter properties. The TypeScript, Node.js, and tooling package versions follow the
[shared Nautilus toolchain](https://github.com/manuelstolze/nautilus-bridge/blob/main/docs/overview.md#toolchain).
Install dependencies once with:

```bash
npm ci
```

`bin/charts.js` is the `charts` command. It is plain JavaScript, so it can check the Node version before it loads the TypeScript files; the [README](./README.md#setup) shows how to link it into `~/.local/bin`.

Keep production code under `src/`, the composition root in `scripts/`, and tests under `tests/`. [docs/structure.md](./docs/structure.md#code-structure) explains the code structure. Use `node:test` for tests. Add a runtime dependency only when the standard library is not enough, and commit `package-lock.json` with it.

## Versions

Charts has a semantic version in `package.json`, which `charts --version` and `charts describe --json` report. The version is the version of Charts's contract: its commands, options, `--json` fields, and error codes ([docs/structure.md](./docs/structure.md#errors-and-exit-codes)).

- **Major:** a command, option, `--json` field, or error code is removed or changes its meaning.
- **Minor:** a command, option, `--json` field, or error code is added.
- **Patch:** a change that callers cannot see, such as a fix or a documentation change.

A change that changes the contract sets the new version in `package.json` in its merge request. After the merge, the change owner tags the merge commit with `v<version>`, for example `git tag v1.0.0 && git push origin v1.0.0`.

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

## Merge request checklist

Before requesting review, confirm that:

- [ ] The change is limited to the required files.
- [ ] Relevant instructions, templates, and documentation are up to date.
- [ ] Checks suited to the change have been run, or missing checks are explained.
- [ ] `npm run check` passes, and no catalog entries or `local/paths.toml` are committed.
- [ ] No credentials, personal settings, machine-specific paths, or real company, host, or repository names are included.
- [ ] The merge request lists checks, results, and known limitations.
