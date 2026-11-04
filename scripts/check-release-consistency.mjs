#!/usr/bin/env node
/**
 * Release metadata guard.
 *
 * The package is published independently of the monorepo, so the version and
 * status in package.json, the bootstrap constant, API.md and both READMEs can
 * silently drift. This script fails CI on drift instead of relying on review.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(resolve(root, relativePath), "utf8");
const fail = (message) => {
  errors.push(message);
};
const errors = [];

const pkg = JSON.parse(read("packages/scene-editor/package.json"));
const rootPkg = JSON.parse(read("package.json"));
const version = pkg.version;

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail(`packages/scene-editor/package.json has an invalid version: ${version}`);
}

// --- npm metadata ---------------------------------------------------------
if (!pkg.description) {
  fail("packages/scene-editor/package.json is missing description");
}

const REPO_URL = "https://github.com/hesetiema/scene-studio";
const normalizeRepo = (url) =>
  String(url ?? "")
    .replace(/^git\+/, "")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");

if (normalizeRepo(pkg.repository?.url) !== REPO_URL) {
  fail(`package repository must be ${REPO_URL}, got ${pkg.repository?.url ?? "(missing)"}`);
}
if (pkg.repository?.directory !== "packages/scene-editor") {
  fail("package repository.directory must be packages/scene-editor");
}
if (!String(pkg.homepage ?? "").startsWith(REPO_URL)) {
  fail("package homepage must point at the GitHub repository");
}
if (normalizeRepo(pkg.bugs?.url) !== `${REPO_URL}/issues`) {
  fail("package bugs.url must point at the GitHub issues page");
}

const rootRepo = normalizeRepo(rootPkg.repository?.url);
if (rootRepo !== REPO_URL) {
  fail(`root repository must be ${REPO_URL}, got ${rootPkg.repository?.url ?? "(missing)"}`);
}

let remote = "";
try {
  remote = execFileSync("git", ["config", "--get", "remote.origin.url"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  // A source tarball without .git is fine; the package metadata is still checked.
}
if (remote && normalizeRepo(remote) !== REPO_URL) {
  fail(`git remote.origin.url (${remote}) does not match the published repository (${REPO_URL})`);
}

// --- license --------------------------------------------------------------
if (pkg.license !== "MIT") {
  fail(`package license must be MIT, got ${pkg.license ?? "(missing)"}`);
}
for (const licensePath of ["LICENSE", "packages/scene-editor/LICENSE"]) {
  if (!existsSync(resolve(root, licensePath))) {
    fail(`${licensePath} is missing`);
  } else if (!/^MIT License\r?\n/.test(read(licensePath))) {
    fail(`${licensePath} is not an MIT license file`);
  }
}

// --- version / status in docs and code -----------------------------------
const bootstrapVersion = read("packages/scene-editor/src/bootstrap-version.ts");
if (!bootstrapVersion.includes(`"${version}"`)) {
  fail(`src/bootstrap-version.ts must export "${version}"`);
}

const api = read("packages/scene-editor/API.md");
if (!api.includes(`Version: \`${version}\``)) {
  fail(`packages/scene-editor/API.md must declare Version: \`${version}\``);
}

const packageReadme = read("packages/scene-editor/README.md");
if (!packageReadme.includes(`**Status:** \`${version}\``)) {
  fail(`packages/scene-editor/README.md must declare **Status:** \`${version}\``);
}
if (/License\s*\n\s*\nTBD/i.test(packageReadme)) {
  fail("packages/scene-editor/README.md still has a TBD license section");
}

const packageReadmeZh = read("packages/scene-editor/README.zh-CN.md");
if (!packageReadmeZh.includes(`仓库内为 \`${version}\``)) {
  fail(`packages/scene-editor/README.zh-CN.md must declare 仓库内为 \`${version}\``);
}

const rootReadme = read("README.md");
if (!rootReadme.includes(`This repo tracks \`${version}\``)) {
  fail(`README.md must declare This repo tracks \`${version}\``);
}

const rootReadmeZh = read("README.zh-CN.md");
if (!rootReadmeZh.includes(`仓库当前版本为 \`${version}\``)) {
  fail(`README.zh-CN.md must declare 仓库当前版本为 \`${version}\``);
}
if (!/^## License$/m.test(rootReadme)) {
  fail("README.md is missing a ## License section");
}
if (/not yet published to npm/i.test(rootReadme)) {
  fail("README.md still says the package is not published to npm");
}

if (errors.length > 0) {
  console.error("Release metadata is inconsistent:\n");
  for (const error of errors) console.error(`  - ${error}`);
  console.error("\nFix the files above, then re-run `pnpm test:release`.");
  process.exitCode = 1;
} else {
  console.log(`Release metadata OK (v${version}, MIT, ${REPO_URL}).`);
}
