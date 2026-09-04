import { describe, it, expect, afterAll } from 'vitest';
import net from 'node:net';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 8 · ALTO REINCIDENTE — "Ahora hay techo por consulta" cubría 2 de
// 13 pasos del cierre. `getConfig` (config.ts) es el cuarto camino que la
// ronda 8 confirmó, sin ningún `Promise.all` que lo salvara por accidente:
// `consultar_politica` (tools.ts) lo llama SOLO, dentro del presupuesto de
// 40s del agente. Sin techo propio, un socket que acepta y calla se llevaba
// la invocación entera — Vercel mata a los 120s, 180s ANTES de que el fetch
// se rindiera solo.
//
// Mismo patrón que `repo_tope.test.ts`: servidor mudo real, sin red ni
// Supabase, midiendo con reloj real cuánto tarda en asentarse.
// ═══════════════════════════════════════════════════════════════════════════

const conexionesMudas = new Set<net.Socket>();
const servidorMudo = net.createServer((s) => {
  conexionesMudas.add(s);
  s.on('close', () => conexionesMudas.delete(s));
  s.on('error', () => {}); /* acepta y calla */
});
await new Promise<void>((r) => servidorMudo.listen(0, '127.0.0.1', () => r()));
const puerto = (servidorMudo.address() as net.AddressInfo).port;

// `process.env.X = ...` NO se auto-restaura entre archivos de prueba (a
// diferencia de `vi.stubEnv`) — es estado del proceso de Node. Sin este
// `afterAll`, este archivo deja `NEXT_PUBLIC_SUPABASE_URL` apuntando al
// servidor mudo para cualquier prueba que corra después en el mismo worker
// (fue exactamente lo que rompió `arnes_ticket_real.test.ts` en la suite
// completa mientras se escribía este archivo).
const ENV_ORIGINAL = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  tope: process.env.LIKIDA_TOPE_CONSULTA_MS,
};
process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${puerto}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'llave-falsa-para-la-medicion';
process.env.LIKIDA_TOPE_CONSULTA_MS = '1500';

const { getConfig } = await import('./config');
const { TOPE_CONSULTA_MS } = await import('./presupuesto');

afterAll(async () => {
  // AbortSignal corta el fetch, pero undici puede conservar el socket TCP en
  // su pool. Si solo llamamos close(), el worker de Vitest queda vivo esperando
  // esa conexión y la suite no termina. Destruir el servidor de prueba no toca
  // recursos externos: son únicamente sockets locales aceptados aquí.
  for (const socket of conexionesMudas) socket.destroy();
  await new Promise<void>((resolve) => servidorMudo.close(() => resolve()));
  if (ENV_ORIGINAL.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = ENV_ORIGINAL.url;
  if (ENV_ORIGINAL.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = ENV_ORIGINAL.key;
  if (ENV_ORIGINAL.tope === undefined) delete process.env.LIKIDA_TOPE_CONSULTA_MS; else process.env.LIKIDA_TOPE_CONSULTA_MS = ENV_ORIGINAL.tope;
});

const CORTE_MS = 12_000;

async function tardanza(fn: () => Promise<unknown>): Promise<number | null> {
  const t0 = performance.now();
  const gano = await Promise.race([
    fn().then(() => 'asienta', () => 'asienta'),
    new Promise<'colgada'>((r) => setTimeout(() => r('colgada'), CORTE_MS)),
  ]);
  return gano === 'colgada' ? null : performance.now() - t0;
}

describe('getConfig contra una base que acepta la conexión y no contesta', () => {
  it('el camino de consultar_politica se rinde en su tope, no se cuelga la invocación', async () => {
    const ms = await tardanza(() => getConfig('t1').catch(() => null));
    expect(ms, `getConfig seguía bloqueada a los ${CORTE_MS} ms: no hay techo`).not.toBeNull();
    expect(ms!).toBeLessThan(TOPE_CONSULTA_MS + 4_000);
  }, 20_000);
});
