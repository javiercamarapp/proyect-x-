import { leerTextoAcotado } from '@/lib/http/cuerpo_acotado';
// ═══════════════════════════════════════════════════════════════════════════
// LANZAR UNA CORRIDA DE QA — /api/admin/qa/lanzar (POST). Carril rápido.
//
// El patrón es el del webhook real (route.ts): se valida, se responde RÁPIDO
// con el id, y el trabajo pesado corre en after() — el navegador redirige a
// /admin/qa/<id> y pollea el ledger en vivo mientras la corrida avanza en
// esta misma invocación (EN PROCESO: processInbound de producción, importado
// tal cual por qa-motor.ts).
//
// Frenos ANTES de arrancar (nunca un botón que falla en silencio):
//  · tope diario (TOPE_DIA_USD): si el gasto real de hoy ya lo tocó — o si NO
//    SE PUDO LEER — no se lanza; a ciegas no se gasta (fallar cerrado).
//  · tope por corrida y techo de tiempo: los aplica el motor a media corrida.
// ═══════════════════════════════════════════════════════════════════════════
import { NextResponse } from 'next/server';
import { after } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { validarLanzar } from '@/lib/admin/qa-tipos';
import { crearCorrida, ejecutarCorridaRapida, TOPE_DIA_USD } from '@/lib/admin/qa-motor';
import { gastoHoyUsd, guardarCorrida, leerManifiesto } from '@/lib/admin/qa-storage';
import { sesionSuperadmin } from '../puerta';
import { vieneDeNuestroSitio } from '@/lib/auth/csrf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// El techo probado del repo (webhook). El motor se auto-limita a
// TECHO_CORRIDA_MS (110 s) para alcanzar a ESCRIBIR su aborto antes de esto.
export const maxDuration = 120;

const MAX_BODY = 64 * 1024;

export async function POST(req: Request) {
  // Auditoría 21, BAJO-MEDIO: el chequeo CSRF explícito (SEG-9) solo cubría
  // /api/admin/palette y /v1/*. Lanza una corrida que gasta dinero real,
  // autenticada solo por cookie de sesión.
  if (!vieneDeNuestroSitio(req)) {
    logger.warn('qa_lanzar.origen_ajeno', { origen: req.headers.get('origin'), sitio: req.headers.get('sec-fetch-site') });
    return NextResponse.json({ error: 'Petición de otro sitio.' }, { status: 403 });
  }

  const { error, sesion } = await sesionSuperadmin();
  if (error) return error;

  const lecturaCuerpo = await leerTextoAcotado(req, MAX_BODY);
  if (!lecturaCuerpo.ok) return NextResponse.json({ error: lecturaCuerpo.motivo === 'demasiado_grande' ? 'payload muy grande' : 'JSON inválido' },
    { status: lecturaCuerpo.motivo === 'demasiado_grande' ? 413 : 400 });
  let body: Record<string, unknown>;
  try {
    const valor: unknown = JSON.parse(lecturaCuerpo.texto);
    if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return NextResponse.json({ error: 'Se esperaba un objeto JSON.' }, { status: 400 });
    body = valor as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const v = validarLanzar(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  const db = supabaseAdmin();

  // El freno del día, re-chequeado en el servidor (la UI también lo enseña,
  // pero la restricción de interfaz no es el candado).
  const gasto = await gastoHoyUsd(db);
  if (!gasto.ok) {
    return NextResponse.json({ error: `no se pudo leer el gasto del día (${gasto.error}) — no se lanza a ciegas` }, { status: 502 });
  }
  if (gasto.datos >= TOPE_DIA_USD) {
    return NextResponse.json({ error: `el gasto de hoy ($${gasto.datos.toFixed(4)}) ya tocó el tope diario ($${TOPE_DIA_USD}) — mañana, o sube TOPE_DIA_USD a propósito` }, { status: 429 });
  }

  // Las fotos existen en el banco ANTES de arrancar — un id colgado se
  // rechaza aquí, no a media corrida.
  const manifiesto = await leerManifiesto(db);
  if (!manifiesto.ok) return NextResponse.json({ error: manifiesto.error }, { status: 502 });
  const enBanco = new Set(manifiesto.datos.map((f) => f.id));
  const faltantes = v.datos.params.fotoIds.filter((id) => !enBanco.has(id));
  if (faltantes.length > 0) {
    return NextResponse.json({ error: `foto(s) fuera del banco: ${faltantes.join(', ')}` }, { status: 400 });
  }

  const corrida = crearCorrida(v.datos.escenario, v.datos.params, v.datos.carril);
  try {
    await guardarCorrida(db, corrida);
  } catch (e) {
    return NextResponse.json({ error: `no se pudo registrar la corrida: ${e instanceof Error ? e.message : e}` }, { status: 502 });
  }

  logger.info('qa.corrida_lanzada', { corrida: corrida.id, escenario: corrida.escenario, carril: corrida.carril, fotos: corrida.parametros.fotoIds.length, por: sesion.userId ?? null });

  // ── EL CARRIL DECIDE QUIÉN CORRE ────────────────────────────────────────
  // Rápido: el motor corre DESPUÉS de responder, en esta misma invocación —
  // nunca lanza (todo fallo queda escrito en la corrida, que es lo que el
  // panel pollea).
  //
  // Completo: aquí NO se corre nada. Una corrida de 91 fotos no cabe en los
  // 120 s de esta ruta, y arrancarla acá daría exactamente lo que la Fase C
  // vino a evitar: una corrida muerta a la mitad. La mueve
  // `POST /api/admin/qa/<id>/continuar`, pasada por pasada, con su
  // `maxDuration` de 300 s y su reloj duro — el MISMO camino para la primera
  // pasada que para la última, que es lo que hace que la continuación esté
  // probada de verdad y no sólo el caso feliz.
  if (corrida.carril === 'rapido') {
    after(async () => {
      await ejecutarCorridaRapida(corrida);
    });
  }

  return NextResponse.json({ id: corrida.id, carril: corrida.carril });
}
