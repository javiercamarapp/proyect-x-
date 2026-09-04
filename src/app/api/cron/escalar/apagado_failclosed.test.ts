import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// FAIL-CLOSED DE VERDAD para el cron de escalar — Fase 1 del blueprint.
//
// `route.test.ts` mockea `estaApagado` directo, así que prueba el contrato de
// la RUTA (apagado=true ⇒ saltado) pero no la cadena completa: de los 5
// interruptores de la fase, `conductores` era el único sin una prueba donde
// el módulo `interruptores` REAL convierte un error de lectura en ILEGIBLE
// (las de liquidacion/peajes/proveedores/ventas ya la tienen, con esa misma
// leyenda: "se prueba la cadena completa, no un mock del mock").
//
// Aquí el error entra POR VALOR desde el builder de Supabase, cruza
// `leerInterruptor` sin mock, y el motor de conductores NO corre. Si alguien
// "normaliza" el fail-closed (error = encendido), esto cae. Y desde la
// AUDITORÍA 18 (A17) la corrida sale 500: ilegible no es apagado.
// ═══════════════════════════════════════════════════════════════════════════

type RespuestaInterruptor = { data: { apagado: boolean } | null; error: { message: string } | null };

/** Respuesta del builder POR NOMBRE de interruptor; sin entrada = sin fila
 *  (el default del catálogo: ENCENDIDO). */
let interruptores: Record<string, RespuestaInterruptor>;

const logs = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger: logs }));

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      if (tabla !== 'interruptor') throw new Error(`tabla inesperada: ${tabla}`);
      return {
        select: () => ({
          eq: (_col: string, nombre: string) => ({
            maybeSingle: async () => interruptores[nombre] ?? { data: null, error: null },
          }),
        }),
      };
    },
  }),
}));

const escalarViajesSinAceptar = vi.fn();
const ejecutarCobranzaGlobal = vi.fn();
vi.mock('@/lib/likida/escalar_viaje', () => ({
  escalarViajesSinAceptar: (...a: unknown[]) => escalarViajesSinAceptar(...a),
  // ESC-3: el cron reparte su reloj entre los dos motores con esta constante.
  PLAZO_ESCALACION_MS: 40_000,
}));
// FASE 6: los relojes legales corren dentro de este cron. Aquí se doblan
// en cero para que las pruebas del reparto del reloj y los interruptores
// sigan midiendo SOLO a sus dos motores — los relojes tienen su propia
// suite (relojes_legales.test.ts).
vi.mock('@/lib/likida/relojes_legales', () => ({
  avisarRelojesLegales: async () => ({ revisadas: 0, avisadas: 0, fallos: 0 }),
  avisarVencimientos: async () => ({ candidatos: 0, avisados: 0, fallos: 0 }),
}));
vi.mock('@/lib/likida/agentes/cobranza', () => ({
  ejecutarCobranzaGlobal: (...a: unknown[]) => ejecutarCobranzaGlobal(...a),
}));
// A19 (0229): el cuarto barrido, doblado en cero por lo mismo que los relojes
// — aquí se prueba la cadena del interruptor, no el vigilante.
vi.mock('@/lib/likida/reglas/vigilante', () => ({
  vigilarReglas: async () => ({ reglas: 0, disparadas: 0, avisos: 0, fallos: 0 }),
}));
// El barrido CRM comparte cron desde 0323; este arnés aísla la lectura real
// de interruptores. Su contrato y sus errores se prueban en route.test.ts.
vi.mock('@/lib/admin/calcom', () => ({
  ejecutarMantenimientoCalcom: async () => ({
    configured: true, completa: true, provisionado: false, revisadas: 0,
    cortadasPorReloj: 0,
    ledger: { configured: true, revisados: 0, recuperados: 0, restantes: 0 },
  }),
}));
const alertarOperador = vi.fn(async () => {});
vi.mock('@/lib/observability/alerta', () => ({
  alertarOperador: (...a: unknown[]) => alertarOperador(...(a as [])),
}));

// El latido (RES-7) se prueba en src/lib/admin/salud.test.ts; aquí se mockea
// para que la racha de cortes (RES-6) sea observable sin tocar la base.
const registrarLatido = vi.fn(async () => {});
const latidoPrevio: { ultimoLatido: string; estado: string; detalle: Record<string, unknown> } | null = null;
vi.mock('@/lib/admin/salud', () => ({
  registrarLatido: (...a: unknown[]) => registrarLatido(...(a as [])),
  leerLatido: async () => latidoPrevio,
  puertaCron: async (_c: string, req: Request) =>
    req.headers.get('authorization') === 'Bearer secreto-de-prueba' ? null : new Response(null, { status: 401 }),
}));

process.env.CRON_SECRET = 'secreto-de-prueba';
const { GET } = await import('./route');
// Después de los mocks, como todo lo demás en este archivo (RES-19).
const { olvidarInterruptores } = await import('@/lib/likida/interruptores');

const peticion = () => new Request('http://likida.test/api/cron/escalar', {
  headers: { authorization: 'Bearer secreto-de-prueba' },
}) as never;

beforeEach(() => {
  // RES-19: `leerInterruptor` cachea 5 s por instancia y estas pruebas usan el
  // módulo REAL — sin tirar la caché, la lectura sana de una prueba contestaría
  // por la lectura rota de la siguiente y el fail-closed se vería como verde.
  olvidarInterruptores();
  interruptores = {};
  escalarViajesSinAceptar.mockReset().mockResolvedValue({ escalados: 0 });
  ejecutarCobranzaGlobal.mockReset().mockResolvedValue({ tenants: 0, contactados: 0, fallos: [] });
  logs.warn.mockClear();
  logs.error.mockClear();
});

describe('fail-closed con el módulo interruptores REAL (cron escalar)', () => {
  it("la lectura de 'agente:conductores' que FALLA detiene SU motor — la cobranza corre igual", async () => {
    interruptores['agente:conductores'] = { data: null, error: { message: 'fetch failed' } };

    const res = await GET(peticion());
    const cuerpo = await res.json();

    // AUDITORÍA 18 (A17): 500 y no 200 — "no pude leer la palanca" NO es un
    // apagado a propósito; el motor no corre (fail-closed) pero la corrida
    // sale ROJA con `codigo`, no verde con `saltado`.
    expect(res.status).toBe(500);
    expect(cuerpo.aceptacion).toMatchObject({ codigo: 'interruptor_ilegible', interruptor: 'agente:conductores' });
    expect(escalarViajesSinAceptar).not.toHaveBeenCalled();
    expect(ejecutarCobranzaGlobal).toHaveBeenCalledTimes(1);
    // El salto por fail-closed se GRITA (interruptores.ts): un cron saltándose
    // corridas por una base con hipo se parece demasiado a un cron sano.
    expect(logs.error).toHaveBeenCalledWith('interruptores.lectura_fallo',
      expect.objectContaining({ interruptor: 'agente:conductores' }));
  });

  it("la lectura de 'global' que FALLA detiene los DOS motores", async () => {
    interruptores.global = { data: null, error: { message: 'fetch failed' } };

    const res = await GET(peticion());
    const cuerpo = await res.json();

    expect(res.status).toBe(500);
    expect(cuerpo).toMatchObject({ corrio: false, codigo: 'interruptor_ilegible', interruptor: 'global' });
    expect(escalarViajesSinAceptar).not.toHaveBeenCalled();
    expect(ejecutarCobranzaGlobal).not.toHaveBeenCalled();
    expect(logs.error).toHaveBeenCalledWith('interruptores.lectura_fallo',
      expect.objectContaining({ interruptor: 'global' }));
  });

  it('sin fila de NINGÚN interruptor (el default del catálogo), los dos motores corren', async () => {
    const res = await GET(peticion());
    expect(res.status).toBe(200);
    expect(escalarViajesSinAceptar).toHaveBeenCalledTimes(1);
    expect(ejecutarCobranzaGlobal).toHaveBeenCalledTimes(1);
    expect(logs.error).not.toHaveBeenCalled();
  });
});
