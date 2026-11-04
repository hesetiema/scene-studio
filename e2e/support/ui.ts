import type { Page } from "@playwright/test";

/**
 * 面板折叠状态：低频分组默认收起，组内低频参数收在「更多设置」里。
 * e2e 直接改 `open`，等价于用户点标题，且不受滚动位置影响。
 */
export async function openGroup(page: Page, groupId: string): Promise<void> {
  await page.evaluate((id) => {
    const group = document.querySelector<HTMLDetailsElement>(`#${id}`);
    if (group && !group.open) group.open = true;
  }, groupId);
}

export async function openAdvanced(page: Page, groupId: string): Promise<void> {
  await page.evaluate((id) => {
    const more = document.querySelector<HTMLDetailsElement>(`#${id} details.more`);
    if (more && !more.open) more.open = true;
  }, groupId);
}
