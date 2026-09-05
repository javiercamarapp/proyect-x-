import { defineConfig, devices } from '@playwright/test';
import { entornoLocalE2E } from './scripts/ci/e2e/entorno-local.mjs';

const entorno = entornoLocalE2E();

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PRUEBAS DE NAVEGADOR CONTRA LA APP PROPIA (E.27) — pruebas-navegador/
 *
 * Hasta hoy Playwright solo se apuntaba a CAPUFE (scripts/qa/) y al smoke de
 * rutas públicas (scripts/ci/playwright-smoke.mjs). Esta suite apunta al
 * producto: login real por magic link, tableros por rol, /admin bloqueado por
 * URL directa, el registro con sus filtros, el camino del dinero en el panel
 * y la vista móvil.
 *
 * CONTRA QUÉ CORRE: un `next start` local apuntado al Supabase LOCAL de
 * `supabase/config.toml` (GoTrue + PostgREST + Storage + Mailpit reales,
 * datos del seed del demo + `scripts/ci/e2e/sembrar-e2e.mjs`). Nunca contra
 * producción: las identidades son @likida.test y el sembrador rehúsa
 * cualquier host que no sea 127.0.0.1.
 *
 * Los archivos se llaman `*.nav.ts` por la misma razón que los arneses caros
 * se llaman `*.prueba.ts`: el include por defecto de vitest levanta cualquier
 * `*.{test,spec}.ts` del repo, y estos archivos solo corren bajo Playwright.
 *
 * Cómo correr en local (necesita Docker):
 *   # Sólo en una pila local desechable: respeta el preflight concurrente 0332.
 *   CI=true node scripts/ci/e2e/iniciar-pila.mjs
 *   eval "$(npx supabase status -o env | grep -E 'ANON_KEY|SERVICE_ROLE_KEY|API_URL')"
 *   PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
 *     -v ON_ERROR_STOP=1 -f scripts/ci/e2e/grants-locales.sql
 *   # ↑ SIN este paso, `supabase start` no propaga a anon/authenticated/
 *   #   service_role los GRANT de tabla que sí trae producción — la primera
 *   #   consulta real truena con "permission denied". Ver la cabecera de
 *   #   ese .sql.
 *   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY \
 *     node scripts/ci/e2e/sembrar-e2e.mjs
 *   (build + start con `next start --hostname localhost` — NO `127.0.0.1`:
 *    ver la cabecera de `supabase/config.toml` [auth], el mismatch de host
 *    que rompe el login real con `--hostname 127.0.0.1` — y las env del
 *    workflow e2e-navegador.yml)
 *   npm run test:e2e
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default defineConfig({
  testDir: './pruebas-navegador',
  testMatch: '**/*.nav.ts',
  // UN worker, en orden: la suite comparte UNA base y UN servidor, y el
  // límite del login (10 correos / 5 min por IP, login/page.tsx) se comparte
  // entre todas las pruebas — el presupuesto de envíos está contado en
  // apoyo/sesion.ts y el paralelismo lo volvería una carrera.
  fullyParallel: false,
  workers: 1,
  // CERO reintentos: un flake que se reintenta en silencio es un flake que
  // nadie arregla. Si una prueba parpadea, que se vea rojo y se mire.
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    // El reporte HTML con trazas es el artefacto que sube CI cuando falla:
    // sin él, depurar un rojo de CI es adivinar.
    ['html', { open: 'never', outputFolder: 'pruebas-navegador/.reporte' }],
  ],
  outputDir: 'pruebas-navegador/.artefactos',
  use: {
    serviceWorkers: 'block',
    // `localhost`, no `127.0.0.1` — ver la cabecera de este archivo y de
    // `supabase/config.toml` [auth].
    baseURL: entorno.app,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'es-MX',
    timezoneId: 'America/Mexico_City',
  },
  projects: [
    // `preparar` hace el login por magic link UNA vez por identidad y guarda
    // las cookies (storageState). El login como FLUJO se prueba aparte en
    // login.nav.ts; esto solo evita repagar 3 correos en cada archivo.
    { name: 'preparar', testMatch: /preparar\.nav\.ts/ },
    {
      name: 'escritorio',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['preparar'],
      testIgnore: [/preparar\.nav\.ts/, /movil\.nav\.ts/],
    },
    {
      // Teléfono REAL de catálogo (Pixel 7: 412×915, DPR 2.625, táctil, UA
      // móvil) — no una ventana de escritorio encogida. El único navegador
      // disponible es Chromium (el mismo del smoke), así que la vista iOS
      // (WebKit) queda declarada como hueco, no fingida.
      name: 'movil',
      use: { ...devices['Pixel 7'] },
      dependencies: ['preparar'],
      testMatch: /movil\.nav\.ts/,
    },
  ],
});
