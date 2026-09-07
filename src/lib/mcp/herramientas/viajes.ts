// ═══════════════════════════════════════════════════════════════════════════
// Lectores OPERATIVOS de viajes para el servidor MCP.
//
// Aquí no viaja un peso: folio, ruta, fecha y estatus. El dinero de un viaje
// (ingreso, comprobado, contribución, cobro) vive en `dinero.ts` detrás del
// área `dinero` — la misma línea que separa al jefe de tráfico del contador
// en el panel y en /v1.
//
// MINIMIZACIÓN: el nombre del operador NO se devuelve. Para contestar «cómo
// van mis viajes» no hace falta, y un cliente MCP es un tercero: lo que no
// se necesita, no cruza. (Mismo criterio que el `anticipo` que /v1/viajes
// tampoco proyecta.)
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase/admin';
import { acotada } from '@/lib/likida/presupuesto';
import { exigir } from '@/lib/likida/pg';
import { fechaCorta } from '@/lib/formato';
import { z } from 'zod';
import type { Herramienta, ResultadoHerramienta } from '../tipos';

export const ESTATUS_VIAJE = ['abierto', 'en_cuadre', 'liquidado'] as const;

export interface ViajeOperativo {
  id: string;
  folio: string;
  ruta: string | null;
  fechaInicio: string | null;
  estatus: string;
}

interface FilaViaje {
  id: unknown;
  folio: unknown;
  origen: unknown;
  destino: unknown;
  fecha_inicio: unknown;
  estatus: unknown;
}

function aViaje(f: FilaViaje): ViajeOperativo {
  const id = String(f.id);
  const origen = (f.origen as string) ?? null;
  const destino = (f.destino as string) ?? null;
  return {
    id,
    // Mismo respaldo que `getLibroViaje`: un viaje sin folio se cita por el
    // prefijo del id.
    folio: (f.folio as string) ?? id.slice(0, 8),
    ruta: origen && destino ? `${origen} → ${destino}` : origen ?? destino ?? null,
    fechaInicio: (f.fecha_inicio as string) ?? null,
    estatus: String(f.estatus),
  };
}

export const TOPE_LISTA = 50;

/** Los más recientes primero, con desempate estable (invariante del repo:
 *  todo `.limit()` lleva su `.order()` completo). */
export async function listarViajesOperativos(
  tenantId: string,
  estatus: (typeof ESTATUS_VIAJE)[number] | undefined,
  limite: number,
): Promise<ViajeOperativo[]> {
  let q = supabaseAdmin()
    .from('viaje')
    .select('id, folio, origen, destino, fecha_inicio, estatus')
    .eq('tenant_id', tenantId);
  if (estatus) q = q.eq('estatus', estatus);
  const res = await acotada(
    q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limite),
    'mcp.listar_viajes',
  );
  return ((exigir(res, 'mcp.listar_viajes') ?? []) as FilaViaje[]).map(aViaje);
}

/**
 * Resuelve «el viaje del que habla el usuario»: un folio tal cual, o un id.
 *
 * Devuelve TODAS las coincidencias de folio (no es único por contrato):
 * elegir una en silencio sería contestar sobre el viaje equivocado con cara
 * de seguridad. El llamador decide qué hacer con más de una.
 */
export async function resolverViaje(tenantId: string, ref: string): Promise<ViajeOperativo[]> {
  const limpio = ref.trim();
  if (limpio.length === 0) return [];
  const esUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(limpio);
  let q = supabaseAdmin()
    .from('viaje')
    .select('id, folio, origen, destino, fecha_inicio, estatus')
    .eq('tenant_id', tenantId);
  q = esUuid ? q.eq('id', limpio) : q.eq('folio', limpio);
  const res = await acotada(
    q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(5),
    'mcp.resolver_viaje',
  );
  return ((exigir(res, 'mcp.resolver_viaje') ?? []) as FilaViaje[]).map(aViaje);
}

/** Búsqueda por texto para la herramienta `search`: folio, origen o destino.
 *  El patrón se sanea — un `%` o `_` del usuario es texto, no comodín.
 *
 *  `,` `(` `)` NO son comodines de ILIKE: son los metacaracteres del propio
 *  `.or()` de PostgREST (separan condiciones o abren/cierran agrupaciones).
 *  Un valor libre como «Monterrey, NL» los mete crudos en la expresión que se
 *  arma abajo y rompe el filtro. Mismo saneo que `buscarGastosParaLigar` en
 *  `sat_descarga/bandeja.ts` (auditoría 28, SEG-M1). */
export async function buscarViajesTexto(tenantId: string, consulta: string): Promise<ViajeOperativo[]> {
  const limpio = consulta.trim().slice(0, 80)
    .replace(/[,()]/g, ' ')
    .replace(/[%_\\]/g, (m) => `\\${m}`);
  if (limpio.length === 0) return [];
  const patron = `%${limpio}%`;
  const res = await acotada(
    supabaseAdmin()
      .from('viaje')
      .select('id, folio, origen, destino, fecha_inicio, estatus')
      .eq('tenant_id', tenantId)
      .or(`folio.ilike.${patron},origen.ilike.${patron},destino.ilike.${patron}`)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(10),
    'mcp.buscar_viajes',
  );
  return ((exigir(res, 'mcp.buscar_viajes') ?? []) as FilaViaje[]).map(aViaje);
}

export function rotuloViaje(v: ViajeOperativo): string {
  const partes = [`Viaje ${v.folio}`];
  if (v.ruta) partes.push(v.ruta);
  partes.push(v.estatus === 'en_cuadre' ? 'en cuadre' : v.estatus);
  return partes.join(' · ');
}

// ── La herramienta ─────────────────────────────────────────────────────────

const esquemaListar = z.object({
  estatus: z.enum(ESTATUS_VIAJE).optional()
    .describe('Filtra por estatus: abierto (en curso), en_cuadre (comprobantes en revisión) o liquidado (cerrado). Sin filtro se devuelven todos.'),
  limite: z.number().int().min(1).max(TOPE_LISTA).optional()
    .describe(`Cuántos viajes devolver, del más reciente al más viejo. Por omisión 20, máximo ${TOPE_LISTA}.`),
});

async function ejecutarListar(tenantId: string, args: z.infer<typeof esquemaListar>): Promise<ResultadoHerramienta> {
  const limite = args.limite ?? 20;
  const viajes = await listarViajesOperativos(tenantId, args.estatus, limite);
  const filtro = args.estatus ? ` con estatus «${args.estatus}»` : '';
  if (viajes.length === 0) {
    return {
      texto: `No hay viajes${filtro} registrados en tu flota.`,
      estructurado: { viajes: [], filtro: args.estatus ?? null },
    };
  }
  const lineas = viajes.map((v) => `• ${rotuloViaje(v)}${v.fechaInicio ? ` — inició ${fechaCorta(v.fechaInicio)}` : ''}`);
  const tope = viajes.length === limite ? `\n(Se muestran los ${limite} más recientes; pide más con \`limite\` o filtra por estatus.)` : '';
  return {
    texto: `${viajes.length === 1 ? 'Un viaje' : `${viajes.length} viajes`}${filtro}, del más reciente al más viejo:\n${lineas.join('\n')}${tope}`,
    estructurado: { viajes, filtro: args.estatus ?? null },
  };
}

export const herramientaListarViajes: Herramienta<z.infer<typeof esquemaListar>> = {
  nombre: 'listar_viajes',
  titulo: 'Viajes de la flota',
  descripcion:
    'Lista los viajes de tu flota, del más reciente al más viejo, con folio, ruta, fecha de inicio y estatus (abierto, en cuadre o liquidado). No incluye cifras de dinero. Solo lectura.',
  area: 'operacion',
  esquema: esquemaListar,
  ejecutar: ejecutarListar,
};
