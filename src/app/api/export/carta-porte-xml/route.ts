import { NextResponse } from 'next/server';
import { getBorradorViaje } from '@/lib/likida/carta_porte_datos';
import { generarXmlCcp } from '@/lib/likida/carta_porte_xml';
import { generarIdCcp } from '@/lib/likida/carta_porte';
import { leerXmlTimbrado } from '@/lib/likida/carta_porte_timbre';
import { rateLimit, clientIp } from '@/lib/ratelimit';
import { resolverTenantApi } from '@/lib/auth/tenant-api';
import { getSessionTenant } from '@/lib/auth/session';
import { puedeExportar } from '@/lib/auth/permisos';
import { puedeVerRuta } from '@/lib/auth/visibilidad';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { acotada } from '@/lib/likida/presupuesto';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
// BE-19 (auditoría 24): sin esto el tope lo pone el default de la plataforma
// (15 s en Node sin Fluid Compute) y un export de 92 días sobre 45,000
// liquidaciones muere en 504 mudo. Literal a propósito: Next lo lee en build.
export const maxDuration = 120;

/**
 * FASE D DE CARTA PORTE — la descarga del XML listo para timbrar.
 *
 * Mismo patrón de puertas que las demás rutas de /api/export (auditoría 18,
 * A21): la del DATO (la ruta de Carta Porte es del área `operacion` — el
 * mismo gate que la página del borrador) Y la del verbo (`puedeExportar`).
 * El `?viaje=` se consulta SIEMPRE acotado al tenant de la sesión: un uuid
 * de otra flota devuelve 404, no el complemento ajeno.
 *
 * El XML solo sale del borrador VALIDADO (fail-closed en generarXmlCcp) y no
 * está timbrado — Likida no timbra (0049); la leyenda va dentro del archivo.
 */
export async function GET(req: Request) {
  if (!(await rateLimit(`export-ccp-xml:${clientIp(req)}`, 10, 60_000))) {
    return new NextResponse('Demasiadas peticiones', { status: 429 });
  }

  const t = await resolverTenantApi(req.url);
  if (!t.ok) return new NextResponse(t.motivo, { status: t.status });

  if (!(await rateLimit(`export-ccp-xml:tenant:${t.tenantId}`, 10, 60_000))) {
    return new NextResponse('Demasiadas peticiones', { status: 429 });
  }

  if (!puedeVerRuta(t.rol, '/dashboard/carta-porte')) {
    logger.warn('export.ccp_xml_area_sin_permiso', { rol: t.rol });
    return new NextResponse('Tu rol no ve la Carta Porte de la flota.', { status: 403 });
  }
  if (!puedeExportar(t.rol)) {
    logger.warn('export.ccp_xml_rol_sin_permiso', { rol: t.rol });
    return new NextResponse('Tu rol no puede descargar este documento.', { status: 403 });
  }

  const url = new URL(req.url);
  const viajeId = url.searchParams.get('viaje')?.trim() ?? '';
  if (!viajeId) return new NextResponse('Falta el viaje (?viaje=…).', { status: 400 });

  // FASE D vía PAC (0226): `&timbrado=1` descarga el XML TIMBRADO tal cual lo
  // devolvió el PAC — el comprobante, no el borrador. Solo existe si el viaje
  // tiene timbre vigente; sin él, 404 honesto (no se genera nada al vuelo).
  if (url.searchParams.get('timbrado') === '1') {
    // PUERTA PROPIA (0227, c6-3): el XML TIMBRADO es el CFDI, con el flete, el
    // IVA y la retención adentro — no es el pre-CFDI del borrador. Se gatea
    // contra el área del TIMBRADO (`dinero`), no contra la de Carta Porte:
    // el jefe de tráfico no descarga comprobantes fiscales con importes.
    if (!puedeVerRuta(t.rol, '/dashboard/timbrado')) {
      logger.warn('export.ccp_xml_timbrado_area_sin_permiso', { rol: t.rol });
      return new NextResponse('Tu rol no ve el timbrado de la flota.', { status: 403 });
    }
    try {
      const timbre = await leerXmlTimbrado(t.tenantId, viajeId);
      if (timbre === null) return new NextResponse('Este viaje no tiene timbre vigente.', { status: 404 });
      logger.info('export.ccp_xml_timbrado', { viajeId, uuid: timbre.uuid, modo: timbre.modo, rol: t.rol });
      // El nombre del archivo GRITA la prueba (c6-10): un XML sandbox
      // reenviado por correo llega sin la pantalla que lo rotulaba, y
      // `ccp-timbrada-<uuid>.xml` se lee como un comprobante real. El aviso
      // también va DENTRO del archivo (`marcarXmlSandbox`).
      const nombre = timbre.modo === 'sandbox'
        ? `ccp-SANDBOX-${timbre.uuid}.xml`
        : `ccp-timbrada-${timbre.uuid}.xml`;
      return new NextResponse(timbre.xml, {
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Content-Disposition': `attachment; filename="${nombre}"`,
          'Cache-Control': 'no-store',
        },
      });
    } catch (e) {
      logger.error('export.ccp_xml_timbrado_fallo', { viajeId, error: e instanceof Error ? e.message : String(e) });
      return new NextResponse('No se pudo leer el XML timbrado. Intenta de nuevo.', { status: 500 });
    }
  }

  try {
    const v = await getBorradorViaje(t.tenantId, viajeId);
    if (!v) return new NextResponse('Ese viaje no existe en tu flota.', { status: 404 });

    const r = generarXmlCcp(v, generarIdCcp());
    if (!r.ok) {
      // 409 y no 500: el estado del borrador es el conflicto, no un error del
      // sistema — y los motivos son los mismos que la página ya enseña.
      return new NextResponse(`El XML no se puede generar todavía:\n· ${r.motivos.join('\n· ')}`, { status: 409 });
    }

    // La bitácora: cuándo y quién generó por última vez (la última gana — el
    // XML se puede regenerar tras corregir datos, y lo citable es la más
    // reciente). Mejor esfuerzo DESPUÉS de generar: un sello caído no le
    // niega el archivo a la flota, pero queda en el log con su porqué.
    const s = await getSessionTenant();
    const sello = await acotada(
      supabaseAdmin().from('viaje')
        .update({ ccp_xml_generado_en: new Date().toISOString(), ccp_xml_generado_por: s?.userId ?? null })
        .eq('tenant_id', t.tenantId)
        .eq('id', viajeId),
      'export.ccp_xml.sello',
    );
    if (sello.error) {
      logger.warn('export.ccp_xml_sello_fallo', { viajeId, error: sello.error.message });
    }
    logger.info('export.ccp_xml_generado', { viajeId, idCcp: r.idCcp, rol: t.rol, omitidos: r.omitidos.length });

    return new NextResponse(r.xml, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${r.nombreArchivo}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logger.error('export.ccp_xml_fallo', { viajeId, error });
    return new NextResponse('No se pudo generar el XML. Intenta de nuevo.', { status: 500 });
  }
}
