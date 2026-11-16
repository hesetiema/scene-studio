/**
 * 可撤销聚合链。
 *
 * 每次碰撞吸收都记一条操作（含被吸收者原来的父节点），因此：
 *   - clear() 可以按逆序完整回滚，供下一帧重算使用；
 *   - undo() 可以逐步回退，宿主做「展开聚合」时不必重建模型；
 *   - 被吸收者若已有父节点，会先从旧父节点摘下再挂到新根，链条不会串成环。
 */
import type { GraphModel } from "./graph-model";

interface AbsorbOperation {
  absorber: GraphModel;
  absorbed: GraphModel;
  previousParent: GraphModel | null;
}

export class AggregationChain {
  #operations: AbsorbOperation[] = [];

  absorb(absorber: GraphModel, absorbed: GraphModel): boolean {
    const root = absorber.root;
    if (root === absorbed || absorbed.root === root) return false;
    const previousParent = absorbed.absorbTo;
    if (previousParent) previousParent.detach(absorbed);
    root.attach(absorbed);
    absorbed.setState("absorbed", true);
    this.#operations.push({ absorber: root, absorbed, previousParent });
    return true;
  }

  undo(): boolean {
    const op = this.#operations.pop();
    if (!op) return false;
    op.absorber.detach(op.absorbed);
    op.absorbed.setState("absorbed", false);
    if (op.previousParent) op.previousParent.attach(op.absorbed);
    return true;
  }

  /** 逆序回滚全部吸收操作（每帧碰撞重算前调用）。 */
  clear(): void {
    while (this.undo()) {
      /* 空循环：undo 自身维护栈 */
    }
  }

  get size(): number {
    return this.#operations.length;
  }

  get operations(): readonly AbsorbOperation[] {
    return this.#operations;
  }
}
