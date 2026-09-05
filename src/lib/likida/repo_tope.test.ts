import { describe, it, expect, afterAll } from 'vitest';
import net from 'node:net';

// ═══════════════════════════════════════════════════════════════════════════
// NINGUNA CONSULTA DEL SISTEMA LLEVABA TECHO.
//
// `supabaseAdmin()` construye el cliente sin `fetch` propio, así que todas las
// consultas y RPC heredaban el default de undici: `headersTimeout` y
// `bodyTimeout` de 300 000 ms. Un socket ACEPTADO que nunca contesta —el
// balanceador que se queda a medias, no el host caído— bloquea cinco minutos.
//
// Vercel mata la función a los 120s. O sea que la consulta se rinde 180s DESPUÉS
// de que ya no hay nadie a quien contestarle, y ese final es el peor de todos:
// la liquidación quedó escrita en la base, el operador no recibe ni el resumen
// ni el PDF, el `logger.error('pdf.no_entregado')` tampoco se escribe porque el
// proceso muere antes del `catch`, y Meta ya recibió su 200 y no reintenta.
//
// MEDIDO EN ESTA MÁQUINA, contra el servidor de abajo (acepta la conexión y no
// escribe nada nunca):
//
//   `fetch()` global de Node v25.9.0 .......... SIGUE BLOQUEADO a los 20 036 ms
//   getViaje() antes de este arreglo .......... SIGUE BLOQUEADA a los 12 000 ms
//   getViaje() con TOPE_CONSULTA_MS=1500 ...... devuelve error en ~1 500 ms
//
// El servidor es local: no hay red, no hay Supabase y no se gasta un centavo.
// ═══════════════════════════════════════════════════════════════════════════

const conexionesMudas = new Set<net.Socket>();
const servidorMudo = net.createServer((s) => {
  conexionesMudas.add(s);
  s.on('close', () => conexionesMudas.delete(s));
  s.on('error', () => {}); /* acepta y calla */
});
await new Promise<void>((resolve, reject) => {
  // Fallar al abrir el socket (p. ej. sandbox) debe rechazar la importación;
  // sin listener de error la suite espera una promesa que nunca se resuelve.
  servidorMudo.once('error', reject);
  servidorMudo.listen(0, '127.0.0.1', () => {
    servidorMudo.off('error', reject);
    resolve();
  });
});
const puerto = (servidorMudo.address() as net.AddressInfo).port;

// Van ANTES del import: `supabaseAdmin()` lee la URL al construir el cliente y
// `TOPE_CONSULTA_MS` lee su env al cargar el módulo.
//
// AUDITORÍA 8: `process.env.X = ...` NO se auto-restaura entre archivos de
// prueba (a diferencia de `vi.stubEnv`) — es estado del proceso de Node, y
// vitest puede correr varios archivos en el mismo worker. Sin este `afterAll`,
// este archivo dejaba `NEXT_PUBLIC_SUPABASE_URL` apuntando al servidor mudo
// para CUALQUIER prueba que corriera después en el mismo worker.
const ENV_ORIGINAL = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  tope: process.env.LIKIDA_TOPE_CONSULTA_MS,
};
process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${puerto}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'llave-falsa-para-la-medicion';
process.env.LIKIDA_TOPE_CONSULTA_MS = '1500';   // el de producción son 8 000

const { getViaje, getGastos, gastoExistePorHash, saveLiquidacion } = await import('./repo');
const { TOPE_CONSULTA_MS } = await import('./presupuesto');

afterAll(async () => {
  // Los aborts de fetch no garantizan que undici cierre de inmediato los
  // sockets en pool. Cerrarlos explícitamente evita que el worker siga vivo
  // después de que todas las assertions ya pasaron.
  for (const socket of conexionesMudas) socket.destroy();
  await new Promise<void>((resolve) => servidorMudo.close(() => resolve()));
  if (ENV_ORIGINAL.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = ENV_ORIGINAL.url;
  if (ENV_ORIGINAL.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = ENV_ORIGINAL.key;
  if (ENV_ORIGINAL.tope === undefined) delete process.env.LIKIDA_TOPE_CONSULTA_MS; else process.env.LIKIDA_TOPE_CONSULTA_MS = ENV_ORIGINAL.tope;
});

const CORTE_MS = 12_000;   // muy por encima del tope; si se llega, es que no hay tope

/** Corre `fn` y devuelve cuánto tardó en ASENTARSE, o `null` si se pasó del corte. */
async function tardanza(fn: () => Promise<unknown>): Promise<number | null> {
  const t0 = performance.now();
  const gano = await Promise.race([
    fn().then(() => 'asienta', () => 'asienta'),
    new Promise<'colgada'>((r) => setTimeout(() => r('colgada'), CORTE_MS)),
  ]);
  return gano === 'colgada' ? null : performance.now() - t0;
}

describe('repo.ts contra una base que acepta la conexión y no contesta', () => {
  it('una lectura se rinde en su tope en vez de colgar la invocación', async () => {
    const ms = await tardanza(() => getViaje('v1', 't1').catch(() => null));
    expect(ms, `getViaje seguía bloqueada a los ${CORTE_MS} ms: no hay techo`).not.toBeNull();
    expect(ms!).toBeLessThan(TOPE_CONSULTA_MS + 4_000);
  }, 20_000);

  it('una escritura por RPC también se rinde', async () => {
    // El cierre pasa por aquí (`guardar_liquidacion_tx`). Es el viaje de red que
    // no se puede permitir colgar: si cuelga, la liquidación ni se escribe.
    const ms = await tardanza(() => saveLiquidacion('t1', {
      viajeId: 'v1', totalComprobado: 0, totalAnticipo: 0, diferencia: 0, estatus: 'cuadrada',
      totalDeducible: 0, totalNoDeducible: 0, totalPorConfirmar: 0, diferencias: [], gastos: [],
      iepsAcreditable: 0, litrosDieselAcreditables: 0, ivaAcreditable: 0, peajeAcreditable: 0,
    }).catch(() => null));
    expect(ms, `saveLiquidacion seguía bloqueada a los ${CORTE_MS} ms`).not.toBeNull();
    expect(ms!).toBeLessThan(TOPE_CONSULTA_MS + 4_000);
  }, 20_000);

  it('agotar el tope se cuenta como fallo de lectura, no como "no hay nada"', async () => {
    // Es lo que hace que este arreglo sea seguro: el tope no inventa una tercera
    // forma de fallar. Entra por el MISMO camino que ya tenía un error de
    // Postgres, así que cada llamador conserva su semántica —`getGastos` lanza,
    // y arriba el `catch` de `processInbound` responde algo al operador— en vez
    // de que un tenant sin datos y una base muda se vean igual.
    await expect(getGastos('v1', 't1')).rejects.toThrow(/getGastos/);
  }, 20_000);

  it('lo que era best-effort SIGUE siendo best-effort', async () => {
    // `gastoExistePorHash` devuelve false ante cualquier fallo de lectura a
    // propósito (preferimos un raro duplicado a perder un gasto). El tope no
    // puede convertir eso en una excepción que tumbe el intake.
    await expect(gastoExistePorHash('v1', 'hash', 't1')).resolves.toBe(false);
  }, 20_000);
});
