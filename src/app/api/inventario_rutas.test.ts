import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// ═══════════════════════════════════════════════════════════════════════════
// CADA RUTA NUEVA DE /api PASA POR UNA REVISIÓN CONSCIENTE (auditoría 21).
//
// El matcher de `proxy.ts` EXCLUYE todo `/api` a propósito (decisión de
// diseño documentada en su cabecera: webhook, demo, export manejan lo suyo y
// no deben pasar por el gate ni cargar cabeceras de página). Eso significa
// que cada `route.ts` bajo `src/app/api/` es su PROPIA y ÚNICA puerta:
// sesión + rol + tenant los resuelve el archivo mismo, sin red de respaldo
// del lado del proxy — a diferencia de /dashboard y /admin, que tienen la
// puerta de proxy.ts MÁS la de la página.
//
// Hoy (auditoría 21) las 64 rutas fueron revisadas y todas tienen su puerta
// bien construida. El riesgo no es ninguna de ellas: es la ruta 65 — un
// endpoint futuro al que se le olvide una de las tres comprobaciones no
// tiene ningún gate anterior que lo atrape; se sirve.
//
// Esta prueba NO agrega esa segunda capa (revertir la exclusión del proxy
// sobre 64 rutas es otro trabajo, con otro riesgo). Es el MECANISMO DE
// CONTENCIÓN: inventaría el disco —no una lista que alguien mantenga— y
// compara contra la constante de abajo. Crecer la superficie sin tocar este
// archivo pone la suite en rojo; tocar este archivo es el momento de la
// revisión. El mismo trato que ya reciben los previews (sin_previews.test.ts).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El número de archivos `route.ts` bajo `src/app/api/` que YA fueron
 * revisados (auditoría 21, 29-ago-2026: sesión + rol + tenant confirmados
 * en las 64, con las excepciones públicas documentadas en cada archivo).
 *
 * 64 → 65 el 1-sep-2026 (auditoría 24): entra `v1/operadores/route.ts`. Su
 * puerta es la de /v1 —`abrir(req, área)`, que resuelve credencial, tasa,
 * rol/área y tenant antes de leer el cuerpo—, con `operacion` para el GET y
 * `administracion` para el POST; el tenant sale SIEMPRE de la credencial y un
 * `tenant_id` en el cuerpo no se lee. Fijado en `v1/operadores/route.test.ts`
 * y en el guardia de áreas del OpenAPI.
 *
 * Si vas a subir este número: primero confirma que la ruta nueva trae su
 * propia puerta COMPLETA — sesión (o firma de webhook / llave de API / secreto
 * de cron), rol y tenant — ANTES de procesar nada. El proxy no la va a salvar.
 */
// 1-sep-2026 (auditoría 24, BLOQ-6): +1 por `v1/liquidaciones/route.ts`.
// Su puerta: `abrir(req, 'dinero')` —llave API por área o cookie+CSRF— antes
// de tocar la base, y `.eq('tenant_id', acceso.tenantId)` en la única consulta.
// 3-sep-2026 (auditoría 25, ALTO): +1 por `client-error/route.ts`. SIN
// sesión a propósito, mismo criterio que `health/route.ts` y `lead/route.ts`:
// es el destino de un fallo de CLIENTE (el layout raíz truena antes de que
// la sesión se pueda leer), así que exigir sesión sería pedirle al reporte
// del fallo la misma cosa que acaba de fallar. Su puerta es otra: rate limit
// por IP (`client-error:${clientIp}`, 20/min), tope de cuerpo (4 KB) aplicado
// durante la lectura streaming (`leerTextoAcotado`), `level` acotado a {warn,error} y
// `msg`/`meta` saneados (sin saltos de línea, `meta` solo si es objeto plano)
// ANTES de tocar `logger.error`/Sentry — no filtra dato de negocio ni tenant.
const RUTAS_API_REVISADAS = 67; // 66 (revision: v1/liquidaciones) + 1 (nueva: client-error)

function rutasApi(): string[] {
  const raiz = join(process.cwd(), 'src', 'app', 'api');
  return readdirSync(raiz, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name === 'route.ts')
    .map((e) => relative(raiz, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort();
}

describe('la superficie /api no crece en silencio', () => {
  it(`hay exactamente ${RUTAS_API_REVISADAS} route.ts bajo src/app/api`, () => {
    const rutas = rutasApi();

    const mensaje = rutas.length > RUTAS_API_REVISADAS
      ? 'Una ruta nueva de /api apareció sin que nadie confirme que tiene su propia ' +
        'sesión+rol+tenant — revísala y sube esta constante (RUTAS_API_REVISADAS en ' +
        'este archivo). Recuerda: proxy.ts excluye /api entero, así que la puerta que ' +
        'esa ruta escriba adentro es la ÚNICA que tiene.\n\nInventario actual ' +
        `(${rutas.length}):\n  ` + rutas.join('\n  ')
      : 'Desaparecieron rutas de /api (¿se borró o movió un endpoint?). Si fue a ' +
        'propósito, baja RUTAS_API_REVISADAS en este archivo para que el inventario ' +
        `siga siendo verdad.\n\nInventario actual (${rutas.length}):\n  ` + rutas.join('\n  ');

    expect(rutas.length, mensaje).toBe(RUTAS_API_REVISADAS);
  });
});
