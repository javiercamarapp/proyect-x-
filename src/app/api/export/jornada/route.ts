import { NextResponse } from 'next/server';
import { rateLimit, clientIp } from '@/lib/ratelimit';
import { resolverTenantApi } from '@/lib/auth/tenant-api';
import { puedeExportar } from '@/lib/auth/permisos';
import { puedeVerArea } from '@/lib/auth/visibilidad';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { hoyMx } from '@/lib/formato';
import { acotada } from '@/lib/likida/presupuesto';
import { leerJornadas, leerPolitica, nombresDeOperadores } from '@/lib/likida/jornada/repo';
import { armarReporte, reporteACsv, type DiaDelReporte } from '@/lib/likida/jornada/reporte';

export const runtime = 'nodejs';
// BE-19 (auditoría 24): sin esto el tope lo pone el default de la plataforma
// (15 s en Node sin Fluid Compute) y un export de 92 días sobre 45,000
// liquidaciones muere en 504 mudo. Literal a propósito: Next lo lee en build.
export const maxDuration = 120;

/**
 * EL REPORTE DE JORNADA QUE LA FLOTA ENSEÑA EN UNA INSPECCIÓN.
 *
 * Registro del art. 132 fracción XXXIV de la LFT, en CSV, con las leyendas
 * pegadas al archivo — qué documento es, qué documento NO es (la bitácora de
 * horas de servicio del art. 83 del Reglamento de Tránsito es otra cosa), qué
 * no se evaluó (los tiempos de conducción de la NOM-087) y qué significa un
 * renglón sin total.
 *
 * ── POR QUÉ ES ÁREA `operacion` Y NO `dinero` ────────────────────────────
 * Aquí no hay un peso en pantalla. El usuario natural es el jefe de tráfico:
 * es quien sabe a qué hora salió cada quien y quien puede corregirlo. Mismo
 * criterio que /dashboard/operadores y /dashboard/unidades.
 *
 * Dos puertas, como en las demás exportaciones: la del DATO (`puedeVerArea`) y
 * la del VERBO (`puedeExportar`). Y el rango se acota SIEMPRE al tenant de la
 * sesión: ningún parámetro decide de qué flota se lee.
 */
const MAX_DIAS = 400;

export async function GET(req: Request) {
  if (!(await rateLimit(`export-jornada:${clientIp(req)}`, 10, 60_000))) {
    return new NextResponse('Demasiadas peticiones', { status: 429 });
  }

  const t = await resolverTenantApi(req.url);
  if (!t.ok) return new NextResponse(t.motivo, { status: t.status });

  if (!(await rateLimit(`export-jornada:tenant:${t.tenantId}`, 10, 60_000))) {
    return new NextResponse('Demasiadas peticiones', { status: 429 });
  }

  if (!puedeVerArea(t.rol, 'operacion')) {
    logger.warn('export.jornada_area_sin_permiso', { rol: t.rol });
    return new NextResponse('Tu rol no ve la operación de la flota.', { status: 403 });
  }
  if (!puedeExportar(t.rol)) {
    logger.warn('export.jornada_rol_sin_permiso', { rol: t.rol });
    return new NextResponse('Tu rol no puede descargar este documento.', { status: 403 });
  }

  const url = new URL(req.url);
  const hoy = hoyMx(new Date());
  const desde = (url.searchParams.get('desde') ?? '').trim() || hoy;
  const hasta = (url.searchParams.get('hasta') ?? '').trim() || hoy;
  const operador = (url.searchParams.get('operador') ?? '').trim() || null;

  const fecha = /^\d{4}-\d{2}-\d{2}$/;
  if (!fecha.test(desde) || !fecha.test(hasta)) {
    return new NextResponse('Las fechas van como AAAA-MM-DD (?desde=&hasta=).', { status: 400 });
  }
  if (desde > hasta) {
    return new NextResponse('La fecha inicial va antes que la final.', { status: 400 });
  }
  const dias = Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000) + 1;
  if (dias > MAX_DIAS) {
    return new NextResponse(`El periodo no puede pasar de ${MAX_DIAS} días. Pide el rango en partes.`, { status: 400 });
  }

  try {
    const lectura = await leerJornadas(t.tenantId, desde, hasta, operador);
    const politica = await leerPolitica(t.tenantId);
    const nombres = await nombresDeOperadores(t.tenantId, lectura.dias.map((d) => d.operadorId));

    const nombreTenant = await acotada(
      supabaseAdmin().from('tenant').select('nombre').eq('id', t.tenantId).maybeSingle(),
      'export.jornada.tenant',
    );
    // El nombre de la flota es adorno del encabezado: si no se pudo leer, el
    // reporte sale igual y lo dice. Lo que NO puede salir a medias son los
    // días, y ésos ya lanzaron arriba si fallaron.
    const tenantNombre = nombreTenant.error
      ? null
      : ((nombreTenant.data as { nombre?: string } | null)?.nombre ?? null);

    const filas: DiaDelReporte[] = lectura.dias.map((d) => {
      const o = nombres.get(d.operadorId);
      return {
        dia: d.dia,
        operadorId: d.operadorId,
        // Nunca se inventa un nombre. Si el operador ya no está en el catálogo
        // se dice con su id, que es lo único cierto que queda de él.
        operadorNombre: o?.nombre ?? `operador ${d.operadorId.slice(0, 8)} (ya no está en el catálogo)`,
        numeroEmpleado: o?.numeroEmpleado ?? null,
        estado: d.estado,
        cerradoEn: d.cerradoEn,
        cerradoPorEmail: d.cerradoPorEmail,
        conformeOperadorEn: d.conformeOperadorEn,
        asientos: d.asientos,
      };
    });

    const reporte = armarReporte({ tenantNombre, desde, hasta, dias: filas, politica });

    // LA TRUNCACIÓN SE DECLARA DENTRO DEL ARCHIVO. Un CSV recortado en silencio
    // es el peor de los documentos: parece completo y le falta gente.
    if (lectura.truncada) {
      reporte.leyendas.unshift(
        '⚠️ ESTE REPORTE ESTÁ INCOMPLETO: el periodo pedido trae más expedientes de los que ' +
        'caben en una lectura. Pide el rango en partes más cortas; lo que sigue NO es el ' +
        'periodo entero.',
      );
    }

    const csv = reporteACsv(reporte);
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="registro_jornada_${desde}_a_${hasta}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    logger.error('export.jornada', { tenant: t.tenantId, err: e instanceof Error ? e.message : String(e) });
    // Fallar cerrado: NO se manda medio reporte. Un registro de jornada
    // incompleto que parece completo es peor que no tener ninguno.
    return new NextResponse(
      'No se pudo generar el registro de jornada. No se entrega uno incompleto: intenta de nuevo en un momento.',
      { status: 500 },
    );
  }
}
