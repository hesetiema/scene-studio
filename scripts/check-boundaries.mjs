#!/usr/bin/env node
// Import-boundary gate for packages/scene-editor/src.
//
// Enforces the invariants that today are upheld by discipline alone
// (see references/repo-facts.md, 不变式 1-3):
//
//   B1  only three/ and assets/ may *statically* import three.
//       element/ may reference three only through a lazy `import()` or a
//       type-position `import()` — never a static `import ... from`.
//       (lazyGltfLoader() in element/ is the sanctioned example.)
//   B2  core/ must not import element/ or three/
//   B3  no import cycles anywhere in src/
//
// Exit 0 = clean, 1 = violations. No dependencies, no build step.
//
// Usage:  node scripts/check-boundaries.mjs [--root <dir>] [--quiet]
//   --root   override the source root (default: <repo>/packages/scene-editor/src)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const rootFlag = args.indexOf("--root");
const ROOT =
  rootFlag >= 0 && args[rootFlag + 1]
    ? path.resolve(args[rootFlag + 1])
    : // scripts/ -> <repo>/packages/scene-editor/src
      path.resolve(HERE, "../packages/scene-editor/src");

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");
const layerOf = (p) => rel(p).split("/")[0];

// Layers allowed a STATIC three import. element/ is intentionally absent:
// it must stay lazy so the element entry does not pull three at module scope.
const THREE_STATIC_ALLOWED = new Set(["three", "assets"]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

// Blank out comments while preserving every newline, so match indices still map
// to the original line numbers. A line-based scan would miss multi-line imports
// (`import type {\n  A,\n} from "x"`), which are the majority in this codebase.
function maskComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/**
 * Classify every module specifier in a file.
 * @returns {{spec:string, line:number, kind:"static"|"type"|"lazy"|"side-effect"}[]}
 */
function importsOf(file) {
  const src = maskComments(fs.readFileSync(file, "utf8"));
  const lineAt = (idx) => src.slice(0, idx).split("\n").length;
  const out = [];

  // import type X from "spec" | import { type X } from "spec" | export * from "spec"
  // The clause may not contain ";" so a match cannot run past its own statement.
  for (const m of src.matchAll(
    /(?:^|\n)[ \t]*(?:import|export)[ \t]+(type[ \t]+)?([^;]*?)\bfrom[ \t]*["']([^"']+)["']/g,
  )) {
    const [, typeKw, clause, spec] = m;
    const onlyInlineTypes = /^\{\s*type\s+[^}]+,\s*type\s+[^}]+\}$/.test((clause ?? "").trim())
      || /^\{\s*type\s+[^}]+\}$/.test((clause ?? "").trim());
    out.push({ spec, line: lineAt(m.index), kind: typeKw || onlyInlineTypes ? "type" : "static" });
  }

  // import "spec"  (side effect)
  for (const m of src.matchAll(/(?:^|\n)[ \t]*(?:import|export)[ \t]*["']([^"']+)["']/g)) {
    out.push({ spec: m[1], line: lineAt(m.index), kind: "side-effect" });
  }

  // import("spec") / import("spec").Foo — dynamic OR type-position; both stay out of the static graph
  for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
    out.push({ spec: m[1], line: lineAt(m.index), kind: "lazy" });
  }

  return out;
}

const isThree = (spec) => spec === "three" || spec.startsWith("three/");

function resolveLocal(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const t = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [t, `${t}.ts`, path.join(t, "index.ts")]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

if (!fs.existsSync(ROOT)) {
  console.error(`check-boundaries: source root not found: ${ROOT}`);
  process.exit(1);
}

const files = walk(ROOT);
const violations = [];
const lazyThree = [];
const graph = new Map();

for (const file of files) {
  const layer = layerOf(file);
  const deps = [];
  for (const { spec, line, kind } of importsOf(file)) {
    if (isThree(spec)) {
      if (kind === "lazy") {
        lazyThree.push(`${rel(file)}:${line}  ->  ${spec}`);
      } else if (kind !== "type" && !THREE_STATIC_ALLOWED.has(layer)) {
        violations.push({
          rule: "B1",
          where: `${rel(file)}:${line}`,
          detail: `layer "${layer}/" has a ${kind} import of "${spec}". Only three/ and assets/ may import three statically; element/ must stay lazy (import()).`,
        });
      }
    }

    const dep = resolveLocal(file, spec);
    if (!dep) continue;
    deps.push(dep);
    if (layer === "core" && (layerOf(dep) === "three" || layerOf(dep) === "element")) {
      violations.push({
        rule: "B2",
        where: `${rel(file)}:${line}`,
        detail: `core/ imports "${rel(dep)}" — core is the leaf layer and must not depend on the adapter or DOM layer.`,
      });
    }
  }
  graph.set(file, deps);
}

// B3: depth-first cycle detection over resolved local edges.
const WHITE = 0;
const GREY = 1;
const BLACK = 2;
const color = new Map();
const reported = new Set();

function dfs(node, stack) {
  color.set(node, GREY);
  stack.push(node);
  for (const dep of graph.get(node) ?? []) {
    const c = color.get(dep) ?? WHITE;
    if (c === GREY) {
      const at = stack.indexOf(dep);
      const cycle = [...stack.slice(at), dep];
      const key = [...cycle].sort().join("|");
      if (!reported.has(key)) {
        reported.add(key);
        violations.push({ rule: "B3", where: cycle.map(rel).join(" -> "), detail: "import cycle" });
      }
    } else if (c === WHITE) {
      dfs(dep, stack);
    }
  }
  color.set(node, BLACK);
  stack.pop();
}

for (const f of files) if ((color.get(f) ?? WHITE) === WHITE) dfs(f, []);

const edges = [...graph.values()].reduce((a, b) => a + b.length, 0);

if (violations.length > 0) {
  console.error(`check-boundaries: ${violations.length} violation(s) across ${files.length} files\n`);
  for (const v of violations) {
    console.error(`  [${v.rule}] ${v.where}`);
    console.error(`        ${v.detail}\n`);
  }
  console.error("Fix the dependency, not the check. Rationale: AGENTS.md — Invariants 1-3.");
  process.exit(1);
}

if (!quiet) {
  console.log(
    `check-boundaries: OK — ${files.length} files, ${edges} internal edges, 0 cycles, 0 violations.`,
  );
  if (lazyThree.length > 0) {
    console.log(`\nSanctioned lazy three edges (not in the static graph): ${lazyThree.length}`);
    for (const l of lazyThree) console.log(`  ${l}`);
  }
}
process.exit(0);
