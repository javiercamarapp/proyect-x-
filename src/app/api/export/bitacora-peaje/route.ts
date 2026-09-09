import { NextResponse } from 'next/server';
import { bitacoraRmf918, bitacoraACsv } from '@/lib/likida/intake/desglose_peaje';
import { rateLimit, clientIp } from '@/lib/ratelimit';
import { resolverTenantApi } from '@/lib/auth/tenant-api';
import { puedeExportar } from '@/lib/auth/permisos';
import { puedeVerArea } from '@/lib/auth/visibilidad';
import { logger } from '@/lib/logger';
import { LecturaIncompleta } from '@/lib/likida/pg';

export const runtime = 'nodejs';
// BE-19 (auditoría 24): sin esto el tope lo pone el default de la plataforma
// (15 s en Node sin Fluid Compute) y un export de 92 días sobre 45,000
// liquidaciones muere en 504 mudo. Literal a propósito: Next lo lee en build.
export const maxDuration = 120;

/**
 * La bitácora RMF 2026 regla 9.1.8, fr. II, de UN desglose de peaje (F5) —
 * los cruces conciliados con su viaje, en CSV, con la leyenda pegada al
 * archivo (qué produce este documento y qué corre por cuenta del
 * contribuyente; ficha `normas/rmf-2026-9.1.8.yaml`).
 *
 * Mismo patrón de puertas que /api/export/facturas-proveedor: la del DATO
 * (área dinero) Y la del verbo (puedeExportar). El `?desglose=` se consulta
 * SIEMPRE acotado al tenant de la sesión — un uuid de otra flota devuelve
 * 404, no datos ajenos.
 */
export async function GET(req: Request) {
  if (!(await rateLimit(`export-bitacora:${clientIp(req)}`, 10, 60_000))) {
    return new NextResponse('Demasiadas peticiones', { status: 429 });
  }

  const t = await resolverTenantApi(req.url);
  if (!t.ok) return new NextResponse(t.motivo, { status: t.status });

  // Cuota por flota además de por IP — ver la nota de export/liquidaciones,
  // mismo criterio y mismo número que ya usaba esta ruta para su IP.
  if (!(await rateLimit(`export-bitacora:tenant:${t.tenantId}`, 10, 60_000))) {
    return new NextResponse('Demasiadas peticiones', { status: 429 });
  }

  if (!puedeVerArea(t.rol, 'dinero')) {
    logger.warn('export.bitacora_area_sin_permiso', { rol: t.rol });
    return new NextResponse('Tu rol no ve las cifras de dinero de la flota.', { status: 403 });
  }
  if (!puedeExportar(t.rol)) {
    logger.warn('export.bitacora_rol_sin_permiso', { rol: t.rol });
    return new NextResponse('Tu rol no puede descargar este documento.', { status: 403 });
  }

  const desgloseId = new URL(req.url).searchParams.get('desglose')?.trim() ?? '';
  if (!desgloseId) {
    return new NextResponse('Falta el desglose (?desglose=…).', { status: 400 });
  }

  try {
    const bitacora = await bitacoraRmf918(t.tenantId, desgloseId);
    if (!bitacora) {
      return new NextResponse('Ese desglose no existe en tu flota.', { status: 404 });
    }
    const csv = bitacoraACsv(bitacora);
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="bitacora_rmf_918_likida.csv"',
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    // AUDITORÍA 24, BE-24: `LecturaIncompleta` no es un bache — es «hay más
    // cruces de los que se pueden traer demostrando que están todos». Decirle
    // «intenta de nuevo en un momento» manda al contralor a reintentar un
    // error determinista y a creer que fue mala suerte. Se nombra, como en
    // export/facturas-proveedor.
    if (e instanceof LecturaIncompleta) {
      logger.error('export.bitacora_peaje_incompleta', { tenant: t.tenantId, leidas: e.leidas, esperadas: e.esperadas });
      return new NextResponse('Ese desglose trae más cruces de los que la bitácora puede traer demostrando que están todos. No se manda un archivo corto: avísanos.', { status: 500 });
    }
    logger.error('export.bitacora_peaje', { tenant: t.tenantId, err: e instanceof Error ? e.message : String(e) });
    return new NextResponse('No se pudo generar la bitácora. Intenta de nuevo en un momento.', { status: 500 });
  }
}
