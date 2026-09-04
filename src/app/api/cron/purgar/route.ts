import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { borrarStorageMarcado } from '@/lib/likida/storage_borrado';
import { leerInterruptor } from '@/lib/likida/interruptores';
import { logger } from '@/lib/logger';
import { codigoDeError } from '@/lib/observability/sentry';
import { alertarOperador } from '@/lib/observability/alerta';
import { registrarLatido, puertaCron } from '@/lib/admin/salud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Un `delete` acotado por fecha y un `insert … on conflict` de agregados. Los
// dos entran por índice (`idx_wa_msg_created` y `idx_costo_tenant`), así que el
// presupuesto es para el caso raro: la PRIMERA corrida, que barre de golpe todo
// lo que se acumuló desde que existe la tabla.
export const maxDuration = 120;

// ═══════════════════════════════════════════════════════════════════════════
// EL CRON DE MANTENIMIENTO DE DATOS.
//
// Hasta la 0072 no se purgaba NADA. Dos tablas crecen sin techo y ninguna tenía
// una línea que las recortara — y la que revienta primero no es la obvia:
// `llm_costo` guarda una fila por LLAMADA AL MODELO, y un mensaje de WhatsApp
// dispara varias, así que crece más rápido que `wa_mensaje_procesado`, que
// guarda una por mensaje.
//
// ── QUÉ HACE, Y QUÉ NO HACE A PROPÓSITO ──────────────────────────────────
//
// BORRA `wa_mensaje_procesado` de más de 30 días. Es una tabla de idempotencia
// y nada más: no tiene `tenant_id` (CLAUDE.md), no se puede atribuir a una
// flota y no responde ninguna pregunta de negocio. 30 días es más de un orden
// de magnitud por encima de la ventana de reintentos de Meta.
//
// `llm_costo` se CONSOLIDA a mensual (0072) y, desde la 0155 (ESC-10), el
// detalle de más de 13 meses se borra: el mes ya está cerrado en
// `llm_costo_mensual`, que es la granularidad que el panel lee. La respuesta
// lleva `llmCostoPurgado` con la cifra real.
//
// EN TANDAS Y CON REPETICIÓN (0155, ESC-16): cada purga borra de 50k en 50k
// con un vencimiento de 60 s compartido dentro de la RPC, y devuelve
// `parcial: true` si no alcanzó. Este cron repite la llamada mientras sea
// parcial y le queden más de 60 s de reloj; lo que no cupo lo levanta la
// corrida de mañana. Antes era UN delete sin tandas bajo maxDuration=120: la
// primera corrida grande moría a la mitad con el lock puesto.
//
// ── POR QUÉ FALLA CERRADO SIN SECRETO ────────────────────────────────────
//
// Mismo criterio que `escalar` y `facturar`: esta ruta BORRA FILAS. Sin
// `CRON_SECRET` devuelve 500 y no 200, porque un 200 dejaría el cron verde en
// el panel de Vercel para siempre y nadie se enteraría de que la purga lleva
// meses sin correr — que es justo el modo de falla que esta ruta existe para
// cerrar. Y sin el secreto, cualquiera que conociera la URL podría disparar
// borrados a voluntad.
// ═══════════════════════════════════════════════════════════════════════════

/** Días que sobrevive una fila de idempotencia. El piso lo impone la 0072. */
const DIAS_WA = 30;
/** Cada llamada a la RPC se corta sola a los 60 s; solo se repite si queda
 *  margen para otra entera. */
const PLAZO_VUELTA_MS = 60_000;
/** Techo duro de vueltas por corrida, por si `parcial` nunca baja. */
const MAX_VUELTAS = 3;
/** 20 × 5,000 = hasta 100k filas por tabla y corrida, sin retener los locks
 * entre lotes porque cada RPC es una transacción independiente. */
const MAX_LOTES_RETENCION_0104 = 20;
/** Reserva 15 s del maxDuration para Storage/producto/MCP y la respuesta. */
const MARGEN_FINAL_MS = 15_000;

type NombrePurga0104 = 'purgar_wa_conversacion' | 'purgar_codigo_pendiente';
type ResultadoDrenaje0104 = {
  borradas: number;
  lotes: number;
  parcial: boolean;
  agotado: boolean;
  error: string | null;
};

async function drenarPurga0104(
  nombre: NombrePurga0104,
  ahora: string,
  venceMs: number,
  yaAgotadaEnMantenimiento: boolean,
): Promise<ResultadoDrenaje0104> {
  const total: ResultadoDrenaje0104 = {
    borradas: 0,
    lotes: 0,
    parcial: true,
    agotado: false,
    error: null,
  };

  // mantenimiento_de_datos ya ejecutó la primera tanda. Si esa tanda dijo
  // que no queda backlog, no hacemos una RPC vacía adicional. Cuando queda
  // parcial (o la versión de BD aún no trae la señal), este ciclo complementa
  // en transacciones independientes y libera locks/WAL entre llamadas.
  if (yaAgotadaEnMantenimiento) {
    total.parcial = false;
    total.agotado = true;
    return total;
  }

  while (total.lotes < MAX_LOTES_RETENCION_0104 && Date.now() < venceMs) {
    const respuesta = await supabaseAdmin().rpc(nombre, {
      p_dias: 180,
      p_ahora: ahora,
      p_vence: new Date(venceMs).toISOString(),
    });
    if (respuesta.error) {
      total.error = respuesta.error.message;
      logger.error('cron.purgar.retencion_0104_falló', { nombre, error: total.error, lotes: total.lotes });
      await alertarOperador('cron.purgar.retencion_0104', { nombre, error: total.error });
      return total;
    }

    const dato = (respuesta.data ?? {}) as Record<string, unknown>;
    const borradas = Number(dato.borradas);
    const parcial = dato.parcial === true;
    const agotado = dato.agotado === true;
    if (!Number.isSafeInteger(borradas) || borradas < 0 || parcial === agotado) {
      total.error = 'respuesta_invalida';
      logger.error('cron.purgar.retencion_0104_respuesta_invalida', { nombre, dato });
      await alertarOperador('cron.purgar.retencion_0104', { nombre, error: total.error });
      return total;
    }

    total.borradas += borradas;
    total.lotes++;
    total.parcial = parcial;
    total.agotado = agotado;
    if (agotado) return total;
  }

  return total;
}

export async function GET(req: Request) {
  // La puerta (RES-7): sin secreto 500 + alerta; 401 con log y código
  // estable — antes ni el 401 ni el secreto ausente dejaban huella y el cron
  // podía llevar semanas muerto con el panel en verde.
  const puerta = await puertaCron('purgar', req, 'La purga no corre sin él.');
  if (puerta) return puerta;

  // ── EL KILL SWITCH (0110): solo 'global' — la purga no es un agente ──────
  //
  // Esta ruta BORRA FILAS: en un incidente donde Javier apaga todo, lo último
  // que quiere es un cron borrando datos mientras investiga. 200 y no error:
  // apagado a propósito no es fallo, y el `saltado` del cuerpo distingue esta
  // corrida de una sana. Fail-closed: interruptor ilegible = no se borra sin
  // permiso legible. AUDITORÍA 18, ALTO (A17): ilegible NO es "apagado" —
  // es un fallo y contesta 500 con `codigo`, para que el cron no salga verde
  // sobre una base que no se pudo leer (el grito y el correo ya salieron de
  // `leerInterruptor`).
  const global = await leerInterruptor('global');
  if (global === 'ilegible') {
    // El latido ANTES del 500 (tableros al día, 28-ago-2026): sin él este
    // camino era mudo y el tablero decía «No late» sin la causa. En un cron
    // diario, además, el silencio tardaba un día entero en notarse.
    await registrarLatido('purgar', 'fallo', { codigo: 'interruptor_ilegible' });
    return NextResponse.json({
      corrio: false,
      error: 'No se pudo leer el interruptor global: no se purga sin saber si está apagado.',
      codigo: 'interruptor_ilegible',
      interruptor: 'global',
    }, { status: 500 });
  }
  if (global === 'apagado') {
    logger.warn('cron.purgar.saltado', { interruptor: 'global' });
    // Sin este latido, el apagado deliberado se pintaba como cron muerto y
    // /api/health alertaba al operador por su propia decisión.
    await registrarLatido('purgar', 'saltado', { interruptor: 'global' });
    return NextResponse.json({ corrio: false, saltado: 'interruptor global' });
  }

  try {
    const inicio = Date.now();
    let vueltas = 0;
    let data: Record<string, unknown> = {};
    let parcial = false;
    let otrasPurgasParcial: boolean | null = null;
    let conversacionesBorradasEnMantenimiento = 0;
    let codigosBorradosEnMantenimiento = 0;
    let lotesConversacionEnMantenimiento = 0;
    let lotesCodigoEnMantenimiento = 0;
    let conversacionesParcialConocido = false;
    let codigosParcialConocido = false;
    let conversacionesParcial = true;
    let codigosParcial = true;
    do {
      vueltas++;
      const r = await supabaseAdmin().rpc('mantenimiento_de_datos', {
        p_dias_wa: DIAS_WA,
      });

      // supabase-js reporta POR VALOR: sin comprobar `error` explícitamente, una
      // base caída se leería como una purga que no encontró nada que borrar y la
      // corrida saldría verde. Ver `exigir()` en analytics.ts.
      if (r.error) {
        // El `codigo` discrimina la causa en el fingerprint de Sentry: un error
        // de PostgREST trae `code` ('42P01', 'PGRST202'…) y ese viaja tal cual —
        // una causa nueva es un issue nuevo, o sea una notificación que sí llega.
        // La alerta va directo al operador del sistema: los avisos por tenant no
        // cubren un cron global, y este no tiene tenant que emitir.
        const codigo = codigoDeError(r.error);
        logger.error('cron.purgar.falló', { error: r.error.message, codigo, vuelta: vueltas });
        await alertarOperador('cron.purgar', { error: r.error.message, codigo });
        await registrarLatido('purgar', 'fallo', { codigo, vuelta: vueltas });
        return NextResponse.json({ error: r.error.message, vueltas }, { status: 500 });
      }
      data = (r.data ?? {}) as Record<string, unknown>;
      const conversacionesVuelta = Number(data.conversacionesPurgadas);
      if (Number.isSafeInteger(conversacionesVuelta) && conversacionesVuelta >= 0) {
        conversacionesBorradasEnMantenimiento += conversacionesVuelta;
        lotesConversacionEnMantenimiento++;
      }
      const codigosVuelta = Number(data.codigosPurgados);
      if (Number.isSafeInteger(codigosVuelta) && codigosVuelta >= 0) {
        codigosBorradosEnMantenimiento += codigosVuelta;
        lotesCodigoEnMantenimiento++;
      }
      if (typeof data.conversacionesParcial === 'boolean') {
        conversacionesParcialConocido = true;
        conversacionesParcial = data.conversacionesParcial;
      }
      if (typeof data.codigosParcial === 'boolean') {
        codigosParcialConocido = true;
        codigosParcial = data.codigosParcial;
      }
      parcial = data.parcial === true;
      if (typeof data.otrasPurgasParcial === 'boolean') otrasPurgasParcial = data.otrasPurgasParcial;
      if (parcial) logger.warn('cron.purgar.parcial', { vuelta: vueltas, transcurridoMs: Date.now() - inicio });
      // AUDITORÍA 19 (legal, reincidente #13): `mantenimiento_de_datos`
      // acumula en `fallos` cada purga que lanzó (0165) y NADIE leía la
      // llave — una purga rota (la de retención que un aviso promete) salía
      // en el log como corrida verde con un array adentro que ningún humano
      // abría. Un fallo de purga es un plazo legal que dejó de correr: se
      // grita como error y se avisa al operador, pero NO se corta la vuelta
      // — las demás purgas sí corrieron y volver a intentarlo aquí no
      // arregla la que lanzó.
      const fallosPurga = Array.isArray(data.fallos) ? (data.fallos as unknown[]) : [];
      if (fallosPurga.length > 0) {
        logger.error('cron.purgar.purgas_con_fallos', { fallos: fallosPurga, vuelta: vueltas });
        await alertarOperador('cron.purgar.purgas_con_fallos', { fallos: fallosPurga.map(String).join(' · ').slice(0, 500) });
        // Una purga que LANZA no es "quedó trabajo pendiente": reintentarla
        // en la misma corrida daría el mismo error. Se sale del ciclo — el
        // `parcial` por fallos ya quedó dicho arriba y en el latido.
        break;
      }
    } while (parcial && vueltas < MAX_VUELTAS && Date.now() - inicio + PLAZO_VUELTA_MS < (maxDuration - 5) * 1000);

    // 0332: conversación/códigos borran UNA tanda por RPC. El ciclo vive aquí,
    // fuera de Postgres, para que cada lote confirme y libere locks/WAL antes
    // del siguiente. Las dos tablas drenan en paralelo y comparten el deadline
    // duro de la ruta; el techo impide un loop infinito ante backlog continuo.
    const ahoraRetencion = new Date(inicio).toISOString();
    const venceRetencionMs = inicio + maxDuration * 1000 - MARGEN_FINAL_MS;
    const [conversacionesDrenaje, codigosDrenaje] = await Promise.all([
      drenarPurga0104('purgar_wa_conversacion', ahoraRetencion, venceRetencionMs,
        conversacionesParcialConocido && !conversacionesParcial),
      drenarPurga0104('purgar_codigo_pendiente', ahoraRetencion, venceRetencionMs,
        codigosParcialConocido && !codigosParcial),
    ]);
    const conversaciones0104 = {
      ...conversacionesDrenaje,
      borradas: conversacionesBorradasEnMantenimiento + conversacionesDrenaje.borradas,
      lotes: lotesConversacionEnMantenimiento + conversacionesDrenaje.lotes,
      borradasMantenimiento: conversacionesBorradasEnMantenimiento,
      lotesMantenimiento: lotesConversacionEnMantenimiento,
      borradasDrenaje: conversacionesDrenaje.borradas,
      lotesDrenaje: conversacionesDrenaje.lotes,
    };
    const codigos0104 = {
      ...codigosDrenaje,
      borradas: codigosBorradosEnMantenimiento + codigosDrenaje.borradas,
      lotes: lotesCodigoEnMantenimiento + codigosDrenaje.lotes,
      borradasMantenimiento: codigosBorradosEnMantenimiento,
      lotesMantenimiento: lotesCodigoEnMantenimiento,
      borradasDrenaje: codigosDrenaje.borradas,
      lotesDrenaje: codigosDrenaje.lotes,
    };
    const retencion0104 = { conversaciones: conversaciones0104, codigos: codigos0104 };
    const erroresRetencion0104 = [
      conversaciones0104.error && `wa_conversacion: ${conversaciones0104.error}`,
      codigos0104.error && `codigo_pendiente: ${codigos0104.error}`,
    ].filter((error): error is string => typeof error === 'string');
    const retencionParcial = conversaciones0104.parcial || codigos0104.parcial || erroresRetencion0104.length > 0;

    // ── EL BORRADO DE STORAGE (23-ago-2026) ────────────────────────────────
    // `mantenimiento_de_datos` MARCA archivos en `storage_huerfano_candidato`
    // porque Supabase prohíbe borrar `storage.objects` desde SQL — pero nadie
    // vaciaba esa cola, así que los archivos quedaban marcados para siempre.
    // Con el ejecutor ARCO (0173) eso deja de ser deuda y pasa a ser un
    // incumplimiento: una cancelación que promete borrar las fotos del titular
    // y las deja en el bucket es una promesa con evidencia escrita de haberse
    // hecho.
    //
    // Va DESPUÉS de la purga y fuera del `do/while`: la purga es la que llena
    // la cola, así que borrar antes sería borrar la cola de ayer. Y su fallo no
    // tumba la corrida —las filas ya se purgaron— pero sí sale en el cuerpo,
    // para que una cola que no baja se vea desde el panel.
    let storage: Awaited<ReturnType<typeof borrarStorageMarcado>> | null = null;
    try {
      storage = await borrarStorageMarcado();
      if (storage.fallidos > 0) {
        logger.warn('cron.purgar.storage_con_fallos', { ...storage });
      }
    } catch (e) {
      logger.error('cron.purgar.storage_excepcion', { err: e instanceof Error ? e.message : String(e) });
    }

    // ── PRODUCTO_EVENTO: consolidar el mes cerrado y purgar el detalle ─────
    // (0259, auditoría tandas 21-24 hallazgo 3). RPC HERMANA y no una llave
    // más de `mantenimiento_de_datos` a propósito: el PR del 0258 redefine
    // esa función desde master y dos redefiniciones independientes se borran
    // las llaves entre sí (regla de la casa: cada PR sale de master, el
    // squash pierde el apilado sin señal). Misma corrida, mismo horario,
    // fallo visible propio. Su fallo NO tumba la corrida —las purgas de
    // arriba ya corrieron— pero se grita y se alerta: una tabla que vuelve a
    // crecer sin techo en silencio es exactamente el hallazgo que esto
    // cierra. `null` en el cuerpo = no se pudo, dicho; jamás un 0 inventado.
    let productoEvento: Record<string, unknown> | null = null;
    try {
      const pe = await supabaseAdmin().rpc('mantener_producto_evento');
      if (pe.error) {
        const codigo = codigoDeError(pe.error);
        logger.error('cron.purgar.producto_evento_falló', { error: pe.error.message, codigo });
        await alertarOperador('cron.purgar.producto_evento', { error: pe.error.message, codigo });
      } else {
        productoEvento = (pe.data ?? {}) as Record<string, unknown>;
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logger.error('cron.purgar.producto_evento_excepcion', { error });
      await alertarOperador('cron.purgar.producto_evento', { error });
    }

    // ── MCP OAUTH: tokens revocados/expirados, códigos muertos, clientes DCR
    // que nunca completaron un login (auditoría final 2026-08-29, hallazgo 3).
    // RPC HERMANA por la misma razón que producto_evento arriba: esta
    // migración (0265) sale de master sin apilarse sobre otra que redefina
    // `mantenimiento_de_datos`. Su fallo tampoco tumba la corrida —las purgas
    // de arriba ya corrieron—, pero sí se grita y se alerta.
    let mcpOauth: Record<string, unknown> | null = null;
    try {
      const mo = await supabaseAdmin().rpc('mantener_mcp_oauth');
      if (mo.error) {
        const codigo = codigoDeError(mo.error);
        logger.error('cron.purgar.mcp_oauth_falló', { error: mo.error.message, codigo });
        await alertarOperador('cron.purgar.mcp_oauth', { error: mo.error.message, codigo });
      } else {
        mcpOauth = (mo.data ?? {}) as Record<string, unknown>;
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logger.error('cron.purgar.mcp_oauth_excepcion', { error });
      await alertarOperador('cron.purgar.mcp_oauth', { error });
    }

    // 0332 separa la señal de las purgas restantes: si conversación/códigos
    // ya se drenaron fuera de la RPC, no conservamos un `parcial` obsoleto de
    // la última tanda de mantenimiento. En rollout sobre una BD anterior se
    // usa el agregado legado, que es el fallback conservador.
    const parcialGlobal = (otrasPurgasParcial ?? parcial) || retencionParcial;
    const estado = erroresRetencion0104.length > 0 ? 'fallo' : parcialGlobal ? 'parcial' : 'ok';
    const detalleFinal = { ...data, vueltas, retencion0104, erroresRetencion0104, storage, productoEvento, mcpOauth };
    if (estado === 'fallo') logger.error('cron.purgar.retencion_0104_incompleta', detalleFinal);
    else if (estado === 'parcial') logger.warn('cron.purgar.incompleta', detalleFinal);
    else logger.info('cron.purgar.ok', detalleFinal);
    await registrarLatido('purgar', estado, { vueltas, parcial: parcialGlobal, erroresRetencion0104, retencion0104 });
    return NextResponse.json({ corrio: true, ...data, parcial: parcialGlobal, estado, vueltas, retencion0104, erroresRetencion0104, storage, productoEvento, mcpOauth });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // Mismo criterio que el `if (error)` de arriba, para el camino que lanza.
    const codigo = codigoDeError(e);
    logger.error('cron.purgar.falló', { error, codigo });
    await alertarOperador('cron.purgar', { error, codigo });
    await registrarLatido('purgar', 'fallo', { codigo });
    return NextResponse.json({ error }, { status: 500 });
  }
}
