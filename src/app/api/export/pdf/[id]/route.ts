import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { rateLimit, clientIp } from '@/lib/ratelimit';
import { resolverTenantApi } from '@/lib/auth/tenant-api';
import { puedeExportar } from '@/lib/auth/permisos';
import { puedeVerArea } from '@/lib/auth/visibilidad';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
// BE-19 (auditoría 24): sin esto el tope lo pone el default de la plataforma
// (15 s en Node sin Fluid Compute) y un export de 92 días sobre 45,000
// liquidaciones muere en 504 mudo. Literal a propósito: Next lo lee en build.
export const maxDuration = 120;

// ═══════════════════════════════════════════════════════════════════════════
// EL PDF QUE YA EXISTÍA Y NO TENÍA PUERTA.
//
// `guardar_liquidacion_tx` recibe `p_pdf_url` y la columna `pdf_url` existe
// desde la 0001, pero `getLiquidacionDetalle` ni la seleccionaba y ninguna
// página la renderizaba: en el demo, "¿me da el PDF?" se contestaba tecleando
// una URL a mano (auditoría 5, frontend, MEDIO 5).
//
// Lo guardado NO es una URL pública: es la ruta dentro del bucket privado
// `liquidaciones` (`{tenantId}/{viajeId}.pdf`, ver tools.ts). Servirla tal cual
// no funcionaría, y hacer público el bucket dejaría las liquidaciones de todas
// las flotas al alcance de quien adivine dos UUIDs. Por eso aquí se firma una
// URL de vida corta, detrás de la sesión real del contralor.
//
// El ejemplar que se entrega es el del CONTRALOR (`{viajeId}.pdf`), no el del
// operador: es el que lleva los veredictos y el que se archiva. Esa separación
// es deliberada en `tools.ts` y aquí se respeta.
// ═══════════════════════════════════════════════════════════════════════════
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await rateLimit(`export-pdf:${clientIp(req)}`, 30, 60_000))) {
    return new NextResponse('Demasiadas peticiones', { status: 429 });
  }

  // `getSessionTenant()` a secas le devolvía 401 al SUPERADMIN: su
  // `app_user.tenant_id` es `null` por diseño (0001), y el fallback a la flota
  // demo vivía solo en `guard.ts`, que una API no puede usar porque redirige.
  // En pantalla eso era apretar "Descargar PDF" y abrir una pestaña en blanco
  // que dice "No autorizado" — el minuto 4 del guion del demo.
  const t = await resolverTenantApi(req.url);
  if (!t.ok) return new NextResponse(t.motivo, { status: t.status });
  const tenantId = t.tenantId;

  // Cuota por flota además de por IP — ver la nota de export/liquidaciones,
  // mismo criterio y mismo número que ya usaba esta ruta para su IP.
  if (!(await rateLimit(`export-pdf:tenant:${tenantId}`, 30, 60_000))) {
    return new NextResponse('Demasiadas peticiones', { status: 429 });
  }

  // ── QUIÉN PUEDE DESCARGAR, NO SOLO DE QUÉ FLOTA ──────────────────────────
  //
  // Faltaba esto y era un IDOR: la ruta autorizaba por SESIÓN y por TENANT, y
  // ahí se detenía. Cualquier usuario de la flota —incluido un OPERADOR, que
  // solo debe ver lo suyo— bajaba el PDF de la liquidación de cualquier
  // compañero con nada más que el id en la URL.
  //
  // `puedeExportar` ya excluía a `operador`; la ruta nunca se lo preguntó. Es
  // el patrón que este repo tiene documentado como el fallo más común del
  // código escrito por agentes: se acota el tenant y se olvida el rol.

  // LA PUERTA DE UN EXPORT ES LA DEL DATO, NO LA DEL VERBO.
  //
  // `puedeExportar` incluye al ENCARGADO, pero la matriz de la 0044 le da solo
  // el área `operacion` y la base lo excluye de `ve_finanzas()`. Este archivo
  // es DINERO: folio, operador, anticipo, comprobado y diferencia por viaje.
  //
  // La contradicción vivía dentro de una sola pantalla: `/dashboard/analitica`
  // le escondía la gráfica con "tu rol no ve cifras de dinero" y tres pulgadas
  // más abajo le pintaba el botón que se las daba enteras en CSV.
  if (!puedeVerArea(t.rol, 'dinero')) {
    logger.warn('export.area_sin_permiso', { rol: t.rol });
    return new NextResponse('Tu rol no ve las cifras de dinero de la flota.', { status: 403 });
  }

  if (!puedeExportar(t.rol)) {
    logger.warn('export.rol_sin_permiso', { rol: t.rol });
    return new NextResponse('Tu rol no puede descargar este documento.', { status: 403 });
  }

  const { id } = await params;
  const admin = supabaseAdmin();
  // El filtro por tenant es EXPLÍCITO: el service-role salta RLS, así que un
  // id de otra flota no puede resolver aquí — tenantId sale de la sesión, no
  // de un env var.
  const { data, error } = await admin
    .from('liquidacion')
    .select('pdf_url, revision')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (error) {
    logger.error('export.pdf.lectura', { tenant: tenantId, liquidacion: id, err: error.message });
    return new NextResponse('No se pudo leer la liquidación. Intenta de nuevo en un momento.', { status: 500 });
  }
  // Sin fila y con fila sin PDF son 404 los dos: quien pregunta no debe poder
  // distinguir "no existe" de "existe y aún no tiene papel".
  if (!data?.pdf_url) return new NextResponse('No hay PDF para esta liquidación', { status: 404 });

  // ── UNA LIQUIDACIÓN RECHAZADA NO TIENE UN PDF VIGENTE (BE-A1) ────────────
  //
  // Este `select` no traía `revision`: la ruta no tenía forma de saber que la
  // liquidación fue rechazada, así que servía el PDF viejo como si nada.
  //
  // La 0346 (`pdf_publicacion_atomica`) anula `pdf_url` cuando `revision`
  // pasa a 'ajustada' (el PDF viejo se archiva y el nuevo se genera aparte),
  // pero NO cuando pasa a 'rechazada' — un rechazo no reemplaza el PDF, así
  // que una liquidación rechazada con un `pdf_url` de ANTES del rechazo lo
  // conserva en la base, apuntando a un ejemplar que ya no es el vigente.
  // El corte tiene que ir aquí, a la lectura, no confiar en que la columna
  // esté vacía.
  if (data.revision === 'rechazada') {
    logger.warn('export.pdf.rechazada', { tenant: tenantId, liquidacion: id });
    return new NextResponse(
      'Esta liquidación fue rechazada: no tiene un PDF vigente para descargar. Revisa el motivo del rechazo en el panel.',
      { status: 409 },
    );
  }

  const firmada = await admin.storage
    .from('liquidaciones')
    .createSignedUrl(data.pdf_url as string, 60, { download: `liquidacion_${id.slice(0, 8)}.pdf` });

  if (firmada.error || !firmada.data?.signedUrl) {
    logger.error('export.pdf.firma', {
      tenant: tenantId, liquidacion: id, path: data.pdf_url,
      err: firmada.error?.message ?? 'storage no devolvió URL firmada',
    });
    return new NextResponse('No se pudo preparar la descarga. Intenta de nuevo en un momento.', { status: 502 });
  }

  // ── LA SEÑAL DE QUE EL PAPEL LLEGÓ A ALGUIEN (mig. 0114) ─────────────────
  //
  // Un PDF generado y nunca abierto se ve idéntico en la base a uno que el
  // contador imprimió y archivó. Esta es la diferencia, y es la señal de PMF
  // más fuerte que el producto puede dar: no que Likida haya cerrado el viaje,
  // sino que el papel entró al cierre de alguien.
  //
  // `primera_descarga_rol` importa tanto como la fecha: un `superadmin`
  // bajando el PDF es Javier enseñando el producto, no un cliente usándolo.
  // Sin esa columna, un demo se lee igual que un cierre contable.
  //
  // Va DESPUÉS de firmar y ANTES de redirigir, y NO puede impedir la descarga
  // pase lo que pase: es telemetría, y una telemetría que le rompe el papel al
  // contralor cuesta infinitamente más que el dato que iba a guardar. Mismo
  // criterio que `registrarCorrida`, que nunca lanza.
  //
  // Los DOS caminos de falla, porque son distintos y este repo ya pagó por
  // confundirlos: supabase-js reporta el error de Postgres POR VALOR (hay que
  // leer `error`, no esperar una excepción), y aparte la llamada de red sí
  // puede lanzar. Se atienden los dos: se lee `error` y además se envuelve.
  try {
    const { error: errDescarga } = await admin.rpc('registrar_descarga_liquidacion', {
      p_liquidacion: id,
      p_tenant: tenantId,
      p_rol: t.rol,
    });
    if (errDescarga) {
      logger.warn('export.pdf.descarga_no_registrada', {
        tenant: tenantId, liquidacion: id, err: errDescarga.message,
      });
    }
  } catch (e) {
    logger.warn('export.pdf.descarga_no_registrada', {
      tenant: tenantId, liquidacion: id,
      err: e instanceof Error ? e.message : String(e),
    });
  }

  return NextResponse.redirect(firmada.data.signedUrl, 302);
}
