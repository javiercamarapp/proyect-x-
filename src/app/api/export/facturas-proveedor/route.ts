import { NextResponse } from 'next/server';
import { toCsv } from '@/lib/likida/export';
import { exportarAprobadas, marcarExportadas, type FormatoExport } from '@/lib/likida/proveedores';
import { registrarCorrida } from '@/lib/likida/agentes/corridas';
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

/** `?formato=` → layout. Sin parámetro sigue saliendo el genérico de la 0091
 *  (hay quien ya lo descarga); un valor inventado es 400, no un default
 *  silencioso — mandar el layout equivocado al ERP es peor que un error. */
const FORMATOS: Record<string, FormatoExport> = {
  '': 'generico',
  generico: 'generico',
  sap_b1: 'sap_b1',
  contpaqi: 'contpaqi',
};

/**
 * Export de facturas de proveedor APROBADAS (F6, escalón 2) — el archivo
 * importable: genérico, layout SAP B1 (Excel/DTW) o variante CONTPAQi.
 * Mismo patrón de puertas que /api/export/liquidaciones: la del DATO (área
 * dinero) Y la del verbo (puedeExportar) — la lección documentada del IDOR:
 * se acota el tenant y se olvida el rol.
 *
 * Después de generar el CSV se marca `exportada_en` (anti-doble-import) y se
 * anota la corrida del agente. Los dos son POSTERIORES al archivo y jamás lo
 * tumban: si el marcado falla, el archivo sale y la corrida lo dice.
 */
export async function GET(req: Request) {
  if (!(await rateLimit(`export-prov:${clientIp(req)}`, 10, 60_000))) {
    return new NextResponse('Demasiadas peticiones', { status: 429 });
  }

  const t = await resolverTenantApi(req.url);
  if (!t.ok) return new NextResponse(t.motivo, { status: t.status });

  // Cuota por flota además de por IP — ver la nota de export/liquidaciones,
  // mismo criterio y mismo número que ya usaba esta ruta para su IP.
  if (!(await rateLimit(`export-prov:tenant:${t.tenantId}`, 10, 60_000))) {
    return new NextResponse('Demasiadas peticiones', { status: 429 });
  }

  if (!puedeVerArea(t.rol, 'dinero')) {
    logger.warn('export.proveedor_area_sin_permiso', { rol: t.rol });
    return new NextResponse('Tu rol no ve las cifras de dinero de la flota.', { status: 403 });
  }
  if (!puedeExportar(t.rol)) {
    logger.warn('export.proveedor_rol_sin_permiso', { rol: t.rol });
    return new NextResponse('Tu rol no puede descargar este documento.', { status: 403 });
  }

  const crudo = new URL(req.url).searchParams.get('formato') ?? '';
  const formato = FORMATOS[crudo];
  if (!formato) {
    return new NextResponse('Formato desconocido. Los que existen: generico, sap_b1, contpaqi.', { status: 400 });
  }

  const inicio = new Date();
  try {
    // ESC-8: `exportarAprobadas` pagina hasta DEMOSTRAR que trajo todas las
    // aprobadas (traerTodo + count); si no puede, lanza `LecturaIncompleta` y
    // aquí se dice — el CSV corto con cara de completo ya no existe como
    // salida. (Antes: `.limit(5000)` recortado a 1,000 por PostgREST y un
    // `recortado` que jamás se cumplía.)
    const { filas, ids } = await exportarAprobadas(t.tenantId, formato);
    const cuerpo = toCsv(filas);

    // El archivo ya existe: lo que sigue anota, no decide.
    const marca = await marcarExportadas(t.tenantId, ids);
    // AUDITORÍA 24, BE-8: el aviso vivía SOLO en `agente_corrida`. Quien
    // descarga el CSV no abre la bitácora del agente: veía un 200 con archivo
    // y lo importaba al ERP; como `exportada_en` seguía NULL, las mismas
    // facturas reaparecían «sin exportar» y las volvía a importar — CFDI y
    // UUID duplicados en la contabilidad de la flota. La advertencia va DENTRO
    // del archivo, como en export/jornada: en la primera línea, comentada con
    // `#` para que el importador la salte.
    const csv = marca.error
      ? `# AVISO: el archivo está completo, pero NO se pudo marcar como exportadas ${ids.length - marca.marcadas} de ${ids.length} facturas. ` +
        'Van a reaparecer en la bandeja como «sin exportar»: NO las vuelvas a importar al ERP sin revisar antes cuáles ya entraron.\n' +
        cuerpo
      : cuerpo;
    await registrarCorrida(t.tenantId, 'proveedores', {
      inicio,
      fin: new Date(),
      estado: marca.error ? 'parcial' : 'ok',
      disparo: 'manual',
      tareasHechas: marca.error ? marca.marcadas : ids.length,
      tareasTotal: ids.length,
      resumen: { accion: 'export', formato, facturas: ids.length },
      error: marca.error
        ? 'El archivo salió, pero no se pudo marcar qué facturas quedaron exportadas — pueden reaparecer como «sin exportar».'
        : undefined,
    });

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        // El genérico conserva su nombre de siempre: hay quien ya lo descarga.
        'Content-Disposition': `attachment; filename="${formato === 'generico' ? 'facturas_proveedor_likida.csv' : `facturas_proveedor_${formato}_likida.csv`}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    if (e instanceof LecturaIncompleta) {
      logger.error('export.proveedor_incompleto', { tenant: t.tenantId, leidas: e.leidas, esperadas: e.esperadas });
      return new NextResponse('La flota tiene más facturas de las que el export puede traer demostrando que están todas. No se manda un archivo corto: avísanos.', { status: 500 });
    }
    logger.error('export.proveedor', { tenant: t.tenantId, err: e instanceof Error ? e.message : String(e) });
    return new NextResponse('No se pudo generar el export. Intenta de nuevo en un momento.', { status: 500 });
  }
}
