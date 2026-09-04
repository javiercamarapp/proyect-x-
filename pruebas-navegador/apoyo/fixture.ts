import { test as base } from '@playwright/test';
import { crearProxyLocalE2E } from '../../scripts/ci/e2e/proxy-local.mjs';

// Browser entero: cubre páginas con storageState, contextos nuevos y popups.
// <-loopback> desactiva el bypass implícito de Chromium para localhost.
export const test = base.extend<object, { proxyLocal: string }>({
  proxyLocal: [async ({}, usar) => {
    const proxy = await crearProxyLocalE2E();
    try { await usar(proxy.server); } finally { await proxy.close(); }
  }, { scope: 'worker' }],
  browser: async ({ playwright, browserName, launchOptions, proxyLocal }, usar) => {
    const browser = await playwright[browserName].launch({
      ...launchOptions, proxy: { server: proxyLocal, bypass: '<-loopback>' },
    });
    try { await usar(browser); } finally { await browser.close(); }
  },
});
export { expect, request, type Page } from '@playwright/test';
