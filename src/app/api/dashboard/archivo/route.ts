// Lee CUALQUIER archivo que el contralor adjunte al chat (12-ago-2026) y
// devuelve el EXTRACTO acotado que viajará con la conversación. No escribe
// nada: es lectura para analizar en el chat.
//
// Las IMÁGENES no entran aquí: van a /api/dashboard/ingesta (el OCR real de
// comprobantes, que entiende tickets mejor que un extracto de texto).
//
// Autorización calcada de ingesta/chat: sesión + área dinero — el archivo
// del contralor puede traer montos, y este endpoint es alcanzable por POST
// directo (el proxy no cubre /api).
import { NextResponse, type NextRequest } from 'next/server';
import { MAX_BASE64, MAX_CUERPO_BYTES, LECTURAS_POR_MINUTO } from './limites';
import { leerTextoAcotado } from '@/lib/http/cuerpo_acotado';
import { rateLimit } from '@/lib/ratelimit';
import { getSessionTenant } from '@/lib/auth/session';
import { rechazoMfaSuperadminApi } from '@/lib/auth/api-superadmin';
import { puedeVerArea } from '@/lib/auth/visibilidad';
import { leerArchivoUniversal, ArchivoNoSoportado } from '@/lib/likida/intake/archivo';
import { logger } from '@/lib/logger';
import { vieneDeNuestroSitio } from '@/lib/auth/csrf';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const ERROR_TAMANO = 'El archivo pesa demasiado (máx ~3 MB). Mándame la parte que importa —una hoja, un rango de fechas— y la leo completa.';


export async function POST(req: NextRequest) {
  // Auditoría 21, BAJO-MEDIO: el chequeo CSRF explícito (SEG-9) solo cubría
  // /api/admin/palette y /v1/*. Autenticada solo por cookie de sesión.
  if (!vieneDeNuestroSitio(req)) {
    logger.warn('archivo.origen_ajeno', { origen: req.headers.get('origin'), sitio: req.headers.get('sec-fetch-site') });
    return NextResponse.json({ error: 'Petición de otro sitio.' }, { status: 403 });
  }

  const sesion = await getSessionTenant();
  if (!sesion) return NextResponse.json({ error: 'sin sesion' }, { status: 401 });
  const rechazoMfa = await rechazoMfaSuperadminApi(sesion);
  if (rechazoMfa) return rechazoMfa;
  if (!puedeVerArea(sesion.rol, 'dinero')) {
    return NextResponse.json({ error: 'sin acceso' }, { status: 403 });
  }
  // Mismo freno que la sonda de ingesta (auditoría 21): el cuerpo ya tiene
  // tope de TAMAÑO, esto le pone el de FRECUENCIA — sin él, un bucle con un
  // xlsx de expansión adversarial repetía el parseo sin techo.
  if (!(await rateLimit(`archivo:${sesion.userId}`, LECTURAS_POR_MINUTO, 60_000))) {
    return NextResponse.json({ error: 'demasiadas lecturas seguidas; espera un minuto' }, { status: 429 });
  }

  const lectura = await leerTextoAcotado(req, MAX_CUERPO_BYTES);
  if (!lectura.ok) return NextResponse.json({ error: lectura.motivo === 'demasiado_grande' ? ERROR_TAMANO : 'cuerpo inválido' },
    { status: lectura.motivo === 'demasiado_grande' ? 413 : 400 });
  let cuerpo: { nombre?: unknown; contenido?: unknown } | null;
  try { cuerpo = JSON.parse(lectura.texto); } catch { return NextResponse.json({ error: 'cuerpo inválido' }, { status: 400 }); }

  const nombre = typeof cuerpo?.nombre === 'string' ? cuerpo.nombre.trim().slice(0, 120) : '';
  const contenido = typeof cuerpo?.contenido === 'string' ? cuerpo.contenido : '';
  if (!nombre || !contenido) return NextResponse.json({ error: 'faltan nombre o contenido' }, { status: 400 });
  if (contenido.startsWith('data:image/')) {
    return NextResponse.json({ error: 'las imágenes van al OCR de comprobantes (/api/dashboard/ingesta)' }, { status: 400 });
  }
  const base64 = contenido.includes('base64,') ? contenido.slice(contenido.indexOf('base64,') + 7) : contenido;
  if (base64.length > MAX_BASE64) {
    return NextResponse.json({
      error: ERROR_TAMANO,
    }, { status: 413 });
  }

  try {
    const leido = await leerArchivoUniversal(nombre, Buffer.from(base64, 'base64'));
    logger.info('archivo.leido', { tenantId: sesion.tenantId, clase: leido.clase, chars: leido.extracto.length });
    return NextResponse.json(leido);
  } catch (err) {
    if (err instanceof ArchivoNoSoportado) {
      return NextResponse.json({
        error: `Todavía no leo archivos ${err.extension}. Sí leo: PDF, Excel (xlsx/xls), CSV, XML de CFDI, texto — y fotos de comprobantes por el clip.`,
      }, { status: 415 });
    }
    logger.error('archivo.fallo', { err: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'no se pudo leer el archivo — ¿está dañado o protegido con contraseña?' }, { status: 502 });
  }
}
