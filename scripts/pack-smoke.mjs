#!/usr/bin/env node
/**
 * Tarball consumption smoke (D9 消费测试 / D19 P3):
 * build → pack → install the tarball into a throwaway consumer → verify
 * exports (node ESM), types (tsc), CSS + element entry (vite build).
 * Run: node scripts/pack-smoke.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(root, "packages", "scene-editor");
const isWin = process.platform === "win32";

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    shell: isWin,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function step(msg) {
  console.log(`[pack-smoke] ${msg}`);
}

const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const threeFloor = (pkg.peerDependencies?.three ?? "").replace(/^[\^~]/, "");
if (!threeFloor) throw new Error("peerDependencies.three missing");

step(`build ${pkg.name}@${pkg.version} (three floor ${threeFloor})`);
run("pnpm", ["--filter", pkg.name, "build"], root);

step("verify packed file list (exports/types/CSS artifacts)");
const dryRun = JSON.parse(run("npm", ["pack", "--dry-run", "--json"], pkgDir));
const packedFiles = new Set((dryRun[0]?.files ?? []).map((f) => f.path));
const required = [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/three-entry.js",
  "dist/three-entry.d.ts",
  "dist/element-entry.js",
  "dist/element-entry.d.ts",
  "dist/scene-editor.css",
  "package.json",
];
const missing = required.filter((f) => !packedFiles.has(f));
if (missing.length > 0) {
  throw new Error(`tarball missing files: ${missing.join(", ")}`);
}
step(`tarball file list OK (${packedFiles.size} files)`);

const tmp = mkdtempSync(join(tmpdir(), "scene-editor-pack-"));
try {
  step(`pack → ${tmp}`);
  const packOut = run("pnpm", ["pack", "--pack-destination", tmp], pkgDir).trim();
  const printed = packOut.split(/[\r\n]+/).pop().trim();
  const tarball = isAbsolute(printed) ? printed : join(tmp, printed);
  if (!existsSync(tarball)) throw new Error(`tarball not found: ${tarball} (pnpm pack said: ${printed})`);

const consumer = join(tmp, "consumer");
mkdirSync(consumer);
writeFileSync(
  join(consumer, "package.json"),
  `${JSON.stringify({ name: "pack-smoke-consumer", private: true, type: "module" }, null, 2)}\n`,
);

  step("consumer: npm install tarball + three floor + toolchain");
  run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      tarball,
      `three@${threeFloor}`,
      `@types/three@${threeFloor}`,
      "typescript@5.9.3",
      "vite@8.3.4",
    ],
    consumer,
  );

  step("consumer: node ESM smoke (core + three entries, no DOM)");
  writeFileSync(
    join(consumer, "smoke-node.mjs"),
    [
      `import assert from "node:assert/strict";`,
      `import { SCENE_EDITOR_VERSION, SceneDocumentSchema, FakeRuntime, AssetCache, createResolverAssetLoader } from "@your-scope/scene-editor";`,
      `import { ThreeRuntime, createRenderer } from "@your-scope/scene-editor/three";`,
      `assert.equal(SCENE_EDITOR_VERSION, ${JSON.stringify(pkg.version)});`,
      `assert.equal(typeof SceneDocumentSchema.parse({ schemaVersion: 1, sceneId: "t", revision: 0, objects: [] }).sceneId, "string");`,
      `assert.throws(() => SceneDocumentSchema.parse({ schemaVersion: 1 }));`,
      `assert.equal(typeof FakeRuntime, "function");`,
      `assert.equal(typeof AssetCache, "function");`,
      `assert.equal(typeof createResolverAssetLoader, "function");`,
      `assert.equal(typeof ThreeRuntime, "function");`,
      `assert.equal(typeof createRenderer, "function");`,
      `console.log("node smoke OK");`,
      ``,
    ].join("\n"),
  );
  run("node", ["smoke-node.mjs"], consumer);

  step("consumer: tsc --noEmit (types export conditions)");
  writeFileSync(
    join(consumer, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        include: ["smoke.ts"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(consumer, "smoke.ts"),
    [
      `import { SceneDocumentSchema, type SceneDocument, FakeRuntime } from "@your-scope/scene-editor";`,
      `import { ThreeRuntime, type ThreeRuntimeOptions } from "@your-scope/scene-editor/three";`,
      `import { defineSceneEditor, SceneEditorElement } from "@your-scope/scene-editor/element";`,
      `const doc = SceneDocumentSchema.parse({ schemaVersion: 1, sceneId: "t", revision: 0, objects: [] }) satisfies SceneDocument;`,
      `const _opts: Partial<ThreeRuntimeOptions> = { enableControls: false };`,
      `const _rt: typeof ThreeRuntime = ThreeRuntime;`,
      `const _el: typeof SceneEditorElement = SceneEditorElement;`,
      `void defineSceneEditor; void FakeRuntime; void doc; void _opts; void _rt; void _el;`,
      ``,
    ].join("\n"),
  );
  run("npx", ["tsc", "--noEmit", "-p", "."], consumer);

  step("consumer: vite build (element entry + CSS through a bundler)");
  writeFileSync(
    join(consumer, "element-smoke.ts"),
    `import { defineSceneEditor } from "@your-scope/scene-editor/element";\nconsole.log(typeof defineSceneEditor);\n`,
  );
  writeFileSync(
    join(consumer, "vite.config.js"),
    `export default ${JSON.stringify(
      {
        build: {
          lib: {
            entry: "element-smoke.ts",
            formats: ["es"],
            fileName: "element-smoke",
          },
          minify: false,
        },
        logLevel: "warn",
      },
      null,
      2,
    )};\n`,
  );
  run("npx", ["vite", "build"], consumer);
  const bundle = join(consumer, "dist", "element-smoke.js");
  if (!existsSync(bundle) || statSync(bundle).size === 0) {
    throw new Error("element bundle missing or empty");
  }

  step(`PASS — ${pkg.name}@${pkg.version} consumable (exports/types/CSS/SSR-import)`);
  rmSync(tmp, { recursive: true, force: true });
} catch (err) {
  console.error(`[pack-smoke] FAIL — kept workdir for debugging: ${tmp}`);
  throw err;
}
