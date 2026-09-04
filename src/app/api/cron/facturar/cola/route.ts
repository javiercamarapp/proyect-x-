import { NextResponse, type NextRequest } from 'next/server';
import { Receiver } from '@upstash/qstash';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { hoyMx } from '@/lib/formato';
import { estaApagado } from '@/lib/likida/interruptores';
import { registrarLatido } from '@/lib/admin/salud';
import { procesarLoteEnCola, type FilaCola } from '../lote';
import { leerTextoAcotado } from '@/lib/http/cuerpo_acotado';

export const runtime = 'nodejs';
// AUDITORÍA 18 (M2, B12): decía 600 "porque QStash permite 10 min de timeout".
// QStash es el CLIENTE: espera más, no deja correr más. El plan del equipo
// está verificado como pro, tope 300s (`presupuesto.ts`, `webhook/whatsapp/
// route.ts`), y el corte real del lote es `PRESUPUESTO_LOTE_MS - MARGEN_LOTE_MS`
// de `../lote.ts`, derivado de `TOPE_DURACION_S` = 300 (el mismo que declara
// `../route.ts` en su `maxDuration`) — o sea 150s de trabajo
// útil. Con 600 aquí, el número escrito no era el que la ruta respetaba ni el
// que la plataforma concede, y quien subiera MARGEN_LOTE_MS "porque tengo
// 600s" dimensionaría contra un presupuesto que no existe. Lo que esta cola
// sí rompe es el ACOPLE con el cron (que tiene que contestar rápido), no el
// techo de la plataforma. `cola/route.test.ts` los mantiene iguales.
export const maxDuration = 300;
const MAX_BODY = 256 * 1024;

// ═══════════════════════════════════════════════════════════════════════════
// EL CALLBACK DE QSTASH — el cron encola aquí el lote (ronda 16) y este
// endpoint lo procesa con su propio presupuesto.
//
// PÚBLICO por diseño pero protegido por la FIRMA de QStash: sin el token de
// verificación, cualquiera podría encolar un lote a procesar. `verify()` de
// @upstash/qstash valida la firma y el cuerpo exactos.
// ═══════════════════════════════════════════════════════════════════════════
export async function POST(req: NextRequest) {
  const token = process.env.UPSTASH_QSTASH_TOKEN;
  const currentKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!token || !currentKey || !nextKey) {
    logger.error('qstash.cola.sin_config', { token: !!token, current: !!currentKey, next: !!nextKey });
    // AUDITORÍA 24, BE-6 (b): este 503 era MUDO. El cron latía `ok` por
    // encolar, QStash reintentaba dos veces contra esta puerta y tiraba el
    // lote; /api/health seguía en verde con cero CFDI. El latido `fallo`
    // aquí es lo que pinta el tablero de rojo en la primera corrida.
    await registrarLatido('facturar', 'fallo', { codigo: 'qstash_config_ausente', token: !!token, current: !!currentKey, next: !!nextKey });
    return NextResponse.json({ error: 'QStash no configurado' }, { status: 503 });
  }

  // La firma necesita el texto exacto, pero ningún remitente puede forzar que
  // materialicemos un body ilimitado antes de llegar a verificarla.
  const lectura = await leerTextoAcotado(req, MAX_BODY);
  if (!lectura.ok) {
    return NextResponse.json(
      { error: lectura.motivo === 'demasiado_grande' ? 'Payload demasiado grande' : 'No se pudo leer el payload' },
      { status: lectura.motivo === 'demasiado_grande' ? 413 : 400 },
    );
  }
  const raw = lectura.texto;
  try {
    // Las SIGNING KEYS reales de QStash (Settings → Signing Keys) — no el
    // token: QStash firma con ellas, y verificarlas con el token fallaría.
    const receiver = new Receiver({ currentSigningKey: currentKey, nextSigningKey: nextKey });
    const valido = await receiver.verify({
      signature: req.headers.get('upstash-signature') ?? '',
      body: raw,
    });
    if (!valido) {
      logger.warn('qstash.cola.firma_invalida', {});
      // BE-6 (b): una signing key rotada en QStash y no en Vercel se ve
      // EXACTAMENTE así — cada lote rebota 401 y nadie factura. También late.
      await registrarLatido('facturar', 'fallo', { codigo: 'qstash_firma_invalida' });
      return NextResponse.json({ error: 'Firma inválida' }, { status: 401 });
    }
  } catch (e) {
    logger.warn('qstash.cola.verificacion_error', { err: e instanceof Error ? e.message : String(e) });
    await registrarLatido('facturar', 'fallo', { codigo: 'qstash_firma_invalida' });
    return NextResponse.json({ error: 'No se pudo verificar la firma' }, { status: 401 });
  }

  let body: { lote?: FilaCola[]; quedaron?: number };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const lote = body.lote ?? [];
  if (lote.length === 0) return NextResponse.json({ corrio: true, vacio: true });

  // EL KILL SWITCH TAMBIÉN AQUÍ (0110): un lote encolado segundos antes del
  // apagón llegaría por esta puerta con hasta 10 minutos de presupuesto — el
  // camino perfecto para que "apagué facturas" siga emitiendo. 200 y no 5xx:
  // un 5xx haría que QStash REINTENTARA el lote (retries: 2), o sea insistir
  // en correr lo apagado. Los tickets no se marcan: el cron los recoge
  // enteros cuando la palanca vuelva.
  const apagadoPor = (await estaApagado('global'))
    ? 'global'
    : (await estaApagado('agente:facturas')) ? 'agente:facturas' : null;
  if (apagadoPor) {
    logger.warn('qstash.cola.saltado', { interruptor: apagadoPor, tickets: lote.length });
    return NextResponse.json({ corrio: false, saltado: `interruptor ${apagadoPor}` });
  }

  // Re-validar que los gastos siguen en la cola (un intento previo pudo
  // facturarlos): no se procesa un ticket que ya tiene CFDI.
  const ids = lote.map((g) => g.id);
  const { data: vigentes, error } = await supabaseAdmin()
    .from('gasto')
    .select('id')
    .in('id', ids)
    .is('cfdi_uuid', null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const vigentesIds = new Set((vigentes ?? []).map((v) => v.id));
  const loteVigente = lote.filter((g) => vigentesIds.has(g.id));

  // RES-13: el día de México, no el UTC — mismo criterio que `../route.ts`.
  const hoy = hoyMx();
  const inicio = Date.now();
  // QStash espera un 2xx para dar por procesado; un 5xx dispara el reintento
  // (retries: 2). El resultado del procesamiento es el de la función compartida.
  return procesarLoteEnCola(loteVigente, req as unknown as Request, hoy, inicio, body.quedaron ?? 0);
}
