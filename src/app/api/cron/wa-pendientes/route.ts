import { NextResponse } from 'next/server';
import { leerInterruptor } from '@/lib/likida/interruptores';
import { urgentesVencidas } from '@/lib/likida/agentes/cola';
import { logger } from '@/lib/logger';
import { drenarBandeja } from './drenado';
import { alertarOperador } from '@/lib/observability/alerta';
import { puertaCron, registrarLatido } from '@/lib/admin/salud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// El drenado procesa hasta LOTE mensajes por el motor completo (OCR + LLM):
// mismo presupuesto que el webhook vivo, que atiende lo mismo en una ráfaga.
export const maxDuration = 120;

// ═══════════════════════════════════════════════════════════════════════════
// EL CRON QUE DRENA LA BANDEJA DEL APAGADO (`wa_evento_pendiente`, 0119).
//
// P1 de la auditoría externa: con el kill switch global abajo, el webhook
// GUARDA los mensajes en vez de tirarlos tras el 200. Este cron corre cada
// minuto y, SOLO con la palanca arriba, procesa lo guardado por el motor
// real — el mismo processInbound del camino vivo, con el mismo dedup de
// claimMessage (0002) haciendo inofensivo el at-least-once.
//
// ── EL CAUDAL (auditoría prod, ESC-1) ───────────────────────────────────
//
// Era LOTE=10 en serie cada 5 minutos: ~60 mensajes/hora de capacidad contra
// 490-1,100/hora de entrada a 50k viajes. La bandeja no se drenaba, CRECÍA —
// y como `sin_tiempo` contaba como intento, a las cinco corridas la foto de
// un chofer se volvía carta muerta sin que nadie la hubiera mirado.
//
// Ahora: cada minuto (vercel.json), lote de 40, y hasta 5 mensajes EN VUELO
// a la vez. El paralelismo es POR CHOFER, no por mensaje: los de una misma
// persona siguen en serie —una caption completa la foto anterior— y los de
// personas distintas corren a la vez. Con el lote lleno se AUTO-REENCOLA por
// QStash (el patrón de facturar/cola): la vuelta siguiente arranca con su
// propio presupuesto en vez de esperar al minuto siguiente.
//
// FALLA CERRADO SIN SECRETO, como escalar: esta ruta dispara mensajes de
// WhatsApp a personas reales al procesar.
// ═══════════════════════════════════════════════════════════════════════════

export async function GET(req: Request) {
  const inicioInvocacion = Date.now();
  // La puerta común (RES-7): 500 + alerta sin secreto, 401 con log y código.
  const puerta = await puertaCron('wa-pendientes', req, 'La bandeja no se drena sin él.');
  if (puerta) return puerta;

  // ── EL MONITOR DE SLA DE URGENTES viaja en este heartbeat ───────────────
  // (auditoría externa P2: la bandeja urgente se mide en minutos y nadie la
  // vigilaba). Va ANTES del kill switch a propósito: las urgentes envejecen
  // igual con el sistema apagado, y avisar de eso es lectura, no proceso.
  // Best-effort con grito: un monitor caído no puede tumbar el drenado.
  try {
    const vencidas = await urgentesVencidas(10);
    if (vencidas > 0) {
      logger.error('cron.wa_pendientes.urgentes_vencidas', { vencidas });
      await alertarOperador('aprobaciones.urgentes', { error: `${vencidas} pieza(s) URGENTE(s) llevan más de 10 minutos esperando aprobación en /admin/aprobaciones`, codigo: 'sla_urgente' });
    }
  } catch (e) {
    logger.error('cron.wa_pendientes.monitor_sla_caido', { err: e instanceof Error ? e.message : String(e) });
  }

  // Apagado = la pausa SIGUE: la bandeja espera, y eso es exactamente el
  // contrato nuevo. 200 con `saltado` — apagado a propósito no es fallo.
  // AUDITORÍA 18, ALTO (A17): NO haber podido leerlo SÍ lo es — este cron
  // corre cada minuto y, saltándose en 200 con `logger.info` (nivel que ni
  // llega a Sentry), la bandeja durable se quedaba sin drenar con el panel
  // en verde. Ilegible = 500 con `codigo`; el grito y el correo ya salieron
  // de `leerInterruptor`.
  const global = await leerInterruptor('global');
  if (global === 'ilegible') {
    // El latido ANTES del 500 (tableros al día, 28-ago-2026): sin él, este
    // camino era MUDO y /admin/crons tardaba cadencia+20 min en enterarse —
    // y cuando se enteraba decía «No late» en vez de «falló y por qué».
    await registrarLatido('wa-pendientes', 'fallo', { codigo: 'interruptor_ilegible' });
    return NextResponse.json({
      corrio: false,
      error: 'No se pudo leer el interruptor global: la bandeja no se drena sin saber si está apagado.',
      codigo: 'interruptor_ilegible',
      interruptor: 'global',
    }, { status: 500 });
  }
  if (global === 'apagado') {
    logger.warn('cron.wa_pendientes.saltado', { interruptor: 'global' });
    // Sin este latido, un apagado A PROPÓSITO se veía en /admin/crons como
    // «No late» en rojo a los 21 minutos, y /api/health alertaba al operador
    // por una decisión deliberada — mismo contrato que gps/asistencia/jornada.
    await registrarLatido('wa-pendientes', 'saltado', { interruptor: 'global' });
    return NextResponse.json({ corrio: false, saltado: 'interruptor global' });
  }

  const r = await drenarBandeja(inicioInvocacion, req);
  if (r.error !== undefined) {
    return NextResponse.json({ error: r.error, procesados: r.procesados, fallidos: r.fallidos, pospuestos: r.pospuestos }, { status: 500 });
  }
  return NextResponse.json({
    corrio: true,
    procesados: r.procesados,
    fallidos: r.fallidos,
    pospuestos: r.pospuestos,
    reclamados: r.reclamados,
    backlogDespues: r.backlogDespues,
    continuacion: r.continuacion,
    cartasMuertas: r.cartasMuertas,
    ...(r.encolado ? { encolado: r.encolado } : {}),
  }, { status: r.fallidos > 0 ? 500 : 200 });
}
