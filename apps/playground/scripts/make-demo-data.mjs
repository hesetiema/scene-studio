/**
 * Generates the **publishable** copy of the vent demo's data snapshot.
 *
 *   node apps/playground/scripts/make-demo-data.mjs
 *   node apps/playground/scripts/make-demo-data.mjs --check   # scan only, no writes
 *
 * Why this exists
 * ---------------
 * The real snapshot is deliberately gitignored (`apps/playground/public/data/`,
 * `public/bim/`): it is a live customer project. It carries the site name, the
 * mall brand, zone names, staff names, a phone number, hostnames, project /
 * building / floor ids — and those ids are *not* confined to the JSON: the FBX
 * chunks name themselves after them (`0Pj3201050003_Bd171851…_F1`), and the
 * massing chunks carry the site name in their node names.
 *
 * GitHub Pages has to serve something, so this script derives a second copy that
 * keeps every *structure* (counts, ids' shape, geometry, referential integrity,
 * the relationship between a space and its floor) and drops every *identity*:
 *
 *   - ids            `Pj…` / `Bd…` / `Fl…` / `Sp…` / `Eq…` / 32-hex guids  →
 *                    same prefix, same length, counter body. Length is not
 *                    cosmetic: the same bytes live in the FBX chunks, and FBX
 *                    strings are length-prefixed, so a replacement must not
 *                    change the byte count.
 *   - display names  buildings → 楼栋 A/B/C, spaces → 房间 N, equipment →
 *                    风机/窗 N, dynamics → 测点 N. The *type* survives
 *                    (`classCode`), because the icon layer picks icons from it.
 *   - free text      `intro`, `creator`, `modifier`, `pic`, `floorMap`,
 *                    `digitalDeliveryName`, `meta.source` — dropped or generic.
 *   - kept           `classCode`, `roomFuncType`, `infoCodeName`, `aliasName`,
 *                    `templateTypeName`, dimensions, geometry, coordinates.
 *
 * Coordinates are *not* shifted. They look alarming (`115503.8,131900.58`) but
 * they are model-local millimetres from the project origin, not survey
 * coordinates: the massing and the Revit floors live in the same local frame, so
 * translating one without the other would break the view, and there is no
 * location in them to leak.
 *
 * Reading the output: `meta.sanitized === true`. CI asserts that marker plus an
 * absence scan (see `.github/workflows/pages.yml`), which is the only thing
 * standing between "we ran the script" and "the site really is clean".
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_DATA = join(ROOT, "public/data/vent");
const SRC_BIM = join(ROOT, "public/bim");
const OUT = join(ROOT, "demo-data");

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has("--check");

const ID_RE = /(Pj|Bd|Fl|Sp|Eq)([0-9a-f]{6,})(?![0-9a-f])/g;
const GUID_RE = /\b[0-9a-f]{32}\b/g;

/** A site-shaped token: never allowed to survive into `demo-data/`. */
const FORBIDDEN_EXTRA = [
  "meos",
  "dev-gw",
  "吾悦",
  "南京",
  "建邺",
  "金街",
  "XC_",
  "Pj9522457558",
  "13308225555",
  "赵强",
];

// ---------------------------------------------------------------- id mapping

/** body of `len` chars, digits when the original was digits, else lowercase hex */
function fakeBody(index, len, digitsOnly) {
  const body = digitsOnly ? String(index) : index.toString(16);
  if (body.length >= len) return body.slice(-len);
  return (digitsOnly ? "0" : "0").repeat(len - body.length) + body;
}

function collectIds(texts) {
  const seen = new Set();
  for (const text of texts) {
    for (const m of text.matchAll(ID_RE)) seen.add(m[0]);
    for (const m of text.matchAll(GUID_RE)) seen.add(m[0]);
  }
  const map = new Map();
  [...seen].sort().forEach((real, i) => {
    const m = /^(Pj|Bd|Fl|Sp|Eq)([0-9a-f]+)$/.exec(real);
    if (m) {
      const digitsOnly = /^\d+$/.test(m[2]);
      map.set(real, m[1] + fakeBody(i + 1, m[2].length, digitsOnly));
    } else {
      map.set(real, fakeBody(i + 1, real.length, false));
    }
  });
  return map;
}

function applyIds(text, idMap) {
  let out = text.replace(ID_RE, (all) => idMap.get(all) ?? all);
  out = out.replace(GUID_RE, (all) => idMap.get(all) ?? all);
  return out;
}

// ------------------------------------------------------------- name handling

/** Deterministic label alphabet for buildings: A, B, C… then A1, A2… */
function buildingLetter(i) {
  const letters = "ABCDEFGH";
  if (i < letters.length) return letters[i];
  return `${letters[i % letters.length]}${Math.floor(i / letters.length)}`;
}

const FLOOR_NAME_RE = /^(RF|B\d+M?|F\d+|\d+F|M\w*|\d+)$/;

function spaceLabel(i) {
  return `房间 ${String(i).padStart(3, "0")}`;
}

function equipLabel(i, classCode) {
  const kind = /^CFC/.test(classCode ?? "") ? "窗" : "风机";
  return `${kind} ${String(i).padStart(3, "0")}`;
}

function dynLabel(i) {
  return `测点 ${String(i).padStart(3, "0")}`;
}

const GENERIC_INTRO = "示例数据：空间与通风设备的运行快照，用于演示。";
const REDACTED = "demo";

// -------------------------------------------------------------- json walking

/**
 * Rewrite one person-facing record. `ctx` carries the per-kind label function so
 * the same key can mean different things on a space and on an equipment.
 */
/**
 * Every record that carries an `id` gets one label, decided once.
 *
 * Walking the whole document matters: `spaces[].relObjects[]` repeats the
 * equipment that sits in a room, and the first version of this script only
 * rewrote the top-level arrays, which left real names inside those copies.
 * One id → one label, wherever it appears.
 */
function scrubVentData(raw) {
  const data = structuredClone(raw);

  const seen = new Map();
  const order = [];
  const visitRecords = (node, fn) => {
    if (Array.isArray(node)) return node.forEach((v) => visitRecords(v, fn));
    if (!node || typeof node !== "object") return;
    if (typeof node.id === "string") fn(node);
    for (const v of Object.values(node)) visitRecords(v, fn);
  };
  visitRecords(data, (rec) => {
    if (seen.has(rec.id)) return;
    seen.set(rec.id, { objType: rec.objType, classCode: rec.classCode, localName: rec.localName });
    order.push(rec.id);
  });

  const label = new Map();
  const extra = new Map();
  let buildings = 0;
  let spaces = 0;
  let equips = 0;
  for (const id of order) {
    const rec = seen.get(id);
    if (rec.objType === "building") {
      const letter = buildingLetter(buildings++);
      label.set(id, `楼栋 ${letter}`);
      extra.set(id, { localId: letter, name: `建筑-${letter}` });
    } else if (rec.objType === "floor") {
      const name = FLOOR_NAME_RE.test(rec.localName ?? "") ? rec.localName : "室外";
      label.set(id, name);
      extra.set(id, { localId: name, name });
    } else if (rec.objType === "space") {
      const text = spaceLabel(++spaces);
      label.set(id, text);
      extra.set(id, { localId: text.replace(" ", "-") });
    } else {
      const text = equipLabel(++equips, rec.classCode);
      label.set(id, text);
      extra.set(id, { localId: text.replace(" ", "-") });
    }
  }

  visitRecords(data, (rec) => {
    const text = label.get(rec.id);
    if (!text) return;
    if ("name" in rec) rec.name = extra.get(rec.id)?.name ?? text;
    // `aliasName` / `infoCodeName` are metric labels (温度 / 运行状态), not
    // place names, so they are deliberately left alone.
    for (const key of ["localName", "dynamicName"]) {
      if (key in rec) rec[key] = text;
    }
    for (const key of ["localId", "digitalDeliveryName"]) {
      if (key in rec) rec[key] = extra.get(rec.id)?.localId ?? text.replace(" ", "-");
    }
    if ("intro" in rec) rec.intro = GENERIC_INTRO;
    if ("creator" in rec) rec.creator = REDACTED;
    if ("modifier" in rec) rec.modifier = REDACTED;
    if ("pic" in rec) rec.pic = "";
    if ("floorMap" in rec) rec.floorMap = "";
    if ("templateTypeId" in rec && /^\d+$/.test(String(rec.templateTypeId))) {
      rec.templateTypeId = String(1000000 + order.indexOf(rec.id) + 1);
    }
  });

  data.meta = {
    capturedAt: raw.meta?.capturedAt ?? null,
    source: "sample snapshot (sanitized for the public demo)",
    page: "",
    sanitized: true,
  };
  return data;
}

// ---------------------------------------------------------------- binary pass

// The chunk prefix is the project's initials. Same width, so byte offsets hold.
const PROJECT_TAG_FROM = "XC_";
const PROJECT_TAG_TO = "DX_";

/** ASCII filler of exactly `bytes` bytes, built from a readable token. */
function asciiPad(bytes, seed) {
  const token = `SAMPLE${seed.toString(36).toUpperCase()}`;
  if (token.length >= bytes) return token.slice(0, bytes);
  return token + "_".repeat(bytes - token.length);
}

/**
 * One replacement per CJK string, keyed by its content and not by its position.
 *
 * The same name lives in `Scene.json` (as a JSON string) and inside the FBX
 * chunk (as a length-prefixed byte string), and the loader matches meshes by
 * `{chunk}/{name}`. Deriving the filler from the text keeps the two sides in
 * agreement, and keeps the byte length so the FBX stays valid.
 */
function cjkFiller(run) {
  const bytes = Buffer.byteLength(run, "utf8");
  const seed = parseInt(createHash("sha1").update(run).digest("hex").slice(0, 6), 16);
  return asciiPad(bytes, seed);
}

/** Same replacement, for JSON strings (no length constraint, but identical). */
function scrubCjkText(text) {
  return text.replace(
    /[\u4e00-\u9fff][\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]*/g,
    (run) => cjkFiller(run),
  );
}

/**
 * Replace the CJK strings a FBX actually contains, and nothing else.
 *
 * A naive scan for "3-byte UTF-8 lead" bytes would fire on the float arrays:
 * bytes 0xE0–0xEF are everywhere in binary geometry, so that approach silently
 * corrupts vertices. Instead the whole chunk is decoded leniently, the CJK runs
 * are taken from the *decoded* text (≥2 chars, so a single stray sequence can't
 * match), and each run's exact UTF-8 bytes are replaced in the original buffer.
 * Replacement is byte-length-preserving: FBX strings are length-prefixed, so
 * nothing after them may shift.
 */
function scrubCjkStrings(buf) {
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  const runs = new Set(
    decoded.match(/[\u4e00-\u9fff][\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]{1,}/g) ?? [],
  );
  let out = Buffer.from(buf);
  let replaced = 0;
  let seed = 0;
  const needles = [];
  for (const run of runs) {
    const needle = Buffer.from(run, "utf8");
    needles.push(needle);
    let from = 0;
    for (;;) {
      const at = out.indexOf(needle, from);
      if (at < 0) break;
      Buffer.from(cjkFiller(run), "latin1").copy(out, at);
      replaced += 1;
      from = at + needle.length;
    }
    seed += 1;
  }
  return { buf: out, replaced, needles };
}

function scrubBinary(buf, idMap) {
  const latin = buf.toString("latin1");
  let text = latin;
  for (const [real, fake] of idMap) {
    if (real.length === fake.length && text.includes(real)) text = text.split(real).join(fake);
  }
  text = text.split(PROJECT_TAG_FROM).join(PROJECT_TAG_TO);
  const { buf: cjkFree, replaced, needles } = scrubCjkStrings(Buffer.from(text, "latin1"));
  return { buf: cjkFree, replaced, needles };
}

// ---------------------------------------------------------------------- main

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const STRINGIFY = (v) => JSON.stringify(v);

function walkStrings(value, visit) {
  if (typeof value === "string") return visit(value);
  if (Array.isArray(value)) return value.map((v) => walkStrings(v, visit));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = walkStrings(v, visit);
    return out;
  }
  return value;
}

async function main() {
  if (!existsSync(SRC_DATA) || !existsSync(SRC_BIM)) {
    console.error("source snapshot missing: run this only where public/data + public/bim exist");
    process.exit(1);
  }

  const ventDataRaw = await readFile(join(SRC_DATA, "vent-real-data.json"), "utf8");
  const fieldsRaw = await readFile(join(SRC_DATA, "vent-model-view-fields.json"), "utf8");
  const sceneRaw = await readFile(join(SRC_BIM, "07_building_relation/Scene.json"), "utf8");
  const materialsRaw = await readFile(join(SRC_BIM, "07_building_relation/Materials.json"), "utf8");

  const revitDir = join(SRC_BIM, "revit");
  const revitFiles = (await readdir(revitDir)).filter((f) => f.endsWith(".json"));
  const revitRaw = new Map();
  for (const f of revitFiles) revitRaw.set(f, await readFile(join(revitDir, f), "utf8"));

  const fbxDir = join(SRC_BIM, "07_building_relation/Models");
  const fbxFiles = (await readdir(fbxDir)).filter((f) => f.toLowerCase().endsWith(".fbx"));
  const fbxRaw = new Map();
  for (const f of fbxFiles) fbxRaw.set(f, await readFile(join(fbxDir, f)));

  // one id space for every file: the same id must map the same way everywhere
  const idMap = collectIds([
    ventDataRaw,
    fieldsRaw,
    sceneRaw,
    materialsRaw,
    ...revitRaw.values(),
    ...fbxFiles,
  ]);
  console.log(`ids mapped: ${idMap.size}`);

  const ventData = scrubVentData(JSON.parse(ventDataRaw));
  const fields = JSON.parse(fieldsRaw).map((f) => ({ ...f, objectId: idMap.get(f.objectId) ?? f.objectId }));
  const scrubSceneJson = (raw) =>
    STRINGIFY(
      walkStrings(JSON.parse(raw), (v) => scrubCjkText(applyIds(v, idMap)).split(PROJECT_TAG_FROM).join(PROJECT_TAG_TO)),
    );
  const scene = scrubSceneJson(sceneRaw);
  const materials = scrubSceneJson(materialsRaw);

  const outFiles = new Map();
  outFiles.set("data/vent/vent-real-data.json", applyIds(JSON.stringify(ventData), idMap));
  outFiles.set("data/vent/vent-model-view-fields.json", applyIds(JSON.stringify(fields), idMap));
  outFiles.set("bim/07_building_relation/Scene.json", scene);
  outFiles.set("bim/07_building_relation/Materials.json", materials);

  let cjkHits = 0;
  for (const [name, buf] of fbxRaw) {
    const { buf: clean, replaced, needles } = scrubBinary(buf, idMap);
    cjkHits += replaced;
    // byte-level proof: a lenient decode of binary geometry always yields a few
    // stray CJK code points, so the check is "no original string is still there",
    // never "no CJK byte anywhere".
    for (const needle of needles) {
      if (clean.indexOf(needle) >= 0) throw new Error(`${name}: a CJK string survived the scrub`);
    }
    if (clean.length !== buf.length) throw new Error(`${name}: byte length changed`);
    outFiles.set(`bim/07_building_relation/Models/${name.split(PROJECT_TAG_FROM).join(PROJECT_TAG_TO)}`, clean);
  }
  console.log(`fbx: ${cjkHits} CJK string occurrence(s) replaced, byte lengths unchanged`);

  for (const [name, raw] of revitRaw) {
    const json = JSON.parse(raw);
    const floorId = idMap.get(json.floorId) ?? json.floorId;
    const projectId = idMap.get(json.projectId) ?? json.projectId;
    const next = { ...json, floorId, projectId };
    outFiles.set(`bim/revit/${name.replace(/^Fl[0-9a-f]+/, floorId)}`, STRINGIFY(next));
  }

  // residual scan: the only real proof that the output is clean
  const blacklist = new Set(FORBIDDEN_EXTRA);
  for (const [real] of idMap) blacklist.add(real);

  const problems = [];
  for (const [name, content] of outFiles) {
    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const latin = buf.toString("latin1");
    const utf8 = buf.toString("utf8");
    for (const bad of blacklist) {
      if (latin.includes(bad) || utf8.includes(bad)) problems.push(`${name} still contains ${bad}`);
    }
    // CJK is expected in data/vent (the synthetic names are Chinese); identity
    // leaks are what the blacklist catches, so no blanket CJK assertion here.
  }

  if (problems.length) {
    console.error(`\nFAILED: ${problems.length} leftover identifier(s)`);
    for (const p of problems.slice(0, 20)) console.error("  " + p);
    process.exit(1);
  }
  console.log(`residual scan: 0 hits across ${blacklist.size} forbidden tokens`);

  if (CHECK_ONLY) {
    console.log("check only: nothing written");
    return;
  }

  await rm(OUT, { recursive: true, force: true });
  for (const [rel, content] of outFiles) {
    const dest = join(OUT, rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, content);
  }
  const total = [...outFiles.values()].reduce(
    (n, c) => n + (typeof c === "string" ? Buffer.byteLength(c) : c.length),
    0,
  );
  console.log(`wrote ${outFiles.size} files, ${(total / 1024 / 1024).toFixed(1)} MB → ${OUT}`);
}

await main();
