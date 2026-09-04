// ═══════════════════════════════════════════════════════════════════════════
// GET /v1/liquidaciones — el CIERRE de un viaje, por llave API.
//
// El hueco que cierra (auditoría 24, «Integración con el cliente»): el TMS del
// piloto no tenía cómo traerse el cierre de un viaje. Lo único que existía era
// `/api/export/liquidaciones`, un CSV que exige SESIÓN DE NAVEGADOR — o sea,
// una persona con cookie, no un servidor. El integrador acababa haciendo
// polling de `GET /v1/viajes` y adivinando el cierre por `estatus`.
//
// ── LA COLUMNA QUE HACE ÚTIL A ESTE ENDPOINT ES `revision` ────────────────
//
// Desde la 0299 una liquidación tiene DOS estados y no uno:
//   · `estatus`  — lo que el MOTOR concluyó (cuadrada / con_diferencias / revisar)
//   · `revision` — lo que una PERSONA firmó (pendiente / aprobada / ajustada / rechazada)
//
// Un ERP que contabilice por `estatus` va a asentar cierres que nadie firmó, y
// —peor— cierres RECHAZADOS cuyas cifras están a punto de cambiar. Por eso el
// default de esta ruta es `revision=firmadas` (aprobada + ajustada): lo que se
// puede asentar. Traerse lo demás se pide EXPLÍCITO (`?revision=pendiente`,
// `?revision=rechazada`, `?revision=todas`) y la respuesta declara siempre qué
// filtro se aplicó, para que nadie confunda «no hay» con «no lo pedí».
//
// Área `dinero`: aquí hay pesos (anticipo, comprobado, diferencia).
// ═══════════════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { acotada } from '@/lib/likida/presupuesto';
import { exigir } from '@/lib/likida/pg';
import {
  type RevisionLiquidacion, type FiltroRevisionExport, leerFiltroRevisionExport,
} from '@/lib/likida/revision';
import {
  abrir, leerPagina, leerCursor, sobre, fallo, errorApi, codificarCursor,
  type Pagina, type Cursor, type CuerpoError,
} from '../_comun';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Lo que se puede pedir en `?revision=`. El vocabulario es el de
 *  `lib/likida/revision.ts` — el MISMO que `/api/export/liquidaciones` (ARQUITECTURA
 *  25, ALTO): antes de esto, `?revision=sin_rechazadas` era válido en el CSV
 *  y 400 aquí. `firmadas` sigue siendo el default de ESTA ruta y NO es una
 *  columna: es «aprobada o ajustada», o sea lo asentable. */
type FiltroRevision = FiltroRevisionExport;
const FILTRO_DEFECTO: FiltroRevision = 'firmadas';

interface LiquidacionApi {
  id: string;
  viajeId: string;
  folio: string | null;
  creadaEn: string;
  /** Lo que concluyó el MOTOR: cuadrada / con_diferencias / revisar. */
  estatus: string;
  /** Lo que firmó una PERSONA. `pendiente` = nadie la ha firmado todavía:
   *  no la asientes. */
  revision: RevisionLiquidacion;
  /** Correo de quien firmó. `null` = la firmó el motor (cuadró sola) o nadie. */
  revisadaPor: string | null;
  revisadaEn: string | null;
  /** El motivo escrito al ajustar o rechazar. */
  motivo: string | null;
  /** Los montos que la persona corrigió al ajustar (WA-3), o `[]`. */
  ajustes: Array<{ gastoId: string; concepto: string; montoAnterior: number; montoNuevo: number }>;
  anticipo: number;
  comprobado: number;
  /** anticipo − comprobado. Positivo = el chofer debe; negativo = se le repone. */
  diferencia: number;
  ivaAcreditable: number;
  iepsAcreditable: number;
  litrosDieselAcreditables: number;
  /** Cuántos hallazgos levantó el motor. El detalle vive en el PDF. */
  hallazgos: number;
}

const COLUMNAS =
  'id, viaje_id, created_at, total_comprobado, total_anticipo, diferencia, estatus, diferencias, '
  + 'revision, revisada_por_email, revisada_en, motivo, ajustes, '
  + 'iva_acreditable, ieps_acreditable, litros_diesel_acreditables, viaje:viaje_id(folio)';

type FilaCruda = Record<string, unknown> & { viaje?: { folio?: string | null } | null };

function aLiquidacionApi(r: FilaCruda): LiquidacionApi {
  const ajustes = Array.isArray(r.ajustes) ? (r.ajustes as Array<Record<string, unknown>>) : [];
  const hallazgos = Array.isArray(r.diferencias) ? (r.diferencias as unknown[]).length : 0;
  return {
    id: String(r.id),
    viajeId: String(r.viaje_id),
    folio: r.viaje?.folio ?? null,
    creadaEn: String(r.created_at),
    estatus: String(r.estatus),
    revision: r.revision as RevisionLiquidacion,
    revisadaPor: (r.revisada_por_email as string | null) ?? null,
    revisadaEn: (r.revisada_en as string | null) ?? null,
    motivo: (r.motivo as string | null) ?? null,
    ajustes: ajustes.map((a) => ({
      gastoId: String(a.gasto_id ?? ''),
      concepto: String(a.concepto ?? ''),
      montoAnterior: Number(a.monto_anterior ?? 0),
      montoNuevo: Number(a.monto_nuevo ?? 0),
    })),
    anticipo: Number(r.total_anticipo ?? 0),
    comprobado: Number(r.total_comprobado ?? 0),
    diferencia: Number(r.diferencia ?? 0),
    ivaAcreditable: Number(r.iva_acreditable ?? 0),
    iepsAcreditable: Number(r.ieps_acreditable ?? 0),
    litrosDieselAcreditables: Number(r.litros_diesel_acreditables ?? 0),
    hallazgos,
  };
}

/** Lee `?revision=`. No recorta en silencio: un valor desconocido es 400, no
 *  «te devuelvo el default» — el integrador que escribió `aprobadas` en plural
 *  se llevaría una lista que no es la que pidió. */
function leerFiltroRevision(url: string): { ok: true; filtro: FiltroRevision } | { ok: false; respuesta: NextResponse<CuerpoError> } {
  const r = leerFiltroRevisionExport(new URL(url).searchParams.get('revision'), FILTRO_DEFECTO);
  if (!r.ok) {
    return {
      ok: false,
      respuesta: errorApi('parametro_invalido', `${r.motivo} Por omisión son las firmadas (aprobada o ajustada), que es lo asentable.`),
    };
  }
  return r;
}

async function leerLiquidaciones(
  tenantId: string,
  filtro: FiltroRevision,
  pagina: Pagina,
  despues: Cursor | null,
  conConteo: boolean,
): Promise<{ filas: FilaCruda[]; total: number | null }> {
  let q = supabaseAdmin()
    .from('liquidacion')
    .select(COLUMNAS, conConteo ? { count: 'exact' } : {})
    .eq('tenant_id', tenantId);

  if (filtro === 'firmadas') q = q.in('revision', ['aprobada', 'ajustada']);
  else if (filtro === 'sin_rechazadas') q = q.neq('revision', 'rechazada');
  else if (filtro !== 'todas') q = q.eq('revision', filtro);

  // `(created_at, id) < (c, i)` en el dialecto de PostgREST — el mismo cursor
  // que `/v1/viajes`. Sin la segunda rama, dos cierres del mismo microsegundo
  // se pierden o se repiten (`pg.ts`).
  if (despues) {
    q = q.or(`created_at.lt.${despues.creadoEn},and(created_at.eq.${despues.creadoEn},id.lt.${despues.id})`);
  }
  q = q.order('created_at', { ascending: false }).order('id', { ascending: false });

  // Una fila de más: `hayMas` exacto sin contar la tabla en cada vuelta.
  const desde = despues ? 0 : pagina.desplazamiento;
  q = q.range(desde, desde + pagina.limite);

  const res = await acotada(q, 'v1.liquidaciones');
  const filas = (exigir(res, 'v1.liquidaciones') ?? []) as unknown as FilaCruda[];
  return { filas, total: typeof res.count === 'number' ? res.count : null };
}

export async function GET(req: Request) {
  const acceso = await abrir(req, 'dinero');
  if (!acceso.ok) return acceso.respuesta;

  const pag = leerPagina(req.url);
  if (!pag.ok) return pag.respuesta;
  const cur = leerCursor(req.url, pag.pagina);
  if (!cur.ok) return cur.respuesta;
  const rev = leerFiltroRevision(req.url);
  if (!rev.ok) return rev.respuesta;

  try {
    const { filas, total } = await leerLiquidaciones(acceso.tenantId, rev.filtro, pag.pagina, cur.despues, cur.conteo);

    // El recorte silencioso de PostgREST, atrapado (igual que `/v1/viajes`):
    // página corta + total que dice que hay más = techo del servidor, no el
    // final de la tabla. Servir eso sería decirle al ERP «ya no hay cierres».
    const pedidas = pag.pagina.limite + 1;
    const leidas = (cur.despues ? 0 : pag.pagina.desplazamiento) + filas.length;
    if (filas.length < pedidas && total !== null && total > leidas) {
      return errorApi(
        'lectura_incompleta',
        'El servidor de datos recortó la lectura antes de llegar al final de la página pedida. No devolvemos una página corta como si fuera la última: pide un `limite` menor o avísanos.',
      );
    }

    const hayMas = filas.length > pag.pagina.limite;
    const pagina = filas.slice(0, pag.pagina.limite);
    const ultima = pagina.at(-1);
    const siguiente = hayMas && ultima
      ? codificarCursor({ creadoEn: String(ultima.created_at), id: String(ultima.id) })
      : null;

    return NextResponse.json({
      ...sobre(pagina.map(aLiquidacionApi), pag.pagina, total, { hayMas, siguiente }),
      // El filtro VIAJA EN LA RESPUESTA. Sin esto, un integrador que no pasó
      // `?revision=` lee una lista corta y concluye «la flota cerró pocos
      // viajes», cuando lo que pasa es que el resto espera firma.
      filtro: {
        revision: rev.filtro,
        significado: rev.filtro === 'firmadas'
          ? 'Solo las que una persona aprobó o ajustó. Las pendientes de firma y las rechazadas no vienen: pídelas con ?revision=pendiente o ?revision=rechazada.'
          : rev.filtro === 'todas'
            ? 'Todas, firmadas o no. Mira `revision` de cada una antes de asentarla.'
            : rev.filtro === 'sin_rechazadas'
              ? 'Todas menos las rechazadas: incluye las que todavía esperan firma.'
              : `Solo las que están en revisión «${rev.filtro}».`,
      },
    });
  } catch (e) {
    return fallo('v1.liquidaciones', e, { tenant: acceso.tenantId });
  }
}
