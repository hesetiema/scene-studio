/**
 * Scenario router for `minimal.html`.
 *
 * The SDK-coverage pages used to be seven standalone HTML entry points under
 * `/demos/*.html`. They are now **scenarios of one page**: `?demo=<name>` injects
 * the page's markup into `minimal.html` and then dynamically imports the very
 * same TypeScript module that used to be its `<script>`.
 *
 * Why keep the modules untouched: every `window.__demo` / `__docDemo` /
 * `__coverage` / `__assets` / `__viewerDemo` hook, every `data-demo="ready"`
 * flag and every DOM id stays byte-for-byte identical, so the 25 Playwright
 * cases only have to change their URL. The markup files are raw fragments now,
 * not documents Vite serves as entries.
 *
 * Loading is deliberately lazy: static `?raw` imports carry only markup strings,
 * while each scenario's SDK code lands in its own on-demand chunk. A page that
 * never opens `?demo=viewer` never parses the 33 kB viewer harness.
 */
import assetsMarkup from "./markup/assets.html?raw";
import compareMarkup from "./markup/compare.html?raw";
import documentMarkup from "./markup/document.html?raw";
import headlessMarkup from "./markup/headless.html?raw";
import hostApiMarkup from "./markup/host-api.html?raw";
import hubMarkup from "./markup/index.html?raw";
import viewerMarkup from "./markup/viewer.html?raw";

interface Scenario {
  title: string;
  markup: string;
  /** Omitted for the hub: it is pure markup, no SDK code to run. */
  load?: () => Promise<unknown>;
}

export const SCENARIOS: Readonly<Record<string, Scenario>> = {
  hub: { title: "SDK 能力场景", markup: hubMarkup },
  "host-api": { title: "宿主编辑 API", markup: hostApiMarkup, load: () => import("./host-api") },
  document: { title: "文档模型", markup: documentMarkup, load: () => import("./document") },
  headless: { title: "Headless 自检", markup: headlessMarkup, load: () => import("./headless") },
  assets: { title: "资产加载", markup: assetsMarkup, load: () => import("./assets") },
  viewer: { title: "Viewer 对标 model-viewer", markup: viewerMarkup, load: () => import("./viewer") },
  compare: { title: "并排对照", markup: compareMarkup, load: () => import("./compare") },
};

export function hasScenario(name: string | null): name is string {
  return name !== null && Object.hasOwn(SCENARIOS, name);
}

/**
 * Turn a former demo document into an injectable fragment:
 *  - head `<style>` blocks are carried along (checkerboard, comparison chrome);
 *    `demo.css` is linked from `minimal.html` instead of duplicated per page;
 *  - `<script>` tags are dropped — this router loads the module itself;
 *  - internal `/demos/*.html` links are rewritten to `?demo=` routes so the
 *    back links and the hub cards keep working after the directory is gone.
 */
export function scenarioMarkup(raw: string): string {
  const styles = [...raw.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)]
    .map((match) => match[0])
    .join("\n");
  const body = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/)?.[1] ?? "";
  return (
    styles +
    body
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/\/demos\/([\w-]+)\.html/g, "/minimal.html?demo=$1")
      .replace(/\/demos\//g, "/minimal.html?demo=hub")
      .replaceAll("← 全部 demo", "← 全部场景")
  );
}

/** Inject one scenario's DOM, then let its module take over (hook + ready flags). */
export async function bootScenario(name: string): Promise<void> {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario: ${name}`);

  // The minimal demo's inline styles target `#status` / `#log` / `#bar` by id
  // and would outrank the scenario's class-based chrome. Remove them only in
  // scenario mode; the bare `/minimal.html` keeps its original look untouched.
  document.getElementById("minimal-style")?.remove();
  document.body.dataset.scenario = name;
  document.body.innerHTML = scenarioMarkup(scenario.markup);
  document.title = `${scenario.title} · scene-editor`;

  // `body.dataset.demo = "ready"` / `dataset.coverage` are set by the scenario
  // module itself — the router must not fake a readiness signal.
  if (scenario.load) await scenario.load();
}
