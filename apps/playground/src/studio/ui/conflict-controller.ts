import type { ConflictDocuments, SceneDocument } from "@scenio/scene-editor";
import type { HUDController } from "./hud-controller";
import { BasePanel } from "./panel";

export interface ConflictControllerOptions {
  hud: HUDController;
  /** Adopt the remote document: the host loads it and re-bases the save loop. */
  adoptRemote: (remote: SceneDocument) => Promise<void>;
  /** Overwrite the server with the local document; returns the new revision. */
  overwriteRemote: (local: SceneDocument, remote: SceneDocument) => number;
}

/**
 * The host half of D17/D18: the SDK refuses to merge and hands back both sides,
 * so *someone* has to ask the user which version wins. This is that someone.
 *
 * Three exits, all of them explicit — no silent overwrite, no auto-merge:
 * 保留本地 (server ← local, revision +1), 采用远端 (load remote, drop local),
 * 稍后 (hide the bar; the footer keeps saying 冲突 and the next save re-asks).
 */
export class ConflictController extends BasePanel {
  readonly #options: ConflictControllerOptions;
  #pending: ConflictDocuments | null = null;

  constructor(options: ConflictControllerOptions) {
    super();
    this.#options = options;
  }

  mount(): void {
    this.click("#conflict-overwrite", () => this.overwrite());
    this.click("#conflict-adopt", () => void this.adopt());
    this.click("#conflict-later", () => this.hide());
  }

  get pending(): ConflictDocuments | null {
    return this.#pending;
  }

  /** Surface a conflict: the bar above the viewport plus the footer state. */
  show(docs: ConflictDocuments): void {
    this.#pending = docs;
    const local = docs.local.objects.length;
    const remote = docs.incoming.objects.length;
    const text = document.querySelector("#conflict-text");
    if (text) {
      text.textContent =
        `远端已推进到 r${docs.incoming.revision}（${remote} 个部件），` +
        `本地有未保存改动（r${docs.local.revision}，${local} 个部件）`;
    }

    const bar = document.querySelector<HTMLElement>("#conflict-bar");
    if (bar) bar.hidden = false;
    document.body.dataset.conflict = "true";
    this.#options.hud.setConflict(docs.incoming.revision);
  }

  /** Dismiss the bar without resolving anything. */
  hide(): void {
    const bar = document.querySelector<HTMLElement>("#conflict-bar");
    if (bar) bar.hidden = true;
  }

  /** Drop the pending conflict (after a resolution, a save or a fresh load). */
  clear(): void {
    this.#pending = null;
    this.hide();
    delete document.body.dataset.conflict;
    this.#options.hud.setConflict(null);
  }

  /** 保留本地: write the local document over the server's revision. */
  overwrite(): void {
    const docs = this.#pending;
    if (!docs) return;
    try {
      const revision = this.#options.overwriteRemote(docs.local, docs.incoming);
      this.clear();
      this.#options.hud.showToast(`已保留本地版本，写入修订 ${revision}`);
    } catch (error) {
      this.#options.hud.showToast(
        error instanceof Error ? `保留本地失败：${error.message}` : "保留本地失败",
      );
    }
  }

  /** 采用远端: drop local edits and load the server's document. */
  async adopt(): Promise<void> {
    const docs = this.#pending;
    if (!docs) return;
    try {
      await this.#options.adoptRemote(docs.incoming);
      this.clear();
      this.#options.hud.showToast(`已采用远端版本（修订 ${docs.incoming.revision}）`);
    } catch (error) {
      this.#options.hud.showToast(
        error instanceof Error ? `采用远端失败：${error.message}` : "采用远端失败",
      );
    }
  }
}
