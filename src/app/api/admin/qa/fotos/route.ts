// ═══════════════════════════════════════════════════════════════════════════
// EL BANCO DE FOTOS DE QA — /api/admin/qa/fotos.
//
// GET   → el manifiesto con URL firmada de 60 s por foto (miniaturas del
//         formulario — bucket privado, nunca un <img src> sin firmar). Desde
//         la Fase B pieza 2 cada foto viaja con su VERDAD-DE-TERRENO y con
//         `confirmadoEn`: la pantalla necesita distinguir "sin etiquetar" de
//         "etiquetada", porque una foto sin etiqueta no se puede medir.
// POST  → subida MÚLTIPLE (multipart): el pedido explícito de Javier es poder
//         soltar una "cantidad obscena de tickets" de golpe. Dedup por sha256
//         (mismo digest que img_hash de producción); cada archivo reporta su
//         suerte por separado.
// PATCH → EL ORÁCULO HUMANO: firma la verdad-de-terreno de UNA foto (lo que
//         una persona leyó mirando el comprobante). Es la vara contra la que
//         se mide el OCR, así que se valida dos veces —aquí con
//         `validarVerdadTerreno` y en la base con el CHECK de la 0239— y el
//         motivo del rechazo se dice completo.
// ═══════════════════════════════════════════════════════════════════════════
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  leerManifiesto, subirFotos, firmarRuta, firmarRutas, confirmarVerdadTerreno,
  BUCKET_QA_FOTOS, type ArchivoNuevo,
} from '@/lib/admin/qa-storage';
import { validarVerdadTerreno } from '@/lib/admin/qa-tipos';
import { sesionSuperadmin } from '../puerta';
import { vieneDeNuestroSitio } from '@/lib/auth/csrf';
import { bodyExcede } from '@/lib/ratelimit';
import { leerBytesAcotados, leerTextoAcotado } from '@/lib/http/cuerpo_acotado';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Tope del LOTE (no por archivo).
 *
 * AUDITORÍA 24, BE-25: decía 120 MB —«40 fotos de ~3 MB caben»— sobre un
 * runtime que corta el cuerpo en 4.5 MB ANTES de que esta ruta exista. O sea:
 * el rótulo prometía 40 fotos y la plataforma mataba el lote en la segunda,
 * con SU 413 y sin una línea de log nuestra. `dashboard/archivo/limites.ts`
 * documenta ese techo desde ESC-14 y ahí se bajó a 4 MB por lo mismo.
 *
 * Se dice la verdad: 4 MB de lote, que es una foto de tres megas o unas cuantas
 * de teléfono. Subir el banco entero de una sentada exige subida directa a
 * Storage (URL firmada desde el navegador, sin pasar por la función) y eso es
 * otra pieza — hasta que exista, el número de aquí es el que la plataforma
 * respeta.
 */
const MAX_LOTE_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVOS_POR_LOTE = 200;
const MENSAJE_LOTE = 'El lote pasa de 4 MB, que es lo que la plataforma deja entrar en una petición. Súbelo en tandas más chicas.';

export async function GET() {
  const { error } = await sesionSuperadmin();
  if (error) return error;
  const db = supabaseAdmin();
  const manifiesto = await leerManifiesto(db);
  if (!manifiesto.ok) return NextResponse.json({ error: manifiesto.error }, { status: 502 });
  // EN LOTE, no una firma por foto: ver el incidente del 28-ago-2026 en la
  // cabecera de `firmarRutas` — ~90 firmas sueltas saturaban el pool de
  // Storage y tumbaban descargas ajenas.
  const urls = await firmarRutas(db, BUCKET_QA_FOTOS, manifiesto.datos.map((f) => f.path));
  const fotos = manifiesto.datos.map((f) => ({ ...f, url: urls.get(f.path) ?? null }));
  return NextResponse.json({ fotos });
}

export async function POST(req: Request) {
  // Auditoría 21, BAJO-MEDIO: el chequeo CSRF explícito (SEG-9) solo cubría
  // /api/admin/palette y /v1/*. Sube archivos al banco, autenticada solo por
  // cookie de sesión.
  if (!vieneDeNuestroSitio(req)) {
    logger.warn('qa_fotos.origen_ajeno', { origen: req.headers.get('origin'), sitio: req.headers.get('sec-fetch-site') });
    return NextResponse.json({ error: 'Petición de otro sitio.' }, { status: 403 });
  }

  const { error } = await sesionSuperadmin();
  if (error) return error;

  // BE-25: si el emisor declara el tamaño, se rechaza ANTES de materializar
  // nada — nuestro texto, no la pantalla de la plataforma.
  if (bodyExcede(req, MAX_LOTE_BYTES)) {
    return NextResponse.json({ error: MENSAJE_LOTE }, { status: 413 });
  }

  const lectura = await leerBytesAcotados(req, MAX_LOTE_BYTES);
  if (!lectura.ok) return NextResponse.json({ error: lectura.motivo === 'demasiado_grande'
    ? MENSAJE_LOTE : 'se esperaba multipart/form-data con archivos' },
  { status: lectura.motivo === 'demasiado_grande' ? 413 : 400 });
  let form: FormData;
  try {
    form = await new Response(lectura.datos, {
      headers: { 'content-type': req.headers.get('content-type') ?? '' },
    }).formData();
  } catch {
    return NextResponse.json({ error: 'se esperaba multipart/form-data con archivos' }, { status: 400 });
  }
  const archivos: ArchivoNuevo[] = [];
  let totalBytes = 0;
  for (const [, valor] of form.entries()) {
    if (!(valor instanceof File)) continue;
    if (archivos.length >= MAX_ARCHIVOS_POR_LOTE) {
      return NextResponse.json({ error: `máximo ${MAX_ARCHIVOS_POR_LOTE} archivos por lote — manda el resto en otra tanda` }, { status: 413 });
    }
    const bytes = Buffer.from(await valor.arrayBuffer());
    totalBytes += bytes.length;
    if (totalBytes > MAX_LOTE_BYTES) {
      return NextResponse.json({ error: MENSAJE_LOTE }, { status: 413 });
    }
    archivos.push({ nombre: valor.name || 'sin-nombre', mime: valor.type, bytes });
  }
  if (archivos.length === 0) return NextResponse.json({ error: 'no llegó ningún archivo' }, { status: 400 });

  const db = supabaseAdmin();
  const r = await subirFotos(db, archivos);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });

  const urls = await firmarRutas(db, BUCKET_QA_FOTOS, r.datos.fotos.map((f) => f.path));
  const fotos = r.datos.fotos.map((f) => ({ ...f, url: urls.get(f.path) ?? null }));
  return NextResponse.json({ resultados: r.datos.resultados, fotos });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_PATCH = 16 * 1024;

/**
 * Firma la verdad-de-terreno de UNA foto: `{ fotoId, verdad }`.
 *
 * Quién la firma sale de LA SESIÓN, jamás del body. Un campo "confirmadoPor"
 * que el cliente pudiera mandar convertiría la firma en decoración —cualquiera
 * podría atribuirle una etiqueta a otro—, y esta columna existe precisamente
 * para que un "esperado" tenga un responsable.
 */
export async function PATCH(req: Request) {
  // Auditoría 21, BAJO-MEDIO: mismo chequeo CSRF que POST — firma la
  // verdad-de-terreno, autenticada solo por cookie de sesión.
  if (!vieneDeNuestroSitio(req)) {
    logger.warn('qa_fotos.origen_ajeno', { origen: req.headers.get('origin'), sitio: req.headers.get('sec-fetch-site') });
    return NextResponse.json({ error: 'Petición de otro sitio.' }, { status: 403 });
  }

  const { error, sesion } = await sesionSuperadmin();
  if (error) return error;

  const lectura = await leerTextoAcotado(req, MAX_BODY_PATCH);
  if (!lectura.ok) return NextResponse.json({ error: lectura.motivo === 'demasiado_grande' ? 'payload muy grande' : 'JSON inválido' },
    { status: lectura.motivo === 'demasiado_grande' ? 413 : 400 });
  let body: unknown;
  try {
    body = JSON.parse(lectura.texto);
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const b = body as Record<string, unknown> | null;
  const fotoId = b?.fotoId;
  if (typeof fotoId !== 'string' || !UUID_RE.test(fotoId)) {
    return NextResponse.json({ error: 'fotoId inválido — se esperaba el uuid de una foto del banco' }, { status: 400 });
  }

  // Se valida ANTES de tocar la base para que el motivo del rechazo sea el
  // texto largo de `validarVerdadTerreno` («folio: es null y no está
  // clasificado…») y no el mensaje de un CHECK de Postgres, que dice qué
  // restricción rebotó pero no cuál de las siete claves la rompió.
  const v = validarVerdadTerreno(b?.verdad);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  const db = supabaseAdmin();
  const r = await confirmarVerdadTerreno(db, fotoId, v.datos, sesion.userId ?? null);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });

  const url = await firmarRuta(db, BUCKET_QA_FOTOS, r.datos.path);
  return NextResponse.json({ foto: { ...r.datos, url } });
}
