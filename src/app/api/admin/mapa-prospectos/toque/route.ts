import { leerTextoAcotado } from '@/lib/http/cuerpo_acotado';
// El registro de TOQUES (0130): cada tap de WhatsApp/correo desde el Cerebro
// deja fila sola — el timeline por prospecto y el filtro "sin contactar en N
// días" viven de esto. Solo escritura mínima; puerta propia (patrón de la
// familia mapa-prospectos).
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { sesionSuperadmin } from '../puerta';
import { vieneDeNuestroSitio } from '@/lib/auth/csrf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CANALES = new Set(['whatsapp', 'correo', 'llamada', 'visita', 'nota']);

export async function POST(req: Request) {
  // Auditoría 21, BAJO-MEDIO: el chequeo CSRF explícito (SEG-9) solo cubría
  // /api/admin/palette y /v1/*. Escribe fila de toque, autenticada solo por
  // cookie de sesión.
  if (!vieneDeNuestroSitio(req)) {
    logger.warn('toque.origen_ajeno', { origen: req.headers.get('origin'), sitio: req.headers.get('sec-fetch-site') });
    return NextResponse.json({ error: 'Petición de otro sitio.' }, { status: 403 });
  }

  const { error, sesion } = await sesionSuperadmin();
  if (error) return error;
  // UUID, canal y resumen de 300 caracteres, incluso escapados.
  const lecturaCuerpo = await leerTextoAcotado(req, 8 * 1024);
  if (!lecturaCuerpo.ok) return NextResponse.json({ error: lecturaCuerpo.motivo === 'demasiado_grande' ? 'payload muy grande' : 'JSON inválido' },
    { status: lecturaCuerpo.motivo === 'demasiado_grande' ? 413 : 400 });
  let cuerpo: Record<string, unknown>;
  try {
    const valor: unknown = JSON.parse(lecturaCuerpo.texto);
    if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return NextResponse.json({ error: 'Se esperaba un objeto JSON.' }, { status: 400 });
    cuerpo = valor as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  if (typeof cuerpo.id !== 'string' || !cuerpo.id || typeof cuerpo.canal !== 'string' || (cuerpo.resumen !== undefined && cuerpo.resumen !== null && typeof cuerpo.resumen !== 'string') || !/^[0-9a-f-]{36}$/.test(cuerpo.id) || !CANALES.has(cuerpo.canal ?? '')) {
    return NextResponse.json({ error: 'Falta prospecto o canal válido.' }, { status: 400 });
  }
  const { error: e } = await supabaseAdmin().from('prospecto_toque').insert({
    prospecto_id: cuerpo.id,
    canal: cuerpo.canal,
    resumen: typeof cuerpo.resumen === 'string' ? cuerpo.resumen.slice(0, 300) : null,
    actor: sesion.userId,
  });
  if (e) {
    logger.error('toque.insert', { err: e.message });
    return NextResponse.json({ error: 'No se pudo registrar el toque.' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
