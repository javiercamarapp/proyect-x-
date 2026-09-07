import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// EL PARPADEO — B7 (auditoría 4), probado contra el motor ENTERO.
//
// El bug: el cierre del incidente hacía DELETE de la fila de
// `agente_notificacion_estado`, borrando la huella `avisado_en` junto con la
// magnitud. El siguiente incidente encontraba `ultimo === null` y `debeAvisar`
// lo despachaba como «primera vez» SIN consultar el piso de una hora: un
// agente que falla un lote sí y uno no mandaba un correo POR LOTE, mientras
// la pestaña juraba «entre dos avisos siempre pasan al menos 60 minutos».
//
// Las pruebas puras de `debeAvisar` no bastan para esto: el bug vivía en la
// PERSISTENCIA (qué sobrevive al cierre), así que aquí la base falsa guarda
// UNA fila de verdad, respeta los CHECK de la migración 0097, y el flujo
// corre completo: leer estado → guardar magnitud → decidir → reclamar →
// mandar. Si el motor intenta un estado que Postgres rechazaría, la fila
// falsa truena igual que la real.
// ═══════════════════════════════════════════════════════════════════════════

/** La fila de `agente_notificacion_estado`, con los tipos de la 0097. */
interface FilaEstado {
  magnitud: number;
  avisado_en: string | null;
  magnitud_avisada: number | null;
  /** AG-M3 (auditoría 28): SOLO la toca `cerrarIncidente` — `guardarMagnitud`
   *  ya no la escribe. Es la señal que sobrevive a cuantas corridas hagan
   *  falta mientras el piso bloquea el primer correo de un incidente
   *  reabierto (ver el comentario de `guardarMagnitud` en notificaciones.ts). */
  actualizado_en: string;
}

let fila: FilaEstado | null = null;

/** Los CHECK de la 0097. La base real rechazaría estas escrituras; la falsa
 *  también, para que una prueba no pase sobre un estado imposible. */
function checksDe0097(f: FilaEstado): void {
  if ((f.avisado_en === null) !== (f.magnitud_avisada === null)) {
    throw new Error('viola agente_notif_huella_completa (0097): la huella va junta o no va');
  }
  if (f.magnitud < 0) throw new Error('viola magnitud >= 0 (0097)');
  if (f.magnitud_avisada !== null && f.magnitud_avisada < 1) {
    throw new Error('viola magnitud_avisada >= 1 (0097)');
  }
}

function tablaEstado() {
  let payload: Record<string, unknown> | null = null;
  let condicionOr: string | null = null;
  const b = {
    select: () => b,
    eq: () => b,
    or: (c: string) => { condicionOr = c; return b; },
    update: (p: Record<string, unknown>) => { payload = p; return b; },
    // El upsert de `guardarMagnitud`. Desde AG-M3 (auditoría 28) SOLO escribe
    // `magnitud` — ni `actualizado_en` (reservada a `cerrarIncidente`) ni
    // `magnitud_avisada` (reservada a un envío REAL). Una fila NUEVA simula el
    // `default now()` de Postgres con un sello fijo: `incidenteCerrado` nunca
    // lo necesita en la primera vez (`ultimo` sale `null` sin correo previo).
    upsert: (p: Record<string, unknown>) => {
      const nueva: FilaEstado = {
        magnitud: (fila?.magnitud ?? 0),
        avisado_en: fila?.avisado_en ?? null,
        magnitud_avisada: fila?.magnitud_avisada ?? null,
        actualizado_en: fila?.actualizado_en ?? '1970-01-01T00:00:00.000Z',
      };
      if ('magnitud' in p) nueva.magnitud = p.magnitud as number;
      if ('magnitud_avisada' in p) nueva.magnitud_avisada = p.magnitud_avisada as number;
      // Genérico a propósito (no solo lo que escribe el código de HOY): un
      // fake fiel a Postgres aplica cualquier columna que el `upsert` traiga,
      // para que este archivo sirva igual de rojo→verde contra una versión
      // anterior de `guardarMagnitud` que sí tocara `actualizado_en` aquí.
      if ('actualizado_en' in p) nueva.actualizado_en = p.actualizado_en as string;
      checksDe0097(nueva);
      fila = nueva;
      return Promise.resolve({ error: null });
    },
    // La lectura de `leerEstado`.
    maybeSingle: () => Promise.resolve({
      data: fila === null ? null : { ...fila },
      error: null,
    }),
    // Un `update` awaiteado: `cerrarIncidente` (sin `.or`) o `reclamarAviso`
    // (con el `.or` del piso, que aquí se EVALÚA de verdad).
    then: (res: (v: unknown) => unknown) => {
      let data: Array<{ tenant_id: string }> = [];
      if (payload !== null && fila !== null) {
        const umbral = condicionOr?.match(/avisado_en\.lt\.(.+)$/)?.[1] ?? null;
        const pasa = condicionOr === null
          // ISO-8601 se compara lexicográficamente, igual que timestamptz.
          || fila.avisado_en === null || (umbral !== null && fila.avisado_en < umbral);
        if (pasa) {
          const nueva: FilaEstado = { ...fila };
          if ('magnitud' in payload) nueva.magnitud = payload.magnitud as number;
          if ('avisado_en' in payload) nueva.avisado_en = payload.avisado_en as (string | null);
          if ('magnitud_avisada' in payload) nueva.magnitud_avisada = payload.magnitud_avisada as (number | null);
          // `cerrarIncidente` es la ÚNICA escritora de esta columna (AG-M3).
          if ('actualizado_en' in payload) nueva.actualizado_en = payload.actualizado_en as string;
          checksDe0097(nueva);
          fila = nueva;
          if (condicionOr !== null) data = [{ tenant_id: 't-1' }];
        }
      }
      return Promise.resolve({ data, error: null }).then(res);
    },
  };
  return b;
}

/** Config sin fila (aplican los defaults: corrida_fallida → flota_admin),
 *  una dueña con correo, y el nombre de la flota. */
function tablaSimple(respuesta: unknown) {
  const b = {
    select: () => b,
    eq: () => b,
    // FE-34 (auditoría 24): `usuariosAvisables` agregó `.order('id')` antes
    // del `.limit()` (desempate determinista, mismo contrato de `pg.ts`) —
    // sin este método el mock tronaba con "b.order is not a function" y
    // `avisarCorridaFallida` se quedaba sin destinatarios.
    order: () => b,
    // AUDITORÍA 25, ALTO (reauditoría): `usuariosAvisables` agregó
    // `.or('activo.is.null,activo.eq.true')` — mismo motivo que `.order()`
    // arriba. El doble no evalúa la condición (igual que `contactos.test.ts`
    // con AGEN-C1): devuelve la tabla entera, así que lo que las pruebas de
    // este archivo ejercen es la fila que la propia `respuesta` ya trae.
    or: () => b,
    maybeSingle: () => Promise.resolve(respuesta),
    limit: () => Promise.resolve(respuesta),
  };
  return b;
}

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      if (tabla === 'agente_notificacion_estado') return tablaEstado();
      if (tabla === 'app_user') {
        return tablaSimple({
          data: [{ id: 'u1', nombre: 'Dueña', email: 'duena@flota.mx', rol: 'flota_admin' }],
          error: null,
        });
      }
      if (tabla === 'tenant') return tablaSimple({ data: { nombre: 'Transportes Parpadeo' }, error: null });
      // `agente_notificacion_config` sin fila: los defaults del código.
      return tablaSimple({ data: null, error: null });
    },
  }),
}));

// AQUÍ el canal SÍ está encendido — a diferencia de `notificaciones_corrida.
// test.ts`—: lo que se prueba es cuántos correos SALEN.
//
// El tipo de retorno se declara ANCHO (éxito o fallo) a propósito: AG-A5(b)
// necesita poder simular un rebote (`mockResolvedValueOnce({ ok: false, ... })`)
// sin que el resto de las pruebas —que solo necesitan el éxito— tengan que
// repetir la unión completa.
const enviarCorreo = vi.fn(
  async (): Promise<{ ok: true; id: string } | { ok: false; motivo: string }> => ({ ok: true, id: 'env-1' }),
);
vi.mock('@/lib/correo/enviar', () => ({
  correoConfigurado: () => true,
  enviarCorreo: (...a: unknown[]) => enviarCorreo(...(a as [])),
}));

const { avisarCorridaFallida, PISO_ENTRE_AVISOS_MS } = await import('./notificaciones');

const T0 = new Date('2026-08-14T06:00:00Z');
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

beforeEach(() => {
  fila = null;
  enviarCorreo.mockClear();
});

describe('falla→aviso→resuelve→falla DENTRO de la misma hora', () => {
  it('NO hay segundo correo, y el porqué lo dice', async () => {
    const r1 = await avisarCorridaFallida('t-1', 'facturas', new Error('Chromium no arrancó'), T0);
    expect(r1.avisado).toBe(true);
    expect(enviarCorreo).toHaveBeenCalledTimes(1);

    // El incidente se resuelve: la cuenta a cero, la HUELLA se queda. Es el
    // corazón de B7 — antes esto era un DELETE y borraba `avisado_en`.
    const r2 = await avisarCorridaFallida('t-1', 'facturas', null, min(10));
    expect(r2.avisado).toBe(false);
    expect(fila?.magnitud).toBe(0);
    expect(fila?.avisado_en).toBe(T0.toISOString());

    // Reaparece a los 20 minutos: NO sale otro correo.
    const r3 = await avisarCorridaFallida('t-1', 'facturas', new Error('tronó otra vez'), min(20));
    expect(r3.avisado).toBe(false);
    expect(r3.porque).toMatch(/hace menos de una hora/);
    expect(enviarCorreo).toHaveBeenCalledTimes(1);
  });
});

describe('falla→aviso→resuelve→falla PASADA la hora', () => {
  it('SÍ sale el segundo correo, desde la primera marca', async () => {
    await avisarCorridaFallida('t-1', 'facturas', new Error('x'), T0);
    await avisarCorridaFallida('t-1', 'facturas', null, min(10));

    const r = await avisarCorridaFallida('t-1', 'facturas', new Error('y'), min(70));
    expect(r.avisado).toBe(true);
    expect(r.porque).toMatch(/primera vez/);
    expect(r.magnitud).toBe(1); // racha nueva, no la vieja
    expect(enviarCorreo).toHaveBeenCalledTimes(2);
  });
});

describe('el rótulo de la pestaña es verdad', () => {
  it('parpadeando cada 5 minutos por 3 horas, nunca salen dos correos en la misma hora', async () => {
    // «Entre dos avisos siempre pasan al menos 60 minutos» — el texto exacto
    // de la pantalla, contra el bucle exacto del bug: falla un lote sí y uno
    // no. Antes de B7 esto mandaba ~18 correos; ahora manda uno por hora.
    const envios: number[] = [];
    for (let i = 0; i < 36; i++) {
      const ahora = new Date(T0.getTime() + i * 5 * 60_000);
      const fallo = i % 2 === 0 ? new Error(`el lote ${i} tronó`) : null;
      const r = await avisarCorridaFallida('t-1', 'facturas', fallo, ahora);
      if (r.avisado) envios.push(ahora.getTime());
    }

    // Ni silencio permanente (el otro modo de falla) ni un correo por lote.
    expect(envios.length).toBeGreaterThanOrEqual(2);
    expect(envios.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < envios.length; i++) {
      expect(envios[i] - envios[i - 1]).toBeGreaterThanOrEqual(PISO_ENTRE_AVISOS_MS);
    }
  });

  it('un incidente que arranca a la sombra del piso y SIGUE roto no se queda mudo, y su correo trae la racha verdadera', async () => {
    // La semántica elegida para el caso que ningún esquema puede tener
    // perfecto (la 0097 no puede representar «este incidente aún no avisa»
    // junto a una huella viva): el primer correo del incidente nuevo se
    // ABSORBE en el del anterior —el destinatario recibió «no pudo trabajar»
    // hace minutos y nunca hubo correo de «ya sanó», así que para él es el
    // mismo episodio— y el siguiente sale al pasar el piso, con la racha
    // REAL medida, nunca inventada.
    await avisarCorridaFallida('t-1', 'facturas', new Error('incidente A'), T0);
    await avisarCorridaFallida('t-1', 'facturas', null, min(5));

    const envios: Array<{ minuto: number; magnitud: number }> = [];
    for (let i = 0; i < 24; i++) { // dos horas fallando cada 5 min
      const ahora = min(10 + i * 5);
      const r = await avisarCorridaFallida('t-1', 'facturas', new Error('incidente B'), ahora);
      if (r.avisado) envios.push({ minuto: 10 + i * 5, magnitud: r.magnitud });
    }

    expect(envios.length).toBeGreaterThanOrEqual(1);
    // Pasó el piso completo desde el correo de A.
    expect(envios[0].minuto).toBeGreaterThanOrEqual(60);
    // Y la racha del correo es la cuenta real de fallos de B, no un 1.
    const corridasDeB = (envios[0].minuto - 10) / 5 + 1;
    expect(envios[0].magnitud).toBe(corridasDeB);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AG-M3 (auditoría 28) — el mismo escenario de arriba, pero con la cadencia
// real de este bucle: 15 minutos, no 5. La prueba anterior no atrapaba el
// hallazgo porque parpadear cada 5 min hace que la racha CRUCE la marca 5
// dentro de la misma hora del piso, y por casualidad el resultado sale igual
// con el código roto y con el arreglado. A 15 min, el incidente B solo lleva
// magnitud 3 cuando el piso se cumple — muy por debajo de la marca 5 — y ahí
// es donde el código viejo se quedaba mudo media hora de más (hasta las
// 11:30, cuando la racha por fin llegaba a 5) en vez de avisar a las 11:00,
// que es lo que la pantalla promete.
// ═══════════════════════════════════════════════════════════════════════════
describe('AG-M3: un incidente reabierto con poca magnitud avisa al pasar el piso, no al llegar a la marca 5', () => {
  it('cadencia de 15 min: falla, correo, sana, falla de nuevo — el segundo correo sale al pasar el piso, no al llegar a 5', async () => {
    await avisarCorridaFallida('t-1', 'facturas', new Error('incidente A'), min(0));   // 10:00 → correo
    await avisarCorridaFallida('t-1', 'facturas', null, min(15));                       // 10:15 → sanó

    const r1 = await avisarCorridaFallida('t-1', 'facturas', new Error('incidente B'), min(30)); // 10:30
    expect(r1.avisado).toBe(false);
    expect(r1.porque).toMatch(/sale en 30 min/);

    const r2 = await avisarCorridaFallida('t-1', 'facturas', new Error('incidente B'), min(45)); // 10:45
    expect(r2.avisado).toBe(false);

    // POCO DESPUÉS de que se cumple el piso de una hora desde el correo de A
    // (min 61, no exactamente min 60: el filo de igualdad milimétrica de
    // `reclamarAviso` es un detalle aparte, no lo que esta prueba fija) —
    // NO a los 90 minutos, que es cuando la racha de B habría llegado a la
    // marca 5 con el código roto.
    const r3 = await avisarCorridaFallida('t-1', 'facturas', new Error('incidente B'), min(61));
    expect(r3.avisado).toBe(true);
    expect(r3.porque).toMatch(/primera vez/);
    // La racha REAL del incidente B: 10:30, 10:45, 10:61 → 3, no 5 ni 1.
    expect(r3.magnitud).toBe(3);
    expect(enviarCorreo).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AG-A5(b) (auditoría 28) — `reclamarAviso` sella la huella ANTES de mandar,
// para que dos corridas solapadas no dupliquen el correo. Pero eso también
// significaba que un envío que REBOTA (Resend 429) consumía el turno del
// incidente exactamente igual que uno que sale: el aviso de que un agente no
// pudo trabajar se perdía por un fallo del CANAL, no del agente.
// ═══════════════════════════════════════════════════════════════════════════
describe('AG-A5(b): un envío que rebota no consume el turno del incidente', () => {
  it('la huella no queda sellada, y la corrida siguiente (ya sin el rebote) sí manda', async () => {
    enviarCorreo.mockResolvedValueOnce({ ok: false as const, motivo: 'Resend devolvió 429' });

    const r1 = await avisarCorridaFallida('t-1', 'facturas', new Error('primer intento'), T0);
    expect(r1.avisado).toBe(false);
    expect(r1.porque).toMatch(/no se pudo entregar/);
    // AG-B3: SÍ había a quién avisarle — el reparto se calculó antes del
    // envío—, así que el resultado no puede decir "0 destinatarios".
    expect(r1.destinatarios).toBeGreaterThan(0);
    // La huella queda EXACTAMENTE como antes del intento (nunca hubo correo
    // previo en este escenario: null/null).
    expect(fila?.avisado_en).toBeNull();
    expect(fila?.magnitud_avisada).toBeNull();

    // La corrida siguiente, un minuto después —muy por debajo del piso de una
    // hora—, sí manda: el intento fallido nunca contó como un correo real.
    const r2 = await avisarCorridaFallida('t-1', 'facturas', new Error('segundo intento'), min(1));
    expect(r2.avisado).toBe(true);
    expect(enviarCorreo).toHaveBeenCalledTimes(2);
  });
});
