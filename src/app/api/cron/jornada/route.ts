import { NextResponse } from 'next/server';
import { derivarJornadas, PLAZO_DERIVACION_MS } from '@/lib/likida/jornada/derivar';
import { leerInterruptor } from '@/lib/likida/interruptores';
import { logger } from '@/lib/logger';
import { codigoDeError } from '@/lib/observability/sentry';
import { alertarOperador } from '@/lib/observability/alerta';
import { puertaCron, registrarLatido } from '@/lib/admin/salud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Una corrida lee viajes y, por cada par (operador, día), hasta dos consultas
// de posiciones. No manda un solo mensaje: es un motor de escritura interna.
export const maxDuration = 60;

// ═══════════════════════════════════════════════════════════════════════════
// EL CRON QUE DERIVA EL REGISTRO DE JORNADA (LFT 132 fr. XXXIV, mig. 0241).
//
// Toma lo que Likida ya sabe —la hora en que el operador aceptó su viaje por
// WhatsApp, las posiciones de su unidad— y lo asienta como marcas CON ORIGEN en
// el expediente del día. No inventa horas: cada marca dice de qué hecho salió,
// y el motor de riesgo trata las derivadas como cotas inferiores (sirven para
// demostrar un exceso, nunca para descartarlo).
//
// ── SIN PALANCA PROPIA, Y ES UNA DECISIÓN ────────────────────────────────
//
// No es un agente del catálogo de la compañía: es un reloj sobre datos que ya
// están en la base, como `avisarRelojesLegales`. La palanca `global` lo apaga
// con todo lo demás. Un interruptor nuevo obligaría a reescribir el catálogo
// completo de `interruptor_id_dominio`, y eso —cuando se hace de memoria—
// borra en silencio las palancas de otros (lo arregló la 0227). No se toca por
// un motor que no llama a ningún modelo ni manda un WhatsApp.
//
// ── FALLA CERRADO, Y EL 500 ES A PROPÓSITO ───────────────────────────────
//
// Este cron no manda mensajes, así que la tentación era dejarlo contestar 200
// pase lo que pase. No: lo que produce es un DOCUMENTO LABORAL, y un cron verde
// que lleva semanas sin derivar deja huecos en el expediente que después nadie
// puede llenar —los hitos viejos siguen ahí, pero nadie vuelve a mirarlos—. Un
// motor caído pinta la corrida en rojo, igual que en `escalar`.
// ═══════════════════════════════════════════════════════════════════════════

/** Cuerpo de respuesta cuando el interruptor no se pudo leer. Mismo criterio
 *  que `escalar`: «no sé si está apagado» no es permiso, y el 500 evita el
 *  cron verde que se salta corridas. */
function ilegible() {
  return {
    corrio: false,
    error: 'No se pudo leer el interruptor global: no se corre sin saber si está apagado.',
    codigo: 'interruptor_ilegible',
    interruptor: 'global',
  };
}

export async function GET(req: Request) {
  const puerta = await puertaCron('jornada', req, 'La derivación del registro de jornada no corre sin él.');
  if (puerta) return puerta;

  const global = await leerInterruptor('global');
  if (global === 'ilegible') {
    // El latido ANTES del 500 (tableros al día, 28-ago-2026): sin él este
    // camino era mudo y el tablero decía «No late» sin la causa.
    await registrarLatido('jornada', 'fallo', { codigo: 'interruptor_ilegible' });
    return NextResponse.json(ilegible(), { status: 500 });
  }
  if (global === 'apagado') {
    logger.warn('cron.jornada.saltado', { interruptor: 'global' });
    await registrarLatido('jornada', 'saltado', { interruptor: 'global' });
    return NextResponse.json({ corrio: false, saltado: 'interruptor global' });
  }

  // ── EL REPARTO DEL RELOJ (patrón del PR #152 / ESC-3) ────────────────────
  // `venceEn` es el instante a partir del cual la corrida deja de tomar
  // trabajo NUEVO. El margen sobre `maxDuration` deja aire para el latido y
  // el cierre de la respuesta.
  const venceEn = Date.now() + Math.min(PLAZO_DERIVACION_MS, (maxDuration - 10) * 1000);

  try {
    const r = await derivarJornadas({ venceEn });
    logger.info('cron.jornada.ok', { ...r, fallos: r.fallos.length });

    // ── EL CORTE SE DICE EN LA RESPUESTA, NO SOLO EN EL LOG ───────────────
    // El runner de producción murió mudo dos veces por un motor que se quedaba
    // sin turno sin que nadie se enterara. `cortadosPorReloj` viaja en el
    // cuerpo, y una corrida que dejó trabajo pendiente se registra como
    // `parcial` — ni «ok» ni «fallo», que son las dos maneras de mentir aquí.
    // `listaTruncada` cuenta como PARCIAL igual que el corte por reloj: esta
    // invocación no terminó la ventana. La cola 0319 conserva los trabajos y
    // sólo ACKea los realmente intentados, así que ambos caminos convergen en
    // corridas posteriores sin ocultar aquí el atraso.
    // AUDITORÍA 22, LEG-C1: un operador sin aviso previo NO es un fallo del
    // cron —el motor hizo lo correcto al negarse—, pero SÍ deja su registro de
    // jornada vacío, y eso el latido tiene que decirlo o el hueco es invisible.
    // `parcial`, que es exactamente lo que significa: la ventana no se derivó
    // entera y la razón está escrita.
    const parcial = r.cortadosPorReloj > 0 || r.listaTruncada || r.sinAvisoPrevio > 0;
    const huboFallo = r.fallos.length > 0;
    await registrarLatido('jornada', huboFallo ? 'fallo' : parcial ? 'parcial' : 'ok', {
      cortadosPorReloj: r.cortadosPorReloj,
      listaTruncada: r.listaTruncada,
      asentados: r.asentados,
      diasSinGps: r.diasSinGps,
      sinAvisoPrevio: r.sinAvisoPrevio,
      motivo: r.sinAvisoPrevio > 0
        ? `${r.sinAvisoPrevio} par(es) (operador, día) sin derivar: el operador nunca recibió el aviso de privacidad (LFPDPPP art. 16). La flota tiene que ponérselo a disposición antes de que su jornada se derive.`
        : undefined,
    });

    if (huboFallo) {
      logger.error('cron.jornada.con_fallos', { fallos: r.fallos.slice(0, 10) });
    }
    return NextResponse.json(r, { status: huboFallo ? 500 : 200 });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // `codigo` estable para que el fingerprint de Sentry separe «no se pudo
    // leer la lista de trabajo» de «la tabla no existe».
    const codigo = codigoDeError(e);
    logger.error('cron.jornada.falló', { error, codigo });
    await alertarOperador('cron.jornada', { error, codigo });
    await registrarLatido('jornada', 'fallo', { error, codigo });
    return NextResponse.json({ corrio: false, error, codigo }, { status: 500 });
  }
}
