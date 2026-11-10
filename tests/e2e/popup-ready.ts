import type { Page } from '@playwright/test';
import { expect } from './fixtures';

/** A page attribute changes inside the transition callback, before pointer input is ready. */
export async function waitForPopupMotion(page: Page): Promise<void> {
  await expect(page.locator('html')).not.toHaveAttribute('data-vt-busy', '1');
}
