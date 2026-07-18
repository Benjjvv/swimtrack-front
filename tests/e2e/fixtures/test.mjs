import { test as base, expect } from '@playwright/test';

import { MonitorPage } from '../support/monitor-page.mjs';

/** Fixtures compartidas para que nuevos flujos E2E no repliquen selectores ni navegación. */
export const test = base.extend({
  monitor: async ({ page }, use) => {
    await use(new MonitorPage(page));
  },
});

export { expect };
