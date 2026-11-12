/**
 * 通风感知 · 纯模型视图（逐项对齐参考产品「通风感知」页面的模型层）
 *
 * 对齐目标：**只看模型**——去掉右侧面板和顶部筛选，左侧楼栋/楼层选择器精简。
 * 建筑视图与楼层视图的模型渲染、包围盒、碰撞、图元展示与真实页一致：
 *
 *   - 土建模型（两个视图用两套数据源）
 *     · 建筑视图：`07_building_relation` 白模场景——Shell 外壳压淡（#EAF0F7@0.14）、
 *       逐层 Board 楼板提白半透明（#FFFFFF@0.82）、逐层线框只画三角边线
 *       （实体面片会糊住下方空间薄片）；俯角 28°、斜距 1300 等轴测取景。
 *     · 楼层视图：Revit 轻量化几何 `public/bim/revit/{floorId}.json`（按类别合并，
 *       离线烘焙世界坐标）——楼板 #DFE6EE 压扁不吃光、墙/柱/梯按屏幕色反解
 *       #BFBFBF、设备/家具（ACVTSF/FFSCMF/FFSCAF）#EDEDED。
 *       `05_building_classic` 已弃用（只覆盖单栋 1F–5F）。
 *   - 空间模型：outline 双几何——建筑=层高×0.6 体块（alpha 0.7）、楼层=单层
 *     三角化**平面**（opacity 1，不是 0.01 挤出：near≈1ft / far≈10⁵ft 的深度精度
 *     会让顶底自相交出条纹），抬到标高 +0.8ft，上方挂 outline 边界线补分区墙线。
 *     状态色 #9BD6DE（正在通风）/#C9B79B（未通风）/#C4C9CF（无法监测）。
 *   - 设备模型：建筑视图隐藏（原「全楼视角默认不展示设备」）；楼层视图 24×24
 *     图标图元（开 #09B3B5 / 关 #424C59 / 离线 #8B949E，白边圆角 + 14px 白 SVG），
 *     **名称默认不显示、hover 才浮出**——常驻文字会把平面图糊成一片。
 *   - 图元展示（CSS2D DOM）：设备图标 + 名称、空间 IoT 值（温度/CO₂）+ 名称；
 *     文字 12px #1B2129 白描边，锚点标高 +0.1。
 *   - 碰撞：AABB 重叠——设备图标相撞聚合为计数角标（`group-wrap`，24×24 #E8ECF0），
 *     文字相撞按状态权重隐藏（异常>控反>IoT>普通）；相机变化即重算。
 *   - 包围盒：楼层**只用 Revit 整层 bbox**（并进空间 outline 会被离群轮廓拉偏）
 *     → `floorCameraFromBox`（fov 50 + 10° 俯角 + scale 1.11）；建筑用 07
 *     Scene.json 的 cameraModel 位姿。
 *   - 光照：物理光照反解 ambient 3.15 / directional 2.6（真实页 0.8/1.0 是
 *     useLegacyLights 口径，数字不可照抄）；不开阴影贴图——楼板不吃光，
 *     墙体自阴影只会把整层压灰。
 *
 * SDK 边界：`@scenio/scene-editor/bim` 只给结构（loadBimScene 双场景、
 * outline 几何、bimLocation 解析）；材质、单位、色板、图元、碰撞、相机
 * 全部由本消费者设定。
 *
 * 数据：`public/data/vent/*.json`（运行环境采样，**不入库**，缺失时显示准备提示）。
 * 几何：`public/bim/07_building_relation/`、`public/bim/revit/`（同样不入库）。
 */
import { defineSceneEditor } from "@scenio/scene-editor/element";
import {
  createSceneDocument,
  type SceneDocument,
} from "@scenio/scene-editor";
import type { SceneEditorElement } from "@scenio/scene-editor/element";
import type { ThreeRuntime } from "@scenio/scene-editor/three";
import {
  extrudedOutlineGeometry,
  loadBimScene,
  loadRevitFloor,
  outlinePlaneGeometry,
  outlinePlanCentroid,
  parseBimLocation,
  type BimSceneHandle,
  type OutlineJson,
  type RevitFloorHandle,
} from "@scenio/scene-editor/bim";
import * as THREE from "three";

defineSceneEditor();

/* ------------------------------------------------------------------ */
/* 单位与轴向（消费者约定）                                             */
/* ------------------------------------------------------------------ */

const MM2FOOT = 0.00328083989501;
const M2FOOT = 1 / 0.3048;

function bimLocationToVector3(bimLocation: string | undefined): THREE.Vector3 | null {
  const raw = parseBimLocation(bimLocation);
  if (!raw) return null;
  const [px, py, pz] = raw;
  return new THREE.Vector3(px * MM2FOOT, pz * MM2FOOT, -py * MM2FOOT);
}

function spaceVolumeDepth(storyHeightMeters: number | string | undefined): number {
  const h = Number(storyHeightMeters ?? 0);
  return Number.isFinite(h) ? M2FOOT * h * 0.6 : 1.2;
}

function floorElevationFeet(elevationMeters: number | string | undefined): number {
  const e = Number(elevationMeters ?? 0);
  return Number.isFinite(e) ? M2FOOT * e : 0;
}

function outlineCenterWorld(outline: OutlineJson | string | undefined): { x: number; z: number } | null {
  const c = outlinePlanCentroid(outline);
  if (!c) return null;
  return { x: c[0] * MM2FOOT, z: -c[1] * MM2FOOT };
}

/* ------------------------------------------------------------------ */
/* 真实数据推导（空间/设备 VM）                                         */
/* ------------------------------------------------------------------ */

interface RawSpace {
  id: string;
  localName: string;
  objType: string;
  classCode?: string;
  roomFuncType?: string;
  buildingId?: string;
  floorId?: string;
  relObjects?: RawEquip[];
  tdbQuality?: Record<string, string>;
  co2Quality?: Record<string, string>;
}
interface RawEquip {
  id: string;
  localName: string;
  objType?: string;
  classCode?: string;
  floorId?: string;
  buildingId?: string;
  monitoringSurveillanceStatus?: string;
  major?: string;
  relObjects?: RawEquip[];
}
interface RawDynItem {
  dataValue?: string;
  unit?: string;
  existsIotRule?: boolean;
  dataTime?: string;
}
interface RawDyn {
  id: string;
  relInfoCodeGroupConfigs?: Array<{
    relInfoCodeConfigs?: Array<{ infoCode?: string } & RawDynItem>;
  }>;
}
interface RawFloor {
  id: string;
  localName: string;
  localId?: string;
  floorElevation?: string | number;
  height?: string | number;
}
interface RawBuilding {
  id: string;
  localName: string;
  floors: RawFloor[];
}

interface VentRealData {
  meta: Record<string, unknown>;
  spaces: RawSpace[];
  equips: RawEquip[];
  buildingTree: RawBuilding[];
  dynamics: RawDyn[];
}

/**
 * 数据快照**不入库**（含真实楼栋几何与内部标识），运行时从 `public/` 取。
 * 缺失时由 `boot()` 渲染「准备数据」提示，而不是白屏 —— 打包产物可以先行分发。
 */
const DATA_URL = "/data/vent/vent-real-data.json";
const MV_URL = "/data/vent/vent-model-view-fields.json";

const EMPTY_DATA = { spaces: [], equips: [], buildingTree: [], dynamics: [] } as unknown as VentRealData;
let DATA: VentRealData = EMPTY_DATA;
let MV_FIELDS = new Map<string, { objectId: string; bimLocation?: string; outline?: string }>();
let DYN_INDEX = new Map<string, Map<string, RawDynItem>>();

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function loadData(): Promise<void> {
  const [rawData, mvList] = await Promise.all([
    fetchJson<VentRealData>(DATA_URL),
    fetchJson<Array<{ objectId: string; bimLocation?: string; outline?: string }>>(MV_URL),
  ]);
  DATA = rawData;
  MV_FIELDS = new Map(mvList.map((f) => [f.objectId, f]));

  DYN_INDEX = new Map();
  for (const d of DATA.dynamics) {
    const m = new Map<string, RawDynItem>();
    for (const g of d.relInfoCodeGroupConfigs ?? []) {
      for (const cfg of g.relInfoCodeConfigs ?? []) {
        if (cfg.infoCode) m.set(cfg.infoCode, cfg);
      }
    }
    DYN_INDEX.set(d.id, m);
  }

  const vm = buildViewModels();
  SPACE_VMS = vm.spaces;
  EQUIP_VMS = vm.equips;
}
function infoOf(objId: string, code: string): RawDynItem | undefined {
  return DYN_INDEX.get(objId)?.get(code);
}

type TdbStatus = "cold" | "cool" | "ok" | "warm" | "hot" | "nodata";
type Co2Status = "ok" | "high" | "vhigh" | "nodata";

function num(v: string | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function tdbStatusOf(val: string | undefined, q: Record<string, string> | undefined): TdbStatus {
  const n = num(val);
  if (n == null) return "nodata";
  const t = n;
  const map: Array<[TdbStatus, number, number]> = [
    ["cold", -Infinity, 16],
    ["cool", 16, 20],
    ["ok", 20, 26],
    ["warm", 26, 28],
    ["hot", 28, Infinity],
  ];
  for (const [s, lo, hi] of map) {
    if (t >= lo && t < hi) {
      if (q && q[s] != null) return s;
      return s;
    }
  }
  return "nodata";
}
function co2StatusOf(val: string | undefined, _q: Record<string, string> | undefined): Co2Status {
  const n = num(val);
  if (n == null) return "nodata";
  if (n < 1000) return "ok";
  if (n < 1500) return "high";
  return "vhigh";
}

type VentState = "hasVentilation" | "notVentilation" | "unableToDetect";
type EquipKind = "AC" | "FF" | "CF";

function equipKind(e: RawEquip): EquipKind | null {
  const m = e.major ?? "";
  if (m === "AC") return "AC";
  if (m === "FF") return "FF";
  if (m === "CF") return "CF";
  return null;
}

interface SpaceVM {
  id: string;
  name: string;
  floorId: string;
  buildingId: string;
  vent: VentState;
  tdb: string | null;
  tdbUnit: string;
  tdbStatus: TdbStatus;
  co2: string | null;
  co2Unit: string;
  co2Status: Co2Status;
  outline: OutlineJson | string | undefined;
  elev: number;
  depth: number;
  x: number;
  y: number;
  z: number;
}
interface EquipVM {
  id: string;
  name: string;
  kind: EquipKind | null;
  run: "on" | "off" | "unknown";
  floorId: string;
  buildingId: string;
  x: number;
  y: number;
  z: number;
}

/**
 * 07 场景的逐层 mesh 名形如 `{前缀}{项目ID}_{楼栋ID}_F6`、
 * `0xiankuang_B3`、`..._B1M`、`..._RF` —— 楼层后缀在末尾，需自定义解析。
 */
function storeyOfMeshName(namePath: string): string | null {
  const tail = namePath.split("/").pop() ?? namePath;
  const m = /_(B\d+F?M?|F\d+|RF)$/i.exec(tail.trim());
  if (!m) return null;
  const k = (m[1] ?? "").toUpperCase();
  const f = /^F(\d+)$/.exec(k);
  if (f) return `F${f[1]}`;
  const b = /^B(\d+)(F?M?)$/.exec(k);
  if (b && b[1]) return b[2]?.includes("M") ? `B${b[1]}M` : `B${b[1]}`;
  return /^RF$/.test(k) ? "RF" : null;
}

function buildViewModels(): { spaces: SpaceVM[]; equips: EquipVM[] } {
  const spaces: SpaceVM[] = [];
  const equips: EquipVM[] = [];
  const seenEquip = new Set<string>();

  for (const b of DATA.buildingTree) {
    for (const f of b.floors) {
      const elev = floorElevationFeet(f.floorElevation);
      const depth = spaceVolumeDepth(f.height);
      const list = DATA.spaces.filter((s) => s.floorId === f.id);

      for (const s of list) {
        const tdbItem = infoOf(s.id, "tdb");
        const co2Item = infoOf(s.id, "cO2");
        let hasVentEquip = false;
        let anyOpen = false;
        let allClosedWithRule = true;
        for (const e of s.relObjects ?? []) {
          const kind = equipKind(e);
          if (!kind) continue;
          hasVentEquip = true;
          const runInfo = infoOf(e.id, "runStatus");
          const open = runInfo?.existsIotRule === true && runInfo.dataValue === "1";
          const closed = runInfo?.existsIotRule === true && runInfo.dataValue === "0";
          if (open) anyOpen = true;
          if (!closed) allClosedWithRule = false;
          if (!seenEquip.has(e.id)) {
            seenEquip.add(e.id);
            const pos = bimLocationToVector3(MV_FIELDS.get(e.id)?.bimLocation);
            equips.push({
              id: e.id,
              name: e.localName,
              kind,
              run: open ? "on" : closed ? "off" : "unknown",
              floorId: s.floorId ?? f.id,
              buildingId: b.id,
              x: pos?.x ?? 0,
              y: pos?.y ?? elev,
              z: pos?.z ?? 0,
            });
          }
        }
        const vent: VentState = anyOpen
          ? "hasVentilation"
          : hasVentEquip && allClosedWithRule
            ? "notVentilation"
            : "unableToDetect";
        const outline = MV_FIELDS.get(s.id)?.outline;
        const c = outlineCenterWorld(outline) ?? (() => {
          const pos = bimLocationToVector3(MV_FIELDS.get(s.id)?.bimLocation);
          return pos ? { x: pos.x, z: pos.z } : { x: 0, z: 0 };
        })();
        spaces.push({
          id: s.id,
          name: s.localName,
          floorId: f.id,
          buildingId: b.id,
          vent,
          tdb: tdbItem?.dataValue ?? null,
          tdbUnit: tdbItem?.unit ?? "℃",
          tdbStatus: tdbStatusOf(tdbItem?.dataValue, s.tdbQuality),
          co2: co2Item?.dataValue ?? null,
          co2Unit: co2Item?.unit ?? "ppm",
          co2Status: co2StatusOf(co2Item?.dataValue, s.co2Quality),
          outline,
          elev,
          depth,
          x: c.x,
          y: elev + 0.15,
          z: c.z,
        });
      }
    }
  }
  return { spaces, equips };
}

let SPACE_VMS: SpaceVM[] = [];
let EQUIP_VMS: EquipVM[] = [];

/* ------------------------------------------------------------------ */
/* 样式常量（真实源码色板）                                             */
/* ------------------------------------------------------------------ */

const VENT_STYLE: Record<VentState, { color: string; label: string }> = {
  hasVentilation: { color: "#9BD6DE", label: "正在通风" },
  notVentilation: { color: "#C9B79B", label: "未通风" },
  unableToDetect: { color: "#C4C9CF", label: "无法监测" },
};

/**
 * 07_building_relation 建筑白模。
 * 场景原色偏蓝偏实（Shell #B7C6D8@0.4 / Board #B4C9E2@0.7），真实页渲染出来
 * 是**白色半透明**堆叠板 —— 板提白加透，壳压淡，描边降到浅灰。
 */
const MAT_SHELL = new THREE.MeshBasicMaterial({
  color: "#EAF0F7",
  transparent: true,
  opacity: 0.14,
  depthWrite: false,
  side: THREE.DoubleSide,
});
const MAT_BOARD = new THREE.MeshBasicMaterial({
  color: "#FFFFFF",
  transparent: true,
  opacity: 0.82,
  depthWrite: false,
  side: THREE.DoubleSide,
});
/**
 * 逐层线框（xiankuang_*）：FBX 里是 1ft 厚的实体面片，直接画会把下方的空间
 * 薄片整片糊住（表现为密集条纹）。改成 `wireframe: true` 只画三角边线，
 * 才是参考图里"平面图墙线"的观感。
 */
const MAT_WIRE = new THREE.MeshBasicMaterial({
  color: "#B4C2D0",
  transparent: true,
  opacity: 0.5,
  depthWrite: false,
  side: THREE.DoubleSide,
  wireframe: true,
});
/** 楼层土建——浅色平面图观感（保留备用配色） */
const CIVIL_EDGE_COLOR = "#7C8794";
const MAT_EDGE = new THREE.LineBasicMaterial({
  color: CIVIL_EDGE_COLOR,
  transparent: true,
  opacity: 0.45,
});

/**
 * 楼层土建材质 —— 逐项对齐参考页的楼层加载流程：
 *
 * · 楼板：`new MeshBasicMaterial({ color: '#DFE6EE' })`，压扁后放在
 *   标高 −0.1ft（`scale.z = 1e-7`）。不吃光 → 屏幕色就是 `#DFE6EE`，
 *   比背景 `#D4DDE5` 略亮，所以整层是「浮起来的一块浅板」。
 *   （参考页的楼板贴图流程在换材质时把贴图丢弃，
 *   楼层视图最终就是纯色板，无需复刻贴图。）
 * · 墙 / 柱 / 楼梯：真实页 `MeshStandardMaterial({ color: '#D0D7E3',
 *   roughness: 0.2, metalness: 0.1, side: DoubleSide })`——颜色来自
 *   类别色表（`CF` 专业色 `#D0D7E3`）。
 *   实测屏幕色：顶面 #D8D8D8~#F0F0F0（亮）、侧面 #C5C5C5（灰）——
 *   「白墙 + 灰描边」的观感就是顶/侧两级差。本仓库是物理光照（1/π），
 *   按屏幕目标反解本色 ≈ `#BFBFBF` + 环境光 3.15 / 方向光 2.6
 *   （见 `AMBIENT_INTENSITY` 反解注释）。
 *   **flatShading 不能省**：离线烘焙做了顶点合并 + 平滑法线，侧立面会从亮到暗
 *   渐变，3× 放大像糊了一圈软边；Revit 原始几何是逐面法线、硬边。
 *   前几版用 MeshBasic 平涂 + 1px 描边，墙会糊成线。
 */
const MAT_REVIT_SLAB = new THREE.MeshBasicMaterial({ color: "#DFE6EE" });
const MAT_REVIT_WALL = new THREE.MeshStandardMaterial({
  // 屏幕目标：侧面 #C5C5C5 / 顶面 #D8D8D8~#F0F0F0（真实页 fit 视图游程实测）。
  // 本仓库是物理光照（带 1/π），`albedo×(A+D·NdotL)/π` 反解出本色 ≈ `#BFBFBF`
  // （中性灰，不带蓝），光强见 `AMBIENT_INTENSITY` / `KEY_LIGHT_INTENSITY`。
  color: "#bfbfbf",
  // roughness 调低会随视角出高光，顶/侧灰阶被镜面污染，和真实页（漫反射主导、
  // 顶侧只差两级）对不上；0.85 基本只剩漫反射。
  roughness: 0.85,
  metalness: 0,
  side: THREE.DoubleSide,
  // Revit 导出的墙是逐面独立法线；我们离线烘焙做了顶点合并（索引化 + 平滑法线），
  // 侧立面会从亮到暗渐变，3× 放大像"糊了一圈软边"。flatShading 让片元着色器按
  // 屏幕空间导数重算面法线，零内存代价恢复 Revit 的硬边。
  flatShading: true,
});
/** 幕墙嵌板（`CFCWPN`）：真实页楼层视图不加载，这里给一个比墙略浅的同类材质。 */
const MAT_REVIT_PANEL = new THREE.MeshStandardMaterial({
  color: "#DDE3EC",
  roughness: 0.3,
  metalness: 0.1,
  side: THREE.DoubleSide,
  flatShading: true,
});
/**
 * 设备 / 家具（`ACVTSF` 通风风机、`FFSCMF` 送风、`FFSCAF` 排风、窗等）——
 * 真实页走 `makeNormalEquipBase` 的 advanced-mesh 路径，保留 FBX 自带材质
 * （截图实测是**白色**块 + 灰侧边，不是专业色 #82DACE/#FA9B96）。
 * 这里用近白标准材质 + 与墙同一套光照，复现「白块 + 灰描边」。
 */
const MAT_REVIT_FIXTURE = new THREE.MeshStandardMaterial({
  color: "#EDEDED",
  roughness: 0.6,
  metalness: 0,
  side: THREE.DoubleSide,
  flatShading: true,
});
const FIXTURE_CATEGORIES = new Set(["ACVTSF", "FFSCMF", "FFSCAF"]);
function revitMaterial(category: string): THREE.Material {
  if (category === "CFCSFL") return MAT_REVIT_SLAB;
  if (category === "CFCWPN") return MAT_REVIT_PANEL;
  if (FIXTURE_CATEGORIES.has(category)) return MAT_REVIT_FIXTURE;
  return MAT_REVIT_WALL;
}
/** 视图切换的土建配色：建筑=白模堆叠半透，楼层=平面图（板实、线深）。 */
function applyShellStyle(view: "building" | "floor"): void {
  const floor = view === "floor";
  MAT_BOARD.color.set(floor ? "#F8FAFD" : "#FFFFFF");
  // 建筑视图必须半透明：否则上层板盖住下层，看不出"千层饼"堆叠
  MAT_BOARD.opacity = floor ? 0.95 : 0.45;
  MAT_WIRE.color.set(floor ? "#5F6B78" : "#B4C2D0");
  MAT_WIRE.opacity = floor ? 0.95 : 0.5;
  MAT_SHELL.opacity = floor ? 0.08 : 0.1;
  MAT_EDGE.color.set(floor ? "#6B7683" : "#AEBAC7");
  MAT_EDGE.opacity = floor ? 0.95 : 0.9;
  MAT_ROOM_EDGE.opacity = floor ? 0.9 : 0;
}

const ROOM_ALPHA = 0.7;
/** 房间轮廓线（楼层平面图的分区墙线） */
const MAT_ROOM_EDGE = new THREE.LineBasicMaterial({
  color: "#5A6572",
  transparent: true,
  opacity: 1,
});

const EQUIP_ICON_BG: Record<string, string> = {
  on: "#09B3B5",
  off: "#424C59",
  unknown: "#8B949E",
};

/* ------------------------------------------------------------------ */
/* 图元层：CSS2D DOM + 投影 + 碰撞 + 聚合                               */
/* ------------------------------------------------------------------ */

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface LabelItem {
  id: string;
  kind: "space" | "equip";
  el: HTMLDivElement;
  pos: THREE.Vector3;
  weight: number;
  name: string;
  /** screen-space rects (layout 产物) */
  iconRect: Rect | null;
  textRect: Rect | null;
  /** equip: 吸收聚合 */
  absorbs: LabelItem[];
  absorbed: boolean;
  textHidden: boolean;
  iconHidden: boolean;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

const measureCtx = document.createElement("canvas").getContext("2d");
function textWidth(text: string): number {
  if (!measureCtx) return text.length * 12;
  measureCtx.font = "12px 'PingFang SC', sans-serif";
  return measureCtx.measureText(text).width;
}

class LabelLayer {
  readonly root: HTMLDivElement;
  #items: LabelItem[] = [];
  #w = 1;
  #h = 1;

  constructor(host: HTMLElement) {
    this.root = document.createElement("div");
    this.root.id = "labels";
    host.appendChild(this.root);
  }

  setItems(items: Array<Omit<LabelItem, "iconRect" | "textRect" | "absorbs" | "absorbed" | "textHidden" | "iconHidden">>): void {
    this.root.innerHTML = "";
    this.#items = items.map((it) => ({
      ...it,
      iconRect: null,
      textRect: null,
      absorbs: [],
      absorbed: false,
      textHidden: false,
      iconHidden: false,
    }));
    for (const it of this.#items) this.root.appendChild(it.el);
  }

  get items(): readonly LabelItem[] {
    return this.#items;
  }

  /** 投影 + 碰撞 + DOM 落位。camera 变化后调用。 */
  layout(camera: THREE.Camera, width: number, height: number): void {
    this.#w = width;
    this.#h = height;
    const v = new THREE.Vector3();
    for (const it of this.#items) {
      it.absorbed = false;
      it.textHidden = false;
      it.iconHidden = false;
      it.absorbs = [it];
      v.copy(it.pos).project(camera);
      const sx = (v.x * 0.5 + 0.5) * width;
      const sy = (-v.y * 0.5 + 0.5) * height;
      const onScreen = v.z > -1 && v.z < 1 && sx > -80 && sx < width + 80 && sy > -80 && sy < height + 80;
      if (!onScreen) {
        it.el.classList.add("hidden");
        it.iconRect = null;
        it.textRect = null;
        continue;
      }
      it.el.classList.remove("hidden");
      it.el.style.left = `${sx}px`;
      it.el.style.top = `${sy}px`;

      if (it.kind === "equip") {
        it.iconRect = { x: sx - 12, y: sy - 12, w: 24, h: 24 };
        const tw = textWidth(it.name);
        it.textRect = { x: sx - tw / 2 - 2.5, y: sy + 12 + 4, w: tw + 5, h: 21 };
      } else {
        it.iconRect = null;
        const tw = Math.max(textWidth(it.name), textWidth((it.el.dataset.lux ?? "") as string));
        it.textRect = { x: sx - tw / 2 - 2.5, y: sy - 38, w: tw + 5, h: 38 };
      }
    }

    this.#collideEquips();
    this.#collideSpaces();
    this.#applyVisibility();
  }

  /** 设备：图标相撞聚合；文字相撞按权重隐藏（沿用参考页的碰撞检测语义） */
  #collideEquips(): void {
    const list = this.#items.filter((i) => i.kind === "equip" && (i.iconRect || i.textRect));
    list.sort((a, b) => b.weight - a.weight);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a || a.absorbed || a.iconHidden) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b || b.absorbed || b.iconHidden) continue;
        if (a.iconRect && b.iconRect && rectsOverlap(a.iconRect, b.iconRect)) {
          // 图标相撞 → A 吸收 B（聚合计数）
          b.absorbed = true;
          b.textHidden = true;
          a.absorbs.push(...b.absorbs);
          b.absorbs = [];
          continue;
        }
        // 文字冲突 → 权重低的隐藏文字
        const pairs: Array<[Rect | null, Rect | null, "a" | "b"]> = [
          [a.iconRect, b.textRect, "b"],
          [a.textRect, b.iconRect, "a"],
          [a.textRect, b.textRect, "b"],
        ];
        for (const [ra, rb, loser] of pairs) {
          if (ra && rb && rectsOverlap(ra, rb)) {
            if (loser === "b") b.textHidden = true;
            else a.textHidden = true;
            break;
          }
        }
      }
    }
  }

  /** 空间标注：文字相撞按权重（IoT 值 > 无值）隐藏（原 SpaceInfoCollisionDetector） */
  #collideSpaces(): void {
    const list = this.#items.filter((i) => i.kind === "space" && i.textRect && !i.textHidden);
    list.sort((a, b) => b.weight - a.weight);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a || a.textHidden || !a.textRect) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b || b.textHidden || !b.textRect) continue;
        if (rectsOverlap(a.textRect, b.textRect)) {
          b.textHidden = true;
          b.textRect = null;
        }
      }
    }
  }

  #applyVisibility(): void {
    for (const it of this.#items) {
      if (it.kind === "equip") {
        const grp = it.el.querySelector<HTMLElement>(".grp");
        const ic = it.el.querySelector<HTMLElement>(".ic");
        const nm = it.el.querySelector<HTMLElement>(".name");
        const count = it.absorbs.length;
        if (count > 1 && !it.iconHidden) {
          if (grp) {
            grp.classList.remove("hidden");
            grp.textContent = String(count);
          }
          ic?.classList.add("hidden");
          if (nm) nm.classList.add("hidden");
        } else {
          grp?.classList.add("hidden");
          if (it.iconHidden) {
            ic?.classList.add("hidden");
          } else {
            ic?.classList.remove("hidden");
          }
          if (nm) nm.classList.toggle("hidden", it.textHidden);
        }
      } else {
        it.el.classList.toggle("hidden", it.textHidden && it.el.classList.contains("hidden") === false ? it.textHidden : it.textHidden);
        if (it.textHidden) it.el.classList.add("hidden");
      }
    }
  }
}

/* 设备图元 DOM（参考页设备图标规格） */
function buildEquipDom(vm: EquipVM): HTMLDivElement {
  const root = document.createElement("div");
  root.className = "lbl lbl-equip";
  const bg = EQUIP_ICON_BG[vm.run] ?? EQUIP_ICON_BG.unknown;
  root.innerHTML = `
    <div class="ic" style="background:${bg}"><svg viewBox="0 0 14 14"><path d="M7 1C4.2 1 2 3 2 5.4c0 1.6 1 3 2.5 3.8L3 13h2l.6-2.6c.4.1.9.1 1.4.1s1 0 1.4-.1L9 13h2l-1.5-3.8C11 8.4 12 7 12 5.4 12 3 9.8 1 7 1zm0 1.4c1.8 0 3.2 1.3 3.2 3S8.8 8.4 7 8.4 3.8 7.1 3.8 5.4 5.2 2.4 7 2.4z"/></svg></div>
    <div class="grp hidden">1</div>
    <div class="name">${escapeHtml(vm.name)}</div>
    <div class="dots"></div>
  `;
  return root;
}

/* 空间图元 DOM（参考页空间信息组件规格：IoT 值 + 名称） */
function buildSpaceDom(vm: SpaceVM): HTMLDivElement {
  const root = document.createElement("div");
  root.className = "lbl lbl-space";
  const lux =
    vm.tdb != null
      ? `温度: ${vm.tdb} ${vm.tdbUnit}`
      : vm.co2 != null
        ? `CO₂: ${vm.co2} ${vm.co2Unit}`
        : "";
  root.dataset.lux = lux;
  root.innerHTML = `
    <div class="lux">${escapeHtml(lux)}</div>
    <div class="name">${escapeHtml(displaySpaceName(vm.name))}</div>
  `;
  return root;
}

/**
 * 真实页空间标签只显示 `localName`，而模型字段接口给的 `localName` 带楼层前缀
 * （`F6_空 2` / `B9_空 1`）——去掉 `F<digits>_` 前缀后与真实页的「空 2」一致；
 * `B9_` 这类楼栋代号真实页是保留的，不动。
 */
function displaySpaceName(name: string): string {
  return name.replace(/^F\d+[_\-]/, "");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

/* ------------------------------------------------------------------ */
/* 相机工具（07 cameraModel / 楼层包围盒取景）                          */
/* ------------------------------------------------------------------ */

/**
 * 建筑视角。方向沿用 07 cameraModel（镜像 X 后），俯角 28°、斜距 1200：
 * 真实页是低角度等轴测（能看到每层楼板的顶面与堆叠间隙），不是顶视。
 */
const BUILDING_CAMERA = {
  fov: 50,
  position: [-27.3, 649.7, -1518.1] as [number, number, number],
  target: [493.7801, 60, -495.395355] as [number, number, number],
};

/** 楼层视图用真实页 `05_building_classic` 的相机参数（fov 50，不是近正交）。 */
const FLOOR_FOV = 50;
/** 楼层取景俯仰：`restoreControls` 把相机偏移绕 X 轴转 π/18 = 10°。 */
const FLOOR_TILT_DEG = 10;
/** 楼层取景余量：`restoreControls` 的 `scaleCoefficient`（楼层 1.11）。 */
const FLOOR_FIT_SCALE = 1.11;

/**
 * 楼层光照强度 —— 按**真实页像素反解**（游程取色，非直方图）。
 *
 * 两个放大倍率的实测（`test-results/profile2.cjs`，量化到 24 级）：
 * · fit 视图（1440×810 整层）：墙带是**三段色调**——侧面 `#C0C0C0`（≈#C5C5C5，
 *   2~15px）+ 顶面 `#D8D8D8`（≈#D0D7E3 本色，4~30px）+ 偶发饱和 `#F0F0F0`
 *   （2~10px，受光最正的顶面）。之前只量到 `#C5C5C5` 就断言"墙是一层平灰、
 *   没有白"，其实是把「侧面 + 顶面 + AA」糊在一条游程里了。
 * · 3× 放大：白顶 `#F0F0F0`（3~6px）+ 深灰边 `#A8A8A8`（3~9px）——
 *   即「白墙 + 灰描边」的观感（灰边是墙的侧立面，不是 EdgeMaterial）。
 *
 * 结论：真实页的立体感 = **顶面亮 / 侧面灰** 的两级差，不是"整条平灰"。
 * 反解（three r186 物理光照：outgoing = albedo×(A+D·NdotL)/π，albedo #BFBFBF
 * ≈0.52 线性；顶面 NdotL≈0.87、侧面≈0~0.22）：
 *   侧面 0.56 线性（#C5C5C5）  → A + 0.1D ≈ 3.4
 *   顶面 0.81 线性（#E8E8E8）  → A + 0.87D ≈ 4.9
 *   → A ≈ 3.2、D ≈ 2.6（部分顶面推到 1.0 附近饱和出 #F0F0F0，与实测一致）
 *
 * 参考页的 0.8/1.0 是 `useLegacyLights` 口径（出射 = albedo×
 * (A+D·NdotL)，无 1/π），不能直接照抄数字，照抄的是**屏幕色**。
 */
const AMBIENT_INTENSITY = 3.15;
const KEY_LIGHT_INTENSITY = 2.6;

function applyCamera(
  el: SceneEditorElement,
  position: [number, number, number],
  target: [number, number, number],
  fov: number,
  background?: string,
): void {
  const view = el.getViewState();
  el.setViewState({
    ...view,
    camera: { position, target, fov },
    ...(background ? { environment: { ...view.environment, background } } : {}),
  });
}

/** 楼层视图背景（真实页平面图底色，比建筑视图更浅） */
const FLOOR_BG = "#D4DDE5";
const BUILDING_BG = "#D6DDE5";

/**
 * 楼层取景 —— 照抄 camera-controls 的 `getDistanceToFitBox`：
 * `max(w/2/tan(fov/2), w/2/tan(fov/2)/aspect) + depth/2`，再把相机偏移绕 X 轴
 * 转 `FLOOR_TILT_DEG`。真实页是 **fov 50 + 10° 俯角**的透视顶视，墙体因此会露出
 * 侧面（10ft 高的墙在屏幕上占 sin(10°)≈1.7ft 的竖向宽度），平面图上的墙才有厚度；
 * 之前用 fov 14 + 4° 压成"近正交"，墙只剩一条白线，整层糊平。
 */
function floorCameraFromBox(box: THREE.Box3, fov: number, aspect: number): {
  position: [number, number, number];
  target: [number, number, number];
} {
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const fovRad = (fov * Math.PI) / 180;
  const w = size.x * FLOOR_FIT_SCALE;
  const h = size.z * FLOOR_FIT_SCALE;
  const depth = size.y * FLOOR_FIT_SCALE;
  const distV = h / 2 / Math.tan(fovRad / 2);
  const distH = w / 2 / Math.tan(fovRad / 2) / Math.max(aspect, 0.5);
  const d = Math.max(distV, distH, 10) + depth / 2;
  const tilt = (FLOOR_TILT_DEG * Math.PI) / 180;
  const offset = new THREE.Vector3(0, d, 0).applyAxisAngle(new THREE.Vector3(1, 0, 0), tilt);
  const pos = center.clone().add(offset);
  return {
    position: [pos.x, pos.y, pos.z],
    target: [center.x, center.y, center.z],
  };
}

/* ------------------------------------------------------------------ */
/* 主控制器                                                            */
/* ------------------------------------------------------------------ */

type ViewMode = "project" | "building" | "floor";

interface SpaceRec {
  vm: SpaceVM;
  vol: THREE.Mesh | null;
  flat: THREE.Mesh | null;
}

class VentDemo {
  readonly #el: SceneEditorElement;
  readonly #labels: LabelLayer;

  #shell: BimSceneHandle | null = null; // 07_building_relation（逐层 Board + 逐层线框）
  /** 楼层 Revit 轻量化几何（`public/bim/revit/{floorId}.json`），懒加载并缓存 */
  readonly #revit = new Map<string, RevitFloorHandle | null>();
  #edgeLines: THREE.LineSegments[] = [];
  readonly #spaceRecs = new Map<string, SpaceRec>();
  readonly #spaceByMesh = new Map<THREE.Object3D, string>();
  readonly #raycaster = new THREE.Raycaster();
  readonly #ndc = new THREE.Vector2();

  #mode: ViewMode = "project";
  #buildingId: string | null = null;
  #floorId: string | null = null;
  #selected: string | null = null;
  #raf = 0;
  #lastMatrix = "";

  onChange: (() => void) | null = null;

  constructor(el: SceneEditorElement) {
    this.#el = el;
    this.#labels = new LabelLayer(document.body);
    // scene-ready 在模块执行前就可能派发完毕，必须走 ready promise
    void el.ready.then(() => this.#onReady());
    this.#el.addEventListener("click", (ev) => this.#onClick(ev as MouseEvent));
    window.addEventListener("resize", () => {
      this.#requestLabelLayout();
    });
  }

  get mode(): ViewMode {
    return this.#mode;
  }
  get floorId(): string | null {
    return this.#floorId;
  }
  get buildingId(): string | null {
    return this.#buildingId;
  }

  /* ---------------- 场景构建 ---------------- */

  async #onReady(): Promise<void> {
    const rt = this.runtime;
    if (!rt) return;
    if (this.#shell) return; // 幂等：只构建一次

    // 空文档：几何全在 presentation 层
    const doc: SceneDocument = createSceneDocument({
      sceneId: "scene-vent-model",
      objects: [],
      view: {
        camera: {
          position: BUILDING_CAMERA.position,
          target: BUILDING_CAMERA.target,
          fov: BUILDING_CAMERA.fov,
        },
        lights: {
          ambient: { color: "#ffffff", intensity: 0.8 },
          directional: { color: "#ffffff", intensity: 0.6, position: [400, 800, 600] },
        },
        environment: { background: "#D6DDE5", gridVisible: false },
      },
    });
    await this.#el.loadDocument(doc);

    // 单一场景承担两个视图：Shell=外墙壳、Board_*=逐层楼板、Wireframe_*=逐层线框。
    // 线框 chunk 在 Scene.json 里 isMainBuilding=false，必须放开过滤，否则
    // 楼层平面图的密集墙线（xiankuang_*）整批丢失。
    this.#shell = await loadBimScene({
      baseUrl: "/bim",
      sceneName: "07_building_relation",
      mainBuildingsOnly: false,
      resolveFloorKey: (namePath) => storeyOfMeshName(namePath),
      resolveMaterial: (info) => {
        const c = info.chunk.toLowerCase();
        if (c.includes("wireframe")) return MAT_WIRE;
        if (c.includes("board")) return MAT_BOARD;
        return MAT_SHELL;
      },
      onMesh: (mesh) => {
        mesh.renderOrder = 0;
      },
    });
    rt.scene.add(this.#shell.group);

    // 逐层楼板边线：0 厚薄板靠轮廓线才有堆叠层次
    for (const list of this.#shell.meshesByFloor.values()) {
      for (const m of list) {
        if (!m.name || /xiankuang/i.test(m.name)) continue;
        const line = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 18), MAT_EDGE);
        line.name = "civil-edge";
        line.renderOrder = 1;
        m.add(line);
        this.#edgeLines.push(line);
      }
    }

    applyShellStyle("building");

    // 空间双几何（体块 + 薄片）
    for (const s of SPACE_VMS) {
      const volGeo = extrudedOutlineGeometry(s.outline, { depth: s.depth, scale: MM2FOOT });
      // 楼层薄片用**平面**而不是 0.01 挤出：两层间距 3mm 远小于平面图像素级的
      // 深度精度（near≈1ft / far≈10⁵ft），挤出体会自相 z-fighting 出条纹。
      const flatGeo = outlinePlaneGeometry(s.outline, { scale: MM2FOOT });
      const color = new THREE.Color(VENT_STYLE[s.vent].color);
      let vol: THREE.Mesh | null = null;
      let flat: THREE.Mesh | null = null;
      if (volGeo) {
        vol = new THREE.Mesh(volGeo, new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: ROOM_ALPHA,
          depthWrite: false,
        }));
        vol.position.y = s.elev + 0.08;
        vol.renderOrder = 2;
        vol.visible = false;
        rt.scene.add(vol);
        this.#spaceByMesh.set(vol, s.id);
      }
      if (flatGeo) {
        flat = new THREE.Mesh(flatGeo, new THREE.MeshBasicMaterial({
          color,
          opacity: 1,
        }));
        // 抬到楼板/墙顶之上：平面视图里垂直位移只带来 tan(4°)≈7% 的平面偏移
        flat.position.y = s.elev + 0.8;
        flat.renderOrder = 2;
        flat.visible = false;
        // 房间轮廓线：真实平面图的墙线密度来自 Revit 构件级几何，
        // 这里用每个空间 outline 的边界补上分区墙线。轻微抬高避免与薄片共面。
        const roomEdge = new THREE.LineSegments(
          new THREE.EdgesGeometry(flatGeo, 24),
          MAT_ROOM_EDGE,
        );
        roomEdge.position.y = 0.02;
        roomEdge.renderOrder = 3;
        flat.add(roomEdge);
        rt.scene.add(flat);
        this.#spaceByMesh.set(flat, s.id);
      }
      this.#spaceRecs.set(s.id, { vm: s, vol, flat });
    }

    this.#el.dispatchEvent(new CustomEvent("vent-ready"));
    this.showProject();
    this.#startLabelLoop();
    setStatus(
      `模型就绪：土建 ${this.#shell.meshByName.size} mesh（${[...this.#shell.meshesByFloor.keys()].join("/")}）· 空间 ${this.#spaceRecs.size} · 设备 ${EQUIP_VMS.length}`,
    );
  }

  get runtime(): ThreeRuntime | null {
    return (this.#el as unknown as { runtime?: ThreeRuntime }).runtime ?? null;
  }

  /* ---------------- 视图切换 ---------------- */

  /* ---------------- 楼层光照（对应参考页的灯光切换 + 方向光计算） ---------------- */

  /**
   * 楼层视图的打光。真实页在楼层模式下：`ambient.intensity = 0.8`、
   * `directional.intensity = 1`，并把方向光**克隆**一份重新定位到
   * `(center.x - 100, center.y + 200, center.z + 50)`、target 指向楼层中心，
   * 阴影贴图按楼层对角线取 512/1024/2048，`radius 0.5 / bias -1e-4`。
   *
   * 但真实页平面图上看到的**不是受光立体模型**：墙只是一条 `#C5C5C5` 的中性灰
   * 细带（2~9px），房间底是被压扁的楼板 `#DFE6EE`。也就是说方向光基本没起作用，
   * 环境光唱主角。原因有二：
   *   1. 楼板换成了 `MeshBasicMaterial`，不吃光也不收阴影 → 阴影贴图在楼层模式
   *      根本投不到东西（土建里唯一能收影的是墙自己）；
   *   2. 10° 俯角下墙的侧立面（10ft × sin10° ≈ 1.7ft）本来就比墙顶宽 3 倍，
   *      光照再拉对比，墙就会变成"白块 + 硬灰边"，比真实页粗一圈。
   * 所以这里的方向光只留 0.25 做一点点面间差，灰阶全部由环境光定。
   *
   * SDK 只提供纯结构（`lights` 走 viewState），所以这里全部由 demo 设定。
   */
  #applyFloorLighting(box: THREE.Box3 | null): void {
    const rt = this.runtime;
    if (!rt || !box || box.isEmpty()) return;
    const renderer = rt.renderer as unknown as THREE.WebGLRenderer;
    if (!renderer?.shadowMap) return;

    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const lightPos: [number, number, number] = [center.x - 100, center.y + 200, center.z + 50];

    const view = this.#el.getViewState();
    this.#el.setViewState({
      ...view,
      lights: {
        ambient: { color: "#FFFFFF", intensity: AMBIENT_INTENSITY },
        // 主方向光槽位没有 target（SDK 的 directional 只有 position），
        // 用 additional 里的方向光 + target，主槽位清零避免双重打光。
        directional: { color: "#FFFFFF", intensity: 0, position: lightPos },
        additional: [
          {
            kind: "directional",
            color: "#FFFFFF",
            intensity: KEY_LIGHT_INTENSITY,
            position: lightPos,
            target: [center.x, center.y, center.z],
          },
        ],
      },
      // 真实页 CF 材质没有 envMap，只用解析光；IBL 会额外压一层平光把对比抹掉
      environment: { ...view.environment, iblIntensity: 0 },
    });

    const key = rt.scene.children.find(
      (o): o is THREE.DirectionalLight =>
        (o as THREE.DirectionalLight).isDirectionalLight === true && (o as THREE.DirectionalLight).intensity > 0,
    );
    if (!key) return;
    key.castShadow = true;
    if (!key.target.parent) rt.scene.add(key.target);
    key.target.position.copy(center);
    key.target.updateMatrixWorld();

    // 阴影相机：真实页按楼层对角线收紧，贴图按对角线选档
    const diag = Math.hypot(size.x, size.z) * 1.2;
    const half = diag / 2;
    const shadowSize = diag >= 1024 ? 2048 : diag >= 512 ? 1024 : 512;
    const cam = key.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 1;
    cam.far = (key.position.distanceTo(center) + size.y) * 1.5;
    cam.updateProjectionMatrix();
    key.shadow.mapSize.set(shadowSize, shadowSize);
    key.shadow.radius = 1;
    key.shadow.bias = -0.0001;
    // 阴影贴图每 texel ≈0.6ft、墙厚也是 0.6ft，纯 bias 压不住自阴影；
    // 真实页靠"背光面本来就只压 5%"把它藏掉，这里再给一点 normalBias 兜底。
    key.shadow.normalBias = 0.03;

    // 阴影**不开**：楼层模式下唯一能收阴影的是墙自己，贴图每 texel 与墙厚同量级，
    // 墙顶只占几个 texel，开 receiveShadow 必然整面自阴影 → 整层发灰；楼板是
    // MeshBasic，本来就不收阴影（真实页同样如此）。立体感全部交给上面的
    // 「受光面过曝成白 / 背光面落成灰」两级漫反射。shadow camera 参数保留，
    // 需要时把下面这行改成 true 即可。
    renderer.shadowMap.enabled = false;
    // on-demand 渲染：改完 renderer 属性必须主动重绘一次，否则新的光照不生效
    rt.render();
  }

  /** 建筑 / 项目视图：关阴影、回到 viewer 默认（只有 IBL 的环境光）。 */
  #resetLighting(): void {
    const rt = this.runtime;
    if (!rt) return;
    const renderer = rt.renderer as unknown as THREE.WebGLRenderer | undefined;
    if (renderer?.shadowMap) renderer.shadowMap.enabled = false;
    const view = this.#el.getViewState();
    if (view.lights.additional?.length) {
      this.#el.setViewState({
        ...view,
        lights: {
          ambient: { color: "#FFFFFF", intensity: 0 },
          directional: { color: "#FFFFFF", intensity: 0, position: [5, 10, 7] },
          additional: [],
        },
        environment: { ...view.environment, iblIntensity: 1 },
      });
    }
    rt.render();
  }

  showProject(): void {
    this.#mode = "project";
    this.#buildingId = null;
    this.#floorId = null;
    this.#applyVisibility();
    this.#resetLighting();
    applyCamera(this.#el, BUILDING_CAMERA.position, BUILDING_CAMERA.target, BUILDING_CAMERA.fov, BUILDING_BG);
    this.#rebuildLabels();
    setStatus("视角：项目 · 全部建筑（07_building_relation 白模堆叠）");
    this.onChange?.();
  }

  showBuilding(buildingId: string): void {
    this.#mode = "building";
    this.#buildingId = buildingId;
    this.#floorId = null;
    this.#applyVisibility();
    this.#resetLighting();
    // 建筑聚焦：按空间包围盒取景（保留相机俯仰与真实 fov）
    const box = this.#spacesBox((s) => s.buildingId === buildingId);
    if (box) {
      const c = new THREE.Vector3();
      box.getCenter(c);
      const size = new THREE.Vector3();
      box.getSize(size);
      const d = Math.max(size.x, size.z) * 1.15 + 200;
      applyCamera(
        this.#el,
        [c.x + d * 0.45, c.y + d * 0.55, c.z - d * 0.75],
        [c.x, c.y, c.z],
        BUILDING_CAMERA.fov,
      );
    } else {
      applyCamera(this.#el, BUILDING_CAMERA.position, BUILDING_CAMERA.target, BUILDING_CAMERA.fov, BUILDING_BG);
    }
    this.#rebuildLabels();
    setStatus(`视角：${DATA.buildingTree.find((b) => b.id === buildingId)?.localName ?? ""}（白模堆叠）`);
    this.onChange?.();
  }

  showFloor(floorId: string): void {
    this.#mode = "floor";
    this.#floorId = floorId;
    const f = DATA.buildingTree.flatMap((b) => b.floors.map((fl) => ({ fl, b }))).find((x) => x.fl.id === floorId);
    this.#buildingId = f?.b.id ?? null;

    // 楼层视图的土建全部来自 Revit 轻量化几何（楼板 + 墙柱楼梯），
    // 07 场景只服务建筑/项目视图，这里先把它的逐层 mesh 收掉。
    this.#shell?.setFloorsVisible([]);
    this.#applyVisibility();

    // 先用空间包围盒给一帧即时取景，等 Revit 楼层数据到达再精取景
    const rt = this.runtime;
    const aspect = rt?.camera ? rt.camera.aspect : 16 / 9;
    const quick = this.#spacesBox((s) => s.floorId === floorId);
    if (quick) {
      const { position, target } = floorCameraFromBox(quick, FLOOR_FOV, aspect);
      applyCamera(this.#el, position, target, FLOOR_FOV, FLOOR_BG);
    }

    this.#rebuildLabels();
    setStatus(`视角：${f?.b.localName ?? ""}/${f?.fl.localName ?? ""}层 · 楼层模型（Revit 土建 + 空间薄片 + 设备图元）`);

    void this.#ensureRevit(floorId).then(() => {
      if (this.#mode !== "floor" || this.#floorId !== floorId) return;
      this.#applyVisibility();
      const box = this.#floorBox(floorId);
      if (box) {
        const { position, target } = floorCameraFromBox(box, FLOOR_FOV, aspect);
        applyCamera(this.#el, position, target, FLOOR_FOV, FLOOR_BG);
        this.#applyFloorLighting(box);
      }
      this.#rebuildLabels();
    });

    this.onChange?.();
  }

  /** 懒加载某层 Revit 几何并挂到场景（不可见，交由 #applyVisibility 控制）。 */
  async #ensureRevit(floorId: string): Promise<void> {
    const rt = this.runtime;
    if (!rt) return;
    if (this.#revit.has(floorId)) return;
    this.#revit.set(floorId, null); // 占位：避免重入
    try {
      const handle = await loadRevitFloor({
        baseUrl: "/bim/revit",
        floorId,
        resolveMaterial: (info) => revitMaterial(info.category),
        onMesh: (mesh, info) => {
          // 楼板最底层；构件靠光照与自阴影分层，不再叠描边线
          // （真实页 CF 没有 EdgeMaterial，墙的"灰边"是侧面背光 + 投影）
          mesh.renderOrder = info.category === "CFCSFL" ? 0 : 1;
          if (info.category !== "CFCSFL") {
            mesh.castShadow = true;
            // 阴影贴图每 texel ≈0.6ft、墙顶面积只有几 texel，收阴影必然整面
            // 自阴影（整层发灰）。真实页靠色调映射把阴影托住，这里直接不收，
            // 立体感交给「顶面纯白 / 侧面浅灰」两级明暗。
            mesh.receiveShadow = false;
          }
          mesh.frustumCulled = true;
        },
      });
      handle.group.visible = false; // 由 #applyVisibility 按当前楼层点亮
      rt.scene.add(handle.group);
      this.#revit.set(floorId, handle);
    } catch (e) {
      console.warn(`[vent] Revit 楼层 ${floorId} 加载失败`, e);
    }
  }

  /* ---------------- 显隐编排（对应 updateShowElements） ---------------- */

  #applyVisibility(): void {
    const isFloor = this.#mode === "floor";
    if (!isFloor) {
      // 建筑模型只留楼板 + 外壳（逐层线框在建筑视图里是满屏线团）
      this.#shell?.setFloorsVisible(null);
      this.#setWireVisible(false);
      applyShellStyle("building");
    }
    // 07 白模只在建筑/项目视图出现；楼层视图换成 Revit 楼层几何
    if (this.#shell) this.#shell.group.visible = !isFloor;
    for (const [id, handle] of this.#revit) {
      if (!handle) continue;
      handle.group.visible = isFloor && id === this.#floorId;
    }

    for (const [id, rec] of this.#spaceRecs) {
      const inFloor = rec.vm.floorId === this.#floorId;
      const inBuilding = this.#mode === "project" || rec.vm.buildingId === this.#buildingId;
      if (isFloor) {
        if (rec.flat) rec.flat.visible = inFloor;
        if (rec.vol) rec.vol.visible = false;
      } else {
        if (rec.vol) rec.vol.visible = inBuilding;
        if (rec.flat) rec.flat.visible = false;
      }
    }
  }

  /** 逐层线框显隐（建筑视图隐藏，楼层视图交给 setFloorsVisible 按层过滤）。 */
  #setWireVisible(on: boolean): void {
    if (!this.#shell) return;
    for (const [key, info] of this.#shell.meshInfo) {
      if (!/wireframe/i.test(info.chunk)) continue;
      const mesh = this.#shell.meshByName.get(key);
      if (mesh) mesh.visible = on;
    }
  }

  #spacesBox(filter: (s: SpaceVM) => boolean): THREE.Box3 | null {
    const box = new THREE.Box3();
    for (const rec of this.#spaceRecs.values()) {
      if (!filter(rec.vm)) continue;
      const m = rec.flat ?? rec.vol;
      if (m) box.expandByObject(m);
    }
    return box.isEmpty() ? null : box;
  }

  /**
   * 楼层包围盒（Revit 土建 + 空间薄片）——对应 _clipBox。
   *
   * 只用 Revit 整层边界：楼板 `CFCSFL` 必然覆盖整层轮廓，是最稳的取景依据。
   * 一旦把空间 outline 薄片并进来，个别离群 outline（接口里坐标异常的空间）
   * 会把 box 拉偏，表现为平面图整体偏移、上下被裁。
   */
  #floorBox(floorId: string): THREE.Box3 | null {
    const revit = this.#revit.get(floorId);
    if (revit && !revit.bbox.isEmpty()) return revit.bbox.clone();
    return this.#spacesBox((vm) => vm.floorId === floorId);
  }

  /* ---------------- 图元编排（对应 updateShowElements + 碰撞） ---------------- */

  #rebuildLabels(): void {
    const items: Array<Omit<LabelItem, "iconRect" | "textRect" | "absorbs" | "absorbed" | "textHidden" | "iconHidden">> = [];
    if (this.#mode === "floor" && this.#floorId) {
      for (const s of SPACE_VMS) {
        if (s.floorId !== this.#floorId) continue;
        items.push({
          id: s.id,
          kind: "space",
          el: buildSpaceDom(s),
          pos: new THREE.Vector3(s.x, s.y + s.depth + 0.15, s.z),
          weight: s.tdb != null || s.co2 != null ? 50 : 0,
          name: s.name,
        });
      }
      for (const e of EQUIP_VMS) {
        if (e.floorId !== this.#floorId) continue;
        items.push({
          id: e.id,
          kind: "equip",
          el: buildEquipDom(e),
          pos: new THREE.Vector3(e.x, e.y, e.z),
          weight: e.run === "on" ? 2 : 0,
          name: e.name,
        });
      }
    }
    // 建筑/项目视图：原页不展示图元（仅异常空间名，本快照无异常）——保持干净白模
    this.#labels.setItems(items);
    this.#requestLabelLayout();
  }

  #requestLabelLayout(): void {
    this.#lastMatrix = ""; // 强制下一帧重排
  }

  #startLabelLoop(): void {
    const tick = (): void => {
      this.#raf = requestAnimationFrame(tick);
      const rt = this.runtime;
      const cam = rt?.camera;
      if (!cam) return;
      const el = this.#el;
      const w = el.clientWidth;
      const h = el.clientHeight;
      const key = `${cam.position.x.toFixed(2)},${cam.position.y.toFixed(2)},${cam.position.z.toFixed(2)},${w},${h}`;
      if (key === this.#lastMatrix) return;
      this.#lastMatrix = key;
      if (this.#labels.items.length > 0) {
        this.#labels.layout(cam, w, h);
      }
    };
    this.#raf = requestAnimationFrame(tick);
  }

  /* ---------------- 拾取 ---------------- */

  #onClick(ev: MouseEvent): void {
    const rt = this.runtime;
    if (!rt) return;
    const rect = this.#el.getBoundingClientRect();
    this.#ndc.set(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.#raycaster.setFromCamera(this.#ndc, rt.camera);
    const meshes: THREE.Mesh[] = [];
    for (const rec of this.#spaceRecs.values()) {
      if (rec.vol?.visible) meshes.push(rec.vol);
      if (rec.flat?.visible) meshes.push(rec.flat);
    }
    const hits = this.#raycaster.intersectObjects(meshes, false);
    const first = hits[0]?.object;
    const id = first ? this.#spaceByMesh.get(first) : undefined;
    this.select(id ?? null);
  }

  select(id: string | null): void {
    // 还原旧选中
    if (this.#selected) {
      const rec = this.#spaceRecs.get(this.#selected);
      for (const m of [rec?.vol, rec?.flat]) {
        if (!m) continue;
        const mat = m.material as THREE.MeshBasicMaterial;
        mat.color.set(VENT_STYLE[rec!.vm.vent].color);
        mat.opacity = ROOM_ALPHA;
      }
    }
    this.#selected = id;
    if (id) {
      const rec = this.#spaceRecs.get(id);
      for (const m of [rec?.vol, rec?.flat]) {
        if (!m) continue;
        const mat = m.material as THREE.MeshBasicMaterial;
        mat.color.set("#246FE5");
        mat.opacity = 1;
      }
      setStatus(`选中空间：${rec?.vm.name ?? id}`);
    }
    this.#requestLabelLayout();
    this.onChange?.();
  }
}

/* ------------------------------------------------------------------ */
/* UI：精简楼层选择器 + 图例                                            */
/* ------------------------------------------------------------------ */

function buildNav(demo: VentDemo): void {
  const nav = document.getElementById("nav");
  if (!nav) return;
  nav.innerHTML = "";

  const mk = (label: string, cls: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = cls;
    b.addEventListener("click", fn);
    return b;
  };

  // 只列有空间数据的楼层（真实页左侧同样只出现有数据的层）
  const floorsWithData = new Set(SPACE_VMS.map((s) => s.floorId));

  nav.appendChild(mk("项目", "primary", () => demo.showProject()));

  for (const b of DATA.buildingTree) {
    const floors = b.floors.filter((f) => floorsWithData.has(f.id));
    if (floors.length === 0) continue;

    const head = document.createElement("div");
    head.className = "nav-building";
    head.textContent = b.localName;
    nav.appendChild(head);

    for (const f of floors) {
      const active = demo.mode === "floor" && demo.floorId === f.id;
      nav.appendChild(mk(f.localName, active ? "active" : "", () => demo.showFloor(f.id)));
    }
    const sep = document.createElement("div");
    sep.className = "nav-sep";
    nav.appendChild(sep);
  }

  nav.appendChild(mk("全部建筑", "", () => demo.showProject()));
}

function buildLegend(mode: ViewMode): void {
  const legend = document.getElementById("legend");
  if (!legend) return;
  const spaceItems = (Object.keys(VENT_STYLE) as VentState[])
    .map(
      (k) =>
        `<span class="lg-item"><span class="sw" style="background:${VENT_STYLE[k].color}"></span>${VENT_STYLE[k].label}</span>`,
    )
    .join("");
  let html = `<span class="lg-title">空间状态:</span>${spaceItems}`;
  if (mode === "floor") {
    html += `<span class="divider"></span><span class="lg-title">设备状态:</span>
      <span class="lg-item"><span class="sw" style="background:#09B3B5"></span>开</span>
      <span class="lg-item"><span class="sw" style="background:#2E3742"></span>关</span>
      <span class="lg-item"><span class="sw" style="background:#C4C9CF"></span>无数据</span>
      <span class="divider"></span>
      <span class="lg-item"><span class="sw round" style="background:#F55047"></span>异常</span>`;
  }
  legend.innerHTML = html;
}

function updateCrumb(demo: VentDemo): void {
  const crumb = document.getElementById("crumb");
  const text = document.getElementById("crumb-text");
  if (!crumb || !text) return;
  if (demo.mode === "floor") {
    const f = DATA.buildingTree
      .flatMap((b) => b.floors.map((fl) => ({ fl, b })))
      .find((x) => x.fl.id === demo.floorId);
    text.textContent = `${f?.b.localName ?? ""}/${f?.fl.localName ?? ""}层`;
    crumb.style.display = "flex";
  } else {
    crumb.style.display = "none";
  }
}

function setStatus(text: string): void {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

/**
 * 数据快照不入库：缺文件时给一张说明卡，而不是让 demo 静默白屏。
 * 采集/生成步骤见 `apps/playground/README.md`「本地数据准备」。
 */
function showPrepareHint(err: unknown): void {
  const labels = document.getElementById("labels");
  if (!labels) return;
  // 没有数据就没有导航/图例可显示，避免留下一排空面板
  for (const id of ["nav", "legend", "crumb"]) {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  }
  labels.innerHTML = `
    <div class="prepare">
      <h2>未找到本地数据快照</h2>
      <p>这个 demo 跑在真实环境的采样数据上，<b>数据与 BIM 几何不随仓库分发</b>：</p>
      <ul>
        <li><code>public/data/vent/*.json</code> — 空间 / 设备 / 动态值快照</li>
        <li><code>public/bim/revit/*.json</code> — 逐层轻量化几何</li>
        <li><code>public/bim/07_building_relation/</code> — 建筑白模场景</li>
      </ul>
      <p>准备步骤见 <code>apps/playground/README.md</code>「本地数据准备」。</p>
      <p class="err">${String(err)}</p>
    </div>`;
}

async function boot(): Promise<void> {
  const el = document.getElementById("stage") as SceneEditorElement | null;
  if (!el) return;
  try {
    await loadData();
  } catch (err) {
    showPrepareHint(err);
    return;
  }
  const demo = new VentDemo(el);
  (window as unknown as { __ventDemo: VentDemo }).__ventDemo = demo;

  demo.onChange = () => {
    buildNav(demo);
    buildLegend(demo.mode);
    updateCrumb(demo);
  };

  document.getElementById("crumb")?.addEventListener("click", () => {
    if (demo.mode === "floor" && demo.buildingId) demo.showBuilding(demo.buildingId);
    else demo.showProject();
  });

  el.addEventListener("vent-ready", () => {
    buildNav(demo);
    buildLegend(demo.mode);
    updateCrumb(demo);
  });

  buildNav(demo);
  buildLegend(demo.mode);
  setStatus("加载 BIM 模型中…");
}

void boot();
