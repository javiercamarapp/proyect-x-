import { NextResponse } from 'next/server';
import { puertaCron, registrarLatido } from '@/lib/admin/salud';
import { reclamarSalidasWhatsApp, finalizarSalidaWhatsApp } from '@/lib/likida/wa_outbox';
import { conPool } from '@/lib/likida/lotes';
import { leerInterruptor } from '@/lib/likida/interruptores';
import { logger } from '@/lib/logger';
import { alertarOperador } from '@/lib/observability/alerta';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { esReintentableMeta } from '@/lib/meta/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// RENDIMIENTO-19C2-6: medido en 155.5s reales contra los 60s declarados —
// mismo ajuste de margen que `gps/route.ts` (ver esa nota para el porqué de
// 300 y no una redistribución de fondo).
//
// AUDITORÍA 20 (R-1): este es el TECHO real de la corrida — el lease del
// outbox (`WA_OUTBOX_LEASE_SECONDS`, wa_outbox.ts) tiene que sobrevivirlo con
// margen, no solo cubrir el promedio medido. Si vuelves a subir este número,
// sube también ese lease — `wa_outbox.test.ts` lo verifica leyendo este
// archivo y se pone rojo si se desalinean.
export const maxDuration = 300;

const GRAPH = 'https://graph.facebook.com/v21.0';

/**
 * AUDITORÍA 19 (OP-19c2-3): antes de la 0189 esta llamada no distinguía "va a
 * reintentar sola" de "murió, nadie la va a volver a intentar". Un mensaje al
 * chofer o al jefe que agota sus 8 reintentos (0180) se perdía en silencio: el
 * cron seguía en verde porque procesó la fila con éxito, solo que el
 * resultado fue enterrarla. Mismo patrón que los otros cinco crons
 * (gps/escalar/purgar/facturar/wa-pendientes), que sí avisan.
 */
async function finalizarYAvisarSiMurio(s: Awaited<ReturnType<typeof reclamarSalidasWhatsApp>>[number], messageId?: string, error?: string): Promise<void> {
  const { muerta } = await finalizarSalidaWhatsApp(s, messageId, error);
  if (muerta) {
    await alertarOperador('cron.wa_outbox', {
      error: `Un mensaje de WhatsApp agotó sus reintentos y no se va a volver a enviar: ${error ?? 'sin detalle'}`,
      codigo: 'salida_muerta',
    });
  }
}

/** Drena el outbox durable. Solo reintenta la misma carga serializada; el
 * lease hace que dos crons solapados no la envíen simultáneamente. */
export async function GET(req: Request) {
  const puerta = await puertaCron('wa-outbox', req, 'El outbox de WhatsApp no se drena sin CRON_SECRET.');
  if (puerta) return puerta;

  // AUDITORÍA 19, BACK-19-1 (CRÍTICO): este cron era el ÚNICO que no
  // preguntaba por la palanca, y es el que de verdad manda — no encola,
  // hace POST a graph.facebook.com. Con el kill switch abajo, `wa-pendientes`
  // dejaba de encolar y este seguía vaciando a teléfonos reales lo que ya
  // estaba dentro, cada minuto. La compuerta va ANTES de reclamar: un lease
  // tomado con el sistema apagado secuestra la salida hasta que expire.
  // Mismo contrato que `wa-pendientes`, palabra por palabra — dos formas de
  // obedecer la misma palanca es una palanca que no se puede razonar.
  const global = await leerInterruptor('global');
  if (global === 'ilegible') {
    // El latido ANTES del 500 (tableros al día, 28-ago-2026): sin él este
    // camino era mudo y el tablero decía «No late» sin la causa.
    await registrarLatido('wa-outbox', 'fallo', { codigo: 'interruptor_ilegible' });
    return NextResponse.json({
      corrio: false,
      error: 'No se pudo leer el interruptor global: el outbox no se drena sin saber si está apagado.',
      codigo: 'interruptor_ilegible',
      interruptor: 'global',
    }, { status: 500 });
  }
  if (global === 'apagado') {
    logger.warn('cron.wa_outbox.saltado', { interruptor: 'global' });
    // Sin este latido, el apagado deliberado se pintaba como cron muerto y
    // /api/health alertaba al operador por su propia decisión.
    await registrarLatido('wa-outbox', 'saltado', { interruptor: 'global' });
    return NextResponse.json({ corrio: false, saltado: 'interruptor global' });
  }

  // AUDITORÍA 24, BE-15: el check del canal iba DENTRO del pool, por fila y
  // DESPUÉS de reclamar. Un token de Meta rotado en Preview y no en
  // Production quemaba un intento de cada salida reclamada (`intentos + 1`
  // en el claim, 0180) cada minuto: con backoff 15·2^n, a la hora todo lo
  // encolado —acuses de POD, «tu viaje se reasignó», cobranza— estaba
  // `dead` por una condición que no es de la fila. Se comprueba ANTES de
  // reclamar y se sale con latido `fallo`: nada se toca hasta que el canal
  // exista.
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    logger.error('cron.wa_outbox.sin_config', { token: Boolean(token), phoneId: Boolean(phoneId), codigo: 'canal_no_configurado' });
    await alertarOperador('cron.wa_outbox', {
      error: 'El canal de WhatsApp no está configurado (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID): el outbox no se drena y nada se reclama hasta que esté.',
      codigo: 'canal_no_configurado',
    });
    await registrarLatido('wa-outbox', 'fallo', { codigo: 'canal_no_configurado' });
    return NextResponse.json({
      corrio: false,
      error: 'El canal de WhatsApp no está configurado; el outbox queda intacto para cuando lo esté.',
      codigo: 'canal_no_configurado',
    }, { status: 500 });
  }

  try {
    try {
      const reconciliacion = await supabaseAdmin().rpc('reconciliar_wa_meta_receipts', { p_limite: 100 });
      if (reconciliacion.error) logger.warn('wa.receipts.reconciliacion_fallo', { error: reconciliacion.error.message });
    } catch (err) { logger.warn('wa.receipts.reconciliacion_fallo', { error: err instanceof Error ? err.message : String(err) }); }
    try {
      const purga = await supabaseAdmin().rpc('purgar_wa_meta_receipts', { p_limite: 100 });
      if (purga.error) logger.warn('wa.receipts.purga_fallo', { error: purga.error.message });
    } catch (err) { logger.warn('wa.receipts.purga_fallo', { error: err instanceof Error ? err.message : String(err) }); }
    const salidas = await reclamarSalidasWhatsApp();
    let enviadas = 0;
    let fallidas = 0;
    await conPool(salidas, 4, async (s) => {
      try {
        const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(s.payload), signal: AbortSignal.timeout(10_000),
        });
        const body = await r.text();
        if (!r.ok) {
          fallidas++;
          let metaCodigo: number | undefined;
          try { metaCodigo = Number((JSON.parse(body) as { error?: { code?: number } }).error?.code); } catch { /* cuerpo no JSON */ }
          const retryable = esReintentableMeta(Number.isFinite(metaCodigo) ? metaCodigo : undefined, r.status);
          const codigo = retryable ? 'retryable:' : 'terminal:';
          await finalizarYAvisarSiMurio(s, undefined, `${codigo}HTTP ${r.status}: ${body.slice(0, 300)}`);
          return;
        }
        let id: string | undefined;
        try { id = (JSON.parse(body) as { messages?: Array<{ id?: string }> }).messages?.[0]?.id; } catch { /* no wamid */ }
        if (!id) {
          // `r.ok` prueba aceptación HTTP, pero sin wamid no existe una
          // identidad que el webhook pueda reconciliar. Reenviar duplicaría un
          // mensaje posiblemente aceptado y marcarlo sent inventaría entrega:
          // queda dead/manual-review y alerta al operador.
          logger.warn('wa.outbox_sin_wamid', { id: s.id, cuerpo: body.slice(0, 300) });
          // Un 200 sin wamid confirma aceptación HTTP pero no deja una
          // identidad reconciliable. No se puede marcar sent: queda dead para
          // revisión manual y se alerta, evitando retry infinito o silencio.
          fallidas++;
          await finalizarYAvisarSiMurio(s, undefined, `sin_wamid:${s.id}`);
          return;
        }
        enviadas++;
        await finalizarSalidaWhatsApp(s, id);
      } catch (e) {
        fallidas++;
        await finalizarYAvisarSiMurio(s, undefined, e instanceof Error ? e.message : String(e));
      }
    });
    await registrarLatido('wa-outbox', fallidas ? 'parcial' : 'ok', { enviadas, fallidas });
    return NextResponse.json({ corrio: true, tomadas: salidas.length, enviadas, fallidas }, { status: fallidas ? 500 : 200 });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logger.error('cron.wa_outbox.fallo', { error });
    await registrarLatido('wa-outbox', 'fallo', {});
    return NextResponse.json({ error }, { status: 500 });
  }
}
