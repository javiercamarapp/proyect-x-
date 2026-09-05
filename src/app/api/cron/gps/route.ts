import { NextResponse } from 'next/server';
import { sincronizarGpsTodas, httpReal } from '@/lib/likida/conectores/sincronizar_gps';
import { sincronizarEventosTodas } from '@/lib/likida/conectores/sincronizar_eventos';
import { leerInterruptor } from '@/lib/likida/interruptores';
import { logger } from '@/lib/logger';
import { codigoDeError } from '@/lib/observability/sentry';
import { alertarOperador } from '@/lib/observability/alerta';
import { registrarLatido, puertaCron } from '@/lib/admin/salud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Una llamada HTTP por flota con GPS conectado, cada una acotada a 15 s dentro
// de `httpReal`.
//
// RENDIMIENTO-19C2-4: el supuesto de "60s cubre una decena de flotas" ya NO
// se cumple — medido tomando 174-188s reales contra los 60s declarados, con
// las flotas de HOY, no una proyección a futuro. Subir el techo (mismo valor
// que ya usa `facturar/route.ts`, el otro cron cuyo trabajo escala por
// flota) es el parche de margen; partir la corrida por flota sigue siendo
// el fix de fondo cuando haga falta escalar más allá de esto.
export const maxDuration = 300;

// ── EL RELOJ DURO (auditoría 21, CRÍTICO de rendimiento) ────────────────────
// Este era el ÚNICO cron de los diez sin reloj: las dos fases (posiciones y
// eventos) corren EN SERIE y cada una escala por flota con la misma paginación
// (10 páginas × 15 s de red + consultas acotadas a 9.5 s), así que el peor
// caso sumado rebasa los 300 s en cuanto N crece — y las posiciones SOLAS ya
// se midieron en ~180 s. Un kill de Vercel a media fase de eventos dejaba el
// barrido de graves (choque/volcadura) sin correr, SIN latido y sin alerta:
// exactamente el silencio que mató al runner el 25 y el 28-ago-2026.
//
// El arreglo es el mismo que ya usan sus nueve hermanos (PR #152 / ESC-3,
// molde de `descarga-sat`: UN venceEn compartido entre las dos fases en
// serie): cada fase deja de despachar flotas NUEVAS al vencer, la flota en
// vuelo termina (unidad atómica), las sin turno se DICEN en el cuerpo y el
// latido sale `parcial`. El margen deja aire para latir y responder.
const MARGEN_RELOJ_MS = 20_000;

// ═══════════════════════════════════════════════════════════════════════════
// EL CRON QUE HACE VERDAD «el GPS de tu flota».
//
// La landing lista el GPS entre las fuentes de dato. Los cuatro conectores
// existían, declaraban `leer_posiciones` y probaban su credencial — y `posicion`
// tenía UN escritor: el pin que un chofer manda a mano por WhatsApp. Un
// conector que nadie llama es una credencial guardada, no una fuente.
//
// ── POR QUÉ NO ALERTA POR CADA FLOTA QUE FALLA ───────────────────────────
// `sincronizarGpsTodas` devuelve el error POR FLOTA en vez de lanzar: un token
// de Samsara vencido en una flota no puede dejar sin posiciones a las demás.
// Aquí eso se traduce en un latido 'parcial' —no 'fallo'— y en el conteo en el
// cuerpo. El 'fallo' se reserva para lo que sí tumba la corrida entera.
//
// ── LA PUERTA Y EL INTERRUPTOR, IGUAL QUE LAS DEMÁS ───────────────────────
// Sin `CRON_SECRET` contesta 500, no 200: un 200 dejaría el cron verde en el
// panel de Vercel mientras el GPS lleva semanas sin entrar. Y el interruptor
// ilegible NO se lee como apagado (A17): es un fallo declarado.
// ═══════════════════════════════════════════════════════════════════════════

export async function GET(req: Request) {
  const puerta = await puertaCron('gps', req, 'El GPS no se sincroniza sin él.');
  if (puerta) return puerta;

  const global = await leerInterruptor('global');
  if (global === 'ilegible') {
    // El latido ANTES del 500 (tableros al día, 28-ago-2026): sin él este
    // camino era mudo y el tablero decía «No late» sin la causa.
    await registrarLatido('gps', 'fallo', { codigo: 'interruptor_ilegible' });
    return NextResponse.json({
      corrio: false,
      error: 'No se pudo leer el interruptor global: no se sincroniza sin saber si está apagado.',
      codigo: 'interruptor_ilegible',
      interruptor: 'global',
    }, { status: 500 });
  }
  if (global === 'apagado') {
    logger.warn('cron.gps.saltado', { interruptor: 'global' });
    await registrarLatido('gps', 'saltado', { interruptor: 'global' });
    return NextResponse.json({ corrio: false, saltado: 'interruptor global' });
  }

  // El reloj de ESTA invocación, uno solo para las dos fases (molde de
  // `descarga-sat`). Se cuenta desde aquí y no desde dentro del motor:
  // `maxDuration` corre desde que Vercel invoca.
  const venceEn = Date.now() + maxDuration * 1000 - MARGEN_RELOJ_MS;

  try {
    // Los EVENTOS DE SEGURIDAD de las cámaras del cliente van en la MISMA
    // corrida — mismo proveedor, misma credencial, misma cadencia; un cron
    // aparte duplicaría las 8,640 invocaciones/mes por nada (la lección de
    // COSTO-VERCEL-50K). Un evento grave (crash/volcadura) abre el expediente
    // de asistencia y avisa al jefe ANTES de que el chofer pueda escribir.
    // Van PRIMERO: con presupuesto compartido, la telemetría ordinaria nunca
    // puede consumir el turno de un choque pendiente.
    const eventos = await sincronizarEventosTodas(httpReal, { venceEn });

    const resultados = await sincronizarGpsTodas(httpReal, { venceEn });

    const conError = resultados.filter((r) => r.error);
    const guardadas = resultados.reduce((s, r) => s + r.guardadas, 0);
    const huerfanas = resultados.reduce((s, r) => s + r.huerfanas, 0);
    const sinTurno = resultados.filter((r) => r.sinTurno).length;
    const eventosConError = eventos.filter((r) => r.error && !r.sinPermiso);
    const eventosGuardados = eventos.reduce((s, r) => s + r.guardados, 0);
    const disparos = eventos.reduce((s, r) => s + r.disparos, 0);
    const eventosSinTurno = eventos.filter((r) => r.sinTurno).length;
    const backlog = resultados.filter((r) => r.backlog).length;
    const eventosBacklog = eventos.filter((r) => r.backlog).length;
    // AUDITORÍA 24, REN-2 y LEG-1: lo que la corrida NO guardó, con nombre.
    const recortadas = resultados.reduce((s, r) => s + (r.recortadas ?? 0), 0);
    const sinAvisoPrevio = resultados.reduce((s, r) => s + (r.sinAvisoPrevio ?? 0), 0);
    const eventosSinAvisoPrevio = eventos.reduce((s, r) => s + (r.sinAvisoPrevio ?? 0), 0);
    const enCuarentena = eventos.reduce((s, r) => s + (r.eventosEnCuarentena ?? 0), 0);
    const cuarentenaMuertos = eventos.reduce((s, r) => s + (r.eventosCuarentenaMuertos ?? 0), 0);
    const outboxPendientes = eventos.reduce((s, r) => s + (r.eventosOutboxPendientes ?? 0), 0);
    const outboxMuertos = eventos.reduce((s, r) => s + (r.eventosOutboxMuertos ?? 0), 0);
    const avisosPendientes = eventos.reduce((s, r) => s + (r.avisosPendientes ?? 0), 0);
    const avisosMuertos = eventos.reduce((s, r) => s + (r.avisosMuertos ?? 0), 0);
    const eventosMuertos = cuarentenaMuertos + outboxMuertos + avisosMuertos;

    // Las huérfanas no son un error de la corrida, pero tampoco son ruido: son
    // camiones que el proveedor reporta y que ninguna unidad reclama. Van en el
    // cuerpo para que se vean desde el panel sin abrir los logs. Lo mismo el
    // `sinPermisoEventos`: la credencial sirve para posiciones pero no trae el
    // scope de eventos — el dueño tiene que enterarse de que sus cámaras
    // detectan cosas que Likida no puede ver.
    const cuerpo = {
      corrio: true,
      flotas: resultados.length,
      guardadas,
      huerfanas,
      conError: conError.length,
      // El corte por reloj viaja en el CUERPO, no solo en el log (regla del
      // PR #152): una corrida que dejó flotas sin sincronizar y contesta 200
      // limpio es un cron verde que miente.
      sinTurnoPorReloj: sinTurno,
      // REN-2: lecturas válidas que el techo dejó fuera. > 0 = hay camiones
      // que este cron no ve; nunca «ok».
      recortadas,
      backlogPendiente: backlog,
      // LEG-1: unidades con viaje vivo cuyo operador no ha recibido el aviso
      // de privacidad. Sus posiciones NO se guardaron (art. 16 LFPDPPP).
      sinAvisoPrevio,
      motivoSinAviso: sinAvisoPrevio > 0 || eventosSinAvisoPrevio > 0
        ? `${Math.max(sinAvisoPrevio, eventosSinAvisoPrevio)} unidad(es) sin rastrear: su operador nunca recibió el aviso de privacidad (LFPDPPP art. 16). La flota tiene que ponérselo a disposición antes de que su GPS o su cámara se sincronicen.`
        : undefined,
      eventos: {
        flotas: eventos.length,
        guardados: eventosGuardados,
        disparosAsistencia: disparos,
        sinTurnoPorReloj: eventosSinTurno,
        backlogPendiente: eventosBacklog,
        sinAvisoPrevio: eventosSinAvisoPrevio,
        sinPermiso: eventos.filter((r) => r.sinPermiso).map((r) => ({ tenantId: r.tenantId, proveedor: r.proveedor })),
        conError: eventosConError.length,
        enCuarentena, cuarentenaMuertos, outboxPendientes, outboxMuertos,
        avisosPendientes, avisosMuertos,
        errores: eventosConError.map((r) => ({ tenantId: r.tenantId, proveedor: r.proveedor, error: r.error })),
      },
      // El detalle SIN la credencial: aquí solo viaja el id del proveedor.
      errores: conError.map((r) => ({ tenantId: r.tenantId, proveedor: r.proveedor, error: r.error })),
    };

    // `parcial` también cuando el reloj cortó: ni «ok» (quedó trabajo sin
    // hacer, incluido el barrido de graves de las flotas sin turno) ni «fallo»
    // (nada se rompió; la corrida siguiente, en 5 min, retoma lo pendiente).
    const cortadaPorReloj = sinTurno > 0 || eventosSinTurno > 0;
    // `parcial` también con recorte o con unidades sin aviso: en los dos casos
    // hay camiones que esta corrida NO sincronizó, y un «ok» lo taparía.
    const incompleta = recortadas > 0 || backlog > 0 || eventosBacklog > 0 ||
      enCuarentena > 0 || outboxPendientes > 0 || avisosPendientes > 0 || eventosMuertos > 0 ||
      sinAvisoPrevio > 0 || eventosSinAvisoPrevio > 0;
    if (eventosMuertos > 0) {
      const afectados = eventos.filter((r) =>
        (r.eventosCuarentenaMuertos ?? 0) + (r.eventosOutboxMuertos ?? 0) + (r.avisosMuertos ?? 0) > 0)
        .map((r) => `${r.tenantId}/${r.proveedor}`).join(', ');
      await alertarOperador('cron.gps.dlq', { afectados, eventosMuertos });
    }
    if (conError.length > 0 || eventosConError.length > 0 || cortadaPorReloj || incompleta) {
      logger.warn('cron.gps.parcial', cuerpo);
      await registrarLatido('gps', 'parcial', {
        flotas: resultados.length,
        conError: conError.length + eventosConError.length,
        sinTurnoPorReloj: sinTurno + eventosSinTurno,
        recortadas,
        backlogPendiente: backlog + eventosBacklog,
        sinAvisoPrevio: sinAvisoPrevio + eventosSinAvisoPrevio,
        eventosMuertos,
      });
    } else {
      logger.info('cron.gps.ok', cuerpo);
      await registrarLatido('gps', 'ok', { flotas: resultados.length, guardadas, disparos });
    }
    return NextResponse.json(cuerpo);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const codigo = codigoDeError(e);
    logger.error('cron.gps.falló', { error, codigo });
    await alertarOperador('cron.gps', { error, codigo });
    await registrarLatido('gps', 'fallo', { codigo });
    return NextResponse.json({ error }, { status: 500 });
  }
}
