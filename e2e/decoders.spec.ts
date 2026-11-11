import { expect, test } from "@playwright/test";

/**
 * `decoder-path` / `decoder-cdn`: a compressed glTF used to be unopenable.
 *
 * `GLTFLoader` refuses to parse `KHR_draco_mesh_compression` without a
 * `DRACOLoader`, and nothing in the element built one — so the flagship format
 * of any asset pipeline (Draco GLB) produced a blank canvas plus a stack trace
 * nobody surfaced. These two tests pin both halves of the fix: the failure now
 * explains itself, and one attribute makes it load.
 *
 * The model and the decoder payloads are local (generated with
 * `gltf-transform draco`, payloads copied from `three/examples/jsm/libs`), so
 * this spec never touches the network.
 */

const DRACO_MODEL = "/assets/tri-draco.glb";
const LOCAL_PAYLOADS = "/decoders/";

interface DecoderProbe {
  errors: string[];
  loadedInCallback: boolean;
  dims: { width: number; height: number; depth: number };
}

async function probe(
  page: import("@playwright/test").Page,
  attributes: Record<string, string>,
): Promise<DecoderProbe> {
  return page.evaluate(async (attrs) => {
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    document.querySelectorAll("scene-editor").forEach((node) => node.remove());

    type El = HTMLElement & {
      ready: Promise<void>;
      loaded: boolean;
      getDimensions(): { width: number; height: number; depth: number };
    };
    const el = document.createElement("scene-editor") as El;
    el.style.width = "640px";
    el.style.height = "480px";

    const errors: string[] = [];
    let loadedInCallback = false;
    el.addEventListener("error", (event) => {
      const detail = (event as unknown as CustomEvent<{ message: string }>).detail;
      errors.push(detail.message);
    });
    el.addEventListener("load", () => {
      loadedInCallback = el.loaded;
    });
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);

    document.body.appendChild(el);
    await el.ready;
    // Wait for a definitive signal (load or error) instead of a fixed 3 s:
    // under a fully parallel e2e run the Draco wasm fetch sometimes took
    // longer than that, flaking both cases at random.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && errors.length === 0 && !loadedInCallback) {
      await wait(100);
    }
    return { errors, loadedInCallback, dims: el.getDimensions() };
  }, attributes);
}

test("a Draco model without a decoder explains what is missing", async ({ page }) => {
  await page.goto("/minimal.html");
  await page.waitForFunction(() => Boolean(customElements.get("scene-editor")));

  const result = await probe(page, { src: DRACO_MODEL });

  expect(result.errors).toHaveLength(1);
  // three says "No DRACOLoader instance provided"; the element shows the fix.
  expect(result.errors[0]).toContain("decoder-path");
  expect(result.loadedInCallback).toBe(false);
});

test("decoder-path loads the same model and pulls the dracos payload", async ({ page }) => {
  const payloadRequests: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (/draco_(wasm_wrapper\.js|decoder\.wasm)/.test(url)) payloadRequests.push(url);
  });

  await page.goto("/minimal.html");
  await page.waitForFunction(() => Boolean(customElements.get("scene-editor")));

  const result = await probe(page, {
    src: DRACO_MODEL,
    "decoder-path": LOCAL_PAYLOADS,
  });

  expect(result.errors).toEqual([]);
  expect(result.loadedInCallback).toBe(true);
  // A 3-vertex triangle is still a real bounds, not the 1x1x1 placeholder.
  expect(result.dims.width).toBeGreaterThan(0);
  expect(result.dims.height).toBeGreaterThan(0);
  // The wasm was fetched from the configured base, not from a CDN.
  expect(payloadRequests.some((url) => url.includes(`${LOCAL_PAYLOADS}draco/gltf/`))).toBe(true);
});
