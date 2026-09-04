// ═══════════════════════════════════════════════════════════════════════════
// EL DISPARO POR CÁMARA — la cámara del cliente reporta lo que el chofer
// todavía no puede.
//
// Un evento GRAVE (crash/impacto/volcadura, ver `esEventoGrave`) de las
// cámaras Samsara de la flota abre el MISMO expediente de asistencia que un
// "chocamos" por WhatsApp: incidencia tipo `siniestro` prioridad `critica`,
// bitácora en `incidencia_evento`, 🚨 al jefe con el botón `asi_ok:` — y de
// ahí el escalamiento de la Fase 5 corre igual que siempre.
//
// ── LA VERDAD DEL AVISO ───────────────────────────────────────────────────
// El jefe tiene que saber DOS cosas distintas: que la fuente es la cámara
// (no el chofer), y que el chofer NO ha reportado nada — porque la reacción
// correcta es distinta: aquí el jefe MARCA él, no espera el mensaje. Un
// aviso que no distinga la fuente convertiría una detección automática en
// un "el chofer dijo" que nadie dijo.
//
// ── POR QUÉ NO SE DUPLICA CON EL REPORTE DEL CHOFER ───────────────────────
// El expediente es ÚNICO por chofer (0201): si el chofer YA reportó, el
// evento de cámara se anota en su expediente (evidencia, no un segundo 🚨) —
// y si ese expediente era MENOS grave que un choque (un varado, un bloqueo),
// la detección lo ESCALA en la misma fila y el jefe recibe el 🚨 nuevo, igual
// que el circuito de WhatsApp post-0201 (auditoría Fable ciclo 2, c2-3: antes
// solo se anotaba en la bitácora y una colisión real quedaba muda). Si la
// cámara llega primero y el chofer escribe después, su mensaje cae en
// `atenderConExpedienteAbierto` de asistencia_wa y se reenvía al jefe como
// siempre. Sin operador identificable (unidad sin viaje vigente), el
// expediente se ata a la UNIDAD y el índice parcial de la 0206 (espejo del
// 0201) garantiza UNA incidencia abierta por unidad — la carrera de dos
// labels graves del mismo choque la gana exactamente uno y el perdedor anota.
// ═══════════════════════════════════════════════════════════════════════════
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { acotada } from './presupuesto';
import { crearIncidencia } from './operacion';
import { anotarEventoIncidencia, TIPOS_ASISTENCIA, RANGO_TIPO, type TipoAsistencia } from './asistencia_wa';
import { telefonoJefeDe } from './contactos';
import { encolarBotonesWhatsApp } from '@/lib/meta/client';

export interface EventoCamaraGrave {
  tenantId: string;
  /** La unidad YA mapeada vía gps_device_id. Sin unidad no hay disparo (el
   *  sync la reporta como huérfana). */
  unidadId: string;
  proveedor: string;
  eventoIdExterno: string;
  etiquetas: string[];
  lat: number | null;
  lng: number | null;
  ocurridoEn: string;
  urlEvento: string | null;
  maxG: number | null;
  viajeId: string | null;
  operadorId: string | null;
  viajeFolio: string | null;
  reintento: boolean;
}

export interface ResultadoDisparo {
  resultado: 'abierta' | 'anotada_en_existente' | 'fallo';
  incidenciaId?: string;
  avisoEstado?: 'no_requerido' | 'encolado' | 'enviado' | 'muerto';
  avisoOutboxId?: string;
  avisoReceipt?: string;
}

/**
 * El expediente de asistencia abierto que este evento debe alimentar en vez
 * de duplicar: por OPERADOR si se conoce (la semántica de la 0201), y si no,
 * por UNIDAD — el caso de la unidad sin viaje, donde dos labels graves del
 * mismo choque llegan en la misma corrida.
 */
interface ExpedienteAbierto {
  id: string;
  tipo: string;
  prioridad: string;
}

async function expedienteAbierto(
  tenantId: string, operadorId: string | null, unidadId: string,
): Promise<ExpedienteAbierto | null> {
  const consulta = supabaseAdmin()
    .from('incidencia')
    .select('id, tipo, prioridad')
    .eq('tenant_id', tenantId)
    .in('tipo', [...TIPOS_ASISTENCIA])
    .neq('estado', 'resuelta')
    .order('abierta_en', { ascending: false })
    .limit(1);
  const { data, error } = await acotada(
    operadorId ? consulta.eq('operador_id', operadorId) : consulta.eq('unidad_id', unidadId),
    'asistencia_camara.abierta',
  );
  if (error) throw new Error(`asistencia_camara.abierta: ${error.message}`);
  const f = (data ?? [])[0];
  if (!f) return null;
  return { id: f.id as string, tipo: f.tipo as string, prioridad: f.prioridad as string };
}

/** Rótulo de la unidad para el aviso. Best-effort: es un rótulo. */
async function rotuloUnidad(tenantId: string, unidadId: string): Promise<string> {
  try {
    const { data } = await supabaseAdmin()
      .from('unidad').select('numero_economico, placas')
      .eq('id', unidadId).eq('tenant_id', tenantId).maybeSingle();
    if (data?.numero_economico) {
      return `la unidad ${data.numero_economico}${data.placas ? ` (placas ${data.placas})` : ''}`;
    }
  } catch { /* rótulo, no verdad crítica */ }
  return 'una de tus unidades';
}

function descripcionDelEvento(e: EventoCamaraGrave): string {
  const partes = [
    `Detección automática de la cámara ${e.proveedor} (evento ${e.eventoIdExterno}): ${e.etiquetas.join(', ') || 'evento grave'}.`,
  ];
  if (e.maxG !== null) partes.push(`Fuerza máxima registrada: ${e.maxG.toFixed(1)} G.`);
  if (e.urlEvento) partes.push(`Video en el panel del proveedor: ${e.urlEvento}`);
  partes.push('El chofer NO ha reportado por WhatsApp al momento de esta detección.');
  return partes.join(' ');
}

/**
 * Abre (o alimenta) el expediente de asistencia por un evento grave de
 * cámara. NUNCA lanza: la corrida de sincronización no puede morir por un
 * disparo — el fallo se reporta en el resultado y en el log.
 */
export async function dispararAsistenciaPorEventoCamara(e: EventoCamaraGrave): Promise<ResultadoDisparo> {
  try {
    const operadorId = e.operadorId;

    const abierta = await expedienteAbierto(e.tenantId, operadorId, e.unidadId);
    if (abierta) {
      // El chofer ya reportó (o un evento anterior ya abrió): la detección se
      // suma como EVIDENCIA a su expediente — un segundo 🚨 por el mismo
      // choque entrena al jefe a ignorar el primero.
      await anotarEventoIncidencia(e.tenantId, abierta.id, 'deteccion_camara', {
        proveedor: e.proveedor, evento: e.eventoIdExterno, etiquetas: e.etiquetas,
        lat: e.lat, lng: e.lng, maxG: e.maxG, urlEvento: e.urlEvento,
      });
      // AUDITORÍA FABLE CICLO 2 (c2-3): si el expediente previo era MENOS
      // grave que un choque (el varado de ayer, un bloqueo), la detección lo
      // ESCALA en la misma fila — espejo del circuito WA post-0201. Anotar en
      // silencio convertía una colisión detectada en una nota de bitácora que
      // nadie leía hasta el post-mortem.
      const rangoCamara = RANGO_TIPO.siniestro;
      const rangoAbierto = RANGO_TIPO[abierta.tipo as TipoAsistencia] ?? 0;
      const escala = rangoCamara > rangoAbierto || abierta.prioridad !== 'critica';
      if (escala) {
        const { error: errEsc } = await acotada(supabaseAdmin()
          .from('incidencia')
          .update({
            // El robo (rango 4) no se degrada a siniestro: la violencia manda
            // el protocolo; solo se le sube la prioridad si no era crítica.
            ...(rangoCamara > rangoAbierto ? { tipo: 'siniestro' } : {}),
            prioridad: 'critica',
            // El reconocimiento anterior era del incidente menor: dejarlo
            // puesto le diría a la Fase 5 que la colisión ya está atendida.
            reconocida_en: null,
            reconocida_por: null,
          })
          .eq('id', abierta.id).eq('tenant_id', e.tenantId)
          .neq('estado', 'resuelta'), 'asistencia_camara.escalar');
        if (errEsc) {
          // Sin escalada no hay verdad que sellar: se reporta fallo para que
          // el barrido del poller lo reintente en la siguiente corrida.
          logger.error('asistencia_camara.escalada_fallo', { incidencia: abierta.id, err: errEsc.message });
          return { resultado: 'fallo' };
        }
        await anotarEventoIncidencia(e.tenantId, abierta.id, 'escalada', {
          de: abierta.tipo, a: rangoCamara > rangoAbierto ? 'siniestro' : abierta.tipo, fuente: 'camara', evento: e.eventoIdExterno,
        });
        const aviso = await avisarAlJefePorCamara(e, abierta.id, e.viajeFolio);
        await anotarEventoIncidencia(e.tenantId, abierta.id, aviso ? 'aviso_jefe_encolado' : 'aviso_jefe_fallido', { fuente: 'camara' });
        if (!aviso) return { resultado: 'fallo', incidenciaId: abierta.id };
        logger.info('asistencia_camara.escalada', { incidencia: abierta.id, de: abierta.tipo, evento: e.eventoIdExterno, aviso: aviso.avisoEstado });
        return { resultado: 'anotada_en_existente', incidenciaId: abierta.id, ...aviso };
      }
      if (e.reintento) {
        const aviso = await avisarAlJefePorCamara(e, abierta.id, e.viajeFolio);
        if (!aviso) return { resultado: 'fallo', incidenciaId: abierta.id };
        return { resultado: 'anotada_en_existente', incidenciaId: abierta.id, ...aviso };
      }
      logger.info('asistencia_camara.anotada', { incidencia: abierta.id, evento: e.eventoIdExterno });
      return { resultado: 'anotada_en_existente', incidenciaId: abierta.id, avisoEstado: 'no_requerido' };
    }

    let incidenciaId: string;
    try {
      incidenciaId = await crearIncidencia(e.tenantId, {
        viajeId: e.viajeId,
        unidadId: e.unidadId,
        operadorId,
        tipo: 'siniestro',
        prioridad: 'critica',
        descripcion: descripcionDelEvento(e).slice(0, 500),
        // La cámara NO sabe de lesionados: NULL = no preguntado, jamás false.
        hayLesionados: null,
        lat: e.lat,
        lng: e.lng,
      });
    } catch (err) {
      const msj = err instanceof Error ? err.message : String(err);
      // La carrera contra el reporte del chofer (o contra otro evento grave
      // de la misma corrida): el índice 0201 (por chofer) o el 0206 (por
      // unidad sin chofer) dejan UN ganador. El perdedor anota su detección
      // en el expediente del ganador.
      if (/incidencia_asistencia_abierta_unica|incidencia_asistencia_unidad_unica|duplicate key/i.test(msj)) {
        const ganadora = await expedienteAbierto(e.tenantId, operadorId, e.unidadId);
        if (ganadora) {
          await anotarEventoIncidencia(e.tenantId, ganadora.id, 'deteccion_camara', {
            proveedor: e.proveedor, evento: e.eventoIdExterno, etiquetas: e.etiquetas,
            lat: e.lat, lng: e.lng, maxG: e.maxG, urlEvento: e.urlEvento,
          });
          if (e.reintento) {
            const aviso = await avisarAlJefePorCamara(e, ganadora.id, e.viajeFolio);
            if (!aviso) return { resultado: 'fallo', incidenciaId: ganadora.id };
            return { resultado: 'anotada_en_existente', incidenciaId: ganadora.id, ...aviso };
          }
          return { resultado: 'anotada_en_existente', incidenciaId: ganadora.id, avisoEstado: 'no_requerido' };
        }
      }
      throw err;
    }

    await anotarEventoIncidencia(e.tenantId, incidenciaId, 'abierta_por_camara', {
      proveedor: e.proveedor, evento: e.eventoIdExterno, etiquetas: e.etiquetas,
      lat: e.lat, lng: e.lng, maxG: e.maxG, urlEvento: e.urlEvento, ocurridoEn: e.ocurridoEn,
    });

    const aviso = await avisarAlJefePorCamara(e, incidenciaId, e.viajeFolio);
    await anotarEventoIncidencia(e.tenantId, incidenciaId, aviso ? 'aviso_jefe_encolado' : 'aviso_jefe_fallido', { fuente: 'camara' });
    if (!aviso) return { resultado: 'fallo', incidenciaId };
    logger.info('asistencia_camara.abierta', { incidencia: incidenciaId, evento: e.eventoIdExterno, aviso: aviso.avisoEstado });
    return { resultado: 'abierta', incidenciaId, ...aviso };
  } catch (err) {
    logger.error('asistencia_camara.fallo', {
      tenant: e.tenantId, unidad: e.unidadId, evento: e.eventoIdExterno,
      err: err instanceof Error ? err.message : String(err),
    });
    return { resultado: 'fallo' };
  }
}

/** El 🚨 al jefe, con la fuente dicha con todas sus letras. */
async function avisarAlJefePorCamara(
  e: EventoCamaraGrave, incidenciaId: string, folio: string | null,
): Promise<Pick<ResultadoDisparo, 'avisoEstado' | 'avisoOutboxId' | 'avisoReceipt'> | null> {
  let telefono: string | null = null;
  try {
    telefono = await telefonoJefeDe(e.tenantId);
  } catch (err) {
    logger.error('asistencia_camara.jefe_ilegible', { tenant: e.tenantId, err: err instanceof Error ? err.message : String(err) });
    return null;
  }
  if (!telefono) {
    logger.warn('asistencia_camara.sin_jefe', { tenant: e.tenantId, incidencia: incidenciaId });
    return null;
  }
  const unidad = await rotuloUnidad(e.tenantId, e.unidadId);
  const cuerpo =
    `🚨 La cámara de ${unidad} detectó una POSIBLE COLISIÓN` +
    `${folio ? ` en el viaje ${folio}` : ''} (${e.etiquetas.join(', ') || 'evento grave'}).\n\n` +
    `Tu chofer NO ha reportado nada por aquí todavía — puede que no pueda. ` +
    `MÁRCALE AHORA${e.urlEvento ? `, y el video está en tu panel del proveedor: ${e.urlEvento}` : ''}.` +
    `\n\nAprieta el botón para que sepamos que ya lo estás atendiendo.`;
  const salida = await encolarBotonesWhatsApp(telefono, cuerpo, [
    { id: `asi_ok:${incidenciaId}`, titulo: 'Ya lo atiendo' },
  ], `gps:${e.proveedor}:${e.tenantId}:${e.eventoIdExterno}`);
  if (!salida) return null;
  if (salida.estado === 'dead') return { avisoEstado: 'muerto', avisoOutboxId: salida.id };
  return salida.estado === 'sent'
    ? { avisoEstado: 'enviado', avisoOutboxId: salida.id, avisoReceipt: salida.providerMessageId ?? undefined }
    : { avisoEstado: 'encolado', avisoOutboxId: salida.id };
}
