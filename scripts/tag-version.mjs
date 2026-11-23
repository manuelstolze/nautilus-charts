#!/usr/bin/env node
// Tags HEAD with v<version> from package.json when the remote `origin`
// has no such tag yet. The tag-version workflow runs it on pushes to main.
// It uses Node alone, so a test can run it against a local bare remote.
// It exits non-zero only when a Git command fails.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Runs a Git command in the current directory and returns its output.
 * @param {string[]} args
 * @returns {string}
 */
function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
if (typeof manifest.version !== "string" || manifest.version === "") {
  console.error("tag-version: package.json has no version");
  process.exit(1);
}
const tag = `v${manifest.version}`;

try {
  if (git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`]).trim() !== "") {
    console.log(`${tag} already exists on origin; nothing to do`);
  } else {
    git(["tag", tag]);
    git(["push", "origin", `refs/tags/${tag}`]);
    console.log(`created and pushed ${tag}`);
  }
} catch (error) {
  console.error(`tag-version: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
