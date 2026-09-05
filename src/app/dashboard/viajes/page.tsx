import { redirect } from 'next/navigation';
import { read as leerLibro, utils as xlsxUtils } from 'xlsx';
import { resolverTenantEfectivo } from '@/lib/auth/tenant-efectivo';
import { requireSessionTenant } from '@/lib/auth/guard';
import { puedeVerRuta, puedeVerArea } from '@/lib/auth/visibilidad';
import { puedeAsignar } from '@/lib/auth/permisos';
import { getLiquidacionesDeViajes } from '@/lib/likida/analytics';
import { getViajesRegistro, getConteosViajes, TOPE_PAGINA } from '@/lib/likida/viajes_registro';
import { interpretarFilasViajes, importarViajes } from '@/lib/likida/importar_viajes';
import { logger } from '@/lib/logger';
import { sufijoTenant } from '../sufijo';
import { VistaViajes, type FiltroViajes, type FilaRegistroViaje } from './vista';
import type { ResultadoImportarUI } from './importar';
import { MAX_ARCHIVO_SUBIDA_BYTES, MENSAJE_ARCHIVO_GRANDE } from '@/lib/http/subidas_formulario';

const MAX_IMPORT_BYTES = MAX_ARCHIVO_SUBIDA_BYTES;

export const dynamic = 'force-dynamic';

const FILTROS: FiltroViajes[] = ['todos', 'abiertos', 'en_cuadre', 'liquidados', 'escalados'];

/** Filas por página del registro: el tope de render que pidió el rediseño,
 *  y el mismo que la RPC impone del lado de la base (0154). */
const POR_PAGINA = TOPE_PAGINA;

/**
 * Registro de Viajes (F2 del plan) — la fuente de verdad NAVEGABLE, no una
 * página de acción: crear/asignar/avisar viven en Despacho. Área
 * `operacion`, así que los pesos (anticipo, comprobado, diferencia) SOLO
 * salen del servidor cuando el rol ve dinero — `puedeVerArea(rol, 'dinero')`
 * abajo; para el jefe de tráfico las tres columnas ni existen (el 4-ago una
 * página de viajes ya filtró anticipos al encargado; `dinero_por_area.test.ts`
 * vigila).
 */
export default async function PaginaViajes({
  searchParams,
}: {
  searchParams: Promise<{ vista?: string; tenant?: string; rol?: string; f?: string; q?: string; c?: string; p?: string }>;
}) {
  const sp = await searchParams;
  const { tenantId, rol } = await resolverTenantEfectivo('/dashboard/viajes', sp);
  if (!puedeVerRuta(rol, '/dashboard/viajes')) redirect('/dashboard');
  const sufijo = sufijoTenant(sp);
  const verDinero = puedeVerArea(rol, 'dinero');

  const filtro: FiltroViajes = (FILTROS as string[]).includes(sp.f ?? '') ? (sp.f as FiltroViajes) : 'todos';
  const q = (sp.q ?? '').trim().slice(0, 80);
  // ESCALA 50k (22-ago-2026): la página se navega por CURSOR (`?c=`), no por
  // número (`?p=`). El `?p=N` viejo —links guardados, marcadores— cae a la
  // primera página: no hay OFFSET al que mapearlo, y a 600k viajes ese
  // OFFSET era justo lo que se quitó. Un cursor corrupto también cae a la
  // primera (decodificarCursor nunca lanza).
  const cursor = (sp.c ?? '').trim().slice(0, 200) || null;

  // Primarios sin catch (fail closed); los conteos degradan a null solos —
  // los cinco salen de UNA lectura (`conteos_viajes_tenant`, 0154), no de
  // cinco `count exact` sobre la tabla entera.
  const [{ filas: viajes, hayMas, siguiente }, conteos] = await Promise.all([
    getViajesRegistro(tenantId, { q, cursor, porPagina: POR_PAGINA, filtro }),
    getConteosViajes(tenantId),
  ]);

  // `/dashboard/[id]` abre por id de LIQUIDACIÓN — se cruza por `viaje_id`
  // (antes por folio, que es texto libre del TMS), y un viaje sin cruce se
  // queda sin link (nunca un link a un 404).
  const liquidaciones = await getLiquidacionesDeViajes(tenantId, viajes.map((v) => v.id));
  const liqPorViaje = new Map(liquidaciones.map((l) => [l.viajeId, l]));

  const filas: FilaRegistroViaje[] = viajes.map((v) => {
    const liq = liqPorViaje.get(v.id) ?? null;
    return {
      id: v.id, folio: v.folio, origen: v.origen, destino: v.destino,
      estatus: v.estatus, operadorNombre: v.operadorNombre, unidadEco: v.unidadEco, fechaInicio: v.fechaInicio,
      intakePendientes: v.intakePendientes,
      avisadoEn: v.avisadoEn, aceptadoEn: v.aceptadoEn, escaladoEn: v.escaladoEn,
      avisosEnviados: v.avisosEnviados,
      // Los pesos se quedan en el servidor si el rol no ve dinero.
      anticipo: verDinero ? v.anticipo : null,
      comprobado: verDinero && liq ? liq.comprobado : null,
      diferencia: verDinero && liq ? liq.diferencia : null,
      // FE-26: sin gatear, el encargado (área `operacion`, sin dinero) veía
      // "Ver →" en cada viaje liquidado y el link lo mandaba a `/dashboard/
      // [id]`, que lo rebota al Resumen (`puedeVerArea(rol,'dinero')`) — el
      // único "detalle de viaje" que el producto ofrece hoy es la
      // liquidación, y para él es un callejón sin salida.
      liqId: verDinero && liq ? liq.id : null,
      liqEstatus: liq?.estatus ?? null,
    };
  });

  async function importar(_prev: ResultadoImportarUI | null, fd: FormData): Promise<ResultadoImportarUI | null> {
    'use server';
    // Se repite ADENTRO (patrón del repo): POST directo posible. Importar
    // CREA viajes — el gate es el de asignar, no solo el de ver.
    const sesion = await requireSessionTenant('/dashboard/viajes');
    if (!puedeAsignar(sesion.rol)) return { error: 'Tu rol no puede crear viajes.' };
    if (sesion.rol !== 'superadmin' && sesion.tenantId !== tenantId) return { error: 'Este registro no es de tu flota.' };

    const archivo = fd.get('archivo');
    if (!(archivo instanceof File) || archivo.size === 0) return { error: 'Elige el CSV o Excel con los viajes.' };
    if (archivo.size > MAX_IMPORT_BYTES) return { error: MENSAJE_ARCHIVO_GRANDE };

    let matriz: unknown[][];
    try {
      const libro = leerLibro(await archivo.arrayBuffer(), { type: 'array' });
      const hoja = libro.Sheets[libro.SheetNames[0]];
      matriz = xlsxUtils.sheet_to_json(hoja, { header: 1, raw: true }) as unknown[][];
    } catch {
      return { error: 'No pude leer el archivo — asegúrate de que sea CSV o Excel.' };
    }

    const lectura = interpretarFilasViajes(matriz, { permitirFinanzas: puedeVerArea(sesion.rol, 'dinero') });
    if (lectura.error && lectura.viajes.length === 0) return { error: lectura.error };

    const r = await importarViajes(tenantId, lectura.viajes);
    logger.info('viajes.importados', { tenantId, creados: r.creados, saltados: r.saltados.length });
    if (r.error) return { error: r.error };
    return {
      resumen: {
        creados: r.creados,
        saltados: r.saltados.length,
        descartadas: lectura.descartadas,
        operadoresSinAmarrar: r.operadoresSinAmarrar,
        sinOperador: r.sinOperador,
        operadorOcupado: r.operadorOcupado,
        unidadesSinAmarrar: r.unidadesSinAmarrar,
        sinUnidad: r.sinUnidad,
        clientesSinAmarrar: r.clientesSinAmarrar,
        sinCliente: r.sinCliente,
      },
    };
  }

  return (
    <VistaViajes
      filas={filas}
      filtro={filtro}
      conteos={conteos ?? { total: null, abiertos: null, enCuadre: null, liquidados: null, escalados: null }}
      sufijo={sufijo}
      importar={importar}
      puedeImportar={puedeAsignar(rol)}
      verDinero={verDinero}
      q={q}
      cursor={cursor}
      siguiente={siguiente}
      hayMas={hayMas}
      porPagina={POR_PAGINA}
    />
  );
}
