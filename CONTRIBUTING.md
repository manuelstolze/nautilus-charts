# Contributing to nautilus-charts

nautilus-charts is the system catalog of Nautilus. Read [the README](./README.md), [the constitution](./CONSTITUTION.md), and [the structure](./docs/structure.md) before contributing. The constitution's rules are mandatory; this guide holds the conventions.

## Scope and change discipline

- Keep changes small, focused, and easy to review.
- Read the relevant instructions, skills, templates, and documents before changing them.
- Update documentation when a change affects how the module is used.
- Check changes with commands or examples suited to the files changed.
- Do not commit credentials, secrets, personal settings, or machine-specific paths to the Charts source repository. Put named catalog entries in their own catalog repository.

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

Each named catalog stores its entries and `tags.toml` in a separate Git repository with one configured `origin` remote. Charts commits writes in the selected catalog and syncs only that catalog after the write. It may sync all registered catalogs on a due read. It never contacts code-repository remotes. Keep the catalog registry and code-repository paths on the machine, as [rule I of the constitution](./CONSTITUTION.md#i-catalog-data-stays-owner-controlled) sets out. The source repository ignores `/folio/` for local catalog repositories.

Use `charts catalog list` to see registered catalogs. If no catalog is registered, commands that read or change catalog data return a usage error that names `charts catalog create` and `charts catalog clone`. Read [docs/getting-started.md](./docs/getting-started.md) to set up a first catalog in the Folio, and [docs/structure.md](./docs/structure.md) for entry types, fields, ID rules, and catalog commands. Follow the [charts skill](./.agents/skills/charts/SKILL.md) when finding or changing entries or resolving a local repository path.

Use Charts' templates in its `templates/` folder when adding entries. Catalogs do not store or override these templates. Keep one entry per file. The file name is the ID. Each named catalog has its own `tags.toml`; use only tags listed there. Keep catalog names and code-repository paths in machine-local files. Do not sync these paths.

## Skills

Skills live in `.agents/skills/`. The links in `.claude/skills/` are tracked. When you add a skill, create its link with this command. Use the skill's path under `.agents/skills/` as `<path>`:

```bash
ln -s ../../.agents/skills/<path> .claude/skills/<name>
```

On Windows, enable Developer Mode and run `git config --global core.symlinks true` before cloning. Otherwise, Git checks out symlinks as text files.

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

A change that changes the contract sets the new version in `package.json` in its merge request. After the merge, the [`tag-version` workflow](./.github/workflows/tag-version.yml) tags `v<version>` on `main`; do not tag by hand.

## Validation

Run checks that match the files you changed. From the repository root, check for whitespace errors with:

```bash
git diff --check
```

Run the type check and tests with:

```bash
npm run check
```

Run `charts check --catalog <name>` separately to validate a named catalog, its links to other registered catalogs, tags, local paths, and code-repository remotes. The source repository stores no catalog data, so `npm run check` does not run this command. For skill, template, or documentation changes, check links and examples and exercise the changed instructions when practical. Record the checks and results when requesting review. Explain any unrelated failures.

## Merge request checklist

Before requesting review, confirm that:

- [ ] The change is limited to the required files.
- [ ] Relevant instructions, templates, and documentation are up to date.
- [ ] Checks suited to the change have been run, or missing checks are explained.
- [ ] `npm run check` passes. No user catalog entries or machine-local path files are committed to the Charts source repository.
- [ ] No credentials, personal settings, machine-specific paths, or real company, host, or repository names are included.
- [ ] The merge request lists checks, results, and known limitations.
