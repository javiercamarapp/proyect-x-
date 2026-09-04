import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// Auditoría 5 · CRÍTICO «No hay observabilidad en producción», punto 3:
// «No hay `Sentry.init` en `src/instrumentation.ts` […], no hay export
// `onRequestError` […]. Una excepción no atrapada en un Server Component del
// panel o en la ruta de export no llega nunca.»
//
// Y el ALTO del error boundary: `src/app/` no importa el `logger` en ninguna
// parte salvo el webhook, así que las tres superficies web fallan sin registrar.
// `onRequestError` es el único punto que las cubre a todas sin tocar `src/app/`.
//
// Estas pruebas NO llaman a `register()`: eso corre las RPC de migraciones
// contra Supabase de verdad. `onRequestError` es independiente.
// ═══════════════════════════════════════════════════════════════════════════

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('onRequestError — el fallo de una superficie web deja línea', () => {
  it('registra ruta, tipo y digest de un fallo de Server Component', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { onRequestError } = await import('./instrumentation');

    const e = Object.assign(new Error('supabase se cayó'), { digest: '3155718393' });
    await onRequestError(
      e,
      { path: '/dashboard/abc', method: 'GET', headers: {} },
      { routerKind: 'App Router', routePath: '/dashboard/[id]', routeType: 'render' },
    );

    const linea = String(spy.mock.calls[0][0]);
    expect(linea).toContain('request.fail');
    expect(linea).toContain('/dashboard/[id]');
    expect(linea).toContain('3155718393'); // el hash que el usuario ve en pantalla
    expect(linea).toContain('supabase se cayó');
  });

  it('el identificador del fallo va redactado como el resto de los logs', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { onRequestError } = await import('./instrumentation');
    const { huellaId } = await import('@/lib/logger');

    const uuid = '11111111-1111-1111-1111-111111111111';
    await onRequestError(
      new Error(`tenant ${uuid} sin config`),
      { path: `/dashboard/${uuid}`, method: 'GET', headers: {} },
      { routerKind: 'App Router', routePath: '/dashboard/[id]', routeType: 'render' },
    );

    const linea = String(spy.mock.calls[0][0]);
    expect(linea).not.toContain(uuid);
    expect(linea).toContain(huellaId(uuid));
  });

  it('nunca lanza: un fallo del reporte no puede sumarse al fallo original', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { onRequestError } = await import('./instrumentation');
    // Argumentos deformes a propósito (Next puede cambiar la forma del contexto).
    await expect(
      onRequestError('no soy un Error', undefined as never, undefined as never),
    ).resolves.toBeUndefined();
  });
});

// ── AUDITORÍA 6 · el cable, no la función ──────────────────────────────────
//
// La ronda encontró DOS mecanismos correctos, con pruebas unitarias, que nadie
// llamaba: `sondearAvisoIntegral` y `flushObservabilidad`. Sus pruebas pasaban
// porque probaban la función en aislamiento — exactamente lo que el rubro de
// pruebas señaló como el modo de falla dominante del repo.
//
// El comentario de arriba dice que estas pruebas NO llaman a `register()`
// porque dispararía las RPC contra Supabase. Con los módulos mockeados sí se
// puede, y es la única forma de fijar el cable.
describe('register — el arranque llama a todo lo que dice que llama', () => {
  it('sonda el aviso de privacidad, no solo las migraciones', async () => {
    const verificarMigracionesCriticas = vi.fn(async () => {});
    const verificarAvisoDePrivacidad = vi.fn(async () => {});
    vi.doMock('@/lib/likida/startup', () => ({ verificarMigracionesCriticas, verificarAvisoDePrivacidad }));
    vi.doMock('@/lib/observability/sentry', () => ({
      avisarObservabilidad: vi.fn(), precargar: vi.fn(async () => {}),
    }));
    vi.doMock('@/lib/observability/arranque', () => ({ avisarConfiguracionSilenciosa: vi.fn() }));
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');

    const { register } = await import('./instrumentation');
    await register();

    expect(verificarMigracionesCriticas).toHaveBeenCalled();
    // ESTE es el hallazgo: la función existía y `register` no la invocaba.
    expect(verificarAvisoDePrivacidad).toHaveBeenCalled();
  });

  // AUDITORÍA 18, BAJO (B11): el sondeo del aviso hace red externa (hasta 10s)
  // y `register()` lo esperaba — la primera petición de una instancia fría
  // pagaba ese tiempo antes del primer 200 a Meta.
  it('el sondeo del aviso de privacidad NO bloquea el arranque', async () => {
    const verificarAvisoDePrivacidad = vi.fn(() => new Promise<void>(() => { /* nunca contesta: el host caído */ }));
    vi.doMock('@/lib/likida/startup', () => ({
      verificarMigracionesCriticas: vi.fn(async () => {}), verificarAvisoDePrivacidad,
    }));
    vi.doMock('@/lib/observability/sentry', () => ({ avisarObservabilidad: vi.fn(), precargar: vi.fn(async () => {}) }));
    vi.doMock('@/lib/observability/arranque', () => ({ avisarConfiguracionSilenciosa: vi.fn() }));
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');

    const { register } = await import('./instrumentation');
    const carrera = await Promise.race([register().then(() => 'arrancó'), new Promise((r) => setTimeout(() => r('colgado'), 200))]);
    expect(carrera).toBe('arrancó');
    expect(verificarAvisoDePrivacidad).toHaveBeenCalled(); // y sí se dispara
  });

  // ═══════════════════════════════════════════════════════════════════════
  // El probe 0172 antiguo insertaba y borraba un tenant. Si vuelve a cablearse,
  // una promesa colgada vuelve a bloquear cada arranque frío.
  // ═══════════════════════════════════════════════════════════════════════
  it('no ejecuta ni espera el antiguo probe mutativo 0172', async () => {
    const probeMutativoQueNuncaTermina = vi.fn(() => new Promise<void>(() => {}));
    vi.doMock('@/lib/likida/startup', () => ({
      verificarMigracionesCriticas: vi.fn(async () => {}),
      verificarAvisoDePrivacidad: vi.fn(async () => {}),
      verificarSondeoEscritura0172: probeMutativoQueNuncaTermina,
    }));
    vi.doMock('@/lib/observability/sentry', () => ({ avisarObservabilidad: vi.fn(), precargar: vi.fn(async () => {}) }));
    vi.doMock('@/lib/observability/arranque', () => ({ avisarConfiguracionSilenciosa: vi.fn() }));
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');

    const { register } = await import('./instrumentation');
    const carrera = await Promise.race([
      register().then(() => 'arrancó'),
      new Promise((r) => setTimeout(() => r('colgado'), 200)),
    ]);
    expect(carrera).toBe('arrancó');
    expect(probeMutativoQueNuncaTermina).not.toHaveBeenCalled();
  });

  it('fuera del runtime de Node no arranca nada', async () => {
    const verificarAvisoDePrivacidad = vi.fn(async () => {});
    vi.doMock('@/lib/likida/startup', () => ({
      verificarMigracionesCriticas: vi.fn(async () => {}), verificarAvisoDePrivacidad,
    }));
    vi.stubEnv('NEXT_RUNTIME', 'edge');

    const { register } = await import('./instrumentation');
    await register();
    expect(verificarAvisoDePrivacidad).not.toHaveBeenCalled();
  });
});
