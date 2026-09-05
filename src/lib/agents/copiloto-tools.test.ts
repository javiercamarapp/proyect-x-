import { describe, it, expect, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// LAS 14 TOOLS DEL COPILOTO — la auditoría externa del 16-ago encontró que
// era el módulo con 0 de 14 funciones cubiertas. Lo que se fija aquí:
//  1. Cada tool devuelve `pantalla` (la fuente clicable, guardarraíl §5.2) y
//     esa ruta EXISTE como page.tsx real — el chip a un 404 ya pasó una vez
//     (traza_corrida → /admin/corridas sin índice) y bitacora/cobranza_saas
//     apuntaban a pantallas equivocadas hasta hoy.
//  2. Los envoltorios NO transforman a escondidas: fuentes ciegas se dicen,
//     el MRR $0 se declara como verdad medida, los uuid se validan ANTES de
//     tocar la base.
//  3. Ninguna tool lanza cuando su lib responde — el copiloto degrada, no
//     revienta.
// Los mocks devuelven formas mínimas realistas; el sujeto es el ENVOLTORIO.
// ═══════════════════════════════════════════════════════════════════════════

// Un query builder camaleónico: acepta CUALQUIER cadena de métodos y al
// await resuelve { data, error: null }. `ilike` es el único con semántica
// (la búsqueda de flota de ficha_cliente); el resto devuelve vacío honesto.
function builderFalso(datos: unknown[] = []) {
  let resultado = datos;
  const b: Record<string, unknown> = {};
  const encadena = (nombre: string) => {
    b[nombre] = (...args: unknown[]) => {
      if (nombre === 'ilike') {
        const patron = String(args[1] ?? '');
        resultado = patron.includes('DEMO') ? [{ id: 't1', nombre: 'FLOTA DEMO' }] : [];
      }
      return b;
    };
  };
  for (const m of ['select', 'eq', 'neq', 'is', 'in', 'gte', 'lte', 'ilike', 'order', 'range', 'limit', 'maybeSingle', 'single', 'head']) encadena(m);
  (b as { then: unknown }).then = (res: (v: unknown) => unknown) => res({ data: resultado, error: null, count: resultado.length });
  return b;
}
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({ from: () => builderFalso() }),
}));
vi.mock('@/lib/admin/negocio', () => ({
  getResumenNegocio: async () => ({
    tenants: 3, viajesProcesados: 42, costoIaUsd: 1.2345, tendenciaCosto: -5,
    facturasTotal: 7, flotas: [{ nombre: 'FLOTA DEMO', plan: 'demo', viajes: 42, costoIaUsd: 1.2345 }],
  }),
  getConteosPlataforma: async () => ({ operadores: 5, liquidaciones: 4, conversaciones: 6, usuariosPorRol: { superadmin: 1 } }),
  getCostoPorFaseModelo: async () => ([{ fase: 'ocr', modelo: 'gemini', costoUsd: 0.5 }]),
}));
vi.mock('@/lib/admin/escalaciones', () => ({
  getBandejaEscalaciones: async () => ({
    conteos: { total: 2, vencidos: 1 },
    fuentes: { arco: { items: 1, error: null }, tickets: { items: null, error: 'fetch failed' } },
    cola: [{ fuente: 'arco', titulo: 'Solicitud ARCO', tenantNombre: 'FLOTA DEMO', desde: '2026-08-16', vence: null, href: '/admin/compliance' }],
  }),
}));
vi.mock('@/lib/admin/guardia', () => ({
  clasificacionDeGuardia: async () => ({
    fuentesCiegas: [], items: [], porSeveridad: { S1: 0, S2: 0, S3: 0, no_incidente: 0 }, limites: ['no ve X'],
  }),
}));
vi.mock('@/lib/admin/bitacora', () => ({
  ultimasEntradasBitacora: async () => ([{ accion: 'apagar', actor: 'u1', creadoEn: '2026-08-16' }]),
}));
vi.mock('@/lib/admin/corridas-cruzadas', () => ({
  corridasRecientes: async () => ([{ id: 'c1', agente: 'redactor', estado: 'ok' }]),
  trazaDeCorrida: async (id: string) => (id === '11111111-1111-4111-8111-111111111111'
    ? { id, agente: 'redactor', estado: 'ok', tareasHechas: 1, tareasTotal: 1 }
    : null),
}));
vi.mock('@/lib/likida/interruptores', () => ({
  listarInterruptores: async () => ([{ id: 'global', apagado: false }]),
}));
vi.mock('@/lib/likida/vendedores', () => ({
  listarProspectos: async () => ([{ id: 'p1', empresa: 'ACME', estado: 'nuevo', vendedorId: null }]),
  listarVendedores: async () => ([{ id: 'v1', nombre: 'Rodrigo' }]),
  conteosVacios: () => ({
    nuevo: 0, contactado: 0, appointment: 0, rescheduled: 0, cancelled: 0,
    'no-show': 0, demo: 0, proposal: 0, pilot: 0, won: 0, lost: 0,
  }),
  normalizarEstadoProspecto: (estado: string) => estado,
}));
vi.mock('@/lib/saas/transferencia', () => ({ getPorCobrar: async () => ([]) }));
vi.mock('@/lib/admin/ficha-cliente', () => ({
  getFichaCliente: async (id: string) => ({ id, nombre: 'FLOTA DEMO', viajes: 42 }),
}));
vi.mock('@/lib/admin/adquisicion', () => ({
  getAdquisicion: async () => ({ fuentes: [], alertas: [], totalProspectos: 829, sinFuenteDeDatos: ['ads'] }),
}));
vi.mock('@/lib/likida/agentes/runner', () => ({ gastoDelDiaUsd: async () => 0.12 }));
vi.mock('@/lib/likida/agentes/corridas', () => ({
  ultimasCorridasNegocio: async () => ([{ id: 'c1', agente: 'redactor', estado: 'ok' }]),
}));
vi.mock('@/lib/likida/agentes/definiciones', () => ({
  listarAgentes: async () => ([{ id: 'redactor', estado: 'vivo', runnerHabilitado: true, presupuestoDiaUsd: 1 }]),
}));
vi.mock('@/lib/likida/agentes/cola', () => ({
  piezasPendientes: async () => ([]),
  contarPendientes: async () => 0,
}));

const { TOOLS_COPILOTO_LECTURA, PANTALLA_POR_TOOL } = await import('./copiloto-tools');
const { executeTool, toolSchemas } = await import('@/lib/llm/tool-executor');

import { existsSync } from 'node:fs';
import { join } from 'node:path';

describe('el contrato de las 14 tools del copiloto', () => {
  it('toda pantalla citada EXISTE como page.tsx — el chip jamás apunta a un 404', () => {
    const raiz = join(process.cwd(), 'src/app');
    for (const [tool, { ruta }] of Object.entries(PANTALLA_POR_TOOL)) {
      const dir = join(raiz, ruta.replace(/^\//, ''));
      const page = join(dir, 'page.tsx');
      expect(existsSync(page), `${tool} cita ${ruta} y ahí no hay page.tsx`).toBe(true);
    }
  });

  it('los mapeos corregidos el 16-ago quedaron corregidos DE VERDAD', () => {
    expect(PANTALLA_POR_TOOL.bitacora.ruta).toBe('/admin/observabilidad');
    expect(PANTALLA_POR_TOOL.cobranza_saas.ruta).toBe('/admin/costos-facturacion');
    expect(PANTALLA_POR_TOOL.traza_corrida.ruta).toBe('/admin/corridas');
  });

  it('las 14 se ejecutan sin lanzar y todas devuelven su `pantalla`', async () => {
    const conArgs: Record<string, Record<string, unknown>> = {
      traza_corrida: { id: '11111111-1111-4111-8111-111111111111' },
      ficha_cliente: { nombre: 'DEMO' },
      bitacora: {},
    };
    for (const nombre of TOOLS_COPILOTO_LECTURA) {
      const r = await executeTool(nombre, conArgs[nombre] ?? {}, { tenantId: 'likida' });
      expect(r.success, `${nombre} falló: ${String(r.error)}`).toBe(true);
      const cuerpo = r.result as { pantalla?: string; error?: string };
      expect(typeof cuerpo.pantalla, `${nombre} sin pantalla`).toBe('string');
    }
  });

  it('metrica_negocio declara el MRR $0 como verdad medida, no como hueco', async () => {
    const r = await executeTool('metrica_negocio', {}, { tenantId: 'likida' });
    const c = r.result as { mrrUsd: number; nota_mrr: string; costoIaUsd: number };
    expect(c.mrrUsd).toBe(0);
    expect(c.nota_mrr).toMatch(/[Cc]ero clientes/);
    expect(c.costoIaUsd).toBe(1.23); // redondeado a centavos, no el crudo
  });

  it('bandeja DICE sus fuentes ciegas por nombre — null ≠ 0', async () => {
    const r = await executeTool('bandeja', {}, { tenantId: 'likida' });
    const c = r.result as { fuentesCiegas: Array<{ fuente: string; error: string | null }> };
    expect(c.fuentesCiegas).toEqual([{ fuente: 'tickets', error: 'fetch failed' }]);
  });

  it('traza_corrida valida el uuid ANTES de tocar la base', async () => {
    const basura = await executeTool('traza_corrida', { id: "'; drop table viaje;--" }, { tenantId: 'likida' });
    expect(basura.success).toBe(true);
    expect((basura.result as { error?: string }).error).toMatch(/forma de corrida/);
    const noExiste = await executeTool('traza_corrida', { id: '22222222-2222-4222-8222-222222222222' }, { tenantId: 'likida' });
    expect((noExiste.result as { error?: string }).error).toMatch(/No existe/);
  });

  it('ficha_cliente sin coincidencias lo dice, no inventa una flota', async () => {
    const r = await executeTool('ficha_cliente', { nombre: 'INEXISTENTE' }, { tenantId: 'likida' });
    const c = r.result as Record<string, unknown>;
    expect(JSON.stringify(c)).not.toMatch(/FLOTA DEMO/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INVARIANTE ESTRUCTURAL (auditoría 21, MEDIO) — el hueco de la ronda 18 se
// cerró a medias.
//
// Las pruebas de arriba son de COMPORTAMIENTO: corren las 14 y verifican que
// no lancen, que citen la pantalla correcta, que `traza_corrida` valide el
// uuid, etc. Ninguna compara el JSON Schema publicado contra la regla
// estructural que SÍ existe en `chat-tools.ts` ("ninguna toma un tenant por
// parámetro: el tenant sale del contexto"). Sin esta prueba, una tool 15ª con
// un parámetro que en efecto ELIJA un tenant —o `bitacora`/`ficha_cliente`
// mutadas de "buscar por texto" a "seleccionar por id"— se cuela sin que
// ninguna prueba lo note.
//
// Recorre `TOOLS_COPILOTO_LECTURA` —el registro real que exporta
// copiloto-tools.ts, no una lista copiada a mano aquí— así que una tool 15ª
// que se agregue a esa constante queda cubierta AUTOMÁTICAMENTE sin tocar
// este archivo.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Los ÚNICOS parámetros de texto libre (string sin `enum`) que el diseño
 * acepta HOY, documentados a propósito por el hallazgo de la auditoría 21:
 *   - `bitacora.filtro`: busca por SUBCADENA de acción — nunca selecciona
 *     una flota.
 *   - `ficha_cliente.nombre`: busca por SUBCADENA de nombre, con
 *     desambiguación si hay más de una coincidencia (prueba de arriba) —
 *     nunca un id directo que salte la búsqueda.
 *   - `traza_corrida.id`: es el uuid de una CORRIDA (no de un tenant) y se
 *     valida con regex antes de tocar la base (prueba de arriba, "valida el
 *     uuid ANTES de tocar la base").
 *
 * Cualquier OTRO string sin enum en cualquier tool —incluida una que se
 * registre mañana— hace fallar la prueba de abajo: la excepción tiene que
 * declararse aquí a propósito, con revisor, igual que hoy.
 */
const TEXTO_LIBRE_A_PROPOSITO: Record<string, string[]> = {
  bitacora: ['filtro'],
  ficha_cliente: ['nombre'],
  traza_corrida: ['id'],
};

/** Ídem `funciones()` de chat-tools.test.ts: estrecha a `function` y de paso
 *  AFIRMA que las 14 lo son — una tool `custom` no lleva JSON Schema y las
 *  reglas de abajo pasarían de largo sin fallar. */
function funcionesCopiloto() {
  const todas = toolSchemas([...TOOLS_COPILOTO_LECTURA]);
  const fns = todas.filter((s) => s.type === 'function');
  expect(fns).toHaveLength(todas.length);
  return fns;
}

describe('copiloto-tools.ts — invariante estructural (auditoría 21, MEDIO)', () => {
  it('el registro completo (TOOLS_COPILOTO_LECTURA) sigue siendo function', () => {
    expect(toolSchemas([...TOOLS_COPILOTO_LECTURA])).toHaveLength(TOOLS_COPILOTO_LECTURA.length);
  });

  it('ninguna acepta propiedades extra: additionalProperties permanece false', () => {
    // Sin `additionalProperties: false` el modelo puede inventar un parámetro
    // que algún handler futuro lea por accidente.
    for (const s of funcionesCopiloto()) {
      const p = s.function.parameters as { additionalProperties?: boolean } | undefined;
      expect(p?.additionalProperties, s.function.name).toBe(false);
    }
  });

  it('ninguna toma un tenant/flota/empresa por NOMBRE de parámetro', () => {
    // El copiloto sí cruza cross-tenant a propósito (superadmin, /admin) —
    // pero por REGISTRO de la tool, nunca porque el modelo lo haya elegido
    // con un argumento. Un parámetro llamado `tenantId`/`flotaId`/`empresa`
    // es justo la puerta que convertiría eso en un selector.
    for (const s of funcionesCopiloto()) {
      const params = s.function.parameters as { properties?: Record<string, unknown> } | undefined;
      for (const clave of Object.keys(params?.properties ?? {})) {
        expect(clave.toLowerCase(), s.function.name).not.toMatch(/tenant|flota|empresa/);
      }
    }
  });

  it('todo string SIN enum está en la lista de excepciones documentadas', () => {
    // Es la prueba que atrapa a la tool 15ª: un parámetro de texto libre
    // nuevo que nadie declaró aquí a propósito hace fallar esto, en vez de
    // colarse en silencio como pasó con las 14 originales en la ronda 18.
    for (const s of funcionesCopiloto()) {
      const params = s.function.parameters as { properties?: Record<string, { type?: string; enum?: unknown[] }> } | undefined;
      const permitidas = TEXTO_LIBRE_A_PROPOSITO[s.function.name] ?? [];
      for (const [clave, def] of Object.entries(params?.properties ?? {})) {
        if (def.type === 'string' && !def.enum) {
          expect(permitidas, `${s.function.name}.${clave} es texto libre no declarado en TEXTO_LIBRE_A_PROPOSITO`).toContain(clave);
        }
      }
    }
  });

  it('las excepciones declaradas de verdad existen en el schema de hoy', () => {
    // Si `bitacora` deja de llamarse `filtro`, o `ficha_cliente` deja de
    // llamarse `nombre`, esta prueba avisa — la lista de arriba no puede
    // quedarse describiendo un schema que ya cambió.
    for (const [tool, props] of Object.entries(TEXTO_LIBRE_A_PROPOSITO)) {
      const [schema] = toolSchemas([tool]);
      expect(schema, tool).toBeDefined();
      const params = schema?.type === 'function'
        ? (schema.function.parameters as { properties?: Record<string, unknown> } | undefined)
        : undefined;
      for (const p of props) {
        expect(Object.keys(params?.properties ?? {}), tool).toContain(p);
      }
    }
  });
});
