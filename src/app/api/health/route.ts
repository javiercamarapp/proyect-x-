import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { acotada } from '@/lib/likida/presupuesto';
import { detalleLatidos, esHuecoDeConfiguracion, type CronId } from '@/lib/admin/salud';
import { alertarOperador, alertarHuecoConfiguracion } from '@/lib/observability/alerta';
import { logger } from '@/lib/logger';
import { rateLimit, clientIp } from '@/lib/ratelimit';
import { cotejarMigracion } from './migracion';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ═══════════════════════════════════════════════════════════════════════════
// /api/health — el pulso para un monitor externo (hallazgo D4, auditoría 4).
//
// Hasta hoy nada podía preguntarle a Likida "¿estás vivo?" desde fuera: el
// cron del camino del dinero tronó cada hora durante nueve días y se
// descubrió porque se cayó una página a la vista. Un UptimeRobot (o el cron
// de un tercero) pegándole a esto cada minuto convierte ese modo de falla en
// una alerta de minutos.
//
// QUÉ MIDE Y QUÉ NO:
//  · la base respondió (consulta real, HEAD + count sobre `tenant`);
//  · qué versión corre (el sha del deploy — es lo que confirma que el último
//    push con [deploy] de verdad llegó, contra el modo de falla silencioso
//    del ignoreCommand);
//  · desde RES-7 (0155) SÍ mide los latidos de los crons. Un cron vencido o
//    una lectura de latidos ilegible degrada el estado agregado a 503 y dispara
//    UNA alerta al operador (piso de una hora). Los nombres y edades concretas
//    quedan únicamente en logs/alerta privados, no en el endpoint público.
//    `sin_latido` mantiene el health degradado hasta que el cron haya probado
//    que está vivo.
//  · un latido no sano (`fallo`/`parcial`/`saltado`) SIEMPRE degrada el
//    status público a 503 — eso no cambia. Lo que sí se distingue (auditoría
//    prod 29-ago-2026) es A QUIÉN se lo dice y con qué urgencia: un hueco de
//    configuración que el propio cron ya declaró en prosa (`descarga-sat` sin
//    LIKIDA_SAT_PROVEEDOR, por ejemplo — `esHuecoDeConfiguracion`) manda a lo
//    sumo un correo por semana por `alertarHuecoConfiguracion`, no uno por
//    hora para siempre por cada ping de un monitor externo. Una regresión de
//    verdad sigue mandando el correo "Urgente" de `alertarOperador` sin cambios.
//  · NO mide la ausencia de corridas de cron: con la base en cero flotas,
//    "no hubo corridas con trabajo" es lo normal y alarmaría siempre. Ese
//    monitor llega cuando `agente_corrida` tenga tráfico real que fechar.
//
// SIN AUTH A PROPÓSITO: no devuelve un solo dato de negocio, nombre de cron ni
// configuración interna — solo estado agregado, sha (público en GitHub) y hora.
// Un health detrás de secreto es un health que el monitor gratuito no puede
// usar. Status 200 solo cuando TODO lo medido está bien; 503 si hay fallo o
// degradación — que es lo que un monitor entiende sin leer el cuerpo.
// ═══════════════════════════════════════════════════════════════════════════

export async function GET(req: NextRequest) {
  const iniciado = Date.now();
  // OPERABILIDAD-19C2-3 (barrido MEDIO/BAJO): sin auth a propósito (ver
  // arriba), esta ruta hace 2 consultas reales a Supabase por petición, sin
  // ningún techo. 30/min por IP deja de sobra a un monitor externo (que le
  // pega "cada minuto", según el comentario original) y frena un scraper.
  if (!(await rateLimit(`health:${clientIp(req)}`, 30, 60_000))) {
    return NextResponse.json({ ok: false, status: 'fail', error: 'demasiadas peticiones' }, {
      status: 429,
      headers: { 'cache-control': 'no-store' },
    });
  }
  let db: 'ok' | 'fallo' = 'fallo';
  try {
    const { error } = await acotada(
      supabaseAdmin().from('tenant').select('id', { count: 'exact', head: true }),
      'health.db',
    );
    if (!error) db = 'ok';
  } catch {
    db = 'fallo';
  }

  // Solo el agregado, sin detalle: el health es público y esto no filtra
  // nombres de cron ni datos de negocio. Una lectura caída degrada el pulso.
  // ── AUDITORÍA 22, OP-C1 (CRÍTICO): TRES ESTADOS, NO DOS ──────────────────
  // `config_ausente` es NUEVO y es el hallazgo entero. Este endpoint ya
  // distinguía por dentro un hueco de configuración DECLARADO (el cron dice qué
  // le falta y quién lo destraba) de una regresión real, y luego colapsaba los
  // dos en `degraded`. El watchdog de producción exige `estado=ok`, así que
  // `descarga-sat` sin LIKIDA_SAT_PROVEEDOR lo dejaba rojo PARA SIEMPRE: 30
  // corridas seguidas en failure, y una muerte real de cron se veía idéntica al
  // ruido conocido. Un detector que no puede cambiar de color no detecta.
  //
  // Se publica el tercer estado para que el watchdog pueda tratarlos distinto:
  // un hueco declarado se anota y no tumba el job; una regresión sí.
  let cronCheck: 'ok' | 'degraded' | 'config_ausente' | 'unknown' = 'unknown';
  try {
    const latidos = await detalleLatidos();
    const ids = Object.keys(latidos) as CronId[];
    const vencidos = ids.filter((c) => latidos[c].estado === 'vencido');
    const sinLatido = ids.filter((c) => latidos[c].estado === 'sin_latido');
    const noSanos = ids.filter((c) => latidos[c].estado === 'ok' && latidos[c].ultimoEstado !== 'ok');

    // ── AUDITORÍA 24, OP-P4 / OP-C2 (ALTO): EL QUE NUNCA LATIÓ SE JUZGA PRIMERO ──
    // `sinLatido` se consultaba en la TERCERA rama, después de `noSanos`: con
    // `cron_latido` vacía salvo un `descarga-sat` en `parcial` por hueco de
    // configuración, el health contestaba `config_ausente` → 200 `ok` con
    // diez crons sin haber latido jamás. El escenario real del piloto es una
    // base restaurada (OP-P2): `wa-outbox` no manda, `facturar` no factura y
    // el watchdog pasa. Un cron muerto (vencido o sin latido) es `degraded`
    // ANTES de mirar si otro tiene un hueco declarado.
    const muertos = [...vencidos, ...sinLatido];
    if (muertos.length > 0) {
      cronCheck = 'degraded';
      logger.error('health.cron_vencido', {
        crons: vencidos, haceMin: vencidos.map((c) => latidos[c].haceMin), sinLatido,
      });
      const partes = [
        ...vencidos.map((c) => `${c} (hace ${latidos[c].haceMin} min)`),
        ...sinLatido.map((c) => `${c} (nunca latió)`),
      ];
      await alertarOperador('cron.sin_latido', {
        error: `Sin latido: ${partes.join(', ')}`,
        codigo: 'cron_sin_latido',
      });
    }
    if (noSanos.length > 0) {
      // Fresco no significa sano: un cron que acaba de reportar `fallo`,
      // `parcial` o `saltado` debe tumbar el health aunque su reloj esté al día.
      // Un hueco de configuración YA declarado (el propio cron dice qué falta
      // y quién lo destraba) no es lo mismo que una regresión real — separarlo
      // ANTES de decidir a quién avisar y con qué urgencia (auditoría prod
      // 29-ago-2026: `descarga-sat` sin LIKIDA_SAT_PROVEEDOR mandaba el mismo
      // correo "Urgente" en cada ping de un monitor externo, para siempre).
      const configAusente = noSanos.filter((c) => esHuecoDeConfiguracion(latidos[c].detalle));
      const regresiones = noSanos.filter((c) => !configAusente.includes(c));
      // OP-C1: si TODO lo no-sano es hueco declarado (y nadie está muerto), el
      // estado es `config_ausente` — visible, pero distinguible de una regresión.
      if (regresiones.length > 0) cronCheck = 'degraded';
      else if (cronCheck !== 'degraded') cronCheck = 'config_ausente';
      if (configAusente.length > 0) {
        for (const c of configAusente) {
          // Código controlado por el catálogo: sobrevive al saneador sin
          // enviar la prosa potencialmente privada del motivo a Sentry.
          logger.warn('health.cron_config_ausente', {
            codigo: `cron_config_ausente:${c}`, ruta: `/api/cron/${c}`,
          });
          await alertarHuecoConfiguracion(`cron.config_ausente:${c}`, String(latidos[c].detalle.motivo), {
            cron: c,
            estado: latidos[c].ultimoEstado,
          });
        }
      }
      if (regresiones.length > 0) {
        logger.error('health.cron_estado_no_ok', {
          crons: regresiones,
          estados: regresiones.map((c) => latidos[c].ultimoEstado),
        });
        await alertarOperador('cron.estado_no_ok', {
          error: `Cron con resultado no sano: ${regresiones.map((c) => `${c} (${latidos[c].ultimoEstado})`).join(', ')}`,
          codigo: 'cron_estado_no_ok',
        });
      }
    } else if (muertos.length === 0) {
      cronCheck = 'ok';
    }
  } catch (e) {
    cronCheck = 'unknown';
    logger.warn('health.latidos_ilegibles', { err: e instanceof Error ? e.message : String(e) });
  }

  // ── AUDITORÍA 24, OP-P1 (BLOQUEANTE): ¿LA BASE VA A LA PAR DEL CÓDIGO? ─────
  // Ver `./migracion.ts`. Una base atrás del código es `degraded` con motivo:
  // el export de póliza pide la forma 0272 de una RPC que la base 0271 no
  // tiene, y hasta hoy nada lo decía desde fuera. La compuerta de despliegue
  // (`scripts/ci/compuerta-deploy.mjs`, que corren el `ignoreCommand` de Vercel
  // y `salud-produccion.yml`) lee este mismo campo y no deja pasar un `[deploy]`
  // con `atras > 0`.
  const migracion = db === 'ok'
    ? await cotejarMigracion(() => acotada(supabaseAdmin().rpc('migraciones_aplicadas'), 'health.migracion'))
    : { base: null, codigo: null, atras: null, aplicados: null, motivo: 'base caída: no se cotejó' };
  if (migracion.atras !== 0) {
    logger.error('health.migracion', { base: migracion.base, codigo: migracion.codigo, atras: migracion.atras, motivo: migracion.motivo });
  }

  // OP-C1: `config_ausente` NO tumba el status global. No es benevolencia: es
  // que un hueco declarado ya tiene su propio canal (alertarHuecoConfiguracion)
  // y dejarlo aquí en rojo permanente destruye la única señal que distingue un
  // cron muerto de uno sin configurar. El estado sigue publicado en
  // `checks.crons` para quien quiera exigirlo.
  const status: 'ok' | 'degraded' | 'fail' =
    db !== 'ok' ? 'fail'
      : cronCheck === 'degraded' || cronCheck === 'unknown' || migracion.atras !== 0 ? 'degraded'
        : 'ok';
  // Métrica de baja cardinalidad para logs/drains. El detalle de qué cron fue
  // vencido queda en el log privado y no se publica en este endpoint.
  logger.info('metric.health', { status, db, cron: cronCheck, migracionAtras: migracion.atras, ms: Date.now() - iniciado });
  const cuerpo = {
    ok: status === 'ok',
    status,
    checks: { db, crons: cronCheck },
    // Vercel la inyecta en build; en local es "local" y eso también es verdad.
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local',
    // OP-P1: `{ base, codigo, atras }` — números de migración, no datos de
    // negocio. `motivo` solo cuando algo no cuadra, y dice qué aplicar.
    migracion,
    hora: new Date().toISOString(),
  };
  return NextResponse.json(cuerpo, {
    status: cuerpo.ok ? 200 : 503,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}
