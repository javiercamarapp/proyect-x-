// ═══════════════════════════════════════════════════════════════════════════
// PIPELINE ENTRANTE — el pegamento del sistema agéntico.
// Mensaje de WhatsApp → (foto? OCR → guarda gasto) → corre el agente → responde
// + manda el PDF si se cerró la liquidación.
// ═══════════════════════════════════════════════════════════════════════════

import { appUrl } from '@/lib/env';
import { randomUUID } from 'crypto';
import type OpenAI from 'openai';
import '@/lib/likida/tools'; // side-effect: registra las tools en el registry
import { runAgent } from '@/lib/agents/run';
import { guardiaCifras } from '@/lib/likida/cuadre/guardia';
import { cuadrarDesdeDB, ventanaDesdeDB } from '@/lib/likida/cuadre/desde_db';
import { fechaDudosa } from '@/lib/likida/cuadre/fecha_dudosa';
import { pipelineTenantApagado } from '@/lib/likida/interruptor_tenant';
import { etiquetaConcepto, copiasDeComprobante } from '@/lib/likida/cuadre/engine';
import { mensajePideFechaOtraVez } from '@/lib/likida/intake/pedir_fecha';
import { resumenCuadre } from '@/lib/likida/cuadre/resumen';
import { PartialExecutionError, isTransientError, esErrorDePresupuesto, type ToolCallRecord } from '@/lib/llm/openrouter';
import type { Gasto } from '@/types/likida';
import { extraerComprobante } from '@/lib/likida/intake/ocr';
import { createLlmBudget } from '@/lib/llm/budget';
import { hashImagen } from '@/lib/likida/intake/hash';
import { subirComprobante } from '@/lib/likida/intake/almacen';
import {
  mensajeGuardadoSinViaje, mensajeGuardadoTrasLiquidar, mensajeOfrecer,
  mensajeAdjuntados, esAfirmacion, esNegacion,
} from '@/lib/likida/intake/huerfanos';
import { decidirFoto } from '@/lib/likida/intake/decidir';
import { marcarMontoDisputado } from '@/lib/likida/gasto_correccion';
import {
  anotarFoto, anotarIncidencia, anotarAcuse, pedirTurnoDeConfirmacion, cerrarRafaga, lineaIncidencias,
  bandejasAbiertas,
} from '@/lib/likida/intake/rafaga';
import { avisoSimplificado, versionAviso, pideAtencionPrivacidad, respuestaPrivacidad } from '@/lib/likida/privacidad';
import { interpretarHito, sellarHito, mensajeHito } from '@/lib/likida/hitos_viaje';
import {
  interpretarMarcaJornada, interpretarConformidadJornada,
  atenderMarcaJornada, atenderConformidadJornada, resumenParaOperador,
} from '@/lib/likida/jornada/wa';
import { asientosDeJornada } from '@/lib/likida/jornada/repo';
import { puedeAsignar } from '@/lib/auth/permisos';
import { atenderDespachoOficina } from '@/lib/likida/despacho_wa';
import { interpretarTalacha, atenderTalachaChofer, atenderAutorizacionTalacha } from '@/lib/likida/talacha_wa';
import { atenderCcpOficina } from '@/lib/likida/carta_porte_wa';
import { interpretarAsistencia, atenderAsistenciaChofer, atenderReconocimientoAsistencia, atenderAsistenciaOficina, anclarUbicacionIncidencia } from '@/lib/likida/asistencia_wa';
import { atenderCoordinacionOficina, atenderMensajeProveedor, atenderMedioProveedorSinTexto } from '@/lib/likida/asistencia_coordinacion';
import { esCaptionPod, guardarPodDelChofer, mensajePod } from '@/lib/likida/pod_wa';
import { atenderInformeOficina } from '@/lib/likida/informes_wa';
import { pideInformePdf, mandarInformePdf, atenderPreguntaLibre, RESPUESTA_OFICINA_SIN_TIEMPO } from '@/lib/likida/oficina_wa';
import { atenderAsignacionOficina } from '@/lib/likida/asignar_wa';
import { violaIndice, llegoTarde } from '@/lib/likida/pg_errores';
import { mxn, fechaMx } from '@/lib/formato';
import { guardiaFundamento, normasDeToolCalls } from '@/lib/likida/normas/fundamento';
import { guardiaEstado } from '@/lib/likida/cuadre/estado_afirmado';
import { crearPresupuesto, PRESUPUESTO_WEBHOOK_MS, MARGEN_CIERRE_CRITICO_MS, acotada, type Presupuesto } from '@/lib/likida/presupuesto';
import { conceptoDesdeClave } from '@/lib/likida/intake/concepto';
import { getConfig } from '@/lib/likida/config';
import { emparejarPendiente, emparejarXmlConTicket } from '@/lib/likida/intake/emparejar';
import { parseCfdiXml, esConsolidado } from '@/lib/likida/intake/cfdi_xml';
import { parseRepXml, ingerirRep, mensajeRepRecibido } from '@/lib/likida/intake/rep';
import { guardarYConciliarConsolidado, mensajeConsolidadoRecibido } from '@/lib/likida/intake/consolidado';
import {
  addGasto, getGastos, updateGastoCfdiXml, saveCfdiXmlRaw, gastoExistePorHash, gastoPorHash, ubicarGastoPorHash, corregirFechaGasto,
  guardarHuerfano, getHuerfanos, resolverHuerfanos, marcarHuerfanosOfrecidos, getViaje,
  enriquecerGastoConCodigo, guardarCodigoPendiente, getCodigosPendientes, reclamarCodigoPendiente,
  getDatosResponsable, reclamarEnvioAviso, confirmarEnvioAviso, liberarEnvioAviso,
  getLiquidacionDeViaje,
  registrarSolicitudArco,
} from '@/lib/likida/repo';
import {
  resolveOperador, getOpenViaje, viajeAbiertoDesdeMs, liquidacionRecienteDe, getTenantContext, type ResolvedOperador,
  sellarEntregaLiquidacion, type LiquidacionReciente,
  loadConversation, saveConversation, claimMessage,
  acquireViajeLock, intentarLockViaje, TTL_LOCK_CIERRE_MS, nuevoTokenDeLock,
  releaseViajeLock, releaseMessageClaim, completarMessageClaim,
  intakeDelta, esperarIntake, fotoAnteriorSinProcesar, ConsultaFallida, OperadorAmbiguo, type ConvTurn,
  buscarTenantPorTelefono,
  iniciarRenovacionMessageClaim,
} from '@/lib/likida/conv';
import { registrarCosto, registrarCostoWhatsApp, faseDeModelo, vincularCostosALiquidacion } from '@/lib/likida/costos';
import { sendText, sendButtons, sendDocument, downloadMediaAsDataUrl, downloadMediaAsText, metadatosMedia, MAX_XML_BYTES, ImagenDemasiadoPesadaError } from '@/lib/meta/client';
import { avisarOficina, parametrosAvisoOficina } from '@/lib/meta/aviso_oficina';
import {
  decidirAcuse, mensajeConfirmar, mensajeAcuse, mensajeRefoto, esPeticionDeFoto,
  mensajeCorregir, mensajeConfirmado, leerBoton, mensajeDemasiadasDudas,
  MAX_CONFIRMACIONES_SEGUIDAS, esMontoImplausible, umbralMontoImplausible,
  type LecturaTicket,
} from './acuse_ticket';
import { estadoDelViaje, responderConsulta } from './consulta_chofer';
import { resolverCuentaOficina, telefonoJefeDe, type CuentaOficina } from './contactos';
import { atenderComandoAdmin } from './admin_comandos_wa';
import { atenderConfirmacion, aceptarPorActividad } from './confirmar_viaje';
import { enviarBriefingInicio } from './briefing_inicio_wa';
import { transcribirNotaDeVoz, RESPUESTA_NO_ENTENDI, RESPUESTA_SIN_PRESUPUESTO } from './voz_transcrita';
import { avisarCierreAlJefe } from './avisar_cierre';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { alertarOperador } from '@/lib/observability/alerta';
import { codigoDeError } from '@/lib/observability/sentry';

export interface InboundMessage {
  from: string;               // teléfono E.164
  type: 'text' | 'image' | 'document' | 'location' | 'audio' | 'other';
  /** El cuerpo del texto — o, en una imagen, su CAPTION (el rótulo que el
   *  chofer escribe al pie de la foto; F4: así se distingue la carta porte
   *  y la nota de talacha de un comprobante cualquiera). */
  text?: string;
  mediaId?: string;           // para image/document
  /**
   * Qué era en realidad un mensaje `other` (`sticker`, `video`, `contacts`,
   * `unsupported`, `list_reply`…). AUDITORÍA 24 · WA-9: sin esto, el chofer
   * que manda un video de la llanta ponchada recibe una lista de formatos que
   * no dice ni una palabra de lo que él mandó. Las reacciones no llegan
   * hasta aquí: el webhook las descarta.
   */
  subtipo?: string;
  /** El pin de WhatsApp (type 'location') — ambas o ninguna (webhook). */
  lat?: number;
  lng?: number;
  waMessageId?: string;       // id de Meta, para idempotencia
  /**
   * Cuándo lo recibió META (epoch en ms), no cuándo lo procesamos (DAT-38).
   *
   * Entre las dos horas caben los reintentos de Meta, el aplazamiento del rate
   * limit y hasta cinco minutos de la bandeja durable. Todo lo que se le
   * ASIENTA AL VIAJE con hora —los hitos «llegué»/«descargando»/«de regreso»—
   * tiene que usar ésta: la otra es la hora de nuestro servidor, y la flota va
   * a cruzar esos sellos contra la bitácora de su cliente.
   *
   * `undefined` cuando el mensaje no viene del webhook (QA, simulador) o
   * cuando Meta mandó un timestamp que no se puede leer: ahí se cae al reloj
   * local, que es el comportamiento de siempre.
   */
  timestampMs?: number;
  /** SOLO lo fija el motor de QA (scripts/qa-agentes/ y /api/admin/qa/*): un
   *  data-URL ya resuelto que SUSTITUYE la descarga real de Meta — el arnés
   *  no tiene un mediaId real de WhatsApp (es el número de prueba; un chofer
   *  externo no puede escribir). `undefined` en TODO mensaje de producción:
   *  el webhook público (api/webhook/whatsapp/route.ts) NUNCA construye este
   *  campo, y `qa-panel.test.ts` vigila con un grep que siga siendo cero.
   *  Cambio aditivo deliberado y acotado — el porqué completo está en
   *  00-PANEL-DE-QA.md §3 (carril rápido): vi.mock cubre al ejército bajo
   *  vitest, pero no existe dentro del runtime de Next/Vercel. */
  mediaDataUrlQA?: string;
}

/** La misma conservación y el mismo acuse para oficina, con y sin viaje. */
async function conservarNotaCredito(tenantId: string, uuid: string, xmlText: string): Promise<string> {
  let guardado = false;
  try {
    guardado = await saveCfdiXmlRaw(tenantId, uuid, null, xmlText);
  } catch (e) {
    logger.warn('xml.nota_credito_no_guardada', { tenant: tenantId, err: e instanceof Error ? e.message : String(e) });
  }
  if (!guardado) return 'Ese XML es una *nota de crédito*, no un gasto. No pude guardar el archivo; reenvíalo para conservarlo. No registré ni concilié sus conceptos como gastos.';
  return 'Ese XML es una *nota de crédito* (comprobante de egreso), no un gasto 🧾. No la registro como deducible — es una devolución o bonificación sobre otra factura. Guardé el archivo; si el gasto original no está registrado, mándame su ticket o su XML de ingreso.';
}

/**
 * La ubicación del chofer (F-Ruta): guarda en `posicion` si el viaje trae
 * unidad y avisa al jefe con el link del mapa. BEST-EFFORT en cada pata por
 * separado: que falle el INSERT no debe callar el aviso al jefe, y viceversa.
 * Nunca lanza — el llamador confirma al chofer pase lo que pase. Devuelve si
 * el JEFE recibió el aviso: la frase «ya se la pasé a tu jefe» solo se dice
 * cuando es verdad (AGEN-5 / WA-4).
 */
async function registrarUbicacionChofer(op: ResolvedOperador, viajeId: string, lat: number, lng: number): Promise<boolean> {
  const admin = supabaseAdmin();
  try {
    const { data: viaje, error } = await admin.from('viaje')
      .select('unidad_id, origen, destino').eq('id', viajeId).eq('tenant_id', op.tenantId).maybeSingle();
    if (error) throw new Error(error.message);
    if (viaje?.unidad_id) {
      const { error: eIns } = await admin.from('posicion').insert({
        tenant_id: op.tenantId, unidad_id: viaje.unidad_id, lat, lng,
        // El pin de WhatsApp se mide al mandarlo — no hay lote que reordenar.
        medida_en: new Date().toISOString(), proveedor: 'whatsapp',
      });
      if (eIns) throw new Error(eIns.message);
    } else {
      // Sin unidad no hay dónde colgarla (la tabla la exige) — se dice en el
      // log, no se inventa una unidad ni se calla el aviso al jefe.
      logger.warn('ubicacion.sin_unidad', { viaje: viajeId });
    }
  } catch (e) {
    logger.error('ubicacion.insert', { viaje: viajeId, err: e instanceof Error ? e.message : String(e) });
  }
  return avisarUbicacionAlJefe(op, `https://maps.google.com/?q=${lat},${lng}`, 'compartió su ubicación en ruta', { viaje: viajeId });
}

/**
 * El link del mapa al jefe, por texto y —fuera de la ventana de 24 h— por
 * plantilla (`avisarOficina`, AGEN-5 / WA-4). El jefe de una flota grande
 * RECIBE y no escribe: `sendText` le rebotaba con 131047 en silencio y al
 * chofer varado a las 02:00 se le afirmaba «ya se la pasé». Nunca lanza;
 * `false` = el jefe NO lo recibió, y el llamador lo dice así.
 */
async function avisarUbicacionAlJefe(op: ResolvedOperador, mapa: string, motivo: string, contexto: Record<string, unknown>): Promise<boolean> {
  try {
    const jefe = await telefonoJefeDe(op.tenantId);
    if (!jefe) {
      logger.warn('ubicacion.sin_jefe', { tenant: op.tenantId, ...contexto });
      return false;
    }
    const r = await avisarOficina(jefe, `📍 ${op.nombre} ${motivo}.\n${mapa}`, {
      parametros: parametrosAvisoOficina(op.nombre, motivo, mapa),
      contexto: { tenant: op.tenantId, ...contexto },
    });
    if (!r.ok) logger.error('ubicacion.aviso_jefe', { tenant: op.tenantId, ...contexto, motivo: r.motivo, codigo: r.codigo });
    return r.ok;
  } catch (e) {
    logger.error('ubicacion.aviso_jefe', { ...contexto, err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/**
 * Cierra el protocolo de dos fotos por el lado contrario: acaba de entrar un
 * comprobante, y en la bandeja puede haber un acercamiento que llegó antes y
 * estaba esperando por ese total.
 *
 * BEST-EFFORT a propósito: el gasto YA está insertado. Si la bandeja falla, se
 * pierde el folio exacto —malo— pero tumbar aquí perdería el gasto entero, que
 * es peor, y encima dispararía el reproceso del webhook.
 */
async function pegarCodigoEnEspera(tenantId: string, viajeId: string, gasto: Gasto): Promise<void> {
  try {
    const extra = (gasto.ocrExtra ?? {}) as Record<string, unknown>;
    // Si esta misma foto ya traía su código no hay nada que buscar. Además
    // ahorra la consulta en el camino de siempre.
    if (extra.folioPortal || extra.codigoBarras) return;
    const bandeja = await getCodigosPendientes(viajeId, tenantId);
    if (!bandeja.length) return;
    const cod = emparejarPendiente(gasto.monto, bandeja);
    if (!cod) return;
    // Claim atómico: las fotos de una ráfaga corren en paralelo y NO toman el
    // mutex del viaje, así que dos comprobantes del mismo total pueden ir por el
    // mismo código a la vez. El que pierde no pega nada.
    if (!(await reclamarCodigoPendiente(tenantId, cod.id))) {
      logger.info('foto.pendiente_ya_tomado', { viaje: viajeId, gasto: gasto.id });
      return;
    }
    const pegado = await enriquecerGastoConCodigo(tenantId, gasto, {
      folioPortal: cod.folioPortal,
      codigoBarras: cod.codigoBarras,
      urlFacturacion: cod.urlFacturacion,
      cfdiUuid: cod.cfdiUuid,
    });
    if (!pegado) {
      // El código pendiente YA quedó reclamado y el gasto resultó tener folio: en
      // el hueco entre la lectura de arriba y este UPDATE, otra foto de la misma
      // ráfaga se lo puso. El folio de este código se pierde, y ese folio es el
      // que la oficina teclea en el portal — por eso es ERROR, no info.
      logger.error('foto.pendiente_reclamado_sin_pegar', { viaje: viajeId, gasto: gasto.id, codigo: cod.id });
      return;
    }
    logger.info('foto.pendiente_pegado', { viaje: viajeId, gasto: gasto.id });
  } catch (e) {
    // AUDITORÍA 9, ALTO operabilidad: `tenantId`/`viajeId`/`gasto.id` están en
    // scope y las tres líneas vecinas los usan — solo este catch los omitía.
    // Sentry agrupa por `msg`, así que sin ellos un fallo aquí ("fetch failed")
    // no se puede cruzar contra la base para saber a qué viaje o tenant
    // pertenece. (El otro mecanismo que compartía este mismo nombre de log,
    // `foto_pendiente`/mig. 0038, se revirtió esta ronda; ya no hay colisión
    // de dos mecanismos distintos bajo un mismo `msg`, pero la falta de
    // contexto en ESTE sitio seguía siendo real por su cuenta.)
    logger.warn('foto.pendiente_error', { viaje: viajeId, tenant: tenantId, gasto: gasto.id, err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Pone el aviso simplificado a disposición del operador la primera vez que
 * manda algo — y otra vez si la flota cambió su aviso (art. 15 fr. VI).
 *
 * No lanza: un fallo aquí NO puede tumbar la liquidación del operador. Pero se
 * registra como ERROR y no como warn, porque el silencio deja a la flota sin
 * poder cumplir y sin enterarse.
 */
/**
 * Atiende el ejercicio del medio ARCO. Se llama ANTES del corte por "sin viaje
 * abierto": el derecho no depende de que la flota le haya asignado uno.
 *
 * Nunca lanza: dejar sin respuesta a quien ejerce un derecho es peor que
 * cualquier fallo que se pueda registrar.
 */
async function atenderPrivacidad(tenantId: string, operadorId: string | null, telefono: string, texto: string): Promise<void> {
  try {
    // ── LA CONSTANCIA SE DEJA SIEMPRE, antes de decidir qué contestar ──────
    // AUDITORÍA 12, ALTO (legal): el aviso promete "queda registrada tu
    // solicitud" y antes NO se registraba nada — `solicitud_arco` (0053)
    // existía sin un solo insert y la flota (la responsable, 15 días hábiles
    // para contestar, LFPDPPP art. 31) no tenía constancia que atender. El
    // tipo se clasifica del texto; la flota decide la calificación exacta.
    //
    // AUDITORÍA 18, ALTO (A10): el registro vivía DENTRO del `if (datos)`
    // que existía para decidir el TEXTO de la respuesta. Sin razón social o
    // domicilio de la flota, el titular recibía "déjame checarlo" y no se
    // insertaba nada: el plazo del art. 31 nunca empezaba a correr y la
    // solicitud no aparecía en /dashboard/arco ni en la guardia.
    // `registrarSolicitudArco` no necesita los datos del responsable — el
    // acoplamiento era accidental. En su propio try: un fallo al registrar
    // no puede dejar al titular sin respuesta, pero sí queda gritado.
    const { tipoDeSolicitudArco } = await import('@/lib/likida/privacidad');
    const tipo = tipoDeSolicitudArco(texto);
    let registrada = false;
    try {
      await registrarSolicitudArco({
        tenantId,
        operadorId,
        titularRef: telefono,
        tipo,
        canal: 'whatsapp',
      });
      registrada = true;
    } catch (e) {
      logger.error('arco.solicitud_no_registrada', { tenantId, tipo, err: e instanceof Error ? e.message : String(e) });
    }

    const datos = await getDatosResponsable(tenantId);
    if (datos) {
      await sendText(telefono, respuestaPrivacidad(datos));
      // ── E1 (auditoría 4): la oposición ENCIENDE algo, no solo se archiva ──
      // Hasta hoy, oponerse insertaba la fila de arriba y no ocurría nada más:
      // el aviso prometía "que la revise alguien" y el pipeline seguía
      // decidiendo solo. La bandera (mig. 0100) es lo que el motor de cuadre
      // lee para mandar toda liquidación suya a revisión humana. Solo se
      // escribe si estaba en NULL: la PRIMERA fecha de ejercicio es la que
      // demuestra desde cuándo se honra.
      if (tipo === 'oposicion' && operadorId) {
        const { error } = await supabaseAdmin().from('operador')
          .update({ oposicion_automatizada: new Date().toISOString() })
          .eq('id', operadorId).eq('tenant_id', tenantId)
          .is('oposicion_automatizada', null);
        if (error) {
          // Ruidoso: la solicitud quedó registrada pero el derecho NO quedó
          // operativo — es exactamente lo que alguien tiene que arreglar mañana.
          logger.error('arco.oposicion_no_encendida', { tenantId, operadorId, err: error.message });
        } else {
          await sendText(telefono, 'Además, desde ahora tus liquidaciones las revisa una persona antes de cerrarse. Queda registrado. 👍');
        }
      }
      return;
    }
    // Sin datos del responsable no se puede decir a quién reclamarle. Se le dice
    // la verdad en vez de dejarlo sin respuesta — y la solicitud YA quedó
    // registrada arriba (A10), así que "te confirmo" tiene algo que lo sostenga.
    logger.error('privacidad.solicitud_sin_datos_responsable', { tenantId, tipo, registrada });
    await sendText(telefono, registrada
      ? 'Tu solicitud quedó registrada. Déjame checar con la empresa los datos del responsable y te confirmo por aquí. 🙏'
      : 'Déjame checarlo con la empresa y te confirmo por aquí. 🙏');
  } catch (e) {
    logger.error('privacidad.solicitud_error', { tenantId, err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Devuelve `false` cuando el aviso NO se pudo poner a disposición.
 *
 * Devolvía `void`, y el llamador seguía adelante pasara lo que pasara: sin razón
 * social o domicilio de la flota, esta función registraba el error, retornaba de
 * SÍ MISMA, y el procesamiento continuaba — la foto del operador se descargaba y
 * se mandaba a un modelo externo igual. Eso es una transferencia de datos
 * personales sin el aviso que la ampare, y es el único supuesto que el art. 8 de
 * la LFPDPPP no admite en ninguna lectura.
 *
 * El obligado es la flota, no Likida; pero quien ejecuta el tratamiento es este
 * código, y no puede ejecutarlo a ciegas.
 */
// Se exporta para poder probarla: es la función que decide si HAY tratamiento,
// y su rama de fallo —liberar la constancia cuando Meta no entregó— no la
// ejecutaba ninguna prueba (auditoría 6, rubro pruebas). Llegar a ella por
// `processInbound` exige montar la cadena entera, y entonces lo que se mide es
// la cadena, no esta decisión.
/**
 * CUATRO desenlaces, no dos, y la diferencia se le dice al operador.
 *
 * Devolvía un booleano, y el llamador traducía TODO el `false` a «tu empresa
 * aún no ha terminado de configurar su aviso de privacidad». Pero `sendText`
 * SÍ lanza ante un fallo de red o un timeout —lleva `AbortSignal.timeout` y no
 * tiene try/catch— y ese throw caía en el catch de aquí abajo, que devolvía
 * `false` igual. O sea: un blip de red de tres segundos se le presentaba al
 * chofer como un error administrativo de su patrón, con la foto descartada y
 * el mensaje marcado como procesado. Le echaba la culpa a su jefe de un
 * problema nuestro, y encima le quitaba el comprobante.
 *
 *   · `puesto`        → se puede tratar (se mandó ahora o ya se había mandado).
 *   · `sin_datos`     → la flota no terminó su alta. ES administrativo, y es lo
 *                       único que justifica mandar al operador con su patrón.
 *   · `no_entregado`  → Meta rechazó el envío (destinatario fuera de lista…).
 *   · `error`         → red, timeout o base. Transitorio: se reintenta.
 */
export type ResultadoAviso = 'puesto' | 'sin_datos' | 'no_entregado' | 'error';

export async function ponerAvisoADisposicion(
  tenantId: string,
  operadorId: string,
  telefono: string,
): Promise<ResultadoAviso> {
  try {
    const datos = await getDatosResponsable(tenantId);
    if (!datos) {
      // El tenant no tiene razón social, domicilio o liga del aviso integral.
      // NO se manda un aviso a medias: uno con el responsable equivocado —o sin
      // él— no dice a quién reclamarle, que es justo para lo que sirve.
      logger.error('privacidad.tenant_sin_datos_responsable', { tenantId });
      return 'sin_datos';
    }
    const texto = avisoSimplificado(datos);
    if (!texto) return 'sin_datos';
    // El claim vive en SQL: el primer mensaje puede llegar por dos caminos a la
    // vez, y sin él el operador recibiría el aviso dos o tres veces seguidas.
    // Ya se le puso a disposición antes: se puede tratar, y no se repite.
    if (!(await reclamarEnvioAviso(tenantId, operadorId, versionAviso(texto)))) return 'puesto';
    // La reserva va ANTES de enviar (si no, el aviso sale dos o tres veces), pero
    // la CONSTANCIA solo vale si el mensaje salió de verdad. `sendText` devolvía
    // `void` y no lanza al fallar, así que la fila se escribía igual: el 28-jul la
    // base afirmó que un operador recibió su aviso diez minutos ANTES del commit
    // que arregló el destinatario que Meta rechazaba. Ante la autoridad esa fila
    // es la prueba del art. 16; una prueba falsa es peor que ninguna.
    const id = await sendText(telefono, texto);
    if (!id) {
      logger.error('privacidad.aviso_no_entregado', { tenantId, operadorId });
      await liberarEnvioAviso(tenantId, operadorId);   // que el siguiente mensaje reintente
      return 'no_entregado';
    }
    // LA CONSTANCIA VA AQUÍ, y no antes. Hasta la 0033 la escribía la reserva, y
    // por eso deshacerla borraba la prueba de un aviso ANTERIOR que sí se había
    // entregado: si el texto de la flota cambia y el reenvío falla, la base
    // pasaba a decir que el operador nunca recibió ninguno.
    await confirmarEnvioAviso(tenantId, operadorId, versionAviso(texto));
    logger.info('privacidad.aviso_enviado', { tenantId, operadorId, id });
    return 'puesto';
  } catch (e) {
    // Si la 0018 no está aplicada, las columnas no existen y esto truena. Y por
    // aquí sale también el throw de `sendText` ante red o timeout: es un fallo
    // NUESTRO y transitorio, no la flota sin dar de alta su aviso.
    logger.error('privacidad.aviso_error', { tenantId, operadorId, err: e instanceof Error ? e.message : String(e) });
    return 'error';
  }
}

/**
 * Deja constancia EN LA CONVERSACIÓN de que se le pidió otra foto.
 *
 * ── POR QUÉ HACE FALTA ───────────────────────────────────────────────────
 *
 * `acuse_ticket.ts` declara como su razón de existir que "una repetición
 * siempre lleva respuesta": si se le pidió otra foto, la segunda se le contesta
 * aunque salga perfecta, porque callar tras un "mándame otra" se lee como
 * "volvió a fallar" y manda una tercera. Esa regla se implementa mirando si el
 * ÚLTIMO turno nuestro fue una petición de foto (`esPeticionDeFoto`).
 *
 * Pero el camino de la foto salía siempre con `say(...); return;` y nunca
 * llegaba al único `saveConversation` del archivo (el del cierre del agente),
 * así que la petición no entraba al historial: `esRepeticion` era `false`
 * SIEMPRE y la rama `if (l.esRepeticion) return { peldano: 'confirmar' }` de
 * `decidirAcuse` era código muerto. La foto que se pidió recibía silencio.
 *
 * ── POR QUÉ SOLO ESTA Y NO TODO EL CAMINO DE LA FOTO ─────────────────────
 *
 * Las fotos NO toman el mutex del viaje (corren en paralelo a propósito), así
 * que cada escritura de esta fila es un "el último gana" contra las demás. Se
 * escribe únicamente lo que un turno POSTERIOR necesita poder ver, que es
 * exactamente esta petición: el acuse con botones se contesta por el botón, no
 * por el historial. Y la ventana de carrera es angosta —esto ocurre antes del
 * `-1` del contador de intake, así que la barrera del "listo" no abre hasta que
 * esta escritura terminó.
 *
 * Best-effort: el gasto YA está guardado. Perder la constancia cuesta un acuse,
 * tumbar aquí costaría el reproceso del webhook y con él la llamada de visión.
 */
async function recordarPeticionDeFoto(
  tenantId: string, telefono: string, viajeId: string, texto: string,
): Promise<void> {
  try {
    const conv = await loadConversation(tenantId, telefono, viajeId);
    await saveConversation(
      conv.id,
      [...conv.turns, { role: 'assistant', content: texto }],
      viajeId,
      { intentosConfirmacion: conv.intentosConfirmacion, cierreSinComprobantes: conv.cierreSinComprobantes },
    );
  } catch (e) {
    logger.warn('foto.refoto_no_recordada', { viaje: viajeId, err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * ¿Este texto parece un "ya acabé"?
 *
 * Vive aquí arriba porque lo usan DOS decisiones: apartarse del ofrecimiento de
 * huérfanos y el freno del cierre sin comprobantes. Dos copias de esta condición
 * se separan en silencio.
 *
 * Cubre las conjugaciones que de verdad escribe un chofer: "terminé", "termine",
 * "termino", "terminó", y lo mismo con "acabar". La frontera es `(?!\p{L})` con
 * bandera `u`, NO `\b`: en JavaScript `\b` se calcula con [A-Za-z0-9_], así que
 * una "é" NO cuenta como letra y "terminé" —la forma correcta y la más
 * escrita— nunca casaba. La lista vieja pedía además la e final, dejando fuera
 * "termino ruta", que es de las más comunes.
 *
 * EL "YA" PELÓN NO CUENTA (AUD3 AG-A1). "ya" solo es cierre acompañado de su
 * forma fuerte: "ya está", "ya quedó", "ya terminé/acabé", "ya no tengo más".
 * La lista vieja empataba `ya` seguido de CUALQUIER cosa — la frontera
 * `(?!\p{L})` corta la palabra, no la frase—, y un chofer con 8 tickets que
 * contestaba "ya voy" al mensaje de cobranza se leía como orden de cerrar, con
 * cierre IRREVERSIBLE (triggers 0036/0037): tickets del regreso a huérfanos y
 * PDF con una diferencia en contra que no es la del viaje. El `(ya\s+)?`
 * opcional conserva "ya terminé"/"ya acabé", que antes entraban por el `ya`
 * pelón; "ya no tengo más" se lista explícito por lo mismo — quitarle el `ya`
 * pelón al regex no puede costarle sus formas fuertes al freno.
 */
function pareceCierre(texto: string): boolean {
  return /^\s*(listo|ya est[aá]|ya qued[óo]|ya no tengo m[áa]s|(ya\s+)?termin[éeoó]|(ya\s+)?acab[éeoó]|cierra|cerrar|eso es todo|es todo)(?!\p{L})/iu.test(texto);
}

/**
 * ¿EL OPERADOR PIDIÓ CERRAR EN ESTE TURNO? (DAT-22)
 *
 * `guardar_liquidacion` estaba disponible en TODOS los turnos del agente, y es
 * la única acción irreversible del sistema: los triggers 0036/0037 bloquean
 * después cualquier alta o corrección sobre ese viaje. El único freno era el
 * del cierre EN CEROS, o sea que un viaje con comprobantes se podía cerrar en
 * el turno de un "¿cuánto llevo?" —bastaba que el modelo se adelantara— y el
 * operador se quedaba sin poder mandar el resto de su fajo.
 *
 * ── POR QUÉ ES MÁS ANCHO QUE `pareceCierre` ─────────────────────────────────
 *
 * `pareceCierre` es el freno del cierre en ceros y es ESTRECHO a propósito: se
 * equivoca hacia no frenar. Éste decide si la tool existe, y equivocarse aquí
 * hacia el "no" le impide cerrar a quien sí lo pidió con otras palabras
 * ("mándame mi liquidación", "no traigo más tickets") — un chofer atrapado en
 * un viaje que no puede cerrar. Por eso cubre las formas largas además de las
 * del freno.
 *
 * Lo que SÍ deja fuera es todo lo demás: una consulta, un saludo, el caption de
 * una foto, un hito. Que es exactamente el turno en el que el modelo no tiene
 * ningún derecho a cerrar.
 *
 * El prompt del agente ya trabaja así ("CIERRA en ese turno... NO le pidas que
 * vuelva a confirmar"), así que esto no parte ningún flujo de dos turnos.
 */
export function pidioCerrar(texto: string | undefined): boolean {
  if (typeof texto !== 'string' || !texto.trim()) return false;
  if (pareceCierre(texto)) return true;
  return /liquidaci[óo]n|liquid[ae]|ci[ée]rr|cerrar|cerramos|cu[áa]dra|cuadrar|finaliz|termin[éeoó]|acab[éeoó]|ya estuvo|ya fue|(no|sin)\s+(traigo|tengo|me\s+falta|falta)\s*(m[áa]s|nada|otro|ninguno)?|[úu]ltimo\s+(ticket|comprobante|recibo)|es\s+todo/iu.test(texto);
}

/**
 * Los mandos de OFICINA que caben en un texto: talacha, despacho, asignación,
 * informe (PDF o texto) y —solo cuando se pide— la pregunta libre al analista.
 *
 * VIVE APARTE PORQUE SE LLAMA DOS VECES, y esa es toda la razón de existir.
 * Hasta aquí este bloque estaba DENTRO de `if (!op)`, así que un número dado de
 * alta como operador no lo alcanzaba nunca: `resolveOperador` acierta primero y
 * el camino de oficina ni se prueba. En una flota chica donde el dueño maneja
 * —el caso que `contactos.ts` documenta como NORMAL, y para el que devuelve a
 * propósito las dos caras— eso significaba que el dueño podía mandar tickets y
 * no podía preguntar «¿cómo van?»: su propio número se lo impedía. El comentario
 * de `contactos.ts` prometía "quien llama decide con su contexto"; aquí nadie
 * decidía, porque aquí no se preguntaba.
 *
 * ── POR QUÉ EL ANALISTA VA DETRÁS DE UN INTERRUPTOR ─────────────────────────
 *
 * Los demás reconocedores devuelven `null` ante un texto que no es suyo: cada
 * módulo trae su propio criterio y se aparta solo. El analista NO — contesta
 * cualquier cosa. Puesto delante del camino del chofer se comería «ya llegué»,
 * «listo» y cada acuse de ruta, que son justo los textos con los que se cierra
 * un viaje. Por eso desde el camino del chofer entra en `false`: ahí el texto
 * que nadie de oficina reclamó le pertenece al chofer.
 *
 * Devuelve `true` si YA contestó y no queda nada que hacer con este mensaje.
 */
async function atenderTextoOficina(
  cuenta: CuentaOficina,
  from: string,
  texto: string,
  opciones: { incluirPreguntaLibre: boolean; incluirDespacho: boolean; reloj?: Presupuesto },
): Promise<boolean | 'reintentar'> {
  // La ASISTENCIA va antes que todo (0198, punto D del plano): el botón
  // `asi_ok:<uuid>` del 🚨 responde a una pregunta nuestra, y un ROJO escrito
  // por el dueño ("chocamos") no puede caer al analista como si fuera una
  // pregunta de negocio. El tenant sale del LOOKUP, jamás del texto.
  try {
    const rReconoce = await atenderReconocimientoAsistencia(
      { tenantId: cuenta.tenantId, rol: cuenta.rol, userId: cuenta.userId }, texto,
    );
    if (rReconoce) {
      logger.info('oficina.asistencia_reconocida', { user: cuenta.userId, rol: cuenta.rol });
      await sendText(from, rReconoce);
      return true;
    }
    const emergenciaOficina = interpretarAsistencia(texto);
    if (emergenciaOficina?.nivel === 'rojo') {
      const rOficina = await atenderAsistenciaOficina(
        { tenantId: cuenta.tenantId, rol: cuenta.rol, userId: cuenta.userId }, texto, emergenciaOficina,
      );
      if (rOficina) {
        logger.info('oficina.asistencia_rojo', { user: cuenta.userId });
        await sendText(from, rOficina);
        return true;
      }
    }
  } catch (e) {
    logger.error('oficina.asistencia_error', { user: cuenta.userId, err: e instanceof Error ? e.message : String(e) });
  }

  // La talacha va DESPUÉS de la asistencia y antes del resto: el botón
  // `tal_si:<uuid>` responde a una pregunta concreta que le mandamos, y con un
  // viaje pendiente de despacho ese módulo se quedaría con todo lo que no sea
  // sí/no — un id crudo de botón acabaría en el resumen del viaje.
  try {
    const rTalacha = await atenderAutorizacionTalacha(
      { tenantId: cuenta.tenantId, rol: cuenta.rol, userId: cuenta.userId }, texto,
    );
    if (rTalacha) {
      logger.info('oficina.talacha_decision', { user: cuenta.userId, rol: cuenta.rol });
      await sendText(from, rTalacha);
      return true;
    }
  } catch (e) {
    logger.error('oficina.talacha_error', { user: cuenta.userId, err: e instanceof Error ? e.message : String(e) });
  }

  // La CARTA PORTE va aquí por la misma razón que la talacha: el botón
  // `ccp_si:<uuid>` y el comando «radio F-123 25» responden a una pregunta
  // concreta que le mandamos al jefe al despachar — con despacho activo, ese
  // texto acabaría en el intérprete de viajes como si fuera una orden nueva.
  try {
    const rCcp = await atenderCcpOficina(
      { tenantId: cuenta.tenantId, rol: cuenta.rol, userId: cuenta.userId }, texto,
    );
    if (rCcp) {
      logger.info('oficina.ccp_declaracion', { user: cuenta.userId, rol: cuenta.rol });
      await sendText(from, rCcp);
      return true;
    }
  } catch (e) {
    logger.error('oficina.ccp_error', { user: cuenta.userId, err: e instanceof Error ? e.message : String(e) });
  }

  // La COORDINACIÓN con proveedores (Capa D, 0213) va junto a sus hermanos de
  // botón: `coo_ir:`/`coo_si:`/`coo_no:` responden a avisos concretos que
  // mandamos, y «contactar» es un mandato cerrado — con un despacho activo,
  // cualquiera de ellos acabaría en el intérprete de viajes como si fuera una
  // orden nueva.
  try {
    const rCoo = await atenderCoordinacionOficina(
      { tenantId: cuenta.tenantId, rol: cuenta.rol, userId: cuenta.userId }, texto,
    );
    if (rCoo) {
      logger.info('oficina.coordinacion', { user: cuenta.userId, rol: cuenta.rol });
      await sendText(from, rCoo);
      return true;
    }
  } catch (e) {
    logger.error('oficina.coordinacion_error', { user: cuenta.userId, err: e instanceof Error ? e.message : String(e) });
  }

  // ── COMANDOS DE ADMINISTRACIÓN DE PLATAFORMA (admin_comandos_wa.ts) ──────
  // "aprobar <id>", "correr <rutina>", "estatus[.rutina]" — la consola de
  // Javier (/admin/aprobaciones, /admin/tu-turno) operada por WhatsApp. Va
  // ANTES del corte de `!cuenta.tenantId`: el superadmin no tiene flota y es
  // justo el único rol que estos comandos aceptan — cortar aquí antes de
  // probarlos los dejaría sin dueño posible. Un flota_admin que los escribe
  // SÍ entra a la función (su teléfono es de oficina) y recibe la negación
  // explícita de rol, no un silencio ni un "no te entendí".
  try {
    const rAdmin = await atenderComandoAdmin(cuenta, from, texto);
    if (rAdmin !== null) {
      logger.info('oficina.comando_admin', { user: cuenta.userId, rol: cuenta.rol });
      await sendText(from, rAdmin);
      return true;
    }
  } catch (e) {
    logger.error('oficina.comando_admin_error', { user: cuenta.userId, err: e instanceof Error ? e.message : String(e) });
  }

  // Sin flota no hay nada que despachar ni sobre qué informar. Es el caso del
  // superadmin, que no pertenece a ninguna.
  if (!cuenta.tenantId) return false;

  // ── DESPACHO Y ASIGNACIÓN: SOLO SIN VIAJE ABIERTO ────────────────────────
  //
  // AUDITORÍA 1, CRÍTICO (Agéntico): estos dos son los ÚNICOS que crean un
  // `pendiente` en `wa_conversacion` y confirman con un "sí". Y `esAfirmacion`
  // (huerfanos.ts) cuenta como "sí" a «va», «vale», «sale», «dale», «ok». Para
  // el dueño-que-maneja —chofer Y oficina, el caso que `contactos.ts` documenta
  // como normal— eso era una trampa doble: con un despacho pendiente vivo, su
  // «listo» de cierre se lo comía el recordatorio ("tengo un viaje esperando
  // confirmación") y su «va» soltaba un viaje con anticipo real que nadie quiso
  // confirmar en ese momento. Además `guardarPendiente` reemplazaba el `estado`
  // entero de su fila, borrando los `turns` del chofer.
  //
  // El desempate es el mismo que `contactos.ts` ya nombra y que este archivo
  // respeta para el analista: CON VIAJE ABIERTO, ES CHOFER. Un dueño despacha
  // cuando NO trae viaje propio abierto; mientras maneja, su texto suelto es de
  // ruta. `incluirDespacho` es `false` en ese caso. El informe ("¿cómo van?")
  // y la talacha (por botón) SÍ siguen — son de solo-lectura o de un id
  // concreto, no consumen un "sí" ambiguo.
  if (opciones.incluirDespacho) {
    // "nuevo viaje para Juan Pérez, Puebla a Monterrey, anticipo 8000" → resumen
    // → SÍ/NO → crearViaje (que ya avisa al chofer solo). El rol se re-verifica
    // ADENTRO (`puedeAsignar`); un error aquí NO deja al jefe sin respuesta.
    try {
      const rDespacho = await atenderDespachoOficina(
        { tenantId: cuenta.tenantId, rol: cuenta.rol }, from, texto,
      );
      if (rDespacho) {
        logger.info('oficina.despacho', { user: cuenta.userId, rol: cuenta.rol });
        await sendText(from, rDespacho);
        return true;
      }
    } catch (e) {
      logger.error('oficina.despacho_error', { user: cuenta.userId, err: e instanceof Error ? e.message : String(e) });
    }

    // ── ASIGNAR UNIDAD / REASIGNAR CHOFER (F4, asignar_wa.ts) ───────────────
    // Va DESPUÉS de despacho: si hay un viaje esperando confirmación, ese "sí"
    // es del viaje (ver el encabezado de `asignar_wa.ts` sobre el pendiente único).
    try {
      const rAsignacion = await atenderAsignacionOficina(
        { tenantId: cuenta.tenantId, rol: cuenta.rol }, from, texto,
      );
      if (rAsignacion) {
        logger.info('oficina.asignacion', { user: cuenta.userId, rol: cuenta.rol });
        await sendText(from, rAsignacion);
        return true;
      }
    } catch (e) {
      logger.error('oficina.asignacion_error', { user: cuenta.userId, err: e instanceof Error ? e.message : String(e) });
    }
  }

  // ── "MÁNDAME EL INFORME EN PDF" ──────────────────────────────────────────
  // Más específico que el informe de texto, así que va ANTES. Un fallo se
  // CONTESTA: silencio tras una petición es la peor respuesta.
  if (pideInformePdf(texto)) {
    try {
      const acuse = await mandarInformePdf(
        { tenantId: cuenta.tenantId, rol: cuenta.rol, userId: cuenta.userId, nombre: cuenta.nombre }, from,
      );
      logger.info('oficina.informe_pdf', { user: cuenta.userId, rol: cuenta.rol });
      await sendText(from, acuse);
    } catch (e) {
      logger.error('oficina.informe_pdf_error', { user: cuenta.userId, err: e instanceof Error ? e.message : String(e) });
      await sendText(from, 'No pude armar tu informe en PDF ahorita. Pregúntame «¿cómo van?» y te paso las cifras en texto, o inténtalo de nuevo en unos minutos. 🙏');
    }
    return true;
  }

  // ── "¿CÓMO VAN?" — EL INFORME CON CIFRAS REALES (F4, informes_wa) ─────────
  // Consulta estructurada y plantilla, SIN modelo. El dinero solo sale para el
  // rol que lo ve en el panel (`visibilidad.ts`); si una consulta falla, el
  // informe DICE que no pudo leer, nunca un cero que parezca medición.
  try {
    const rInforme = await atenderInformeOficina(
      { tenantId: cuenta.tenantId, rol: cuenta.rol }, texto,
    );
    if (rInforme) {
      logger.info('oficina.informe', { user: cuenta.userId, rol: cuenta.rol });
      await sendText(from, rInforme);
      return true;
    }
  } catch (e) {
    logger.error('oficina.informe_error', { user: cuenta.userId, err: e instanceof Error ? e.message : String(e) });
  }

  // ── LA PREGUNTA LIBRE → EL ANALISTA (oficina_wa) ──────────────────────────
  // `null` = rol sin analista (encargado) — el llamador sigue a lo suyo.
  if (opciones.incluirPreguntaLibre) {
    const rLibre = await atenderPreguntaLibre(
      { tenantId: cuenta.tenantId, rol: cuenta.rol, userId: cuenta.userId, nombre: cuenta.nombre }, texto,
      { reloj: opciones.reloj },
    );
    // REN-A2: no cupo en lo que queda de la invocación. Se le dice y se pide
    // al llamador que suelte el claim: la bandeja durable lo trae de vuelta
    // en otra invocación, con reloj entero. Hasta aquí ningún reconocedor
    // escribió nada, así que reprocesar el texto es seguro.
    if (rLibre === RESPUESTA_OFICINA_SIN_TIEMPO) {
      await sendText(from, rLibre);
      return 'reintentar';
    }
    if (rLibre) {
      logger.info('oficina.pregunta_libre', { user: cuenta.userId, rol: cuenta.rol });
      await sendText(from, rLibre);
      return true;
    }
  }

  return false;
}

/**
 * Lo que el llamador necesita saber para decidir qué hacer con la fila durable
 * (`wa_evento_pendiente`, 0119) de este mensaje:
 *
 *   · 'procesado'   — el turno corrió hasta el final: sellar.
 *   · 'duplicado'   — YA se había procesado (claim completado): sellar.
 *   · 'en_curso'    — otra invocación lo tiene en vuelo: ni sellar ni contar
 *                     como fallo; la siguiente vuelta del cron decide.
 *   · 'sin_tiempo'  — la invocación no tiene presupuesto, o una barrera de
 *                     cierre no pudo confirmar que los insumos estén completos:
 *                     no consumir el intento durable; que lo recupere el cron.
 *   · 'reintentable'— se abandonó a medias por un fallo NUESTRO y transitorio
 *                     (mutex ocupado, +1 de la barrera, aviso caído, crash):
 *                     el claim se soltó, la fila durable debe reintentar.
 *
 * AUDITORÍA 18 (C5/A3/A27): antes devolvía `void`, y el cron y el webhook
 * sellaban `procesado_en` ante cualquier retorno sin excepción — incluido el
 * 'duplicado' de un claim huérfano y los `return` de abandono. Un mensaje
 * matado a media corrida quedaba sellado como procesado con un `info` como
 * único rastro.
 */
export type ResultadoInbound = 'procesado' | 'duplicado' | 'en_curso' | 'sin_tiempo' | 'reintentable';

export interface OpcionesInbound {
  /** `Date.now()` de cuando ARRANCÓ LA INVOCACIÓN que procesa este mensaje
   *  (no este mensaje). Sin esto el presupuesto cree que los 120s son suyos
   *  aunque la invocación lleve 60 gastados en los mensajes anteriores (C4). */
  inicioInvocacionMs?: number;
  /**
   * AUDITORÍA 19 (agéntico AGEN-19C2-1, corregido tras auditoría Fable-5
   * post-merge del PR #72): ¿hay otra FOTO antes/después de ésta en la
   * cadena de ESTE chofer, en esta invocación? (route.ts/drenado.ts ya la
   * conocen por adelantado — la cadena está completa antes de procesar el
   * primer mensaje).
   *
   * Hace falta porque el 23-ago (`EN PARALELO POR CHOFER, EN SERIE DENTRO DE
   * CADA CHOFER`) el `for` dejó de correr las fotos de un mismo chofer al
   * mismo tiempo — y la barrera de ráfaga (`intakeDelta`, `esperarIntake`,
   * este mismo archivo más abajo) detecta "hubo ráfaga" mirando si otra foto
   * sigue EN VUELO cuando ésta termina. Bajo ejecución serial nunca hay dos
   * en vuelo: cada foto termina —con su `finally` decrementando el contador
   * a 0— antes de que la siguiente arranque. El contador ve una foto sola,
   * veintidós veces seguidas, y la "libreta" de la ráfaga
   * (`anotarFoto`/`cerrarRafaga`) se abre y se cierra en cada una en vez de
   * una sola vez para todo el fajo: 22 comprobantes se volvían 22 acuses
   * sueltos, y el resumen consolidado nunca disparaba.
   *
   * LA PRIMERA VERSIÓN (`cadenaTotal`/`cadenaPosicion`, contando TODO
   * mensaje de la cadena sin importar su tipo) tenía el mismo bug con otra
   * cara: una cadena `[foto, foto, "listo"]` marcaba la ÚLTIMA FOTO como
   * "no es la última del lote" (porque el texto "listo" viene después), así
   * que nunca cerraba la libreta — ni el "listo" la cierra, porque el cierre
   * de ráfaga solo vive en el camino de `msg.type === 'image'`. El resumen,
   * y con él cualquier aviso de "no pude leer este comprobante", se perdía
   * en silencio: exactamente el modo de falla que este mecanismo existe
   * para evitar. Contar solo FOTOS (no cualquier mensaje) es lo que hace que
   * un "listo" o una caption de texto detrás de la última foto ya no
   * mantengan la libreta abierta para siempre.
   *
   * No toca el candado que sí depende de la concurrencia real entre
   * invocaciones distintas (`esperarIntake`, el "listo" que espera a que las
   * fotos terminen) — ese sigue siendo el contador de la base, correcto tal
   * cual está.
   */
  hayFotoAntesEnCadena?: boolean;
  hayFotoDespuesEnCadena?: boolean;
}

/**
 * Lo mínimo que cuesta un turno útil: un texto corre el agente (15s de piso,
 * `COSTO_AGENTE_MS`) y una foto descarga + visión. Por debajo de esto no se
 * empieza: se devuelve 'sin_tiempo' sin tomar el claim, y la bandeja durable
 * lo recupera entero en vez de arrancarlo para que lo mate Vercel a medias.
 */
const COSTO_MINIMO_TURNO_MS = 15_000;

/**
 * AUDITORÍA 21, MEDIO: lo que recibe el chofer cuando su foto excede
 * `MAX_IMAGEN_WHATSAPP_BYTES` (`ImagenDemasiadoPesadaError`, `meta/client.ts`).
 * A propósito NO es el mismo texto que "no pude descargar tu foto": ahí
 * reenviar la misma foto puede funcionar (fue un problema de red o del token);
 * aquí reenviar la MISMA foto sin comprimir falla otra vez por el mismo
 * motivo, así que hay que decírselo con esas palabras.
 */
const MENSAJE_FOTO_PESADA =
  'Tu foto es muy pesada para que la pueda leer 📦. Intenta mandarla de nuevo o comprimida, por favor. 🙏';

/**
 * ── EL REGISTRO DE JORNADA POR WHATSAPP (LFT 132 fr. XXXIV, mig. 0241) ─────
 *
 * Vive fuera de `processInbound` porque se cablea DOS VECES, y la razón es la
 * misma por la que la asistencia también está en dos sitios: la jornada de un
 * operador existe tenga o no un viaje abierto. Un chofer que llega al patio a
 * las seis y no tiene viaje asignado hasta las nueve trabajó esas tres horas, y
 * hasta hoy el sistema le contestaba «no tienes un viaje abierto para
 * liquidar».
 *
 * Devuelve `null` si el mensaje no era suyo —y entonces sigue su camino, como
 * todos los reconocedores de esta fila— o la lista de mensajes que hay que
 * mandarle, en orden.
 *
 * EL ORDEN DENTRO DE LA FILA. Va ANTES de los hitos y del freno de cierre:
 * `pidioCerrar` empata con `/termin[éeoó]/` y se comería «termino mi jornada»
 * como intento de cerrar el viaje. Y va DESPUÉS de la emergencia y de los
 * botones, que son respuesta a preguntas nuestras. Las frases de este módulo
 * exigen la palabra «jornada», «descanso» o «comer», así que no se cruzan con
 * ninguna lista de los demás — pero el orden documenta la intención igual.
 */
async function atenderJornadaSiAplica(args: {
  tenantId: string;
  operadorId: string;
  texto: string | undefined;
  momento: Date;
  waMessageId: string | null;
  viajeId: string | null;
}): Promise<string[] | null> {
  if (typeof args.texto !== 'string' || !args.texto.trim()) return null;

  // La conformidad va primero: sus frases contienen «jornada» y ninguna es una
  // marca, pero preguntar en este orden hace explícito que confirmar no es
  // fichar.
  if (interpretarConformidadJornada(args.texto)) {
    const r = await atenderConformidadJornada({
      tenantId: args.tenantId,
      operadorId: args.operadorId,
      momento: args.momento,
      waMessageId: args.waMessageId,
    });
    logger.info('jornada.conformidad', { operador: args.operadorId, resultado: r.resultado });
    return [r.respuesta];
  }

  const tipo = interpretarMarcaJornada(args.texto);
  if (!tipo) return null;

  const r = await atenderMarcaJornada({
    tenantId: args.tenantId,
    operadorId: args.operadorId,
    tipo,
    // La hora del MENSAJE, no la del procesamiento (DAT-38, igual que los
    // hitos): el acuse dice «iniciaste a las 06:12» y esa hora tiene que ser
    // la que el operador vivió, no la que este servidor tenía cuando le tocó
    // turno. En un registro laboral la diferencia no es cosmética.
    momento: args.momento,
    texto: args.texto,
    waMessageId: args.waMessageId,
    viajeId: args.viajeId,
  });
  logger.info('jornada.marca', {
    operador: args.operadorId, tipo, resultado: r.resultado, dia: r.dia,
  });

  const mensajes = [r.respuesta];

  // Al cerrar la jornada se le enseña EXACTAMENTE lo que quedó escrito y se le
  // pide su conformidad. Es la pieza que persigue la «prueba plena» del tercer
  // párrafo del art. 132 fr. XXXIV: para acordar un registro hay que verlo.
  //
  // Si el resumen no se puede leer NO se manda un resumen a medias: se le dice
  // que lo vea con la oficina. Un resumen incompleto presentado como completo
  // es justo lo que después se firma sin leer.
  if (tipo === 'fin_jornada' && r.resultado === 'asentado' && r.jornadaId && r.dia) {
    const asientos = await asientosDeJornada(args.tenantId, r.jornadaId);
    mensajes.push(
      asientos === null
        ? 'No pude armarte el resumen del día ahorita. Tu registro quedó guardado; revísalo con la oficina.'
        : resumenParaOperador(r.dia, asientos),
    );
  }

  return mensajes;
}

/**
 * Lo que se le contesta a un mensaje que no sabemos leer (AUDITORÍA 24 · WA-9).
 *
 * La lista de formatos era la misma para todo, y por eso no servía para nada:
 * el chofer que manda un video de la llanta ponchada leía «solo proceso texto,
 * fotos de comprobantes, el XML del CFDI y tu ubicación» sin una palabra sobre
 * el video. Se nombra lo que mandó y se le dice qué hacer con ESO.
 *
 * Las reacciones (👍) no llegan aquí: el webhook las descarta antes del inbox.
 *
 * PURA: es texto y se prueba como texto.
 */
export function mensajeTipoNoSoportado(subtipo?: string): string {
  const cola = 'Mándame la foto de tu ticket o el XML. 📸';
  switch (subtipo) {
    case 'sticker':
      return `Ese sticker no me dice nada 🙂. Si necesitas algo, escríbemelo. ${cola}`;
    case 'video':
      return `Los videos no los leo 🎥 — una *foto* sí. Si es un ticket, tómale foto; si es un problema del camión, cuéntamelo por escrito. ${cola}`;
    case 'contacts':
      return `Los contactos compartidos no los uso 📇. Si necesitas que tu jefe se entere de algo, dímelo por escrito y yo le aviso. ${cola}`;
    default:
      return `Por ahora solo proceso texto, fotos de comprobantes, el XML del CFDI y tu ubicación 📍. ${cola}`;
  }
}

/**
 * Un `document` que NO es el XML del CFDI (AUDITORÍA 24 · WA-8).
 *
 * WhatsApp deja mandar cualquier cosa por el botón de «Documento», y el
 * mensaje era uno solo: «necesito el XML del CFDI, no el PDF». El chofer con
 * iPhone que usa «Documento» para no perder calidad manda su ticket como
 * `image/heic` y lee que mandó un PDF —que no mandó—, así que no tiene forma
 * de saber qué hacer. Se le dice lo que pasó y el siguiente paso, por tipo.
 *
 * PURA: es texto y se prueba como texto.
 */
export function mensajeDocumentoNoEsXml(mime?: string | null): string {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/')) {
    return 'Esa foto me llegó como *archivo* 📎 y así no la puedo leer. Mándamela otra vez con el botón de la *cámara o la galería* (como foto) y la proceso. 📸';
  }
  if (m === 'application/pdf') {
    return 'El *PDF* del comprobante no lo leo 📄. Mándame el *XML* del CFDI (el archivo .xml que viene junto con el PDF) o una *foto* del ticket. 🧾';
  }
  if (m.startsWith('video/') || m.startsWith('audio/')) {
    return 'Eso no lo puedo leer 🤔. Si es un comprobante, mándame la *foto* del ticket o el *XML* del CFDI. 🧾';
  }
  return 'Recibí un documento, pero necesito el *XML* del CFDI (el archivo .xml que te manda la gasolinera por correo), no el PDF. ¿Me lo reenvías? 📎';
}

/**
 * ¿Puede este `mime` ser el XML del CFDI? Se responde en NEGATIVO a propósito:
 * un XML reenviado por correo llega igual como `text/xml`, `application/xml`
 * o `application/octet-stream` según el cliente, y bloquear por lista blanca
 * rebotaría comprobantes buenos. Solo se descarta lo que con certeza no lo es.
 */
export function puedeSerXml(mime?: string | null): boolean {
  const m = (mime ?? '').toLowerCase();
  if (!m) return true;   // Meta no lo dijo: se intenta, como siempre.
  return !(m.startsWith('image/') || m.startsWith('video/') || m.startsWith('audio/') || m === 'application/pdf');
}

/** El error de fondo, sin el envoltorio del ciclo de tools (ver arriba). */
function causaDeFondo(e: unknown): unknown {
  return e instanceof PartialExecutionError ? e.cause : e;
}

/** Colofón que todo cuadre DEGRADADO lleva: dice sin rodeos que el viaje sigue
 *  abierto (AUDITORÍA 24, AGEN-10, reincidente desde la 22). El texto se
 *  añade DESPUÉS de las guardias, porque `guardiaCifras` sustituye el `reply`
 *  entero por `resumenCuadre` y se lo comería. */
const COLOFON_NO_CERRE = 'Todavía *NO* cerré tu liquidación: tu viaje sigue abierto. En un momento vuelve a escribirme *listo* y la cierro.';
const COLOFON_SIN_PRESUPUESTO = 'Hoy tu flota ya agotó su cupo de IA, así que todavía *NO* cerré tu liquidación: tu viaje sigue abierto y tus comprobantes quedan guardados. Mañana escríbeme *listo* otra vez, o pídele a tu contralor que suba el tope hoy.';


// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24 · AGEN-4 (ALTO) — TODA muerte posterior al commit del cierre
// aterriza en la rama «sin viaje abierto» del siguiente «listo». Antes esa
// rama decía «pídeselo a tu contralor» sin mandar el PDF que existe ni avisar
// al jefe. Ahora lee los dos sellos de la 0279 y ENTREGA lo que falte: el PDF
// del operador si nunca salió, el aviso a la oficina si nunca salió. Lo
// sellado no se repite. Best-effort en cada pata, nunca lanza.
// ═══════════════════════════════════════════════════════════════════════════
type EntregaPendiente = {
  pdf: 'mandado' | 'ya_entregado' | 'sin_pdf' | 'fallo';
  jefe: 'avisado' | 'ya_avisado' | 'fallo';
};

async function entregarCierrePendiente(op: ResolvedOperador, telefono: string, liq: LiquidacionReciente): Promise<EntregaPendiente> {
  const admin = supabaseAdmin();
  const ctx = { tenant: op.tenantId, viaje: liq.viajeId, liq: liq.liquidacionId, reentrega: true };

  let pdf: EntregaPendiente['pdf'];
  if (!liq.pdfUrl) {
    pdf = 'sin_pdf';
  } else if (liq.entregadaOperadorEn) {
    pdf = 'ya_entregado';
  } else {
    try {
      // El ejemplar del OPERADOR (`tools.ts`), igual que el camino feliz.
      const firma = await acotada(admin.storage.from('liquidaciones').createSignedUrl(`${op.tenantId}/${liq.viajeId}-operador.pdf`, TTL_FIRMA_PDF_SEGUNDOS), 'createSignedUrl.reentrega');
      if (firma.error || !firma.data?.signedUrl) throw new Error(firma.error?.message ?? 'storage no devolvió URL firmada');
      const r = await sendDocument(telefono, firma.data.signedUrl, 'liquidacion.pdf', 'Aquí está tu liquidación 📄');
      if (!r.ok) {
        logger.error('pdf.no_entregado', { ...ctx, codigo: r.codigo, error: r.error });
        await alertarOperador('pdf.no_entregado', { ...ctx, codigo: r.codigo, error: r.error });
        pdf = 'fallo';
      } else {
        await registrarCostoWhatsApp(op.tenantId, liq.viajeId);
        await sellarEntregaLiquidacion(op.tenantId, liq.liquidacionId, 'entregada_operador_en');
        pdf = 'mandado';
      }
    } catch (e) {
      logger.error('pdf.no_entregado', { ...ctx, err: e instanceof Error ? e.message : String(e), codigo: codigoDeError(e) });
      await alertarOperador('pdf.no_entregado', { ...ctx, err: e instanceof Error ? e.message : String(e), codigo: codigoDeError(e) });
      pdf = 'fallo';
    }
  }

  let jefe: EntregaPendiente['jefe'];
  if (liq.avisadaOficinaEn) {
    jefe = 'ya_avisado';
  } else {
    try {
      let urlPdfJefe: string | null = null;
      if (liq.pdfUrl) {
        const firma = await acotada(admin.storage.from('liquidaciones').createSignedUrl(`${op.tenantId}/${liq.viajeId}.pdf`, TTL_FIRMA_PDF_SEGUNDOS), 'createSignedUrl.contralor');
        if (firma.error || !firma.data?.signedUrl) logger.warn('cierre.pdf_jefe_sin_url', { ...ctx, err: firma.error?.message ?? 'storage no devolvió URL firmada' });
        else urlPdfJefe = firma.data.signedUrl;
      }
      const rj = await avisarCierreAlJefe({ tenantId: op.tenantId, viajeId: liq.viajeId, urlPdf: urlPdfJefe, telefonoOperador: telefono });
      // AUDITORÍA 25 (MEDIO, agentico.md:526): mismo candado que el camino
      // feliz — si había PDF del contralor (`liq.pdfUrl`) y no llegó, no se
      // sella. Ésta es precisamente la reentrega (AGEN-4): si sella aquí sin
      // el PDF, ya no queda ningún turno futuro que lo reintente.
      const pdfJefeOk = !liq.pdfUrl || rj.pdfEnviado === true;
      if (rj.enviado && pdfJefeOk) {
        await sellarEntregaLiquidacion(op.tenantId, liq.liquidacionId, 'avisada_oficina_en');
        jefe = 'avisado';
      } else {
        logger.warn('cierre.jefe_no_avisado', { ...ctx, motivo: rj.motivo, pdfJefeOk });
        jefe = 'fallo';
      }
    } catch (e) {
      logger.error('cierre.aviso_jefe_falló', { ...ctx, err: e instanceof Error ? e.message : String(e) });
      jefe = 'fallo';
    }
  }
  return { pdf, jefe };
}

/** Lo que se le dice al chofer según lo que de verdad pasó con su PDF. Ninguna
 *  frase afirma una entrega que Meta no aceptó. */
function mensajeCierreConfirmado(e: EntregaPendiente): string {
  const cabeza = 'Tu último viaje ya quedó liquidado ✅ — no tienes ninguno abierto ahorita.';
  switch (e.pdf) {
    case 'mandado': return `${cabeza} Te acabo de mandar tu PDF 📄`;
    case 'ya_entregado': return `${cabeza} Tu PDF ya te lo había mandado; si no lo ves, pídeselo a tu contralor: él ya lo tiene en el panel. 👍`;
    case 'sin_pdf': return `${cabeza} El PDF de esa liquidación no se generó; avísale a tu contralor para que la revise en el panel.`;
    case 'fallo': return `${cabeza} El PDF no se te pudo entregar por el chat; pídeselo a tu contralor: él ya lo tiene en el panel. 🙏`;
  }
}

/** TTL de las URLs firmadas de los PDF (segundos). Ver AGEN-9: el outbox
 *  reintenta a ≥ 5 min, así que una firma de 60 s nacía muerta. */
/**
 * Cuánto vive la URL firmada del PDF que se le manda al chat.
 *
 * ── POR QUÉ YA NO SON 60 s (AUDITORÍA 24 · AGEN-9, MEDIO) ─────────────────
 *
 * Las rondas 5-13 lo bajaron a 60 s con un razonamiento correcto —Meta baja
 * el `link` en segundos y el objeto es privado— y con una regla explícita:
 * subirlo solo cuando `pdf.no_entregado` traiga un error de STORAGE, no de
 * Meta. Esa evidencia llegó por otro lado: `sendDocument` ENCOLA el payload
 * entero —`link` incluido— cuando el POST a Meta se cae por red, y el outbox
 * lo reintenta a los 5 minutos (`RETRASO_AMBIGUO_SEGUNDOS = 300`) y después
 * con backoff `15·2^n` hasta ocho veces. O sea: cada PDF que se cayó por red
 * nacía muerto —a los 300 s la firma lleva 240 s vencida—, Meta contestaba
 * «medio no descargable» (no reintentable), y a la octava el mensaje moría
 * con su alerta de `salida_muerta`. Ocho intentos garantizados de fallar y
 * una alerta operativa por cada PDF que tocó una red mala.
 *
 * 15 minutos cubren el reintento de los 5 y los tres siguientes del backoff.
 * No cubren los ocho, y no se estira más por eso: lo correcto de verdad es
 * que el outbox vuelva a firmar al enviar (anotado en CIERRE.md, toca el cron
 * de `wa-outbox`), y este número es lo que hace que el caso normal —una red
 * mala de diez segundos— entregue el PDF en vez de gastar una hora de cola.
 */
const TTL_FIRMA_PDF_SEGUNDOS = 900;

/**
 * LA BASE ES LA AUTORIDAD sobre si un viaje cerró.
 *
 * AUDITORÍA 24, AGEN-1 (CRÍTICO, 3ª ronda) + AGEN-A1/BE-1 (ALTO, 2ª ronda).
 * `guardar_liquidacion_tx` puede COMMITEAR y aun así la tool reportar fallo:
 * `acotada` se rinde a los 8 s y el RPC termina del lado del servidor; o el
 * reloj del agente vence con la tool en vuelo. En los dos casos el viaje
 * queda `liquidado`, los PDF en el bucket, y el `ToolCallRecord` dice
 * `error`. Por eso, tras CUALQUIER resultado no-OK de `guardar_liquidacion`,
 * se relee la liquidación y se narra lo que la base dice — en el camino feliz
 * y en el de excepción, con UN SOLO registro sintético.
 *
 * El registro sintético habla el VOCABULARIO DE LA TOOL (`pdf_generado`,
 * `pdf_contralor_generado`), que es lo que leen los consumidores de abajo
 * (`agentTools.find(...).result.pdf_generado`, `guardia.ts`). El anterior
 * traía `pdf_url` —vocabulario de la tabla— y nadie lo leía: al chofer se le
 * negaba un PDF que sí existía. Los dos ejemplares se suben ANTES del RPC
 * (`tools.ts`), así que `pdf_url != null` implica que existen ambos.
 *
 * Tres respuestas, nunca dos: si la lectura truena, `no_verificable` — un
 * error de red no puede leerse como «no se cerró».
 */
async function confirmarCierreEnBase(tenantId: string, viajeId: string): Promise<
  | { estado: 'cerrado'; liqId: string; registro: ToolCallRecord }
  | { estado: 'abierto' }
  | { estado: 'no_verificable'; err: string }
> {
  try {
    const liq = await getLiquidacionDeViaje(tenantId, viajeId);
    if (!liq) return { estado: 'abierto' };
    const hayPdf = liq.pdfUrl != null;
    return {
      estado: 'cerrado',
      liqId: liq.id,
      registro: {
        toolName: 'guardar_liquidacion',
        args: {},
        result: { liquidacion_id: liq.id, pdf_generado: hayPdf, pdf_contralor_generado: hayPdf },
        durationMs: 0,
      } as ToolCallRecord,
    };
  } catch (e) {
    return { estado: 'no_verificable', err: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Cierra la ráfaga del chofer que se quedó sin reloj y le dice lo suyo.
 *
 * AUDITORÍA 22, AGEN-A2. Solo habla si hay algo que decir: una libreta sin
 * incidencias y sin acuses no genera un mensaje — el módulo de ráfaga existe
 * precisamente para no mandar siete.
 *
 * AUDITORÍA 24, AGEN-A2/BE-2 (ALTO, 2ª ronda): cerraba y BORRABA las libretas
 * de TODOS los choferes del proceso. Con pool de 5 cadenas y reloj compartido,
 * `sin_tiempo` es el final NORMAL de cada vuelta del cron: la cadena que se
 * quedaba sin reloj le mandaba al chofer A «de tus 4 fotos, 2 no las leí»
 * mientras su 4ª foto seguía en vuelo, y el cierre real le mandaba después
 * «de tus 2 fotos…» sobre una libreta recreada en cero. Dos cifras, ninguna
 * verdadera. Ahora recibe el teléfono del mensaje que se quedó sin presupuesto
 * y cierra SOLO esa libreta; las de los demás siguen vivas para su propio
 * cierre.
 */
async function cerrarRafagasPorCorte(telefono: string): Promise<void> {
  for (const { viajeId, telefono: tel } of bandejasAbiertas()) {
    if (tel !== telefono) continue;
    const b = cerrarRafaga(viajeId);
    if (!telefono || b.vistas === 0) continue;
    const linea = lineaIncidencias(b.vistas, b.incidencias);
    if (!linea && b.acuses.length === 0) continue;
    const texto = linea
      ?? `Van ${b.vistas} comprobante${b.vistas === 1 ? '' : 's'} anotado${b.vistas === 1 ? '' : 's'}. Sigo con el resto en un momento.`;
    try {
      await sendText(telefono, texto);
    } catch (e) {
      logger.error('rafaga.cierre_por_corte_no_enviado', { viaje: viajeId, err: e instanceof Error ? e.message : String(e) });
    }
  }
}

export async function processInbound(msg: InboundMessage, opts: OpcionesInbound = {}): Promise<ResultadoInbound> {
  // ── RELOJ COMPARTIDO, desde la primera línea ─────────────────────────────
  // Las etapas de abajo pedían su tope fijo sin saber que comparten UNA
  // invocación: 20s de barrera + 12s de mutex + 40s de agente = 72s contra un
  // presupuesto de 60. Y como el webhook ya respondió 200, Meta no reintenta:
  // cuando Vercel mata la función, el operador se queda sin nada y sin rastro.
  //
  // Arranca AQUÍ y no más abajo: resolver al operador, buscar el viaje abierto y
  // mandar el aviso de privacidad también gastan, y son llamadas de red. Un
  // reloj que arranca a media función cree tener 60s cuando ya se fueron varios.
  //
  // Y arranca en el inicio de LA INVOCACIÓN, no de este mensaje (C4): el
  // llamador que procesa N mensajes en una sola invocación pasa el suyo.
  const reloj = crearPresupuesto(PRESUPUESTO_WEBHOOK_MS, Date.now, opts.inicioInvocacionMs ?? Date.now());
  if (!reloj.alcanza(COSTO_MINIMO_TURNO_MS)) {
    logger.warn('wa.sin_tiempo', { id: msg.waMessageId, gastadoMs: reloj.gastado(), restanteMs: reloj.restante() });
    // ── AUDITORÍA 22, AGEN-A2 (ALTO): LA LIBRETA NO SE VA MUDA ─────────────
    // Este `return` corta la cadena (el `break` del webhook y del drenado), y
    // es el caso NORMAL del fajo grande: 22 fotos a 8-15 s no caben en una
    // invocación. La libreta solo se cerraba en la foto sin otra detrás, así
    // que se quedaba abierta con lo ya visto —«de tus 6 fotos, 3 no se
    // leyeron»— y moría con el proceso. El cron levanta el resto en OTRA
    // invocación, con libreta nueva: nadie iba a decirlo después.
    //
    // Se cierra lo que haya y se dice. Cuesta un envío; el silencio costaba
    // que el chofer no supiera que tres de sus fotos no se leyeron.
    await cerrarRafagasPorCorte(msg.from);
    return 'sin_tiempo';
  }

  // Idempotencia: si Meta reintenta el webhook, no re-procesar (no duplicar gasto).
  const claimOwner = `wa-message:${randomUUID()}`;
  const rawClaim = msg.waMessageId
    ? await claimMessage(msg.waMessageId, claimOwner, true)
    : 'nuevo';
  // Tests and older in-process callers may still mock the compatibility
  // overload that returns the status string. Production uses the fenced
  // handle returned by the RPC.
  const messageClaim = typeof rawClaim === 'string'
    ? { status: rawClaim, owner: claimOwner, token: undefined }
    : rawClaim;
  const claim = messageClaim.status;
  if (claim === 'duplicado') {
    logger.info('wa.duplicate', { id: msg.waMessageId });
    return 'duplicado';
  }
  if (claim === 'en_curso') {
    logger.warn('wa.en_curso', { id: msg.waMessageId });
    return 'en_curso';
  }
  if (claim === 'indeterminado') {
    // NO se abandona el turno. Meta ya recibió su 200 en `route.ts` y no
    // reintenta, así que abandonar aquí no aplaza el mensaje: lo pierde, para
    // siempre y en silencio. Se sigue, aceptando el riesgo de reprocesar: los
    // efectos con dinero tienen sus propios candados —hash de comprobante para el
    // gasto, `on conflict (viaje_id)` para la liquidación— y ninguno depende de
    // esta rejilla. Perder el "listo" del operador no tiene candado ninguno.
    logger.warn('wa.claim_indeterminado', { id: msg.waMessageId });
  }

  // El claim se suelta SOLO por aquí, para saber al salir si el turno se
  // abandonó (→ 'reintentable') o llegó al final (→ se sella como completado).
  let claimLiberado = false;
  let pospuestoSinConsumirIntento = false;
  const soltarClaim = async (sinConsumirIntento = false): Promise<void> => {
    claimLiberado = true;
    pospuestoSinConsumirIntento ||= sinConsumirIntento;
    if (msg.waMessageId) {
      if (messageClaim.token) await releaseMessageClaim(msg.waMessageId, messageClaim.token, messageClaim.owner);
      else await releaseMessageClaim(msg.waMessageId);
    }
  };

  const detenerRenovacionMessage = msg.waMessageId && messageClaim.token && typeof iniciarRenovacionMessageClaim === 'function'
    ? iniciarRenovacionMessageClaim(msg.waMessageId, messageClaim.token, messageClaim.owner)
    : () => {};
  try {
    await procesarTurno(msg, reloj, soltarClaim, opts);
  } finally {
    detenerRenovacionMessage();
  }

  if (claimLiberado) return pospuestoSinConsumirIntento ? 'sin_tiempo' : 'reintentable';
  if (msg.waMessageId) {
    if (messageClaim.token) await completarMessageClaim(msg.waMessageId, messageClaim.token, messageClaim.owner);
    else await completarMessageClaim(msg.waMessageId);
  }
  return 'procesado';
}

/** El turno propiamente: todo lo que había en `processInbound` menos el
 *  claim y el reloj. Nunca lanza (el `catch` general vive aquí). */
async function procesarTurno(msg: InboundMessage, reloj: Presupuesto, soltarClaim: (sinConsumirIntento?: boolean) => Promise<void>, opts: OpcionesInbound): Promise<void> {
  let lockedViaje: string | null = null;
  /** BE-11: la firma del lease que TOMÓ este turno; solo con ella se suelta. */
  let tokenViaje: string | undefined;
  // Contexto para el `catch` general. Vive FUERA del `try` a propósito: sin esto
  // el log de un fallo salía como `{ id, de, err }` — sin tenant, sin viaje y sin
  // saber si la liquidación había cerrado—, así que era imposible reconstruir
  // CUÁL liquidación quedó cerrada sin entregar. Un error del camino del dinero
  // que no dice de qué dinero habla no sirve a las 3 de la mañana.
  let ctxTenant: string | null = null;
  let ctxViaje: string | null = null;
  let ctxCerro = false;
  try {
    // ── EL MEDIO ARCO RESPONDE SIEMPRE, incluso a quien YA no es operador ──
    // AUDITORÍA 12, MEDIO (legal): el chequeo vivía dentro de `if (op)`, así
    // que un operador con `activo = false` escribía PRIVACIDAD y recibía "no
    // te tengo registrado". La población más probable de ejercer
    // cancelación/oposición es exactamente la que el canal rechazaba. El
    // tenant se busca por teléfono SIN el filtro de activo, o por cuenta de
    // oficina; sin ninguna de las dos, se le dice la verdad en vez de callar.
    //
    // ESTE COMENTARIO SE CORRIGIÓ DOS VECES EL MISMO DÍA, y las dos veces por
    // lo mismo: describía el estado de OTRA pantalla en vez de lo que hace
    // esta rama. Primero decía que `activo = false` era "la única forma de
    // inactivar DEL PANEL" cuando ese camino no existía (auditoría 20, H2);
    // se corrigió a "ninguna pantalla lo escribe" y esa frase duró una hora —
    // el PR #260 cerró el ciclo esa misma tarde y hoy `/dashboard/operadores`
    // SÍ da de baja (`actualizarOperador`, con `operador.baja` en bitácora).
    //
    // La lección se queda escrita porque es la que evita la tercera vuelta:
    // esta rama NO DEPENDE de cómo se apagó la bandera, ni de si existe una
    // pantalla que la apague. Responde a cualquiera que escriba PRIVACIDAD —
    // activo o no, dado de alta o no—, y por eso su comentario no tiene por
    // qué nombrar el inventario de escritores de `operador.activo`.
    if (msg.type === 'text' && msg.text && pideAtencionPrivacidad(msg.text)) {
      const tenantId =
        (await buscarTenantPorTelefono(msg.from).catch(() => null))
        ?? (await resolverCuentaOficina(msg.from).catch(() => null))?.tenantId
        ?? null;
      if (tenantId) {
        await atenderPrivacidad(tenantId, null, msg.from, msg.text);
      } else {
        await sendText(msg.from, 'Claro. No te tengo identificado con una flota en Likida, así que no sé a qué empresa reclamarle. Si trabajaste con una flota que usa Likida, pídeles que te confirmen qué hicieron con tus datos. 🙏');
      }
      return;
    }

    const op = await resolveOperador(msg.from);
    if (!op) {
      // ── ¿ES UNA CUENTA DE OFICINA? ───────────────────────────────────────
      //
      // Antes esto era un callejón sin salida: cualquier número que no fuera
      // chofer recibía "no te tengo registrado como operador" y ahí terminaba.
      // El costo real no era la frase, era esto: los avisos que Likida MANDA a
      // la oficina —"tu chofer no aceptó el viaje", "tienes tickets por
      // vencer"— llegaban a un número que el sistema no reconocía de vuelta. El
      // jefe podía contestar "cámbialo a Pérez" y nadie estaba escuchando. Un
      // aviso que no se puede contestar no es una conversación, es una alerta.
      const cuenta = await resolverCuentaOficina(msg.from).catch((e) => {
        // Ambigüedad o base caída. No se afirma que no existe: eso es justo la
        // confusión que `resolveOperador` ya corrigió arriba.
        logger.error('oficina.no_resuelta', { err: e instanceof Error ? e.message : String(e) });
        return null;
      });

      if (cuenta) {
        // ── AUDITORÍA 10, CRÍTICO FISCAL — EL XML CONSOLIDADO DE LA OFICINA ──
        //
        // El monedero de combustible y el TAG de casetas mandan SU CFDI al
        // correo de la OFICINA, no al del chofer — es la oficina quien lo
        // reenvía. Hasta hoy este bloque respondía el mismo texto genérico a
        // CUALQUIER mensaje, documento incluido: un XML consolidado que la
        // oficina reenviara aquí se perdía en silencio, sin siquiera un
        // "no sé qué hacer con esto".
        //
        // Alcance DELIBERADAMENTE angosto: solo se atiende el documento que
        // el parser reconoce como CONSOLIDADO (`lineas.length > 1` —
        // `esConsolidado`). Un XML de un solo concepto mandado por error desde
        // la oficina sigue sin tener dueño (no hay viaje/operador de
        // contexto para el camino de ticket 1:1) y cae al mensaje genérico de
        // abajo — ampliar ESE caso es una decisión de producto aparte.
        if (cuenta.tenantId && msg.type === 'document' && msg.mediaId) {
          try {
            const xmlText = await downloadMediaAsText(msg.mediaId);
            const xml = xmlText ? parseCfdiXml(xmlText) : null;
            // ── FASE 7 (mig. 0199): el REP entra por CUALQUIER puerta ──────
            // Un complemento de pago no es "el ticket de un viaje": libera el
            // IVA a crédito de la flota entera. La oficina es de hecho quien
            // más probablemente lo reenvía (se lo manda la estación por
            // correo). Va ANTES del camino 1:1, que con Total=0 lo rebotaría
            // con "viene sin el total".
            if (xml?.tipoComprobante === 'P' && xmlText) {
              const rep = parseRepXml(xmlText);
              if (rep) {
                const resumen = await ingerirRep(cuenta.tenantId, rep, xmlText);
                logger.info('oficina.rep', { tenant: cuenta.tenantId, rep: rep.uuid, ...resumen });
                await sendText(msg.from, mensajeRepRecibido(resumen));
                return;
              }
            }
            if (xml?.uuid && xml.tipoComprobante === 'E') {
              await sendText(msg.from, await conservarNotaCredito(cuenta.tenantId, xml.uuid, xmlText!));
              return;
            }
            if (xml?.uuid && esConsolidado(xml)) {
              logger.info('oficina.xml_consolidado', { tenant: cuenta.tenantId, user: cuenta.userId, uuid: xml.uuid, lineas: xml.lineas.length });
              const resumen = await guardarYConciliarConsolidado(cuenta.tenantId, xml, xmlText!);
              await sendText(msg.from, mensajeConsolidadoRecibido(resumen));
              return;
            }
          } catch (e) {
            // Best-effort: si algo truena aquí, cae al mensaje genérico de
            // abajo en vez de dejar al remitente sin ninguna respuesta.
            logger.error('oficina.xml_consolidado_error', { tenant: cuenta.tenantId, err: e instanceof Error ? e.message : String(e) });
          }
        }

        // ── LOS MANDOS DE OFICINA, TODOS EN UN SITIO ─────────────────────────
        //
        // Talacha, despacho, asignación, informe y analista viven en
        // `atenderTextoOficina` desde que el camino del chofer también los
        // necesita (un dueño que maneja es su propio operador). Aquí entra con
        // el analista ENCENDIDO: este número no es de nadie más, así que una
        // pregunta suelta es suya y no se le disputa a ningún acuse de ruta.
        if (msg.type === 'text' && msg.text) {
          const rOficina = await atenderTextoOficina(cuenta, msg.from, msg.text, { incluirPreguntaLibre: true, incluirDespacho: true, reloj });
          if (rOficina === 'reintentar') { await soltarClaim(); return; }
          if (rOficina) return;
        }
        const quien = cuenta.nombre ? `${cuenta.nombre}` : 'Qué tal';
        // Se le dice lo que SÍ puede hacer hoy por aquí y se le manda al panel
        // para lo demás — y desde F4, despachar por aquí YA existe, así que el
        // saludo lo enseña (solo a quien su rol se lo permite: prometérselo al
        // contador sería prometerle una acción que `puedeAsignar` va a negar).
        logger.info('oficina.mensaje', { user: cuenta.userId, rol: cuenta.rol });
        const puedeDespachar = cuenta.tenantId !== null && puedeAsignar(cuenta.rol);
        const puedeInforme = cuenta.tenantId !== null;
        await sendText(msg.from,
          `${quien}, te reconozco como ${cuenta.rol === 'contador' ? 'contador' : 'parte del equipo'} de tu flota en Likida 👋\n\n` +
          `Por aquí te aviso cuando un chofer no confirma su viaje y cuando haya comprobantes por facturar. ` +
          // Solo se le ofrece lo que su rol de verdad puede hacer: prometerle
          // el despacho al contador sería prometerle una acción que
          // `puedeAsignar` va a negar dos mensajes después.
          (puedeDespachar
            ? `También puedes despacharme viajes («nuevo viaje para Juan Pérez, Puebla a Monterrey, anticipo 8000»), asignar unidad o reasignar chofer («asígnale la unidad 12 al viaje de Juan») — todo te lo confirmo antes de aplicarlo. `
            : '') +
          (puedeInforme
            ? `Pregúntame «¿cómo van?» y te doy el resumen de la operación. `
            : '') +
          `Para el detalle completo, entra a ${appUrl()}.`);
        return;
      }

      // ── ¿ES UN PROVEEDOR CONTACTADO POR LA CAPA D? (0213) ────────────────
      // Rama propia y aislada por teléfono-de-proveedor-con-gestión-viva: no
      // toca el camino del chofer ni el de oficina. Su respuesta ("40 min,
      // $1,200") avanza la coordinación y le llega al jefe con botones; sin
      // gestión viva, este número sigue siendo un desconocido y cae abajo.
      if (msg.type === 'text' && msg.text) {
        const rProveedor = await atenderMensajeProveedor(msg.from, msg.text).catch((e) => {
          logger.error('proveedor.mensaje_error', { err: e instanceof Error ? e.message : String(e) });
          return null;
        });
        if (rProveedor) {
          await sendText(msg.from, rProveedor);
          return;
        }
      }
      // El gruero que contesta con NOTA DE VOZ —como contesta medio México—
      // caía al "no te tengo registrado como operador" con la cotización en
      // la mano (c4-5). No se transcribe (la E1 es solo-chofer a propósito):
      // se le pide el texto y la constancia queda en el expediente.
      if (msg.type === 'audio' || msg.type === 'image' || msg.type === 'location' || msg.type === 'document') {
        const rMedio = await atenderMedioProveedorSinTexto(msg.from, msg.type).catch((e) => {
          logger.error('proveedor.medio_error', { err: e instanceof Error ? e.message : String(e) });
          return null;
        });
        if (rMedio) {
          await sendText(msg.from, rMedio);
          return;
        }
      }

      await sendText(msg.from, 'Hola, no te tengo registrado como operador. Pídele a tu flota que te dé de alta en Likida. 🚛');
      return;
    }
    // ── AUDITORÍA 24, ADM-6: EL INTERRUPTOR POR FLOTA (mig. 0297) ───────────
    //
    // `interruptor` (0110) es global — apagarlo corta a las 800 unidades de
    // Innovativos junto con las demás flotas del piloto. Esta palanca es por
    // (tenant, pipeline): Javier puede frenar SOLO el pipeline de whatsapp de
    // una flota con un incidente, sin tocar a las otras. Se pregunta aquí
    // —ya hay tenant, todavía no arrancó OCR ni cuadre— y se avisa (a
    // diferencia del kill switch global, este SÍ contesta: solo un tenant
    // se ve afectado, no todo el canal de WhatsApp).
    if (await pipelineTenantApagado(op.tenantId, 'whatsapp')) {
      logger.warn('wa.pipeline_tenant_apagado', { tenant: op.tenantId, operador: op.operadorId });
      await sendText(msg.from, 'Tu flota puso en pausa la recepción automática por WhatsApp ahorita. Guarda tu foto o mensaje y reenvíamelo más tarde, o contacta a tu oficina.');
      return;
    }
    // ── CAPA E1: LA NOTA DE VOZ DEL CHOFER SE VUELVE TEXTO, AQUÍ Y SOLO AQUÍ ─
    //
    // El chofer asustado manda audio, no escribe (blueprint 19). La conversión
    // vive en ESTE punto —ya se sabe que el remitente es un chofer, ya hay
    // tenant para el presupuesto, y todavía no arranca ningún camino— para que
    // TODO lo de abajo (ARCO, ROJO, talacha, hitos, confirmación) reciba el
    // texto transcrito por el mismo canal que un mensaje escrito. Ningún
    // reconocedor se relaja: si la transcripción no dice "chocamos", el
    // protocolo ROJO no dispara — el léxico cerrado sigue mandando.
    //
    // Fail-closed en la verdad: no entender es respuesta, adivinar no. La nota
    // ininteligible, el presupuesto agotado y el fallo nuestro terminan todos
    // en un "¿me lo escribes?" — jamás en silencio.
    //
    // ── AUDITORÍA E.28, LEG-C1 (CRÍTICO legal, LFPDPPP art. 8/16-II) ─────────
    // La nota de voz es dato personal (la voz, y lo que dice) y transcribirla
    // es tratarla: `transcribirNotaDeVoz` la manda a OpenRouter. Hasta hoy eso
    // ocurría AQUÍ, unas 130 líneas ANTES de la compuerta del aviso
    // (`ponerAvisoADisposicion`, más abajo) — el dato ya había salido hacia un
    // proveedor externo sin que el aviso estuviera puesto. La foto y el XML sí
    // pasaban por la compuerta antes de tratarse (aviso_bloqueo.test.ts,
    // auditoría 8); la nota de voz era la única puerta que la saltaba, porque
    // ARCO/ROJO/talacha necesitan el TEXTO para reconocerse y ese texto no
    // existe hasta transcribir.
    //
    // La compuerta se evalúa AQUÍ, antes de la transcripción, y no se mueve
    // otra vez a su posición original para este mensaje (`avisoConfirmadoAudio`
    // se lo dice al segundo chequeo, más abajo, para no invocar la MISMA
    // compuerta dos veces por turno). Esto sí cambia el comportamiento de
    // ROJO/ARCO ejercidos POR VOZ cuando la flota aún no configuró su aviso
    // (`sin_datos`): antes disparaban igual, porque la nota ya se había
    // transcrito; ahora se bloquean como cualquier otro tratamiento, porque no
    // hay forma de saber que la nota dice "chocamos" sin mandarla al modelo
    // primero. ROJO y ARCO por TEXTO o por CAPTION DE FOTO siguen sin gate —esos
    // no tratan ningún dato personal para reconocerse, es coincidencia de texto
    // local— así que una emergencia escrita sigue atendida siempre. La garantía
    // que no se negocia es la otra: ningún dato personal sale hacia un modelo
    // antes de que el aviso esté confirmado.
    let avisoConfirmadoAudio = false;
    if (msg.type === 'audio') {
      if (!msg.mediaId) {
        await sendText(msg.from, RESPUESTA_NO_ENTENDI);
        return;
      }
      const avisoAudio = await ponerAvisoADisposicion(op.tenantId, op.operadorId, msg.from);
      if (avisoAudio !== 'puesto') {
        logger.error('privacidad.tratamiento_bloqueado', {
          tenant: op.tenantId, operador: op.operadorId, motivo: avisoAudio, canal: 'audio',
        });
        try {
          await sendText(msg.from, avisoAudio === 'sin_datos'
            ? 'No puedo escuchar tu nota de voz todavía: tu empresa aún no ha terminado de configurar su aviso de privacidad. Avísale a tu flota. 🙏'
            : 'Se me trabó tantito antes de poder escuchar tu nota de voz 😕. No es cosa tuya ni de tu empresa. Reenvíamela en un minuto, por favor. 🙏');
        } catch { /* best-effort */ }
        if (avisoAudio !== 'sin_datos') await soltarClaim();
        return;
      }
      avisoConfirmadoAudio = true;

      const t = await transcribirNotaDeVoz({
        tenantId: op.tenantId,
        mediaId: msg.mediaId,
        senal: reloj.senal(30_000),
      });
      if (!t.ok) {
        await sendText(msg.from, t.motivo === 'presupuesto' ? RESPUESTA_SIN_PRESUPUESTO : RESPUESTA_NO_ENTENDI);
        return;
      }
      // La transcripción queda citable en el log con su marca de origen; el
      // texto que sigue el camino es el LIMPIO — un prefijo rompería los
      // comandos exactos («va», «radio F-123 25») que el chofer sí puede decir.
      logger.info('voz.transcrita', {
        operador: op.operadorId, id: msg.waMessageId ?? null,
        texto: `🎤 (transcrito): ${t.texto}`,
      });
      msg = { ...msg, type: 'text', text: t.texto };
    }
    // ── El medio ARCO responde SIEMPRE, haya viaje o no ──────────────────────
    // Va ANTES del corte por "sin viaje abierto". El aviso de privacidad le
    // promete al operador que escribiendo PRIVACIDAD se le atiende, y un derecho
    // ARCO no depende de que su flota le haya asignado un viaje — de hecho, quien
    // quiere que dejen de tratar sus datos es probable que YA no tenga viajes.
    //
    // Estaba después del corte, así que la promesa del aviso era falsa en el caso
    // más probable de ejercerla. Lo cazó la auditoría 3. (El chequeo global de
    // arriba —antes de la resolución de identidad— ya lo atiende, incluido al
    // operador dado de baja: este bloque queda como red redundante por si el
    // de arriba cambia de orden.)
    if (msg.type === 'text' && msg.text && pideAtencionPrivacidad(msg.text)) {
      await atenderPrivacidad(op.tenantId, op.operadorId, msg.from, msg.text);
      return;
    }

    ctxTenant = op.tenantId;
    const viajeId = await getOpenViaje(op.tenantId, op.operadorId);
    ctxViaje = viajeId;

    // ── EMERGENCIA ROJA, POR ENCIMA DE TODO (0198, Fase 4) ──────────────────
    //
    // Va ANTES del gate de privacidad A PROPÓSITO (punto E del plano técnico,
    // mismo precedente por el que el medio ARCO se izó arriba): un chofer que
    // aún no aceptó el aviso y escribe "chocamos, hay un herido" recibe
    // TRATAMIENTO MÍNIMO — incidencia + aviso al jefe, sin foto, sin OCR, sin
    // modelo. Bloquear una emergencia de vida detrás de un trámite de aviso
    // sería lo contrario de lo que la LFPDPPP protege. Decisión consciente de
    // producto+legal, no un default.
    //
    // Y va antes del check de oficina y de talacha: ROJO le gana a todo —
    // "chocamos y la talacha cobra 800" es un choque, no una talacha. Cubre
    // texto E imagen por su caption (punto B): la foto de un camión volcado
    // NO paga visión ni entra como comprobante — hoy pagaba OCR y el chofer
    // recibía "esa foto salió difícil de leer" mientras su unidad ardía.
    // También cubre al chofer SIN viaje (punto C): `viajeId` puede ser null y
    // la incidencia se ata al operador (columna `operador_id` de la 0198).
    // Ámbar NO pasa por aquí: no es riesgo de vida y respeta el gate.
    if ((msg.type === 'text' || msg.type === 'image') && msg.text) {
      const emergencia = interpretarAsistencia(msg.text);
      if (emergencia?.nivel === 'rojo') {
        const r = await atenderAsistenciaChofer({
          tenantId: op.tenantId,
          viajeId,
          operadorId: op.operadorId,
          texto: msg.text,
          asistencia: emergencia,
          waMessageId: msg.waMessageId ?? null,
        });
        logger.info('asistencia.rojo', { viaje: viajeId, tipoMsg: msg.type, mudo: emergencia.modoMudo });
        await sendText(msg.from, r.respuesta);
        return;
      }
    }

    // ── EL DUEÑO QUE MANEJA TAMBIÉN DESPACHA ────────────────────────────────
    //
    // `resolveOperador` acertó, así que hasta aquí este mensaje era del chofer y
    // solo del chofer. Pero en una flota chica el dueño maneja, y `contactos.ts`
    // devuelve LAS DOS caras justamente porque un número puede ser las dos
    // cosas; lo que faltaba era que alguien preguntara por la segunda. Sin esto,
    // dar de alta al dueño como operador —para que pueda mandar sus tickets—
    // le apagaba el despacho y los informes por WhatsApp, y nada se lo decía.
    //
    // SOLO TEXTO. Una foto, un XML, un pin o un botón son de ruta por
    // definición; el mando de oficina viaja escrito.
    //
    // DESPUÉS DE `getOpenViaje` Y ANTES DEL GATE DE AVISO, y las dos cosas a
    // propósito. Después, porque el viaje abierto es el desempate y hace falta
    // tenerlo. Antes, porque pedir el informe de la flota no trata datos
    // personales del operador: bloquear un «¿cómo van?» del dueño porque su
    // propia empresa no publicó su aviso sería cobrarle una deuda que tiene
    // consigo mismo.
    if (msg.type === 'text' && msg.text) {
      const cuentaPropia = await resolverCuentaOficina(msg.from).catch((e) => {
        // Ambigüedad o base caída: NO se afirma que no tiene cuenta de oficina.
        // Se sigue como chofer, que es lo que ya se sabe cierto de este número.
        logger.error('chofer.oficina_no_resuelta', { err: e instanceof Error ? e.message : String(e) });
        return null;
      });
      // EL TENANT TIENE QUE SER EL MISMO. Dos filas del mismo número apuntando a
      // flotas distintas es dato corrupto, y aquí decidiría SOBRE QUÉ FLOTA se
      // despacha: se registra y se sigue como chofer, que es la cara que ya
      // trae tenant comprobado. Mismo criterio que `resolveOperador` ante dos
      // filas — negarse a adivinar es lo único correcto cuando el que decide el
      // tenant es el dato que está roto.
      if (cuentaPropia?.tenantId && cuentaPropia.tenantId !== op.tenantId) {
        logger.error('chofer.oficina_otro_tenant', {
          telefono: msg.from, operadorTenant: op.tenantId, cuentaTenant: cuentaPropia.tenantId,
        });
      } else if (cuentaPropia
          // EL ANALISTA SE ENCIENDE SOLO SIN VIAJE ABIERTO, y ése es justo el
          // desempate que `contactos.ts` describe: "si trae viaje abierto, es
          // chofer; si pregunta por su flota, es oficina". Importa porque el
          // analista contesta CUALQUIER texto —los demás reconocedores se
          // apartan solos devolviendo null, él no—, así que en ruta se comería
          // «ya llegué» y «listo», que son con los que se cierra un viaje. Sin
          // viaje abierto no hay nada de ruta que decir y la pregunta es del
          // dueño. Lo que ningún reconocedor reclame sigue su camino intacto.
      ) {
        const rOficina = await atenderTextoOficina(cuentaPropia, msg.from, msg.text, { incluirPreguntaLibre: !viajeId, incluirDespacho: !viajeId, reloj });
        if (rOficina === 'reintentar') { await soltarClaim(); return; }
        if (rOficina) return;
      }
    }

    // ── Aviso de privacidad, ANTES de CUALQUIER tratamiento (LFPDPPP 16-II) ──
    // AUDITORÍA 3, LEG-C1 (CRÍTICO, reincidente): el gate vivía después de la
    // rama "sin viaje abierto", y esa rama descarga la foto y la manda al
    // modelo de visión — el primer contacto real de un chofer nuevo suele ser
    // once fotos sin viaje, y se trataban con aviso_privacidad_en = NULL.
    // Izado aquí, TODO camino que trate datos (foto huérfana, XML, ticket
    // 1:1, texto al agente) queda detrás del aviso.
    //
    // El obligado es el RESPONSABLE, o sea la flota. Likida solo pone el
    // mecanismo: sin él la flota no puede cumplir aunque quiera.
    //
    // AUDITORÍA E.28, LEG-C1: si el mensaje llegó como nota de voz, la MISMA
    // compuerta ya se evaluó arriba —antes de transcribir, no después— y
    // `avisoConfirmadoAudio` lo registra. No se vuelve a invocar
    // `ponerAvisoADisposicion` una segunda vez para el mismo turno: es la
    // misma compuerta, no una copia.
    const avisoPuesto = avisoConfirmadoAudio
      ? 'puesto' as const
      : await ponerAvisoADisposicion(op.tenantId, op.operadorId, msg.from);
    if (avisoPuesto !== 'puesto') {
      // SIN AVISO NO HAY TRATAMIENTO. Lo que se le dice depende de POR QUÉ no
      // se pudo: «tu empresa no ha configurado su aviso» solo cuando es
      // verdad; un blip nuestro de red no se le cuelga a su patrón.
      logger.error('privacidad.tratamiento_bloqueado', {
        tenant: op.tenantId, operador: op.operadorId, motivo: avisoPuesto,
      });
      try {
        await sendText(msg.from, avisoPuesto === 'sin_datos'
          ? 'No puedo procesar tus comprobantes todavía: tu empresa aún no ha terminado de configurar su aviso de privacidad. Avísale a tu flota. 🙏'
          : 'Se me trabó tantito antes de poder recibir tu comprobante 😕. No es cosa tuya ni de tu empresa. Reenvíamelo en un minuto, por favor. 🙏');
      } catch { /* best-effort */ }
      // Y EL CLAIM SE LIBERA cuando el fallo es nuestro y transitorio: el
      // mensaje NO se procesó, así que no puede quedar contado como
      // procesado. Con `sin_datos` no se libera a propósito — reintentar no
      // da de alta a la flota, y el aviso se vuelve a intentar al siguiente.
      if (avisoPuesto !== 'sin_datos') await soltarClaim();
      return;
    }

    if (!viajeId) {
      // ── EL XML QUE PEDIMOS NO SE TIRA, aunque el viaje ya haya cerrado ──────
      // `complemento_no_verificable` NO está en SOLO_CONTRALOR a propósito: su
      // nota le dice al operador "reenvía el XML (el que te manda la gasolinera
      // por correo)". Y ese texto llega en el MISMO mensaje de cierre, cuando
      // `guardar_liquidacion` ya puso el viaje en 'liquidado'. Así que el
      // operador obedecía, el corte de arriba lo mandaba de vuelta con "no tienes
      // viaje abierto", y el XML se descartaba sin guardarse en ningún lado: el
      // producto pedía un documento y luego se negaba a recibirlo.
      //
      // Se conserva por UUID (CFF 30 lo exige igual) con `gasto_id` nulo. Volver
      // a cuadrar una liquidación ya cerrada es otra decisión —de producto, no de
      // este corte— y por eso aquí solo se garantiza que el dato no se pierda y
      // que al operador se le diga la verdad.
      if (msg.type === 'document' && msg.mediaId) {
        const xmlText = await downloadMediaAsText(msg.mediaId);
        const xml = xmlText ? parseCfdiXml(xmlText) : null;
        // ── FASE 7 (mig. 0199): REP sin viaje abierto — el caso NATURAL ─────
        // El pago de un CFDI a crédito llega semanas después del viaje, casi
        // siempre con el viaje ya cerrado. No necesita viaje de contexto.
        if (xml?.tipoComprobante === 'P' && xmlText) {
          const rep = parseRepXml(xmlText);
          if (rep) {
            const resumen = await ingerirRep(op.tenantId, rep, xmlText);
            logger.info('rep.sin_viaje', { tenant: op.tenantId, rep: rep.uuid, ...resumen });
            await sendText(msg.from, mensajeRepRecibido(resumen));
            return;
          }
        }
        // ── AUDITORÍA 10, CRÍTICO FISCAL — CONSOLIDADO SIN VIAJE ABIERTO ────
        // Un CFDI de monedero/TAG ampara MUCHOS días y MUCHOS viajes — nunca
        // pertenece a "el viaje abierto de este operador", así que esta rama
        // (justamente la de "no hay viaje abierto") es, si acaso, la más
        // natural para recibirlo: no hace falta viaje de contexto porque el
        // consolidado nunca lo usó. Va ANTES del camino de ticket 1:1 de
        // abajo, que asume 1 CFDI = 1 gasto.
        if (xml?.uuid && xml.tipoComprobante === 'E') {
          await sendText(msg.from, await conservarNotaCredito(op.tenantId, xml.uuid, xmlText!));
          return;
        }
        if (xml?.uuid && esConsolidado(xml)) {
          const resumen = await guardarYConciliarConsolidado(op.tenantId, xml, xmlText!);
          logger.info('xml.consolidado_sin_viaje', { tenant: op.tenantId, operador: op.operadorId, uuid: xml.uuid, ...resumen });
          await sendText(msg.from, mensajeConsolidadoRecibido(resumen));
          return;
        }
        if (xml?.uuid) {
          await saveCfdiXmlRaw(op.tenantId, xml.uuid, null, xmlText!);
          logger.info('xml.sin_viaje_abierto', { tenant: op.tenantId, operador: op.operadorId, uuid: xml.uuid });
          await sendText(msg.from, 'Recibí tu XML y ya quedó guardado ✅. Tu viaje ya estaba cerrado, así que tu contralor lo aplica desde el panel. 🙏');
          return;
        }
      }
      // ── LA FOTO TAMPOCO SE TIRA ─────────────────────────────────────────────
      // Era la asimetría más fea del intake: el XML de arriba SÍ se conservaba y
      // la foto —el documento que de verdad importa— se descartaba con un «no
      // tienes viaje abierto», que es cierto y no es lo que pasó. Lo que pasó es
      // que se tiraron sus tickets.
      //
      // Y hay un chofer real detrás: no todos escriben «hola» ni esperan a que
      // la oficina abra el viaje. Terminan la ruta, sacan el fajo y mandan once
      // fotos de golpe. Ese operador perdía once comprobantes sin enterarse.
      //
      // Se le paga la visión AQUÍ, sin viaje: es lo que permite decirle cuánto
      // trae cada uno cuando se le pregunte si van, y evita pagarla otra vez al
      // adjuntarlos. Un comprobante vale mucho más que una llamada de visión.
      if (msg.type === 'image' && msg.mediaId) {
        try {
          // El `??` es el gancho de QA (ver InboundMessage.mediaDataUrlQA):
          // producción siempre trae el campo undefined y descarga de Meta.
          let dataUrl: string | null;
          try {
            dataUrl = msg.mediaDataUrlQA ?? await downloadMediaAsDataUrl(msg.mediaId);
          } catch (e) {
            if (e instanceof ImagenDemasiadoPesadaError) { await sendText(msg.from, MENSAJE_FOTO_PESADA); return; }
            throw e;
          }
          if (!dataUrl) { await sendText(msg.from, 'No pude descargar tu foto 😕. ¿Me la reenvías?'); return; }
          // DAT-01: el hash se calcula UNA vez y se conserva. Antes se usaba
          // para nombrar el archivo del bucket y se tiraba, así que la fila de
          // la sala de espera nacía sin él — y el reproceso del mismo mensaje
          // dejaba DOS filas del mismo papel, que el «sí» del operador
          // adjuntaba las dos. Ahora viaja dentro del `gasto` (el jsonb que
          // `addGasto` lee al adjuntar) y `uq_huerfano_img_hash` (0164) impide
          // la segunda.
          const imgHash = await hashImagen(dataUrl);
          const ruta = await subirComprobante(op.tenantId, 'sin-viaje', imgHash, dataUrl);
          const ex = await extraerComprobante(dataUrl, reloj.senal(25_000), createLlmBudget(op.tenantId, randomUUID(), 'interactivo'));
          await registrarCosto({ tenantId: op.tenantId, viajeId: null, fase: 'ocr', modelo: ex.costo.modelo, tokensIn: ex.costo.tokensIn, tokensOut: ex.costo.tokensOut, costoUsd: ex.costo.costoUsd });
          // ── FALLO NUESTRO: AQUÍ TAMPOCO SE PIERDE EL COMPROBANTE ────────────
          //
          // Es la rama GEMELA del `avisar_falla` de más abajo (el camino CON
          // viaje abierto), y hasta hoy hacía justo lo que aquélla dejó de
          // hacer: tirar la foto sin guardar nada y pedirle al operador que la
          // reenviara «con buena luz y completo el ticket». Dos mentiras en una
          // frase: la foto está bien —`fallo_tecnico` es un 429, un
          // truncamiento o el proveedor de visión caído— y no hay nada que
          // completar, porque no llegamos a leer el ticket. Y el disparador es
          // SISTÉMICO: si falló una foto de la ráfaga, fallaron las once.
          //
          // Este huérfano nace con `monto: 0` (es lo que devuelve
          // `extraerComprobante` cuando truena) y por eso NO entra al
          // ofrecimiento —el filtro `monto > 0` de más abajo—: adjuntarlo
          // metería una línea de $0.00 en la liquidación del contralor, que es
          // una cifra que nadie midió. Se guarda igual porque la fila y la
          // imagen son la evidencia de que ese papel existió; el monto solo
          // vuelve por el reenvío, y por eso el reenvío es lo que se le pide.
          //
          // LO QUE ESTO DEJA ABIERTO (igual que la rama gemela, que ya lo
          // tenía): un huérfano sin monto NUNCA se ofrece, así que nunca se
          // resuelve y se queda en la sala de espera. `getHuerfanos` lee 50 por
          // operador ordenados por antigüedad, o sea que un operador que
          // acumule 50 de éstos —dos o tres caídas del proveedor con ráfagas
          // largas— dejaría de ver los que SÍ tienen monto. No se resuelve aquí
          // porque marcarlos 'descartado' escribiría en la base algo que el
          // operador no dijo; el arreglo va en la lectura (filtrar por monto en
          // la consulta, o subir el tope) y queda anotado.
          if (!ex.legible && ex.motivo === 'fallo_tecnico') {
            const guardado = await guardarHuerfano(op.tenantId, op.operadorId, {
              gasto: { ...ex.gasto, imgHash, ...(ruta ? { imagenUrl: ruta } : {}) },
              motivo: 'fallo_ocr', rutaImagen: ruta,
            });
            logger.warn('huerfano.fallo_tecnico', {
              tenant: op.tenantId, operador: op.operadorId, guardado, conImagen: Boolean(ruta),
            });
            if (!guardado) {
              await sendText(msg.from, 'Se me trabó a mí al leer ese comprobante ⚙️ — no es tu foto — y tampoco lo pude guardar. Conserva el ticket y reenvíamelo en un rato, por favor. 🙏');
              return;
            }
            // MISMO CRITERIO QUE EL ACUSE DE ABAJO: se cuenta lo que ya hay en
            // la sala de espera para no dar once explicaciones idénticas por
            // una falla que es una sola.
            const enEspera = await getHuerfanos(op.tenantId, op.operadorId);
            if (enEspera.length <= 1) {
              await sendText(msg.from, 'Se me trabó a mí al leer ese comprobante ⚙️ — no es tu foto. Guardé la imagen, así que el papel no se pierde, pero no alcancé a leer el monto: ¿me lo reenvías en un ratito para poder contarlo? 📸');
            }
            return;
          }
          // ── AUDITORÍA 24 · WA-2 (ALTO): EL VOUCHER SIN VIAJE NO ES UN GASTO ──
          // Con viaje, `decidirFoto` ya sabe que el voucher de la terminal (o el
          // acercamiento al código) se PEGA al ticket y no se da de alta. Esta
          // rama reutilizaba el `gasto` crudo de la extracción: el voucher
          // entraba a la sala de espera CON monto, se ofrecía junto al ticket
          // («Tengo 2 comprobantes tuyos, $5,780») y un «sí» cobraba la misma
          // carga dos veces. Se guarda para la oficina —la foto es evidencia—
          // pero con `monto: 0`, marcado como lo que es, y por eso nunca se
          // ofrece (solo se ofrece lo que tiene monto).
          if (!ex.legible && (ex.motivo === 'solo_codigo' || ex.motivo === 'solo_pago')) {
            const esVoucher = ex.motivo === 'solo_pago';
            const guardado = await guardarHuerfano(op.tenantId, op.operadorId, {
              gasto: {
                ...ex.gasto, monto: 0, imgHash, ...(ruta ? { imagenUrl: ruta } : {}),
                ocrExtra: { ...(ex.gasto.ocrExtra ?? {}), documento: esVoucher ? 'voucher_pago' : 'acercamiento_codigo', montoDelPapel: ex.gasto.monto },
              },
              motivo: 'sin_viaje', rutaImagen: ruta,
            });
            logger.info('huerfano.voucher_sin_viaje', { tenant: op.tenantId, operador: op.operadorId, motivo: ex.motivo, montoDelPapel: ex.gasto.monto, ok: guardado });
            if (!guardado) {
              await sendText(msg.from, 'No pude guardar ese comprobante ⚙️. Guarda el papel y vuelve a mandarlo en un rato, por favor.');
              return;
            }
            await sendText(msg.from, esVoucher
              ? 'Ese es el voucher de la terminal 💳, no el ticket. Lo guardé para tu oficina, pero lo que cuenta en tu liquidación es el ticket de la gasolinera: mándamelo cuando tengas viaje abierto. 🧾'
              : 'Ese es el acercamiento al código 🔍, no el ticket completo. Lo guardé para tu oficina, pero lo que cuenta es el ticket entero: mándamelo cuando tengas viaje abierto. 🧾');
            return;
          }
          // Ilegible: se le pide otra ANTES de guardar algo que no se puede usar.
          // Aquí sí es la foto (borrosa, cortada, oscura) y reenviarla SIRVE.
          if (!ex.legible) {
            await sendText(msg.from, 'Esa foto salió difícil de leer 🔍. ¿Me la reenvías con buena luz y completo el ticket?');
            return;
          }
          const guardado = await guardarHuerfano(op.tenantId, op.operadorId, {
            gasto: { ...ex.gasto, imgHash, ...(ruta ? { imagenUrl: ruta } : {}) },
            motivo: 'sin_viaje', rutaImagen: ruta,
          });
          logger.info('huerfano.guardado', { tenant: op.tenantId, operador: op.operadorId, monto: ex.gasto.monto, ok: guardado });
          if (!guardado) {
            // Se le dice la verdad: es la única forma de que no lo dé por hecho.
            await sendText(msg.from, 'No pude guardar ese comprobante ⚙️. Guarda el ticket y vuelve a mandarlo en un rato, por favor.');
            return;
          }
          // Cuántos lleva ya, para no acusar once veces en una ráfaga de once.
          const enEspera = await getHuerfanos(op.tenantId, op.operadorId);
          if (enEspera.length <= 1) await sendText(msg.from, mensajeGuardadoSinViaje(enEspera.length));
          return;
        } catch (e) {
          logger.error('huerfano.error', { err: e instanceof Error ? e.message : String(e) });
          await sendText(msg.from, 'Se me trabó tantito al recibir tu foto 😕. ¿Me la reenvías?');
          return;
        }
      }
      // ── EL PIN DE UNA EMERGENCIA SIN VIAJE (c4-6) ──────────────────────
      // El chofer varado SIN viaje al que el bot le pidió su ubicación la
      // mandaba y recibía "no tienes un viaje abierto para liquidar 👍" —
      // grosero en una emergencia, y el pin se tiraba. Si tiene expediente de
      // asistencia vivo, el pin se ancla ahí y el jefe recibe el link.
      if (msg.type === 'location' && typeof msg.lat === 'number' && typeof msg.lng === 'number') {
        const anclada = await anclarUbicacionIncidencia(op.tenantId, op.operadorId, msg.lat, msg.lng);
        if (anclada) {
          const avisado = await avisarUbicacionAlJefe(op, `https://maps.google.com/?q=${msg.lat},${msg.lng}`, 'compartió su ubicación (emergencia en curso)', { operador: op.operadorId });
          await sendText(msg.from, avisado
            ? '📍 Recibida tu ubicación — quedó en tu reporte de emergencia y ya se la pasé a tu jefe.'
            : '📍 Recibida tu ubicación — quedó en tu reporte de emergencia, pero NO pude pasársela a tu jefe por WhatsApp. Si es urgente, márcale directo.');
          return;
        }
        // Sin expediente vivo, el pin sin viaje sigue al mensaje de abajo.
      }
      // ── ¿VARADO SIN VIAJE? (0198, punto C) ─────────────────────────────
      // "Estoy varado" sin viaje abierto merecía algo mejor que "no tienes un
      // viaje abierto para liquidar". El ROJO ya se atendió arriba (antes del
      // gate); aquí se ata el ámbar al operador, con viaje_id null.
      if (msg.type === 'text' && msg.text) {
        const ambar = interpretarAsistencia(msg.text);
        if (ambar) {
          const r = await atenderAsistenciaChofer({
            tenantId: op.tenantId,
            viajeId: null,
            operadorId: op.operadorId,
            texto: msg.text,
            asistencia: ambar,
            waMessageId: msg.waMessageId ?? null,
          });
          logger.info('asistencia.sin_viaje', { operador: op.operadorId, nivel: ambar.nivel });
          await sendText(msg.from, r.respuesta);
          return;
        }
      }
      // ── ¿MARCA DE JORNADA SIN VIAJE? (LFT 132-XXXIV, mig. 0241) ────────
      // El caso NATURAL, no el raro: el operador llega al patio a las seis y
      // le asignan viaje a las nueve. Esas tres horas son jornada, y hasta hoy
      // el sistema le contestaba «no tienes un viaje abierto para liquidar».
      // Va después del ámbar (una emergencia le gana a fichar) y antes del
      // fallback.
      if (msg.type === 'text') {
        const jornada = await atenderJornadaSiAplica({
          tenantId: op.tenantId,
          operadorId: op.operadorId,
          texto: msg.text,
          momento: msg.timestampMs ? new Date(msg.timestampMs) : new Date(),
          waMessageId: msg.waMessageId ?? null,
          viajeId: null,
        });
        if (jornada) {
          for (const t of jornada) await sendText(msg.from, t);
          return;
        }
      }

      // ── ¿ES EL REINTENTO DE UN CIERRE QUE SÍ OCURRIÓ? (auditoría 21, C1) ──
      // El chofer al que un fallo posterior a `guardar_liquidacion` le dijo
      // "se me trabó, ¿me reenvías tu último mensaje?" obedece y cae AQUÍ,
      // porque su viaje ya es `liquidado`. "No tienes un viaje abierto" es
      // verdad a medias y él la lee como "tu cierre no existió". Si hay una
      // liquidación reciente suya, se le confirma el cierre — la verdad
      // completa. `liquidacionRecienteDe` es fail-open (null si no se supo):
      // el mensaje genérico de abajo sigue siendo cierto en ese caso.
      try {
        const reciente = await liquidacionRecienteDe(op.tenantId, op.operadorId);
        if (reciente) {
          logger.info('sin_viaje.cierre_confirmado', { tenant: op.tenantId, operador: op.operadorId, viaje: reciente.viajeId, liq: reciente.liquidacionId });
          // AGEN-4: se ENTREGA lo que ese cierre dejó pendiente (PDF al
          // chofer, aviso al jefe) y se narra lo que de verdad pasó.
          const entrega = await entregarCierrePendiente(op, msg.from, reciente);
          logger.info('sin_viaje.cierre_entregado', { tenant: op.tenantId, viaje: reciente.viajeId, liq: reciente.liquidacionId, ...entrega });
          await sendText(msg.from, mensajeCierreConfirmado(entrega));
          return;
        }
      } catch (e) {
        // Nunca debería lanzar (es fail-open), pero un aviso accesorio no
        // puede tirar la respuesta del turno.
        logger.warn('sin_viaje.liquidacion_reciente', { err: e instanceof Error ? e.message : String(e) });
      }
      await sendText(msg.from, 'No tienes un viaje abierto para liquidar ahorita. Cuando tu flota te asigne uno, aquí lo cerramos. 👍');
      return;
    }

    // Helper: enviar + contar el costo. DEVUELVE SI SALIÓ, y ahí está el asunto.
    //
    // `sendText` NO lanza cuando Meta rechaza: devuelve `null` (y su propio
    // comentario dice que el éxito deja rastro justo para poder distinguirlos).
    // Aquí se tiraba ese resultado, así que un mensaje rebotado se trataba igual
    // que uno entregado. Dos consecuencias, y las dos se vieron en producción el
    // 1-ago con un `131030` (destinatario fuera de la lista de Meta):
    //
    //   · el turno del asistente se guardaba en la conversación igual, así que
    //     el agente CREÍA haber saludado a alguien que nunca leyó nada, y en el
    //     siguiente mensaje contestaba como si viniera de una charla en curso;
    //   · y se cobraba el costo de un mensaje que no se entregó, inflando el
    //     costo por liquidación.
    //
    // Es la misma familia que la constancia falsa del aviso de privacidad, que
    // se cerró esta misma semana: registrar como hecho algo que no ocurrió.
    const say = async (text: string): Promise<boolean> => {
      const id = await sendText(msg.from, text);
      if (!id) return false;
      await registrarCostoWhatsApp(op.tenantId, viajeId);
      return true;
    };

    // (El gate del aviso de privacidad vivía aquí y se IZÓ arriba, antes de
    // la rama sin-viaje — auditoría 3, LEG-C1: esa rama trataba la foto
    // huérfana con visión externa sin aviso puesto.)


    // ── IMAGEN: captura SILENCIOSA en PARALELO (acuse consolidado) ────────────
    // Las fotos NO toman el mutex: corren en paralelo (rápido). Cada una hace +1
    // al contador de intake al entrar y -1 al salir; el "listo" espera a que ese
    // contador llegue a 0 antes de cuadrar → nunca cierra sobre datos parciales.
    if (msg.type === 'image' && msg.mediaId) {
      // ── ¿ES LA CARTA PORTE SELLADA? (POD por foto, F4) ────────────────────
      //
      // El CAPTION es la única señal determinística de qué papel es la foto;
      // sin él, la foto sigue el camino de comprobante como siempre. Este
      // branch va ANTES de la barrera de intake a propósito: la carta porte
      // no es un gasto —no paga visión, no entra a la liquidación— y el
      // "listo" no debe esperarla. Aterriza en `pod`, que el tablero del
      // encargado ya cuenta (`podPendientes`).
      if (esCaptionPod(msg.text)) {
        try {
          // Gancho de QA (ver InboundMessage.mediaDataUrlQA) — undefined en producción.
          let dataUrl: string | null;
          try {
            dataUrl = msg.mediaDataUrlQA ?? await downloadMediaAsDataUrl(msg.mediaId);
          } catch (e) {
            if (e instanceof ImagenDemasiadoPesadaError) { await say(MENSAJE_FOTO_PESADA); return; }
            throw e;
          }
          if (!dataUrl) { await say('No pude descargar tu foto 😕. ¿Me la reenvías?'); return; }
          // El constraint pod_subido_tiene_archivo manda: sin archivo guardado
          // no hay "subido" que registrar. Fallar cerrado y decirlo.
          const ruta = await subirComprobante(op.tenantId, viajeId, await hashImagen(dataUrl), dataUrl);
          if (!ruta) {
            logger.error('pod.foto_sin_guardar', { viaje: viajeId, tenant: op.tenantId });
            await say(mensajePod('fallo'));
            return;
          }
          const resultado = await guardarPodDelChofer(op.tenantId, viajeId, op.operadorId, ruta);
          await say(mensajePod(resultado));
        } catch (e) {
          logger.error('pod.error', { viaje: viajeId, err: e instanceof Error ? e.message : String(e) });
          await say(mensajePod('fallo'));
        }
        return;
      }

      // El +1 de esta foto. El valor devuelto ya NO decide el acuse (ver abajo):
      // decidirlo con "el contador pasó de 0 a 1" mandaba el mensaje una vez por
      // foto. Se conserva la llamada porque su EFECTO —el incremento— es lo que
      // sostiene la barrera del "listo".
      //
      // AUDITORÍA 7, ALTO — EL PAR +1/-1 NO ERA SIMÉTRICO ANTE EL ERROR. Si este
      // +1 fallaba (RPC transitoria → `null`), el código seguía de largo a
      // descargar/OCR/registrar el gasto igual, sosteniendo la barrera con un
      // incremento que NUNCA ocurrió — y el `finally` de abajo decrementa PASE
      // LO QUE PASE. Si el OCR de esa foto no termina antes de que el operador
      // escriba "listo", el cuadre cierra SIN ese comprobante, sin avisar, y el
      // operador paga de su bolsa un gasto que sí hizo.
      //
      // Fail-closed: sin incremento confirmado, no se sigue procesando esa foto
      // (nada que insertar sin que la barrera lo sepa) y se avisa, en vez de
      // fallar en silencio. Como no hubo +1, tampoco se ejecuta el -1 gemelo:
      // no hay nada que compensar, y compensarlo de todos modos recortaría el
      // contador de OTRA foto que sí está en vuelo (`greatest(0,…)` no distingue
      // de quién es el crédito).
      const incrementado = await intakeDelta(viajeId, 1);
      if (incrementado == null) {
        logger.error('intake.incremento_fallido', { viaje: viajeId, tenant: op.tenantId });
        await say('No pude registrar tu foto en el orden correcto 😕. Reenvíala en un momento y, si ya escribiste *listo*, vuelve a escribirlo cuando te confirme que la recibí.');
        // Y SE LIBERA EL CLAIM, que faltaba. Este `return` dejaba el mensaje
        // marcado en `wa_mensaje_procesado` para siempre — el mismo patrón que el
        // `return` del mutex ocupado (abajo) arregló el mismo día, con su propio
        // comentario: "seguía reclamado PARA SIEMPRE... el modo de falla 'se
        // trabó' sin que nadie diga que se trabó".
        //
        // Aquí duele menos —se le pide al operador que reenvíe, y un reenvío
        // manual trae otro `waMessageId`— pero la asimetría es real: el catch
        // general y el mutex sí lo liberan. Un mensaje que no se procesó no puede
        // quedar contado como procesado.
        await soltarClaim();
        return;
      }
      // La foto YA cuenta para la barrera, así que también cuenta para el
      // resumen: `vistas` es el "de tus N fotos" del mensaje de cierre. Va aquí
      // y no más abajo para que una foto que se cae en la descarga también se
      // cuente — el operador la mandó, y el resumen tiene que cuadrar con lo
      // que él mandó, no con lo que nosotros logramos procesar.
      //
      // `incrementado === 1` marca además el ARRANQUE de una ráfaga: no había
      // nada en vuelo, así que lo que quedara anotado es de una anterior que
      // murió sin cerrarse y no puede sumarse a ésta.
      //
      // AUDITORÍA 19 (AGEN-19C2-1): bajo ejecución SERIAL por chofer,
      // `incrementado === 1` es cierto para CADA foto del fajo (nunca hay dos
      // en vuelo), así que sin el freno de abajo esta línea BORRABA la
      // libreta de las fotos anteriores en cuanto llegaba la siguiente —
      // `anotarFoto(viajeId, true)` empieza descartando lo que hubiera. Si
      // `hayFotoAntesEnCadena` dice que ya hubo OTRA foto antes en esta misma
      // cadena, ya se sabe que lo anotado es de ESTA MISMA ráfaga, no de una
      // muerta. (Antes se usaba `cadenaPosicion > 0`, que contaba cualquier
      // mensaje — un texto antes de la primera foto de la cadena hacía que
      // esa primera foto SÍ se tratara como "siguiente", perdiendo el reset
      // que le tocaba: ver la nota de `OpcionesInbound` arriba.)
      const siguienteDeLaMismaCadena = opts.hayFotoAntesEnCadena === true;
      anotarFoto(viajeId, incrementado === 1 && !siguienteDeLaMismaCadena, msg.from);
      // AQUÍ VIVÍA `llegoSola = incrementado === 1`, y era falso justo cuando
      // más importaba. `1` no significa «llegó sola»: significa «es la primera
      // en vuelo», y toda ráfaga tiene una primera. El incremento es atómico,
      // así que en un fajo de 22 exactamente una foto lo veía, contestaba por
      // su cuenta, y luego el resumen la volvía a contar — el chofer leía el
      // mismo trabón dos veces (medido, 20-ago-2026).
      //
      // Los tres caminos que contestaban por foto ahora ANOTAN su mensaje en la
      // libreta (`mensajeSolo`) y se callan. Quien sí sabe si hubo ráfaga es el
      // `finally`: cuando el contador vuelve a 0 tiene el `vistas`. Ver
      // `intake/rafaga.ts`.
      try {
        // Gancho de QA (ver InboundMessage.mediaDataUrlQA) — undefined en producción.
        let dataUrl: string | null;
        try {
          dataUrl = msg.mediaDataUrlQA ?? await downloadMediaAsDataUrl(msg.mediaId);
        } catch (e) {
          if (e instanceof ImagenDemasiadoPesadaError) { await say(MENSAJE_FOTO_PESADA); return; }
          throw e;
        }
        if (!dataUrl) { await say('No pude descargar tu foto 😕. ¿Me la reenvías?'); return; }

        // ── EL HASH SE CALCULA SIEMPRE (DAT-01, CRÍTICO) ────────────────────
        //
        // Aquí vivía `if (process.env.LIKIDA_DEDUP_FOTOS === '1')`, y esa
        // bandera NO está puesta en producción. O sea: ningún gasto de
        // producción llevaba `img_hash`, y `uq_gasto_img_hash` (0027) —el único
        // candado que impide cobrar el mismo ticket dos veces cuando el papel
        // no trae CFDI, que es el caso de TODO ticket de gasolinera— llevaba
        // meses indexando el vacío. La protección existía en el esquema, en el
        // repo y en los comentarios; no existía en la base.
        //
        // La bandera se retira entera en vez de encenderse: una protección de
        // dinero que se puede apagar con una variable de entorno es una
        // protección que un despliegue puede apagar sin que nadie lo note, y
        // así fue exactamente como se apagó ésta.
        //
        // Cuesta un SHA-256 sobre los bytes que ya están en memoria, al lado de
        // una llamada de visión de ~$0.015. No es una decisión de costo.
        const imgHash = await hashImagen(dataUrl);
        const resolverIncidenteOcrDeEstaFoto = async (): Promise<void> => {
          try {
            const incidentes = await getHuerfanos(op.tenantId, op.operadorId, {
              viajeId, soloFalloOcr: true, fallarCerrado: true,
            });
            const ids = incidentes
              .filter((h) => h.gasto.imgHash === imgHash)
              .map((h) => h.id);
            if (ids.length) {
              const sellados = await resolverHuerfanos(op.tenantId, ids, 'adjuntado', viajeId);
              if (!sellados) logger.error('foto.fallo_ocr_no_resuelto', { viaje: viajeId, tenant: op.tenantId, ids });
            }
          } catch (e) {
            // El gasto válido ya está (o ya estaba) en la base. No se revierte;
            // el incidente queda abierto y, por diseño, seguirá bloqueando el
            // cierre hasta que esta resolución durable se pueda escribir.
            logger.error('foto.fallo_ocr_resolucion_ilegible', {
              viaje: viajeId, tenant: op.tenantId,
              err: e instanceof Error ? e.message : String(e),
            });
          }
        };
        if (await gastoExistePorHash(viajeId, imgHash, op.tenantId)) {
          logger.info('foto.dedup', { viaje: viajeId });
          await resolverIncidenteOcrDeEstaFoto();
          // EL SILENCIO ES CORRECTO… SALVO CUANDO ESA FOTO ES LA QUE SE PIDIÓ.
          //
          // Fallo del ensayo del 1-ago: se le pidió otra foto de un ticket con
          // la fecha mal leída, reenvió EL MISMO archivo, y esto lo descartó
          // antes del OCR sin decir nada. Hizo lo que se le pidió, no pasó
          // nada, y no tenía forma de enterarse — el peor modo de falla que
          // hay, porque desde su lado el sistema quedó mudo.
          //
          // Para un reenvío cualquiera (doble toque, reintento) el silencio
          // sigue siendo lo correcto: avisarle de cada foto repetida sería
          // ruido. Lo que cambia el caso es que el gasto que empata tenga la
          // fecha en duda, porque entonces esa foto NO puede aportar nada:
          // es la misma que ya se leyó mal.
          //
          // AUDITORÍA 24 · AGEN-11 (BAJO): dentro de una ráfaga, callar rompe
          // la cuenta. `anotarFoto` ya la contó en «de tus 5 fotos», el gasto
          // no se duplicó, y el resumen decía «llevo 4 comprobantes» sin
          // explicar la resta: el chofer la reenvía y vuelve el silencio. Se
          // anota en la libreta (no se manda nada por sí sola: para una foto
          // suelta el silencio SIGUE siendo lo correcto) y el resumen de la
          // ráfaga dice «*1* venía repetida (ya la tenía)».
          let avisadaPorFecha = false;
          try {
            const [previo, v] = await Promise.all([
              gastoPorHash(viajeId, imgHash, op.tenantId),
              ventanaDesdeDB(op.tenantId, viajeId),
            ]);
            if (previo && v && fechaDudosa(previo.fecha, v)) {
              await say(`Esa es la *misma foto* que ya me habías mandado 🔁, así que la fecha sigue igual. Necesito una foto *nueva* de ese ticket de ${mxn(previo.monto)} —tomada otra vez, no reenviada— enfocando la parte donde viene la fecha. 📸`);
              avisadaPorFecha = true;
            }
            if (!avisadaPorFecha) anotarIncidencia(viajeId, { tipo: 'repetida', monto: previo?.monto ?? null });
          } catch (e) {
            // Best-effort: el dedup ya hizo su trabajo. Fallar aquí no puede
            // costar un gasto, solo un aviso.
            logger.warn('foto.dedup_aviso_falló', { err: e instanceof Error ? e.message : String(e) });
            if (!avisadaPorFecha) anotarIncidencia(viajeId, { tipo: 'repetida' });
          }
          return; // ya la teníamos: no re-OCR, no duplicar gasto
        }

        // LA FOTO SE GUARDA, y se arranca AQUÍ para que corra en paralelo con
        // la visión: esperarla después costaría segundos de pared que no hacen
        // falta, porque nadie la necesita hasta el `addGasto` de más abajo.
        //
        // Hasta hoy no se guardaba ninguna (22 gastos en producción, 0 con
        // `imagen_url`). El CFF art. 30 obliga a conservar el comprobante cinco
        // años, y un gasto con monto y folio pero sin el papel es una fila en
        // una tabla. Además es lo único que dirime un OCR discutido: sin la
        // foto, es la palabra del sistema contra la del operador.
        //
        // No se hace `await` aquí y `subirComprobante` nunca lanza: si falla, el
        // gasto entra sin imagen. Perder el comprobante por no poder guardar su
        // retrato sería cambiar un problema chico por el grande.
        const subida = subirComprobante(
          op.tenantId, viajeId, imgHash ?? randomUUID(), dataUrl,
        );

        // La foto también respeta el reloj: 25s de tope propio, o menos si ya se
        // gastó el presupuesto. Sin esto caía al default del SDK (10 min).
        //
        // AUDITORÍA 9 — REVERTIDO: aquí vivió `foto_pendiente`, un intento de
        // retener el ticket sin código unos segundos por si llegaba el
        // acercamiento, para pagar una sola visión en vez de dos. Dos
        // auditores independientes (agéntico, backend) encontraron que
        // `reclamarFotoPendiente(tenantId, { viajeId })` reclamaba CUALQUIER
        // foto pendiente del viaje sin verificar que fuera el par correcto:
        // un voucher o cualquier otra foto con código que llegara mientras un
        // ticket sin código esperaba se fusionaba con él, y el gasto real de
        // esa segunda foto desaparecía de la liquidación sin aviso. El ahorro
        // (~$0.015/ticket de dos fotos) no justificaba ese riesgo a 5 días del
        // demo — decisión explícita de Javier, 1-ago-2026. Cada foto vuelve a
        // pagar su propia visión, como antes de la auditoría 8.
        const extraccion = await extraerComprobante(dataUrl, reloj.senal(25_000), createLlmBudget(op.tenantId, randomUUID(), 'interactivo'));
        const { gasto, costo } = extraccion;
        await registrarCosto({ tenantId: op.tenantId, viajeId, fase: 'ocr', modelo: costo.modelo, tokensIn: costo.tokensIn, tokensOut: costo.tokensOut, costoUsd: costo.costoUsd });

        // Los gastos ya registrados se leen para EMPAREJAR: el acercamiento del
        // protocolo de dos fotos y el voucher de la terminal — y, desde el
        // 1-ago, también en el camino legible, por la corrección de fecha de
        // abajo.
        //
        // La lista tiene que coincidir con la de `decidirFoto`. Si aquí falta un
        // motivo que allá empareja, `gastos` llega vacío, `emparejarPorMonto` no
        // encuentra nada y el operador recibe "mándame el ticket" por uno que ya
        // mandó — sin error en ningún lado. `decidir_empareja.test.ts` fija las
        // dos listas juntas.
        const EMPAREJAN = ['solo_codigo', 'solo_pago'];
        // Una foto LEGIBLE también necesita los gastos y la ventana del viaje:
        // es lo que permite reconocer que ésta es la SEGUNDA foto de un ticket
        // cuya fecha no cuadraba, y re-fechar el gasto que ya existe en vez de
        // dar de alta otro. Sin eso, la foto que se le pidió al operador entra
        // como gasto nuevo y —si el ticket no trae folio, que es la llave del
        // dedup— cobra el mismo consumo dos veces.
        //
        // En paralelo para que cueste un viaje a la base y no tres. Al lado de
        // la llamada de visión que acaba de correr, es ruido.
        const [yaRegistrados, ventana, viajeDelGasto] = await Promise.all([
          extraccion.legible || EMPAREJAN.includes(extraccion.motivo ?? '')
            ? getGastos(viajeId, op.tenantId) : Promise.resolve([]),
          // FAIL-OPEN a propósito: si esto falla, `ventana` queda `undefined` y
          // el intake se comporta como antes —sin corrección y sin petición—.
          // Tumbar la foto por no poder calcular una ventana sería cambiar una
          // mejora por una pérdida de comprobante.
          extraccion.legible
            ? ventanaDesdeDB(op.tenantId, viajeId).catch((e) => {
                logger.warn('foto.ventana_no_disponible', { err: e instanceof Error ? e.message : String(e) });
                return undefined;
              })
            : Promise.resolve(undefined),
          // DAT-18: el ANTICIPO, que es la escala contra la que se mide si una
          // cifra tiene sentido en este viaje. Va en el mismo `Promise.all` para
          // que no cueste un viaje más a la base; fail-open por el mismo motivo
          // que la ventana —sin anticipo el umbral cae al piso de $50,000 y el
          // intake se comporta como antes, no se pierde la foto—.
          extraccion.legible
            ? getViaje(viajeId, op.tenantId).catch((e) => {
                logger.warn('foto.anticipo_no_disponible', { err: e instanceof Error ? e.message : String(e) });
                return null;
              })
            : Promise.resolve(null),
        ]);
        // ── DAT-18 · ¿ESTA CIFRA CABE EN ESTE VIAJE? ────────────────────────
        //
        // La marca viaja en `ocrExtra` (no en una columna): es una observación
        // sobre la LECTURA, igual que `montoDiscrepante` y `textoSospechoso`, y
        // el motor la levanta como diferencia al cuadrar. Se calcula una sola
        // vez y con la MISMA función que usa el motor (`esMontoImplausible`),
        // para que el chofer y el contralor no vean dos umbrales distintos.
        const montoImplausible = esMontoImplausible(extraccion.gasto.monto, viajeDelGasto?.anticipo);
        if (montoImplausible) {
          logger.warn('foto.monto_implausible', {
            viaje: viajeId, tenant: op.tenantId,
            monto: extraccion.gasto.monto, umbral: umbralMontoImplausible(viajeDelGasto?.anticipo),
          });
          extraccion.gasto.ocrExtra = { ...(extraccion.gasto.ocrExtra ?? {}), montoImplausible: true };
        }
        const decision = decidirFoto(extraccion, yaRegistrados, ventana);

        // Pedir reenvío SOLO cuando reenviar arregla algo. Si el fallo fue
        // nuestro (truncamiento, provider caído), la misma foto falla igual:
        // decirle "mándala con mejor luz" lo manda a un bucle y le echa la culpa
        // de un bug nuestro.
        // ── FALLO NUESTRO: EL COMPROBANTE NO SE PIERDE ───────────────────────
        //
        // Era el ÚNICO camino de pérdida que no guardaba nada. Los otros dos
        // —la foto sin viaje abierto y la que llega tras liquidar— pasan por
        // `guardarHuerfano` y se le ofrecen al operador en su siguiente viaje;
        // éste se despedía con "hay que capturarlo aparte" y tiraba la foto.
        //
        // Y ese trámite NO EXISTE: `addGasto` es el único insert sobre `gasto`
        // en todo el repo y sus tres llamadores viven en este archivo, todos en
        // el camino de WhatsApp. No hay alta manual en el panel, ni en una API,
        // ni en ningún lado. O sea que el mensaje mandaba al operador a hacer
        // algo imposible con un papel que nadie iba a capturar — verificado el
        // 4-ago-2026 antes de tocar esta rama.
        //
        // Encima el disparador es SISTÉMICO: `fallo_tecnico` es un 429, un
        // truncamiento o el proveedor caído, así que en una ráfaga de 22 no
        // falla una, fallan las 22. Perderlas todas y decírselo 22 veces era el
        // peor par posible.
        if (decision.accion === 'avisar_falla') {
          // AHORA SÍ SE ESPERA LA SUBIDA. Aquí abajo la promesa se quedaba
          // flotando: la ruta del objeto se descartaba y, si la invocación se
          // congelaba antes de que resolviera, no quedaba ni la imagen.
          const ruta = await subida;
          const guardado = await guardarHuerfano(op.tenantId, op.operadorId, {
            gasto: {
              ...gasto,
              imgHash,
              ...(ruta ? { imagenUrl: ruta } : {}),
            },
            // `fallo_ocr` y ya no `sin_viaje` (4-ago-2026). La nota anterior
            // decía que el motivo real era éste y que se dejaba pendiente por
            // no tocar `repo.ts`; se tocó, y la columna es `text` a secas sin
            // CHECK (0040), así que el valor honesto entra sin migración.
            // `sin_viaje` describía el efecto y escondía la causa: la foto no
            // se quedó fuera por no haber viaje —lo hay—, sino porque se cayó
            // NUESTRO OCR.
            motivo: 'fallo_ocr', rutaImagen: ruta, viajeId,
          });
          logger.warn('foto.fallo_tecnico_guardado', { viaje: viajeId, tenant: op.tenantId, guardado, conImagen: Boolean(ruta) });
          // SE ANOTA SIEMPRE, y con ella el texto que le tocaría si resultara
          // que llegó sola. Anotarla también cuando venía acompañada es lo que
          // hace que el resumen cuadre con lo que el operador mandó: "de tus 22
          // fotos, 22 se me trabaron" en vez de un resumen que dice 21 y parece
          // otra cosa. Quién habla —éste o el resumen— lo decide el `finally`.
          anotarIncidencia(viajeId, {
            tipo: 'fallo_tecnico',
            mensajeSolo: guardado
              // AGEN-12 (BAJO): NO se promete «te lo ofrezco en el siguiente» —
              // un huérfano sin monto nunca se ofrece; lo que lo recupera es
              // el reenvío, y eso es lo que se pide.
              ? 'Se me trabó a mí al leer ese comprobante ⚙️ — no es tu foto. Guardé la imagen para tu oficina, así que el papel *no se pierde*, pero no alcancé a leer el monto: reenvíamela en un momento para poder contarla. 📸'
              : 'Se me trabó a mí al leer ese comprobante ⚙️ y tampoco lo pude guardar. Conserva el ticket y reenvíamelo en un rato, por favor. 🙏',
          });
          return;
        }
        if (decision.accion === 'pedir_reenvio') {
          // Mismo criterio: una gasolinera mal iluminada de noche no arruina una
          // foto, arruina las veintidós. Se consolidan en el resumen.
          anotarIncidencia(viajeId, {
            tipo: 'ilegible',
            mensajeSolo: 'Esa foto salió difícil de leer 🔍. ¿Me la reenvías con buena luz y completo el ticket?',
          });
          return;
        }
        // Acercamiento del protocolo de dos fotos: hizo lo correcto, no se le
        // regaña. Pero un código por su cuenta NO se da de alta como gasto —
        // vale el mismo dinero que el ticket que le toca, y sumar los dos
        // inflaría la liquidación.
        if (decision.accion === 'pedir_ticket') {
          // A la BANDEJA (mig. 0016): el acercamiento llegó antes que su ticket.
          // Sin esto, el folio exacto que trae el código se perdía y el gasto se
          // quedaba con el que leyó la visión — que es justo el que baila.
          // QUÉ SE LE PIDE DEPENDE DE QUÉ MANDÓ. A quien mandó el voucher de la
          // terminal se le decía «mándame el ticket completo», y de ese papel no
          // hay ticket más completo: se queda esperando algo que no existe. Lo
          // que le falta es OTRO documento — el del comercio, que es el que trae
          // los litros y el RFC para facturar.
          const pideOtroPapel = decision.porVoucher
            ? 'Ese es el comprobante de la *terminal* (el de la tarjeta) 💳, y ése no sirve para facturar. Mándame el ticket del *comercio* — el que trae los litros y el RFC. 🧾'
            : 'Ya tengo el código de ese ticket 👍. Mándame también la foto del *ticket completo* para registrar el gasto.';
          const extra = (gasto.ocrExtra ?? {}) as Record<string, unknown>;
          try {
            await guardarCodigoPendiente(op.tenantId, viajeId, {
              monto: gasto.monto,
              folioPortal: extra.folioPortal as string | undefined,
              codigoBarras: extra.codigoBarras as string | undefined,
              urlFacturacion: extra.urlFacturacion as string | undefined,
              cfdiUuid: gasto.cfdiUuid,
            });
            logger.info('foto.codigo_en_espera', { viaje: viajeId, monto: gasto.monto });
          } catch (e) {
            // Si la 0016 no está aplicada esto truena. Dejarlo salir tumbaría el
            // procesamiento de la foto y Meta reintentaría el webhook en bucle.
            // Se pierde el folio exacto (grave, por eso ERROR) pero el operador
            // igual recibe la instrucción y el gasto entra con la foto del ticket.
            logger.error('foto.codigo_en_espera_error', { err: e instanceof Error ? e.message : String(e) });
          }
          // UNA VEZ POR VIAJE, no una por acercamiento. Mismo criterio que el
          // acuse de la ráfaga, y por la misma razón: en el primer ensayo real
          // (1-ago) tres acercamientos seguidos produjeron TRES avisos idénticos
          // uno detrás de otro. El operador no necesita que se lo digan tres
          // veces; necesita entender el protocolo una vez.
          //
          // Se ata al PRIMER código pendiente del viaje, que es cuando de verdad
          // hace falta explicarlo. Y como el `guardarCodigoPendiente` de arriba
          // ya ocurrió, si esto devuelve 1 es que éste es el primero.
          //
          // La carrera —dos acercamientos simultáneos que guardan antes de que
          // cualquiera cuente— hace que se pierda el aviso, no que se duplique.
          // Igual que con el acuse: perder uno es molesto, mandar tres es un
          // producto que se ve roto.
          //
          // DAT-37 — EL `say()` NO PUEDE VIVIR DENTRO DEL `catch`. Aquí había
          // un `await say(...)` como fallback del conteo, y esa es la forma de
          // la que trata el hallazgo entero: una llamada de red en el camino de
          // recuperación, sin nada que la atrape. Si `say` lanzaba (Meta 500,
          // el registro del costo contra una base caída), el turno completo se
          // caía DESPUÉS de haber guardado el código pendiente, el catch
          // general soltaba el claim, y la bandeja durable reprocesaba el mismo
          // mensaje: segunda fila en la bandeja de códigos. El índice de la
          // 0164 ya impide la fila; esto impide el bucle que la provocaba.
          //
          // El criterio de fondo no cambia: si no se puede contar, se avisa
          // igual —es peor dejar al operador sin instrucción que repetírsela—.
          const primeroDelViaje = await getCodigosPendientes(viajeId, op.tenantId)
            .then((p) => p.length <= 1)
            .catch((e) => {
              logger.warn('foto.codigos_no_contados', { viaje: viajeId, err: e instanceof Error ? e.message : String(e) });
              return true;
            });
          if (primeroDelViaje) {
            try { await say(pideOtroPapel); } catch (e) {
              logger.warn('foto.codigo_aviso_falló', { viaje: viajeId, err: e instanceof Error ? e.message : String(e) });
            }
          }
          return;
        }
        // LA FOTO QUE SE LE PIDIÓ: re-fecha el gasto que ya existe.
        //
        // No da de alta nada. Es el mismo papel, y darlo de alta otra vez lo
        // cobraría dos veces cuando el ticket no trae folio —la llave con la que
        // `copiasDeComprobante` deduplica—. Se toca UNA columna: la fecha.
        if (decision.accion === 'corregir_fecha') {
          try {
            await corregirFechaGasto(op.tenantId, decision.gastoId, decision.fecha);
            logger.info('foto.fecha_corregida', { viaje: viajeId, gasto: decision.gastoId, fecha: decision.fecha });
            await say(`Ya quedó ✅ — ese ticket de ${mxn(gasto.monto)} ahora tiene fecha *${fechaMx(decision.fecha)}*. No lo registré otra vez: es el mismo gasto, solo con la fecha corregida.`);
          } catch (e) {
            // Mismo hecho que en el alta: la liquidación de este viaje ya se
            // emitió y el trigger de la 0037 lo impide. Aquí el operador hizo
            // exactamente lo que se le pidió, así que callarlo sería peor que en
            // el alta: creería que su corrección entró.
            if (llegoTarde(e)) {
              logger.warn('foto.correccion_llego_tarde', { viaje: viajeId, gasto: decision.gastoId });
              await say(`Esa foto llegó después de que cerré tu liquidación, así que la fecha quedó como estaba. Pídele a la oficina que corrija el ticket de ${mxn(gasto.monto)}: la fecha buena es ${fechaMx(decision.fecha)}.`);
              return;
            }
            logger.error('foto.correccion_error', { err: e instanceof Error ? e.message : String(e) });
            await say(`No pude guardar la fecha corregida de ese ticket de ${mxn(gasto.monto)} ⚙️. Avísale a la oficina: la fecha buena es ${fechaMx(decision.fecha)}.`);
          }
          return;
        }
        if (decision.accion === 'enriquecer') {
          const destino = yaRegistrados.find((g) => g.id === decision.gastoId);
          if (destino) {
            const extra = (gasto.ocrExtra ?? {}) as Record<string, unknown>;
            try {
              const pegado = await enriquecerGastoConCodigo(op.tenantId, destino, {
                folioPortal: extra.folioPortal as string | undefined,
                codigoBarras: extra.codigoBarras as string | undefined,
                urlFacturacion: extra.urlFacturacion as string | undefined,
                cfdiUuid: gasto.cfdiUuid,
              });
              // false = ese gasto ya tenía su acercamiento. No es un error: es
              // el claim haciendo su trabajo (dos acercamientos del mismo total,
              // o el mismo reenviado). El primero se queda, que es lo correcto.
              logger.info(pegado ? 'foto.acercamiento_pegado' : 'foto.acercamiento_ya_tenia',
                { viaje: viajeId, gasto: destino.id });
            } catch (e) {
              // Si la 0017 no está aplicada, el RPC no existe. Dejarlo salir
              // tumbaría el procesamiento y Meta reintentaría el webhook en
              // bucle. Se pierde el folio del acercamiento (grave, por eso
              // ERROR) pero el gasto ya está registrado con su monto.
              logger.error('foto.acercamiento_error', { err: e instanceof Error ? e.message : String(e) });
            }
          }
          return; // silencioso: el acuse de la ráfaga ya se dio con la 1ª foto
        }
        try {
          // Aquí sí se espera la subida: es lo único que faltaba del gasto, y
          // para este punto lleva corriendo todo el rato que tardó la visión.
          const imagenUrl = await subida;
          await addGasto(op.tenantId, viajeId, {
            ...gasto,
            imgHash,
            // DAT-01: la llave del REPROCESO. El `say()` de abajo puede lanzar
            // (Meta 500, red), el catch general suelta el claim y la bandeja
            // durable vuelve a correr ESTE MISMO mensaje: otro `randomUUID()`,
            // otro OCR, y hasta hoy nada que lo detuviera. Con el wamid en la
            // fila, el segundo intento choca contra `uq_gasto_wa_message_id` y
            // se trata abajo como lo que es: el gasto ya está registrado.
            ...(msg.waMessageId ? { waMessageId: msg.waMessageId } : {}),
            ...(imagenUrl ? { imagenUrl } : {}),
          });
          await resolverIncidenteOcrDeEstaFoto();
        } catch (e) {
          // R1: dos fotos IDÉNTICAS en el mismo lote pasan el pre-check antes de
          // que cualquiera inserte; el índice único (mig. 0015) atrapa la 2ª con
          // 23505 → es un duplicado benigno, no un error. Se ignora en silencio.
          // ── EL MISMO MENSAJE, OTRA VEZ (DAT-01) ─────────────────────────
          //
          // No es una carrera ni un reenvío del operador: es NUESTRO reproceso.
          // El gasto YA está en la base con este wamid, así que el comprobante
          // no se pierde y no hay nada que decirle a nadie — el turno anterior
          // ya habló (o murió intentándolo, que es justo lo que trajo el
          // reintento). Se ignora en silencio, como los otros dos duplicados
          // benignos, y sobre todo NO se relanza: dejarlo salir tumbaría el
          // turno otra vez y la bandeja lo reintentaría en bucle.
          if (violaIndice(e, 'uq_gasto_wa_message_id')) {
            logger.info('foto.reproceso_mismo_wamid', { viaje: viajeId, id: msg.waMessageId });
            return;
          }
          if (imgHash && violaIndice(e, 'uq_gasto_img_hash')) {
            // OJO: EL ÍNDICE ES `unique(tenant_id, img_hash)` — TODA LA FLOTA.
            //
            // El pre-chequeo de arriba mira UN VIAJE, así que aquí caen dos
            // casos que no son el mismo:
            //
            //   a) misma ráfaga, dos fotos idénticas → carrera benigna, silencio;
            //   b) la foto YA ESTÁ registrada en OTRO viaje → no es una carrera,
            //      y callarse deja al operador creyendo que la mandó bien.
            //
            // Se trataban las dos como (a). Medido el 1-ago con un operador que
            // reenvió su fajo: DIEZ fotos rechazadas, cero mensajes. Tercer caso
            // del mismo patrón en un día —descartar en silencio— y el que más
            // veces se repitió.
            //
            // SOLO SI LLEGÓ SOLA (`incrementado === 1`). En una ráfaga de
            // dieciocho, diez de estos serían diez mensajes seguidos —el mismo
            // antipatrón de siempre—; ahí lo cubre el resumen del cierre de
            // ráfaga, que dice cuántos comprobantes quedaron en el viaje.
            const donde = incrementado === 1
              ? await ubicarGastoPorHash(op.tenantId, imgHash).catch(() => null)
              : null;
            if (donde && donde.viajeId !== viajeId) {
              logger.info('foto.ya_en_otro_viaje', { viaje: viajeId, otro: donde.viajeId, monto: donde.monto });
              await say(`Ese comprobante de ${mxn(donde.monto)} ya estaba registrado en ${donde.folio ? `tu viaje *${donde.folio}*` : 'otro viaje tuyo'}, así que no lo agregué aquí para no cobrarlo dos veces. Si de verdad es de este viaje, dile a la oficina que lo mueva. 🙏`);
              return;
            }
            logger.info('foto.dedup_race', { viaje: viajeId });
            return;
          }
          // Mismo CFDI llegando dos veces (mig. 0019). También benigno: el gasto
          // ya está registrado con ese UUID, así que el comprobante no se pierde
          // — lo que se evita es contarlo dos veces. Dejarlo salir tumbaría el
          // procesamiento y Meta reintentaría el webhook en bucle.
          if (violaIndice(e, 'uq_gasto_cfdi_uuid')) {
            logger.info('foto.cfdi_ya_registrado', { viaje: viajeId, uuid: gasto.cfdiUuid });
            return;
          }
          // LLEGÓ TARDE (mig. 0036): la liquidación de este viaje ya se emitió.
          //
          // NO es benigno como los dos de arriba, y por eso no se ignora en
          // silencio: en aquellos el gasto ya está registrado, aquí no está en
          // ningún lado. Antes esta foto entraba y hacía que el texto de
          // WhatsApp y el PDF ya emitido dijeran cifras distintas y de signo
          // contrario, con el gasto huérfano de por vida.
          //
          // Se le dice al operador, porque es lo único que le permite hacer algo
          // —abrir el viaje siguiente y mandarla ahí, o pedirle a la oficina que
          // reabra—. Tragárselo le quita el dinero sin avisarle.
          if (llegoTarde(e)) {
            // NO SE PIERDE: pasa a la sala de espera (mig. 0040) y se le ofrece
            // en su próximo viaje.
            //
            // Antes decía «NO entró. Guárdalo: mándalo en tu siguiente viaje o
            // pídele a la oficina que lo agregue», y eso mandaba al operador a
            // un trámite que NO EXISTE: no hay forma de que la oficina agregue
            // un comprobante a un viaje cerrado, ni desde el panel ni desde
            // ningún lado. El comprobante se perdía igual, solo que despacio y
            // con el operador cargando un papel que nadie iba a capturar.
            const ruta = await subida;
            const ok = await guardarHuerfano(op.tenantId, op.operadorId, {
              // Con el hash (DAT-01): el mismo comprobante que llega tarde dos
              // veces —el reproceso de la bandeja durable— es UNA fila en la
              // sala de espera, no dos que se adjunten juntas al viaje siguiente.
              gasto: { ...gasto, imgHash, ...(ruta ? { imagenUrl: ruta } : {}) },
              motivo: 'tras_liquidar', rutaImagen: ruta,
            });
            logger.warn('foto.llego_tarde', { viaje: viajeId, monto: gasto.monto, guardado: ok });
            await sendText(msg.from, ok
              ? mensajeGuardadoTrasLiquidar(gasto.monto)
              : `Ese comprobante de ${mxn(gasto.monto)} llegó después de que cerré tu liquidación y no lo pude guardar ⚙️. Consérvalo y mándalo en tu siguiente viaje.`);
            return;
          }
          throw e;
        }
        // ¿Había un acercamiento esperando por este comprobante? (el caso en que
        // el operador mandó primero el código y después el ticket).
        await pegarCodigoEnEspera(op.tenantId, viajeId, gasto);

        // FECHA QUE NO CUADRA → se le pide otra foto AHORA, no al cuadrar.
        //
        // Al cuadrar, la liquidación ya se emitió y el trigger de la 0037 impide
        // tocar el gasto: pedírsela entonces sería mandarlo a hacer algo que el
        // sistema ya no puede aceptar. Aquí todavía tiene el ticket en la mano.
        //
        // El gasto YA ENTRÓ y se queda: la fecha dudosa no lo invalida, y no
        // registrarlo por una fecha sospechosa le costaría al operador un gasto
        // que sí hizo. Si manda la foto buena, `corregir_fecha` la re-fecha; si
        // no la manda, el cuadre levanta `fecha_sospechosa` (o
        // `gasto_otro_ejercicio` si el año es de otro ejercicio) como siempre.
        // Los dos caminos siguen cerrados.
        const dudosa = ventana ? fechaDudosa(gasto.fecha, ventana) : null;
        if (dudosa) {
          const extra = (gasto.ocrExtra ?? {}) as Record<string, unknown>;
          logger.info('foto.fecha_dudosa', { viaje: viajeId, motivo: dudosa, fecha: gasto.fecha });
          // TAMBIÉN ES SISTÉMICO, y por eso entra al mismo resumen: el reloj mal
          // puesto de una terminal, o un ticket de año viejo mal impreso, salen
          // igual en todo el fajo de esa gasolinera. Con 22 fotos eran 22 de
          // estos mensajes —y son de los largos—, uno detrás de otro.
          anotarIncidencia(viajeId, {
            tipo: 'fecha_dudosa',
            monto: gasto.monto,
            etiqueta: etiquetaConcepto(gasto.concepto, extra),
            mensajeSolo: mensajePideFechaOtraVez({
              etiqueta: etiquetaConcepto(gasto.concepto, extra),
              monto: gasto.monto,
              folio: gasto.folio,
              emisor: extra.emisor as string | undefined,
              estacion: extra.estacion as string | undefined,
              fecha: gasto.fecha!,
              fechaImpresa: extra.fechaImpresa as string | undefined,
              ejercicioHoy: ventana?.hoy ? Number(ventana.hoy.slice(0, 4)) : null,
            }, dudosa),
          });
        }
        // MANDAR UN COMPROBANTE ES ACEPTAR EL VIAJE.
        //
        // Cierra un hueco que habría salido en el primer demo: el chofer que
        // ignora la pregunta de confirmación y se pone a trabajar. Sin esto, a
        // las 5 h la escalación le dice al jefe "tu chofer no confirmó" mientras
        // el chofer lleva ocho tickets mandados, y el jefe le habla para
        // regañarlo por algo que sí hizo. Una foto es una aceptación más fuerte
        // que un "va": es trabajo hecho.
        // `op.operadorId` va al UPDATE: `confirmar_viaje.ts` documenta que este
        // llamador todavía no lo pasaba y que por eso el filtro por chofer no se
        // aplicaba. Hoy ya se puede — el viaje viene de `getOpenViaje(tenantId,
        // operadorId)`, así que el filtro no cambia nada, y deja de estar a un
        // llamador nuevo de marcar como aceptado el viaje de un compañero.
        await aceptarPorActividad(op.tenantId, viajeId, op.operadorId);

        // EL TERCER DISPARO DEL BRIEFING (0208). AUDITORÍA FABLE CICLO 3
        // (c3-2): el chofer que acepta POR FOTO —el camino que este mismo
        // archivo llama "una aceptación más fuerte que un va"— nunca pasa por
        // `atenderConfirmacion` con estado 'confirmado', así que el reintento
        // del briefing de ese gancho jamás corría para él: si el intento del
        // despacho falló (ventana de 24 h cerrada, lo normal), salía a
        // carretera sin los avisos de papeles ni los teléfonos verificados —
        // permanentemente. Su foto acaba de abrir la ventana: es exactamente
        // el momento del segundo gancho. Idempotente por el sello (una
        // lectura extra por foto — barato contra un briefing perdido para
        // siempre) y mejor esfuerzo: el comprobante ya quedó registrado.
        await enviarBriefingInicio(op.tenantId, viajeId).catch((e) => {
          logger.warn('briefing.actividad_fallo', {
            viaje: viajeId, err: e instanceof Error ? e.message : String(e),
          });
        });

        // ── ¿LA FOTO VENÍA ROTULADA COMO TALACHA? (F4, 0107) ─────────────────
        //
        // "se me ponchó una llanta, son 800" como caption de la foto de la
        // nota. El gasto YA entró arriba (addGasto) y entra a la liquidación
        // como cualquier comprobante; aquí se abre —o se completa— la
        // incidencia con la foto de evidencia y el enlace al gasto, y se le
        // manda al jefe la solicitud de autorización. La respuesta de talacha
        // SUSTITUYE al acuse genérico: es la contestación específica a lo que
        // el chofer preguntó, con el monto que se leyó a la vista (y el jefe
        // como control humano de esa cifra).
        const talachaFoto = interpretarTalacha(msg.text);
        if (talachaFoto) {
          const rutaEvidencia = await subida;   // ya corrió en paralelo con la visión
          const respuestaTalacha = await atenderTalachaChofer({
            tenantId: op.tenantId,
            viajeId,
            operadorId: op.operadorId,
            texto: msg.text!,
            // El monto del CAPTION manda (lo dijo el chofer); el de la nota
            // solo entra si el caption no trajo cifra y el OCR sí leyó una.
            monto: talachaFoto.monto ?? (gasto.monto > 0 ? gasto.monto : null),
            evidenciaPath: rutaEvidencia ?? null,
            gastoId: gasto.id,
          });
          await say(respuestaTalacha);
          return;   // el finally de abajo libera la barrera igual
        }

        // ── ¿SE LE CONTESTA POR ESTA FOTO? ───────────────────────────────────
        //
        // Tres peldaños, en `acuse_ticket.ts`. Aquí solo llegan comprobantes que
        // YA se guardaron: la foto ilegible se atajó mucho antes, sin insertar.
        //
        // El SILENCIO es el peldaño bueno, y no por ahorrar mensajes. Un viaje
        // trae ~22 comprobantes; acusarlos todos hace que el chofer deje de
        // leerlos al quinto, y entonces el único que importaba —el del monto
        // dudoso— se pierde entre los que no. Callar en los buenos es lo que
        // hace que el del malo se lea.
        try {
          const extraAcuse = (gasto.ocrExtra ?? {}) as Record<string, unknown>;
          const lectura: LecturaTicket = {
            montoMxn: gasto.monto,
            concepto: etiquetaConcepto(gasto.concepto, extraAcuse),
            fecha: gasto.fecha ?? null,
            confianza: gasto.ocrConfianza ?? null,
            deCfdi: Boolean(gasto.cfdiUuid),
            esRepeticion: false,
            // DAT-18: un $850,000 leído nítido salía por `silencio` con
            // confianza 0.95 — la confianza mide qué tan claro se vio el papel,
            // no si la cifra cabe en el viaje.
            montoImplausible,
            // FISCAL-19C2-3: sin esto, un ticket en USD se anunciaba como si
            // fueran pesos — el motor ya lo excluye del acreditamiento
            // (`moneda_extranjera` en engine.ts), pero el acuse mentía la cifra.
            moneda: typeof extraAcuse.moneda === 'string' ? extraAcuse.moneda : undefined,
          };
          let d = decidirAcuse(lectura);

          // Solo si íbamos a callar vale la pena preguntar si le debíamos una
          // respuesta: si se le pidió otra foto, se le contesta aunque la
          // segunda salga perfecta. Callar tras un "mándame otra" se lee como
          // "volvió a fallar", y manda una tercera.
          if (d.peldano === 'acusar' && !lectura.deCfdi) {
            const conv = await loadConversation(op.tenantId, msg.from, viajeId);
            const ultimo = [...conv.turns].reverse().find((t) => t.role === 'assistant');
            if (ultimo && esPeticionDeFoto(String(ultimo.content ?? ''))) {
              lectura.esRepeticion = true;
              d = decidirAcuse(lectura);
            }
          }
          logger.info('foto.acuse', { viaje: viajeId, peldano: d.peldano, porque: d.porque });

          if (d.peldano === 'acusar') {
            // SE LE CONTESTA SIEMPRE que el ticket entró. Antes esto era
            // `silencio` y no se mandaba nada; el 24-ago-2026 se midió lo que
            // eso produce: cuatro tickets leídos bien, cero mensajes, y el
            // chofer preguntando «Que pasó?» dos minutos después.
            //
            // NO consume el tope de confirmaciones por ráfaga: ese tope existe
            // para los mensajes con BOTÓN, que son los que exigen algo del
            // chofer. Un acuse no le pide nada.
            const estado = await estadoDelViaje(op.tenantId, viajeId);
            anotarAcuse(viajeId, mensajeAcuse(lectura, estado));
          } else if (d.peldano === 'confirmar') {
            // ── EL TOPE ESTABA ESCRITO Y NO ESTABA CABLEADO ────────────────────
            //
            // `MAX_CONFIRMACIONES_SEGUIDAS` existía desde que se escribió este
            // módulo, con su párrafo explicando que doce tickets térmicos
            // arrugados producen doce mensajes con botones —"justo el ruido que
            // este módulo existe para evitar"— y ni un solo `import`. La
            // constante describía una protección que nadie aplicaba.
            //
            // El turno se pide ANTES de mandar: es lo que hace que el tope
            // cuente confirmaciones ENVIADAS y no fotos vistas.
            const turno = pedirTurnoDeConfirmacion(viajeId);
            if (turno > MAX_CONFIRMACIONES_SEGUIDAS) {
              // Pasado el tope no se calla: se anota, y el resumen del cierre
              // dice cuántas quedaron sin confirmar. Un tope que no se anuncia
              // se lee como "todo salió bien", que es la peor lectura posible.
              logger.info('foto.acuse_sobre_tope', { viaje: viajeId, turno, tope: MAX_CONFIRMACIONES_SEGUIDAS });
              anotarIncidencia(viajeId, { tipo: 'duda', monto: gasto.monto, etiqueta: lectura.concepto });
            } else {
              const estado = await estadoDelViaje(op.tenantId, viajeId);
              const m = mensajeConfirmar(gasto.id, lectura, estado);
              // Si el botón no sale —fuera de la ventana de 24 h, Meta caído— se
              // degrada a texto en vez de perderse: `sendButtons` devuelve null sin
              // lanzar, y quedarse sin confirmación es peor que quedarse sin botón.
              const enviado = await sendButtons(msg.from, m.cuerpo, m.botones);
              if (!enviado) await say(`${m.cuerpo}\n\nContéstame *sí* o *no*.`);
            }
          } else if (d.peldano === 'refoto') {
            // Mismo tope y mismo contador: para el chofer, "confírmame esto" y
            // "mándamela otra vez" son el mismo ruido, y en una ráfaga de doce
            // tickets malos llegan mezclados. Contarlos por separado dejaría
            // pasar ocho mensajes en vez de cuatro.
            const turno = pedirTurnoDeConfirmacion(viajeId);
            if (turno > MAX_CONFIRMACIONES_SEGUIDAS) {
              logger.info('foto.refoto_sobre_tope', { viaje: viajeId, turno, tope: MAX_CONFIRMACIONES_SEGUIDAS });
              anotarIncidencia(viajeId, { tipo: 'duda', monto: gasto.monto, etiqueta: lectura.concepto });
            } else {
              const pedida = mensajeRefoto(d.porque);
              // SE GUARDA LO QUE SE LE PIDIÓ, no solo se manda. Es lo único que
              // le permite a la SIGUIENTE foto saber que es la repetición que
              // pedimos y contestarle. Ver `recordarPeticionDeFoto`.
              if (await say(pedida)) await recordarPeticionDeFoto(op.tenantId, msg.from, viajeId, pedida);
            }
          }
        } catch (e) {
          // Best-effort: el gasto YA está guardado. Un acuse que no sale es
          // molesto; tumbar aquí dispararía el reproceso del webhook, y con él
          // el de la foto — que sí cuesta dinero.
          logger.warn('foto.acuse_falló', { err: e instanceof Error ? e.message : String(e) });
        }

        // ACUSE UNA SOLA VEZ POR VIAJE, no "cuando el contador va de 0 a 1".
        //
        // Esa era la condición anterior, y el comentario decía otra cosa: creía
        // marcar la primera foto de la RÁFAGA. Pero el contador se decrementa en
        // el `finally` de cada foto, así que vuelve a 0 entre una y otra. Un
        // operador que fotografía 17 tickets en la gasolinera y los manda de uno
        // en uno —adjuntar, enviar, ~15 s de interacción humana— deja que cada
        // OCR termine antes de que llegue el siguiente: las 17 ven `enVuelo === 1`
        // y recibe DIECISIETE veces el mismo mensaje. El guion del demo promete
        // justo lo contrario.
        //
        // Se ata al primer COMPROBANTE del viaje, que es cuando el operador de
        // verdad necesita saber cómo funciona el flujo. Cuesta un `count` por
        // foto, que es despreciable al lado de la llamada de visión ($0.015).
        //
        // La carrera posible —dos fotos simultáneas que insertan antes de que
        // cualquiera cuente— hace que se pierda el acuse, no que se dupliquen.
        // Perder un acuse es molesto; mandar diecisiete es un producto roto.
        try {
          const registrados = await getGastos(viajeId, op.tenantId);
          if (registrados.length === 1) {
            await say('📸 Voy recibiendo tus comprobantes. Mándalos todos y cuando termines escribe *listo* para cerrar tu liquidación. 🚛');
          }
        } catch (e) {
          // En su propio try: un fallo aquí, ya guardado el gasto, NO debe
          // disparar reproceso — el comprobante ya está registrado.
          logger.warn('ack.send', { viaje: viajeId, err: e instanceof Error ? e.message : String(e) });
        }
      } finally {
        const quedan = await intakeDelta(viajeId, -1); // libera el contador pase lo que pase

        // ── RESUMEN AL CERRAR LA RÁFAGA ────────────────────────────────────────
        //
        // El problema que arregla, medido el 1-ago: un operador mandó DIECIOCHO
        // fotos de golpe y no recibió una sola palabra sobre ellas. Diez ya
        // estaban registradas en otro viaje, tres eran acercamientos a códigos y
        // dos eran idénticas a fotos de este viaje — todos caminos correctos, y
        // todos SILENCIOSOS. Desde su lado: mandó dieciocho fotos y no pasó nada.
        //
        // Y avisar por foto no es la salida: serían diez mensajes seguidos, que
        // es el antipatrón que ya hizo ver roto este producto tres veces (el
        // acuse de ráfaga, el aviso de acercamiento, los avisos de fecha).
        //
        // `quedan === 0` significa que ESTA fue la última foto en vuelo: el
        // contador es atómico, así que exactamente una invocación lo ve. Y solo
        // se resume si de verdad hubo RÁFAGA (`incrementado > 1`): para una foto
        // suelta, su propio camino ya habló y esto sería un mensaje de más.
        //
        // `quedan === null` TAMBIÉN cierra, y eso es nuevo. Significa que la RPC
        // no contestó, así que no se sabe si quedaba alguna en vuelo — y con la
        // libreta de la ráfaga ya llena, no cerrar equivale a tragarse el único
        // aviso de que tres comprobantes no entraron. El peor caso de cerrar de
        // más es un resumen partido en dos mensajes; el de no cerrar es el
        // silencio, que es exactamente lo que esta ronda vino a quitar.
        try {
          // AUDITORÍA 19 (AGEN-19C2-1, corregido tras auditoría Fable-5):
          // bajo ejecución SERIAL por chofer (23-ago), `quedan` vuelve a 0
          // después de CADA foto —nunca hay dos en vuelo—, así que sin este
          // freno la libreta se cerraría (y resumiría) foto por foto en vez
          // de una sola vez para todo el fajo. `hayFotoDespuesEnCadena` lo
          // sabe de antemano (route.ts/drenado.ts ya conocen la cadena
          // completa) y frena el cierre SOLO cuando de verdad viene OTRA
          // FOTO detrás en esta misma cadena — no cualquier mensaje: un
          // "listo" o una caption de texto después de la última foto ya no
          // la dejan colgada para siempre. El fail-safe de `quedan === null`
          // (RPC caída) NO se toca: sigue cerrando de inmediato pase lo que
          // pase, porque dejar la libreta abierta sobre un contador
          // ilegible es tragarse el aviso, que es peor que un resumen
          // partido.
          const masEnEstaCadena = quedan !== null && opts.hayFotoDespuesEnCadena === true;
          const ultima = (quedan === 0 || quedan === null) && !masEnEstaCadena;
          // Lo que se anotó mientras la ráfaga corría. Se cierra SIEMPRE que
          // ésta sea la última —aunque no haya nada anotado— para no dejar la
          // libreta viva sobre un viaje cuya ráfaga ya terminó.
          const rafaga = ultima ? cerrarRafaga(viajeId) : null;
          // HUBO RÁFAGA si por aquí pasó más de una foto (`vistas`), si el
          // contador vio más de una en vuelo (`incrementado`), o si
          // route.ts/drenado.ts ya sabían que esta foto tiene OTRA foto
          // hermana en su misma cadena —antes o después— del mismo chofer
          // (AUDITORÍA 19: bajo ejecución serial nunca hay solape temporal
          // que las dos primeras señales puedan ver).
          const huboRafaga = !!rafaga && (rafaga.vistas > 1 || incrementado > 1
            || opts.hayFotoAntesEnCadena === true || opts.hayFotoDespuesEnCadena === true);

          // UNA SOLA COSA QUE CONTAR SE CUENTA ENTERA.
          //
          // El resumen consolida porque veintidós mensajes son ruido; pero
          // cuando en todo el fajo hay UNA incidencia, consolidarla PIERDE. El
          // caso concreto: seis fotos buenas y una con la fecha fuera del
          // viaje. Consolidado se lee «*1* trae fecha dudosa: la de $45.00», y
          // con eso el chofer no encuentra el papel entre los otros seis —que
          // es justo lo que `pedir_fecha.ts` existe para evitar—. Entero trae
          // comercio, folio y la fecha tal como venía impresa.
          //
          // Así que el umbral no es «llegó sola»: es «hay una sola cosa que
          // decir». Vale para una foto suelta y para la única que falló de un
          // fajo de veinte.
          const unicaEntera = rafaga && rafaga.incidencias.length === 1
            ? rafaga.incidencias[0].mensajeSolo
            : undefined;

          // NO HUBO RÁFAGA, y esto es lo único que puede afirmarlo: la libreta
          // ya cerró, así que `vistas` es definitivo. Le toca el mensaje que su
          // propio camino escribió, y NO el resumen: decirle las dos cosas es
          // el ruido que esto vino a quitar. Va por `say` y no por `sendText`
          // para que siga contando su costo de WhatsApp, igual que cuando lo
          // mandaba el camino de la foto.
          if (ultima && rafaga && !huboRafaga) {
            // Una incidencia entera manda sobre el acuse: si hay algo que
            // resolver, eso es lo que el chofer tiene que leer, no un «ya
            // quedó». Si no hubo nada que decir, sale el acuse — que es el
            // mensaje que faltaba y por el que el silencio se leía como falla.
            const solo = unicaEntera ?? rafaga.acuses[0];
            if (solo) await say(solo);
          }
          const incidencias = rafaga
            ? (unicaEntera ?? lineaIncidencias(rafaga.vistas, rafaga.incidencias))
            : null;
          // Con UNA sola foto no se resume: su mensaje de arriba ya habló.
          if (ultima && rafaga && huboRafaga) {
            const puestos = await getGastos(viajeId, op.tenantId);
            // AUDITORÍA 25 (ALTO, agentico.md:426) — MISMO `copiasDeComprobante`
            // que el motor y el PDF. Este resumen sumaba TODAS las filas sin
            // excluir copias; el protocolo normal de dos fotos por ticket (el
            // ticket entero + el acercamiento al QR) deja dos filas del mismo
            // comprobante, y el chofer leía un total que el «listo» del mismo
            // hilo desmentía minutos después. Un segundo cálculo aquí se
            // separaría del cuadre en silencio, el error que este repo ya pagó.
            const copias = copiasDeComprobante(puestos);
            const comprobantes = puestos.filter((g) => !copias.has(g.id)).length;
            const total = puestos.reduce(
              (s, g) => (copias.has(g.id) || !(g.monto > 0) ? s : s + g.monto), 0);
            // Las que se pasaron del tope de botones llevan su propia frase, que
            // es la que `mensajeDemasiadasDudas` ya escribía y nadie llamaba.
            const dudas = rafaga.incidencias.filter((i) => i.tipo === 'duda').length;
            const cola = dudas
              ? `\n\n${mensajeDemasiadasDudas(dudas, await estadoDelViaje(op.tenantId, viajeId).catch(() => null))}`
              : '';
            logger.info('foto.resumen_rafaga', {
              viaje: viajeId, gastos: puestos.length, comprobantes, copias: copias.size,
              vistas: rafaga.vistas, incidencias: rafaga.incidencias.length,
            });
            await sendText(msg.from,
              `📸 Ya revisé tus fotos. En este viaje llevo *${comprobantes} ${comprobantes === 1 ? 'comprobante' : 'comprobantes'}* por *${mxn(total)}*.\n\n` +
              (incidencias ? `${incidencias}\n\n` : '') +
              `Si te falta alguno, mándalo otra vez. Cuando termines, escribe *listo*. 👍${cola}`);
          }
        } catch (e) {
          // Best-effort puro: el resumen es información, no el dinero.
          logger.warn('foto.resumen_falló', { err: e instanceof Error ? e.message : String(e) });
        }
      }
      return; // no corre el agente por foto
    }

    // ── DOCUMENTO: XML del CFDI (NIVEL 2 del complemento de hidrocarburos) ────
    // El operador/oficina reenvía el XML que la gasolinera manda por correo. NO
    // requiere e.firma ni portales. Silencioso (acuse consolidado): la validación
    // se refleja en el cuadre al cerrar.
    //
    // AUDITORÍA 8, ALTO (agéntico) — LA BARRERA NO LO VEÍA. La foto hace +1/-1
    // al contador de intake y el "listo" la espera; el XML no hacía nada de
    // eso, y su ruta es lenta (dos `fetch` a la Graph API, hasta 30s). Un
    // operador que reenvía el XML y escribe "listo" 4s después podía cerrar
    // ANTES de que la descarga terminara: `esperarIntake` veía el contador en
    // 0 (nadie lo tocó) y el estímulo/IVA acreditable de esa carga se perdía
    // para siempre — el motor solo cuenta litros e IVA de gastos con
    // `xml_verificado`. Mismo contrato fail-closed que la foto: si el +1 no
    // se confirma, no se sigue procesando (nada que insertar sin que la
    // barrera lo sepa).
    if (msg.type === 'document' && msg.mediaId) {
      const incrementado = await intakeDelta(viajeId, 1);
      if (incrementado == null) {
        logger.error('intake.incremento_fallido', { viaje: viajeId, tenant: op.tenantId });
        await say('No pude registrar tu XML en el orden correcto 😕. Reenvíalo en un momento y, si ya escribiste *listo*, vuelve a escribirlo cuando te confirme que lo recibí.');
        await soltarClaim();
        return;
      }
      try {
        // ── AUDITORÍA 24 · WA-8 (MEDIO): QUÉ ES Y CUÁNTO PESA, ANTES ────────
        // WhatsApp acepta documentos de 100 MB y esto los bajaba ENTEROS a
        // memoria para después descubrir que no eran un XML. Una llamada a
        // los metadatos lo decide barato, y de paso permite contestar por lo
        // que de verdad mandó: el HEIC del iPhone leía «no el PDF».
        const metaDoc = await metadatosMedia(msg.mediaId);
        if (metaDoc && !puedeSerXml(metaDoc.mimeType)) {
          logger.info('xml.no_es_xml', { viaje: viajeId, mime: metaDoc.mimeType, bytes: metaDoc.fileSize });
          await say(mensajeDocumentoNoEsXml(metaDoc.mimeType));
          return;
        }
        if (metaDoc?.fileSize != null && metaDoc.fileSize > MAX_XML_BYTES) {
          logger.warn('xml.demasiado_pesado', { viaje: viajeId, bytes: metaDoc.fileSize });
          await say('Ese archivo pesa demasiado para ser el XML de un comprobante 📎. Mándame el *.xml* que te manda la gasolinera, o una *foto* del ticket. 🧾');
          return;
        }
        const xmlText = await downloadMediaAsText(msg.mediaId);
        const xml = xmlText ? parseCfdiXml(xmlText) : null;
        if (!xml || !xml.uuid) {
          await say(mensajeDocumentoNoEsXml(metaDoc?.mimeType));
          return;
        }

        // ── FASE 7 (mig. 0199): ¿es un COMPLEMENTO DE PAGO? ─────────────────
        // Un REP (TipoDeComprobante=P) trae Total=0 por estándar: el camino
        // 1:1 de abajo lo rebotaría con "viene sin el total" — que es cierto
        // del atributo y falso del documento. Se ingiere aparte: registra los
        // pagos y sella `pagado_en` en los CFDI PPD que liquida, que es lo
        // que libera su IVA (LIVA 5-III) en el motor.
        if (xml.tipoComprobante === 'P') {
          const rep = parseRepXml(xmlText!);
          if (rep) {
            const resumen = await ingerirRep(op.tenantId, rep, xmlText!);
            logger.info('rep.con_viaje', { tenant: op.tenantId, viaje: viajeId, rep: rep.uuid, ...resumen });
            await say(mensajeRepRecibido(resumen));
            return;
          }
          // Es tipo P pero sin un solo pago legible: decir la verdad, no
          // intentar registrarlo como gasto de $0.
          logger.warn('rep.ilegible', { tenant: op.tenantId, uuid: xml.uuid });
          await say('Recibí un complemento de pago pero no pude leer ningún pago adentro 🤔. Verifica que sea el XML timbrado completo y reenvíalo.');
          return;
        }

        // ── AUDITORÍA 25, ALTO FISCAL (hallazgo, línea 218) — UNA NOTA DE
        // CRÉDITO (TipoDeComprobante=E) NO ES UN GASTO DEDUCIBLE ────────────
        // Un CFDI de egreso documenta una devolución, descuento o bonificación:
        // RESTA una deducción y RESTITUYE IVA ya acreditado (LIVA art. 7); no
        // ampara una erogación nueva (LIVA art. 5 fr. I). Antes de este corte,
        // el camino 1:1 de abajo lo trataba como cualquier ticket de gasolinera
        // — lo casaba con un ticket existente o daba de alta un gasto nuevo,
        // con `xml_verificado: true`, acreditando su IVA de signo contrario. El
        // XML sí se conserva (CFF 30); lo que no se hace es contarlo como gasto.
        if (xml.tipoComprobante === 'E') {
          logger.warn('xml.nota_credito', { tenant: op.tenantId, viaje: viajeId, uuid: xml.uuid });
          await say(await conservarNotaCredito(op.tenantId, xml.uuid, xmlText!));
          return;
        }

        // ── AUDITORÍA 10, CRÍTICO FISCAL — CONSOLIDADO, NO TICKET 1:1 ───────
        // Un CFDI de monedero/TAG ampara MUCHAS transacciones de MUCHOS días
        // — nunca es "el ticket de este viaje". El camino de abajo
        // (`emparejarXmlConTicket` + `getGastos(viajeId,...)`) asume 1 CFDI =
        // 1 gasto DE ESTE viaje, así que un consolidado tiene que resolverse
        // ANTES, contra el `gasto` del TENANT completo, no solo del viaje
        // abierto. NO toma `xmlLock` (ese mutex protege la escritura de ESTE
        // viaje contra otro XML del mismo viaje en la misma ráfaga; el
        // consolidado escribe en gastos de otros viajes, y su propia
        // idempotencia por `(tenant_id, cfdi_uuid)` es la que lo protege).
        if (esConsolidado(xml)) {
          const resumen = await guardarYConciliarConsolidado(op.tenantId, xml, xmlText!);
          logger.info('xml.consolidado', { tenant: op.tenantId, viaje: viajeId, uuid: xml.uuid, ...resumen });
          await sendText(msg.from, mensajeConsolidadoRecibido(resumen));
          return;
        }

        // AUDITORÍA 9, MEDIO agéntico — MUTEX, porque esto es read-modify-write
        // sobre una fila COMPARTIDA, no un insert nuevo como la foto. Sin él, dos
        // XML del mismo total en el mismo lote (Meta los entrega juntos,
        // `route.ts:72` los corre con `Promise.all`) leían el mismo `gastos`
        // ANTES de que ninguno escribiera, los dos emparejaban con el MISMO
        // ticket sin `cfdi_uuid`, y el segundo `updateGastoCfdiXml` pisaba al
        // primero: su UUID, RFC emisor, IVA e IEPS desaparecían sin aviso —
        // `saveCfdiXmlRaw` seguía conservando el XML crudo del primero, apuntando
        // a un gasto que ya no traía su propio UUID. El mismo mutex que ya
        // protege el "listo" contra el doble cierre protege aquí el
        // emparejamiento contra la carrera. Si sigue ocupado tras esperar, se le
        // pide al operador que reenvíe en vez de proceder sin exclusividad —
        // proceder es exactamente la carrera que esto existe para cerrar.
        // BE-11: el lease se FIRMA, y el TTL es el mismo que el del cierre
        // (por omisión). Con 60 s contra 120 s, este lease vencía a media
        // escritura, el «listo» entraba encima, y el `finally` de aquí le
        // borraba el lock al cierre.
        const xmlToken = nuevoTokenDeLock();
        const xmlLock = await acquireViajeLock(viajeId, { maxWaitMs: reloj.acotar(12_000), token: xmlToken });
        if (!xmlLock) {
          logger.warn('xml.lock_ocupado', { viaje: viajeId, tenant: op.tenantId });
          await sendText(msg.from, 'Estoy terminando de procesar otro XML de tu viaje 🙏. Reenvía este en un momento.');
          return;
        }
        try {
          const gastos = await getGastos(viajeId, op.tenantId);
          // 1) Por UUID: el gasto ya venía de un CFDI (foto con QR fiscal legible).
          let match = gastos.find((x) => x.cfdiUuid && x.cfdiUuid.toLowerCase() === xml.uuid);
          let eraTicket = false;
          if (!match) {
            // 2) Por monto y fecha, contra los TICKETS sin timbrar. Es el caso normal:
            // un ticket de gasolinera NO trae UUID, así que buscar solo por UUID no
            // encontraba nada y se creaba un SEGUNDO gasto — el mismo consumo contado
            // dos veces, con su IVA y su IEPS encima. Un unique(cfdi_uuid) no lo
            // arregla: el del ticket es NULL y NULL no colisiona.
            const porTicket = emparejarXmlConTicket({ total: xml.total, fecha: xml.fecha }, gastos);
            if (porTicket) {
              match = porTicket; eraTicket = true;
              // AUDITORÍA 24 · WA-5: cuando el empate fue APROXIMADO (el OCR
              // leyó $2,890.00 sobre un CFDI de $2,890.50), el XML corrige el
              // monto —`updateGastoCfdiXml` escribe su `total`, que viene de
              // un comprobante timbrado—. Queda dicho en el log: es la única
              // señal de que una cifra del chofer se movió sin que él lo pidiera.
              const brecha = xml.total != null ? Math.abs(porTicket.monto - xml.total) : 0;
              if (brecha > 0.01) logger.info('xml.monto_corregido_por_cfdi', { viaje: viajeId, gasto: porTicket.id, leido: porTicket.monto, cfdi: xml.total });
            }
          }
          let gastoId: string;
          if (match) {
            // Ya existía el gasto: se enriquece con el XML. Si era un ticket, el XML
            // además le aporta UUID, RFC, monto y fecha, que son autoritativos.
            //
            // AUDITORÍA 8, ALTO (modelo de datos + agéntico): este UPDATE puede
            // cambiar monto/IVA/IEPS de un gasto que ya forma parte de una
            // liquidación emitida — la 0037 lo bloquea en la base (mismo SQLSTATE
            // `CU001` que la 0036), pero sin este catch el operador recibía "se me
            // trabó tantito" en vez de la verdad, igual que el brazo de imagen ya
            // corrige más abajo con `llegoTarde`.
            try {
              await updateGastoCfdiXml(op.tenantId, match.id, eraTicket
                ? { ...xml, uuid: xml.uuid, rfcEmisor: xml.rfcEmisor, rfcReceptor: xml.rfcReceptor, total: xml.total, fecha: xml.fecha }
                : xml);
            } catch (e) {
              if (llegoTarde(e)) {
                logger.warn('xml.llego_tarde', { viaje: viajeId, gasto: match.id });
                await sendText(msg.from, `El XML que mandaste llegó después de que cerré tu liquidación, así que NO se aplicó. Guárdalo: mándalo en tu siguiente viaje o pídele a la oficina que lo agregue.`);
                return;
              }
              throw e;
            }
            if (eraTicket) logger.info('xml.pegado_a_ticket', { viaje: viajeId, gasto: match.id });
            gastoId = match.id;
          } else {
            // El XML llegó sin foto previa: se crea el gasto desde el XML.
            // El concepto sale de la CLAVE del SAT, no de un prefijo. Antes esto era
            // `startsWith('15101') ? 'diesel' : 'factura'`, así que toda caseta
            // timbrada entraba como 'factura' y perdía el estímulo del 50% de peaje
            // (LIF 2026 Art. 20-A), que el motor sólo aplica a `concepto === 'caseta'`.
            // ── DAT-37 · UN CFDI SIN TOTAL NO ES UN GASTO DE $0.00 ────────
            //
            // `monto: xml.total ?? 0` daba de alta un gasto de CERO PESOS con
            // `xml_verificado: true`, que es la peor combinación posible: la
            // marca de verificado es justo la que hace que el motor cuente sus
            // litros y acredite su IVA/IEPS, y el renglón de $0.00 aparece en
            // la liquidación del contralor como una cifra medida. `@Total` es
            // obligatorio en CFDI 4.0, así que si no viene el archivo está
            // roto o no es un CFDI — y de un papel roto no se afirma nada.
            //
            // El XML crudo SÍ se conserva (CFF 30, abajo): la evidencia no se
            // tira; lo que no se hace es inventarle un importe.
            if (xml.total == null || !(xml.total > 0)) {
              logger.warn('xml.sin_total', { viaje: viajeId, uuid: xml.uuid });
              await saveCfdiXmlRaw(op.tenantId, xml.uuid, null, xmlText!);
              await sendText(msg.from, 'Recibí tu XML pero viene *sin el total* del comprobante 🤔, así que no lo puedo registrar como gasto — me saldría en $0.00. Guardé el archivo; mándame la foto del ticket para capturar el monto, o pídele a la gasolinera el XML completo. 📎');
              return;
            }
            gastoId = randomUUID();
            const cfg = await getConfig(op.tenantId);
            // AUDITORÍA 8, ALTO (agéntico): sin este try/catch, un XML sin foto
            // previa que llega tarde chocaba con la 0036 (CU001) igual que el
            // camino de arriba, pero saltaba al catch general — "se me trabó
            // tantito" para un hecho que no es transitorio.
            try {
              await addGasto(op.tenantId, viajeId, {
                id: gastoId,
                concepto: conceptoDesdeClave(xml.claveProdServ, cfg.hidrocarburos.claves, cfg.estimulos.clavesPeaje),
                monto: xml.total,
                fecha: xml.fecha,
                rfcEmisor: xml.rfcEmisor,
                rfcReceptor: xml.rfcReceptor,
                cfdiUuid: xml.uuid,
                claveProdServ: xml.claveProdServ,
                claveUnidad: xml.claveUnidad,
                tipoComprobante: xml.tipoComprobante,
                complementoHidrocarburos: xml.complementoHidrocarburos,
                cfdiEsquemaAlterno: xml.esquemaAlterno,
                formaPago: xml.formaPago,
                metodoPago: xml.metodoPago,
                subTotal: xml.subTotal,
                descuento: xml.descuento,
                iepsTraslado: xml.iepsTraslado,
                ivaTraslado: xml.ivaTraslado,
                xmlVerificado: true,
                // Auditoría 12 (fiscal, ALTO): el XML 1:1 trae la cantidad
                // (Cantidad="113.00" ClaveUnidad="LTR") y sin esto el gasto
                // nacía con 0 litros — el estímulo no se acreditaba.
                //
                // Y DAT-19: la moneda del comprobante viaja con él. Sin esto,
                // el `@Total` de una factura en USD entraba entero en la
                // columna de pesos y el motor no tenía cómo enterarse.
                ocrExtra: (() => {
                  const extra: Record<string, unknown> = {};
                  if (xml.claveUnidad === 'LTR' && xml.cantidad != null) extra.litros = xml.cantidad;
                  if (xml.moneda) extra.moneda = xml.moneda;
                  if (xml.tipoCambio != null) extra.tipoCambio = xml.tipoCambio;
                  return Object.keys(extra).length ? extra : undefined;
                })(),
              });
            } catch (e) {
              if (llegoTarde(e)) {
                logger.warn('xml.llego_tarde', { viaje: viajeId, gasto: gastoId });
                await sendText(msg.from, `El XML que mandaste llegó después de que cerré tu liquidación, así que NO se aplicó. Guárdalo: mándalo en tu siguiente viaje o pídele a la oficina que lo agregue.`);
                return;
              }
              throw e;
            }
          }
          // 1.8: conservar el XML crudo (CFF 30). Best-effort.
          await saveCfdiXmlRaw(op.tenantId, xml.uuid, gastoId, xmlText!);
        } finally {
          await releaseViajeLock(viajeId, xmlToken);
        }
      } finally {
        await intakeDelta(viajeId, -1); // libera el contador pase lo que pase
      }
      return; // silencioso
    }

    // ── UBICACIÓN DEL CHOFER (F-Ruta, 17-ago-2026) ───────────────────────────
    //
    // El pin de "Compartir ubicación": se registra en `posicion` (si el viaje
    // trae unidad — la tabla la exige, 0050) y SIEMPRE le llega al jefe con el
    // link del mapa: un chofer comparte su posición cuando algo pasa. Todo
    // best-effort menos la confirmación: perder el INSERT es malo, dejarlo sin
    // respuesta creyendo que nadie la vio es peor.
    if (msg.type === 'location' && typeof msg.lat === 'number' && typeof msg.lng === 'number') {
      const avisadoJefe = await registrarUbicacionChofer(op, viajeId, msg.lat, msg.lng);
      // c4-6: el pin que el propio bot pide ("mándame tu ubicación") ahora SÍ
      // llega a donde la cascada y el mensaje al proveedor lo van a usar — el
      // expediente de asistencia vivo del chofer, si lo hay. Best-effort.
      const anclada = await anclarUbicacionIncidencia(op.tenantId, op.operadorId, msg.lat, msg.lng);
      // AGEN-5 / WA-4: «ya se la pasé a tu jefe» solo cuando Meta la aceptó
      // (texto o plantilla). Si no, se dice y se le da la salida.
      const donde = anclada ? 'quedó en tu viaje Y en tu reporte de emergencia' : 'queda registrada en tu viaje';
      await say(avisadoJefe
        ? `📍 Recibida tu ubicación — ${donde}, y ya se la pasé a tu jefe.`
        : `📍 Recibida tu ubicación — ${donde}, pero NO pude pasársela a tu jefe por WhatsApp. Si es urgente, márcale directo.`);
      return;
    }

    // ── TEXTO: corre el agente UNA vez → respuesta consolidada ───────────────
    if (!(msg.type === 'text' && msg.text)) {
      await say(mensajeTipoNoSoportado(msg.subtipo));
      return;
    }

    // ── BOTÓN APRETADO ───────────────────────────────────────────────────────
    //
    // Llega como TEXTO con el id del botón —así lo mapea el webhook— y se atiende
    // ANTES que nada: es la respuesta a una pregunta concreta que hicimos, no
    // algo que el agente deba interpretar. Mandarle "ok:<uuid>" al modelo cuesta
    // una llamada y puede contestar cualquier cosa.
    const boton = leerBoton(msg.text);
    if (boton) {
      const est = viajeId ? await estadoDelViaje(op.tenantId, viajeId) : null;
      if (boton.accion === 'ok') {
        logger.info('acuse.confirmado', { viaje: viajeId, gasto: boton.gastoId });
        await say(mensajeConfirmado(est));
      } else {
        // NO se toca el gasto. El chofer dijo que el monto está mal, pero no dijo
        // cuál es el bueno: corregirlo a un número inventado sería peor que
        // dejarlo mal leído, y ponerlo en cero le quitaría un gasto que sí hizo.
        //
        // AUDITORÍA 24 · WA-3 (ALTO): lo que faltaba era el RASTRO. Esto era un
        // `logger.warn` que muere con la invocación y un mensaje que lo mandaba
        // con su oficina — la cual no tenía forma de enterarse de que él había
        // dicho nada. Ahora la fila queda marcada, y el texto solo lo afirma si
        // la marca de verdad se escribió.
        logger.warn('acuse.rechazado', { viaje: viajeId, gasto: boton.gastoId });
        const marcado = await marcarMontoDisputado({
          tenantId: op.tenantId, gastoId: boton.gastoId, quien: op.operadorId,
        });
        await say(mensajeCorregir(marcado));
      }
      return;
    }

    // ── ¿EMERGENCIA DE CARRETERA? (0198, punto A del plano) ──────────────────
    //
    // Entre el botón y la consulta A PROPÓSITO: el botón responde a una
    // pregunta nuestra (un id crudo no es un reporte); todo lo demás puede
    // comerse una emergencia — "¿cuánto llevo?" jamás trae "volcadura", pero
    // el orden documenta la intención. El ROJO normalmente ya se atendió
    // ARRIBA (antes del gate de privacidad); este check es la red redundante
    // —el mismo patrón que el ARCO— y el camino titular del ÁMBAR con viaje.
    const emergenciaConViaje = interpretarAsistencia(msg.text);
    if (emergenciaConViaje) {
      const rEmergencia = await atenderAsistenciaChofer({
        tenantId: op.tenantId,
        viajeId,
        operadorId: op.operadorId,
        texto: msg.text,
        asistencia: emergenciaConViaje,
        waMessageId: msg.waMessageId ?? null,
      });
      logger.info('asistencia.con_viaje', { viaje: viajeId, nivel: emergenciaConViaje.nivel });
      await say(rEmergencia.respuesta);
      return;
    }

    // ── "¿CUÁNTO LLEVO?" ─────────────────────────────────────────────────────
    //
    // Se contesta con una consulta y una plantilla, SIN modelo. No es por
    // ahorrar: la cifra sale de la base, y un modelo en medio no puede mejorarla
    // pero sí puede equivocarla. `null` = no era una consulta, sigue al agente.
    const respEstado = await responderConsulta(msg.text, op.tenantId, viajeId);
    if (respEstado) {
      logger.info('consulta.estado', { viaje: viajeId });
      await say(respEstado);
      return;
    }

    // ── ¿MARCA DE JORNADA? (LFT 132 fr. XXXIV, mig. 0241) ───────────────────
    //
    // ANTES de los hitos y del freno de cierre, por la misma razón por la que
    // los hitos van antes que el freno: `pidioCerrar` empata con
    // `/termin[éeoó]/` y se comería «termino mi jornada» como intento de cerrar
    // el viaje — anotando un cierre que el operador no pidió y perdiendo la
    // hora de salida que sí declaró.
    //
    // Las frases de este módulo exigen «jornada», «descanso» o «comer», y
    // ninguna lista de los reconocedores de arriba las menciona, así que el
    // solape es cero por construcción; el orden documenta la intención.
    {
      const jornada = await atenderJornadaSiAplica({
        tenantId: op.tenantId,
        operadorId: op.operadorId,
        texto: msg.text,
        momento: msg.timestampMs ? new Date(msg.timestampMs) : new Date(),
        waMessageId: msg.waMessageId ?? null,
        viajeId,
      });
      if (jornada) {
        for (const t of jornada) await say(t);
        return;
      }
    }

    // ── ¿HITO DEL VIAJE? "ya llegué" / "descargando" / "de regreso" (0090) ──
    //
    // ANTES del freno de cierre A PROPÓSITO: `pareceCierre` arranca con
    // ^(listo|ya|...) y se comería "ya llegué" como intento de cerrar. Y
    // después de botones/consultas, que son respuestas a preguntas nuestras.
    // La lista de frases es CERRADA y anclada (hitos_viaje.ts): lo que traiga
    // más contexto sigue su camino al agente.
    const hito = interpretarHito(msg.text);
    if (hito) {
      // DAT-38: la hora del MENSAJE, no la del procesamiento. El acuse dice
      // «anotado: llegaste a las 14:32» y esa hora tiene que ser la que el
      // chofer vivió, no la que este servidor tenía cuando le tocó el turno.
      // Sin timestamp de Meta se cae al reloj local, como siempre.
      const ahoraHito = msg.timestampMs ? new Date(msg.timestampMs) : new Date();
      const sello = await sellarHito(op.tenantId, viajeId, hito, ahoraHito);
      logger.info('hito.viaje', { viaje: viajeId, hito, sello });
      await say(mensajeHito(hito, sello, ahoraHito));
      return;
    }

    // ── ¿REPORTE DE TALACHA / AVERÍA? (F4, 0107) ─────────────────────────────
    //
    // "se me ponchó una llanta, la talacha son 800" → incidencia pendiente de
    // autorización + solicitud al JEFE por WhatsApp con botones. Va después de
    // hitos (frases exactas primero) y ANTES de la confirmación de viaje: un
    // reporte de avería nunca es una afirmación de arranque. El módulo
    // atiende solo palabras del oficio (lista cerrada); todo lo demás sigue
    // al agente, que sí lee contexto.
    const talacha = interpretarTalacha(msg.text);
    if (talacha) {
      const respuestaTalacha = await atenderTalachaChofer({
        tenantId: op.tenantId,
        viajeId,
        operadorId: op.operadorId,
        texto: msg.text,
        monto: talacha.monto,
      });
      logger.info('talacha.reporte_texto', { viaje: viajeId, conMonto: talacha.monto !== null });
      await say(respuestaTalacha);
      return;
    }

    // ── ¿ESTÁ CONFIRMANDO SU VIAJE? ──────────────────────────────────────────
    //
    // Va DESPUÉS de la consulta de estado y ANTES del agente. El orden importa:
    // un viaje que el chofer no ha aceptado tampoco lo puede haber terminado,
    // así que su "listo" aquí significa "listo para arrancar", no "ya acabé".
    //
    // `decidirInicio` es puro y no elige por él: con dos viajes asignados y un
    // "sí" pelón devuelve `ambiguo` y vuelve a preguntar. Arrancar el que no era
    // mete los comprobantes de una ruta en la liquidación de otra, y eso se
    // descubre hasta el cuadre, con el papel ya entregado.
    //
    // TODO EL BLOQUE VA EN try/catch, Y NO CONTRADICE "fallar cerrado". Esa
    // regla protege de AFIRMAR algo falso; aquí no se afirma nada: es un atajo
    // delante del agente, y si no se puede consultar, el mensaje sigue su camino
    // normal y lo contesta el agente. Lanzar rompería CADA mensaje de CADA
    // chofer mientras la base tosa —incluidos los de quienes ya arrancaron su
    // viaje y no tienen nada que confirmar—, que es un daño mucho mayor que
    // perder una confirmación recuperable (el viaje escala a las 5 h y se ve en
    // el panel).
    try {
      const conv0 = await loadConversation(op.tenantId, msg.from, viajeId);
      // Cuántas veces se le ha preguntado ya. Sin este conteo, "se repregunta
      // UNA vez" no se puede cumplir: `decidirInicio` no tiene memoria, y a
      // alguien manejando se le acabaría preguntando en bucle.
      //
      // ── EL BUCLE ERA REAL, Y ESTABA EN DOS PIEZAS ──────────────────────────
      //
      // El conteo se hacía leyendo el TEXTO de los turnos con
      // `/confirma|¿cu[áa]l de|arranco/i`, y esa expresión no empata con NINGUNO
      // de los mensajes que este flujo manda: "¿Arrancas este viaje?", "✅ Va,
      // arrancamos:", "Sí, pero ¿cuál? Traes 2.". Y aunque hubiera empatado, el
      // atajo de abajo salía con `say(...); return;` sin pasar nunca por
      // `saveConversation` —el único de todo el archivo, al final del camino del
      // agente—, así que las preguntas jamás entraban a `conv.turns` y el filtro
      // corría sobre una lista vacía.
      //
      // Dos fallas independientes, un mismo efecto: `intento` valía 1 para
      // siempre, la rama `intento >= 2` de `dudar()` —el freno que manda con el
      // encargado— era inalcanzable, y el chofer recibía "Perdón, no te entendí"
      // indefinidamente.
      //
      // Ahora el número lo lleva la conversación (`MarcasConversacion`) y el
      // turno se guarda aquí abajo. Editar un texto ya no puede romperlo.
      const intento = (conv0.intentosConfirmacion ?? 0) + 1;

      const c = await atenderConfirmacion({
        tenantId: op.tenantId,
        operadorId: op.operadorId,
        texto: msg.text,
        viajeActual: viajeId,
        intento,
      });
      if (c.mensaje) {
        logger.info('viaje.inicio', { viaje: c.viajeConfirmado ?? viajeId, intento, estado: c.estado });
        const entregado = await say(c.mensaje);

        // EL SEGUNDO DISPARO DEL BRIEFING (0208): el chofer acaba de escribir,
        // así que la ventana de 24 h está ABIERTA — es el momento en que el
        // texto libre sí entra. Idempotente por el sello: si el intento del
        // despacho ya llegó, esto devuelve `ya_enviado` y no manda nada.
        // Mejor esfuerzo: la confirmación ya quedó registrada arriba y un
        // briefing que no salió no puede deshacerla.
        if (c.estado === 'confirmado' && c.viajeConfirmado) {
          await enviarBriefingInicio(op.tenantId, c.viajeConfirmado).catch((e) => {
            logger.warn('briefing.confirmacion_fallo', {
              viaje: c.viajeConfirmado, err: e instanceof Error ? e.message : String(e),
            });
          });
        }
        // ── EL TURNO SE GUARDA ───────────────────────────────────────────────
        //
        // Mismo criterio que el cierre del agente: los turnos del OPERADOR se
        // guardan siempre (ocurrieron), y el del asistente solo si Meta lo
        // aceptó — un mensaje rebotado que quedara en el historial haría que el
        // agente diera por dicho algo que el chofer nunca leyó, y que el
        // contador de intentos cobrara una pregunta que no salió.
        const turnos: ConvTurn[] = [...conv0.turns, { role: 'user', content: msg.text }];
        await saveConversation(
          conv0.id,
          entregado ? [...turnos, { role: 'assistant', content: c.mensaje }] : turnos,
          viajeId,
          {
            // Solo cuentan las veces que se le VOLVIÓ A PREGUNTAR. Un "no" o un
            // viaje confirmado cierran el asunto: dejar el contador arriba haría
            // que la primera duda del SIGUIENTE viaje lo mandara con el
            // encargado sin haberle preguntado nunca.
            intentosConfirmacion:
              entregado && (c.estado === 'ambiguo' || c.estado === 'esperando_confirmacion') ? intento : 0,
            cierreSinComprobantes: conv0.cierreSinComprobantes,
          },
        );
        return;
      }
    } catch (e) {
      logger.error('viaje.confirmacion_no_consultada', {
        viaje: viajeId, err: e instanceof Error ? e.message : String(e),
      });
    }

    // ── COMPROBANTES QUE ESPERABAN VIAJE (mig. 0040) ─────────────────────────
    //
    // Ya hay viaje, así que por fin hay dónde ponerlos. NO se adjuntan solos: un
    // ticket del viaje anterior metido en éste es dinero en la liquidación
    // equivocada, y nadie lo nota hasta que el contralor paga. Se enseña qué hay
    // y se pregunta.
    //
    // Todo este bloque es best-effort: `getHuerfanos` devuelve [] ante un error
    // de lectura, y no poder leer la sala de espera NO puede impedirle al
    // operador cerrar el viaje que sí tiene.
    // SOLO SE OFRECE LO QUE TIENE MONTO. Desde que el fallo técnico de OCR
    // guarda huérfano (arriba), la sala de espera puede contener comprobantes
    // cuyo monto NO se pudo leer: el `gasto` que dejó `extraerComprobante` en
    // esa rama trae `monto: 0`. Adjuntarlos metería una línea de $0.00 en la
    // liquidación del contralor —una cifra que no es una medición— y el
    // ofrecimiento le enseñaría al operador "• Otro · $0.00", que no le dice
    // nada. Se conservan (la foto y la fila son la evidencia de que existió) y
    // se recuperan reenviando la foto, que es lo que su propio mensaje le pide.
    // WA-7: el filtro de monto va en la base (antes del tope de 50); el
    // `.filter` de aquí se queda como cinturón para el `gasto` mal formado.
    const enEspera = (await getHuerfanos(op.tenantId, op.operadorId, { soloConMonto: true }))
      .filter((h) => h.gasto.monto > 0);
    if (enEspera.length) {
      const ofrecidos = enEspera.filter((h) => h.ofrecidoEn);
      const comoLista = (hs: typeof enEspera) => hs.map((h) => ({
        monto: h.gasto.monto,
        etiqueta: etiquetaConcepto(h.gasto.concepto, h.gasto.ocrExtra as Record<string, unknown> | undefined),
      }));

      if (ofrecidos.length && esAfirmacion(msg.text)) {
        // Se marcan DESPUÉS de insertar, no antes: si un `addGasto` falla a
        // medias, lo que queda es una fila todavía pendiente —que se vuelve a
        // ofrecer— y no un comprobante marcado como puesto que no está.
        const puestos: string[] = [];
        for (const h of ofrecidos) {
          try {
            await addGasto(op.tenantId, viajeId, h.gasto);
            puestos.push(h.id);
          } catch (e) {
            // Un duplicado benigno también cuenta como resuelto: el comprobante
            // YA está en el viaje, que es lo que el operador pidió.
            // AUDITORÍA 24 · BE-12: `gasto_pkey` también. El huérfano guarda el
            // `gasto` con su id ya fijado (`ocr.ts` lo asigna al extraer); si un
            // «sí» anterior insertó y `resolverHuerfanos` falló, el segundo «sí»
            // choca contra la llave primaria (el índice de menor OID se evalúa
            // primero), no contra `uq_gasto_img_hash` — y sin esto el
            // comprobante se reofrecía para siempre con un error sin fila.
            if (violaIndice(e, 'uq_gasto_img_hash') || violaIndice(e, 'uq_gasto_cfdi_uuid') || violaIndice(e, 'gasto_pkey')) { puestos.push(h.id); continue; }
            logger.error('huerfano.adjuntar_error', { huerfanoId: h.id, gastoId: h.gasto.id, viaje: viajeId, tenant: op.tenantId, err: e instanceof Error ? e.message : String(e) });
          }
        }
        const resueltos = await resolverHuerfanos(op.tenantId, puestos, 'adjuntado', viajeId);
        if (!resueltos) logger.error('huerfano.sin_sellar', { viaje: viajeId, tenant: op.tenantId, huerfanos: puestos, nota: 'los gastos SÍ quedaron en el viaje; el siguiente «sí» los reconoce por gasto_pkey' });
        const ok = ofrecidos.filter((h) => puestos.includes(h.id));
        logger.info('huerfano.adjuntados', { viaje: viajeId, cuantos: ok.length, de: ofrecidos.length });
        // EL NETO, con el MISMO `copiasDeComprobante` que usan el motor y el PDF.
        // Un segundo cálculo aquí se separaría del cuadre en silencio, que es el
        // error que este repo ya ha pagado tres veces.
        const neto = await (async () => {
          try {
            const todos = await getGastos(viajeId, op.tenantId);
            const copias = copiasDeComprobante(todos);
            const comprobado = todos.reduce(
              (s, g) => (copias.has(g.id) || !(g.monto > 0) ? s : s + g.monto), 0);
            return { copias: copias.size, comprobado };
          } catch { return undefined; } // sin neto se calla, no se arriesga la cifra
        })();
        await say(ok.length
          ? mensajeAdjuntados(comoLista(ok), neto)
          : 'No pude agregarlos ⚙️. Siguen guardados; lo intento otra vez en un momento.');
        return;
      }

      if (ofrecidos.length && esNegacion(msg.text)) {
        await resolverHuerfanos(op.tenantId, ofrecidos.map((h) => h.id), 'descartado', null);
        logger.info('huerfano.descartados', { viaje: viajeId, cuantos: ofrecidos.length });
        // "dime cuál y lo pongo" ERA IMPOSIBLE POR PARTIDA DOBLE, y se decía
        // JUSTO DESPUÉS de descartarlos: `resolverHuerfanos` acaba de poner
        // `resuelto_en`, y `getHuerfanos` filtra por `resuelto_en is null`, así
        // que esos papeles ya no existen para el sistema. Aunque siguieran
        // existiendo, no hay ningún camino que lea "el de diésel" y adjunte uno
        // solo: `esAfirmacion` y `esNegacion` son todo o nada a propósito.
        //
        // Lo que SÍ funciona es reenviar la foto: entra como alta normal, y como
        // el huérfano descartado nunca llegó a `gasto`, no hay contra qué
        // duplicar.
        await say('Va, no los agrego a este viaje 👍. Ya no te los vuelvo a ofrecer. Si alguno sí era de aquí, mándame otra vez su foto y lo registro.');
        return;
      }

      // AÚN NO SE LE HA PREGUNTADO. Se aparta cuando el mensaje parece un
      // cierre: interceptar un "listo" con una pregunta lo obligaría a
      // escribirlo dos veces, y en una sala eso se ve como que no entendió.
      // Perder la oferta este turno no cuesta nada — se le vuelve a hacer.
      // (La condición vive en `pareceCierre`, arriba: la comparte con el freno
      // del cierre sin comprobantes.)
      if (!ofrecidos.length && !pareceCierre(msg.text)) {
        const viaje = await getViaje(viajeId, op.tenantId).catch(() => null);
        await marcarHuerfanosOfrecidos(op.tenantId, enEspera.map((h) => h.id));
        logger.info('huerfano.ofrecidos', { viaje: viajeId, cuantos: enEspera.length });
        await say(mensajeOfrecer(comoLista(enEspera), viaje?.destino ? `${viaje.origen ?? ''}${viaje.origen ? '→' : ''}${viaje.destino}` : undefined));
        return;
      }
    }

    // ── DAT-21 · UN "LISTO" VIEJO NO CIERRA EL VIAJE DE HOY ─────────────────
    //
    // La bandeja durable puede rescatar un mensaje minutos —o dos vueltas de
    // cron— después de que Meta lo recibió. En ese hueco caben las dos cosas
    // que hacen falta para el accidente: que la oficina cierre el viaje al que
    // ese "listo" pertenecía, y que le abra el SIGUIENTE. Cuando el mensaje por
    // fin corre, `getOpenViaje` devuelve el viaje NUEVO y el "listo" del viaje
    // anterior lo cierra: sin comprobantes, con el anticipo entero en contra
    // del chofer, e irreversible por los triggers 0036/0037.
    //
    // La prueba de que el mensaje es de otro viaje es la hora de META
    // (DAT-38): un operador sólo puede tener UN viaje abierto a la vez
    // (`uq_viaje_abierto_por_operador`, 0029), así que un texto recibido ANTES
    // de que ESTE viaje se abriera pertenece, por construcción, al anterior.
    //
    // SÓLO SE DESCARTA LO QUE PARECE UN CIERRE, y sólo eso. Un "¿cuánto llevo?"
    // viejo contestado contra el viaje nuevo es una respuesta rara; un "listo"
    // viejo es una liquidación en ceros. Y hace falta la hora de Meta: sin ella
    // (QA, simulador, un timestamp ilegible) no se puede demostrar causalidad
    // y el cierre se aplaza sin consumir el intento.
    //
    const cierreSolicitado = pidioCerrar(msg.text);
    const timestampCierreMs = typeof msg.timestampMs === 'number'
      && Number.isFinite(msg.timestampMs) && msg.timestampMs > 0
      ? msg.timestampMs
      : null;

    // Sin una hora válida de Meta no se puede demostrar qué fotos precedían al
    // «listo». Es incertidumbre causal, no permiso para cerrar: se conserva la
    // fila durable y el cron vuelve a intentar sin consumir el intento.
    if (cierreSolicitado && timestampCierreMs === null) {
      logger.warn('cierre.timestamp_indeterminado', {
        viaje: viajeId, tenant: op.tenantId, timestamp: msg.timestampMs ?? null,
      });
      await soltarClaim(true);
      return;
    }

    // La consulta corre SÓLO en este caso —texto que parece cierre y con hora
    // de Meta—, no en cada mensaje. Esta guardia distingue un cierre atrasado;
    // las barreras posteriores siguen siendo fail-closed ante lecturas dudosas.
    if (msg.timestampMs && pareceCierre(msg.text)) {
      const abiertoDesde = await viajeAbiertoDesdeMs(op.tenantId, viajeId);
      if (abiertoDesde != null && msg.timestampMs < abiertoDesde) {
        logger.warn('cierre.mensaje_de_viaje_anterior', {
          viaje: viajeId, tenant: op.tenantId,
          mensajeMs: msg.timestampMs, viajeDesdeMs: abiertoDesde,
        });
        await say('Ese *listo* era de tu viaje anterior, que ya quedó cerrado 👍. Éste es un viaje nuevo: mándame sus comprobantes y escribe *listo* cuando termines con él.');
        return;
      }
    }

    // BARRERA DE RÁFAGA: espera a que terminen los OCR de fotos en vuelo antes de
    // cuadrar. El timeout o una lectura indeterminada NO autorizan el cierre:
    // se libera el claim y la fila durable conserva su intento para que el cron
    // vuelva a ejecutar el mismo "listo". Dormir unos segundos no es la garantía;
    // la garantía es que nunca se llama al agente mientras la barrera no diga sí.
    const intakeOk = await esperarIntake(viajeId, reloj.acotar(20_000));
    if (!intakeOk) {
      logger.warn('intake.barrera_timeout', { viaje: viajeId, restanteMs: reloj.restante(), cierreSolicitado });
      if (cierreSolicitado) {
        await soltarClaim(true);
        return;
      }
    }

    // ── AUDITORÍA 24 · AGEN-6 (MEDIO): EL «LISTO» ADELANTADO ────────────────
    //
    // La barrera de arriba solo ve las fotos que YA hicieron `+1`. Meta no
    // garantiza el orden entre POSTs: la foto que el chofer mandó ANTES puede
    // aterrizar en el inbox DESPUÉS de este «listo», y entonces el contador
    // está en cero porque nadie lo tocó — se cierra sin el último ticket, y la
    // liquidación es irreversible (0036/0037). La 0280 pone el orden de la
    // cola por la hora del MENSAJE; esto cubre al turno que ya está corriendo.
    //
    // Se pregunta aquí y no antes a propósito: después de la barrera la foto
    // ya tuvo su ventana para llegar a la tabla. Y solo para un «listo» con
    // hora de Meta — sin ella no se adivina, igual que la guardia de arriba.
    if (cierreSolicitado) {
      const fotoAnterior = await fotoAnteriorSinProcesar(msg.from, timestampCierreMs!);
      if (fotoAnterior !== false) {
        logger.warn(fotoAnterior
          ? 'cierre.foto_anterior_pendiente'
          : 'cierre.foto_anterior_indeterminada', {
          viaje: viajeId, tenant: op.tenantId, mensajeMs: timestampCierreMs,
        });
        await soltarClaim(true);
        return;
      }
    }

    // Una imagen que sí llegó pero cuyo OCR falló es también un insumo causal
    // pendiente. La fila huérfana conserva la evidencia y ahora lleva viaje_id;
    // hasta que se resuelva, el cierre queda aplazado. La consulta es
    // deliberadamente fail-closed: `[]` solo significa vacío si Postgres lo
    // confirmó, no si la lectura se cayó.
    if (cierreSolicitado) {
      try {
        const incidentes = await getHuerfanos(op.tenantId, op.operadorId, {
          viajeId,
          soloFalloOcr: true,
          fallarCerrado: true,
        });
        if (incidentes.length > 0) {
          logger.warn('cierre.ocr_pendiente', { viaje: viajeId, tenant: op.tenantId, n: incidentes.length });
          await soltarClaim(true);
          return;
        }
      } catch (e) {
        logger.error('cierre.ocr_pendiente_ilegible', {
          viaje: viajeId, tenant: op.tenantId,
          err: e instanceof Error ? e.message : String(e),
        });
        await soltarClaim(true);
        return;
      }
    }

    // Mutex para serializar cierres concurrentes (dos "listo" a la vez).
    //
    // Si NO se consigue, se ABANDONA el turno. Antes solo se dejaba un warn y se
    // seguía de largo sin mutex, que es justo lo que el mutex viene a impedir:
    // dos "listo" seguidos y el segundo corre el agente completo también. La BD
    // impide la doble fila (upsert), pero como el upsert no lanza, ambas
    // ejecuciones reportan éxito → el operador recibe el cierre y el PDF DOS
    // veces, y se paga el LLM dos veces.
    //
    // Abandonar es seguro porque 'ocupado' significa una sola cosa: otro turno
    // tiene el lease vigente y ESE va a responder.
    //
    // DAT-21 — Y AHORA HAY UN TERCER ESTADO. Antes un fallo persistente de la
    // RPC (12 s de timeouts, pool agotado, 503) devolvía `true`: "el lock es
    // tuyo", sobre una base que no contestó. Y con ese `true` este camino se
    // ponía a cuadrar, imprimir los dos PDFs y CERRAR —irreversiblemente— sin
    // exclusividad ninguna, justo cuando la infraestructura estaba peor. Hoy
    // eso llega como 'indeterminado' y se falla CERRADO: se avisa, se suelta el
    // claim y la bandeja durable lo reintenta. Cuesta un mensaje; abrirlo
    // costaba una liquidación cerrada dos veces.
    //
    // El TTL también cambia: `TTL_LOCK_CIERRE_MS` (120 s) en vez del default de
    // 60 s, porque el cierre no cabe en 60 s en el peor caso —cuadre + dos PDFs
    // + subida + RPC + envío del documento— y un lease que vence a media faena
    // deja de ser un mutex.
    //
    // AUDITORÍA 7, ALTO — SE ABANDONABA EN SILENCIO Y PARA SIEMPRE. El comentario
    // que justificaba el `return` tenía razón en que "otro turno va a
    // responder" — pero a SU mensaje, no al que se acaba de abandonar. Con dos
    // mensajes de texto en la ventana del agente (p. ej. "¿cuánto llevo?" y
    // "listo" 3s después), el segundo nunca corría el agente, nunca entraba a
    // `wa_conversacion.estado.turns`, y seguía reclamado en
    // `wa_mensaje_procesado` PARA SIEMPRE (este `return` no pasaba por
    // `releaseMessageClaim`). El operador veía sus dos palomitas azules y
    // ninguna respuesta a ese mensaje específico — el modo de falla "se trabó"
    // sin que nadie diga que se trabó.
    //
    // Fix acotado (la cola de verdad —con reintento real del turno perdido— es
    // FASE 3, deuda documentada en GUIA_BUILD.md): se AVISA en vez de callar, y
    // se libera el claim para que el mensaje no quede atascado. No resuelve
    // "el segundo mensaje se contesta", pero sí "el operador sabe que no se
    // perdió, y puede volver a mandarlo".
    const tokenCierre = nuevoTokenDeLock();
    const lock = await intentarLockViaje(viajeId, {
      ttlMs: TTL_LOCK_CIERRE_MS, maxWaitMs: reloj.acotar(12_000), token: tokenCierre,
    });
    if (lock === 'obtenido') {
      lockedViaje = viajeId;
      tokenViaje = tokenCierre;
    } else {
      // Los dos motivos se cuentan por separado: 'ocupado' es el sistema
      // funcionando (otro turno en vuelo) y 'indeterminado' es la base sin
      // contestar. Un solo log para los dos haría invisible el segundo, que es
      // el que hay que atender.
      logger[lock === 'ocupado' ? 'warn' : 'error'](
        lock === 'ocupado' ? 'viaje.lock_ocupado_abandona' : 'viaje.lock_indeterminado_abandona',
        { viaje: viajeId, tenant: op.tenantId, restanteMs: reloj.restante() },
      );
      try {
        // Al operador se le dice lo que es cierto en cada caso. «Estoy
        // procesando tu mensaje anterior» sería falso cuando lo que pasa es que
        // no pudimos consultar: el producto no afirma hechos que no le constan.
        await say(lock === 'ocupado'
          ? 'Un momento, todavía estoy procesando tu mensaje anterior 🙏. En cuanto termine, vuelve a escribirme esto si sigue pendiente.'
          : 'No pude apartar tu viaje para cerrarlo ahorita 😕 — la conexión falló y prefiero no cerrarlo dos veces. Tus comprobantes están guardados; vuelve a escribirme *listo* en un minuto.');
      } catch { /* best-effort: el aviso es una cortesía, no puede tumbar la liberación del claim */ }
      await soltarClaim();
      return;
    }

    // Doble "listo": tras tomar el lock, re-verifica que el viaje SIGA abierto. Si
    // otro "listo" ya lo cerró, no re-corras el agente (evita doble cuadre/costo).
    if ((await getOpenViaje(op.tenantId, op.operadorId)) !== viajeId) {
      await say('Ese viaje ya quedó cerrado 👍. Si te falta algo, tu flota te abre el siguiente.');
      return;
    }

    const tenant = await getTenantContext(op.tenantId);
    const conv = await loadConversation(op.tenantId, msg.from, viajeId);

    // ── EL CIERRE NO SE HACE SOLO PORQUE ALGUIEN ESCRIBIÓ "YA" ───────────────
    //
    // `guardar_liquidacion` cerraba con CERO comprobantes exactamente igual que
    // con veintidós, y el cierre es IRREVERSIBLE: los triggers de la 0036/0037
    // bloquean después cualquier alta o corrección sobre ese viaje. Con cero
    // comprobados la liquidación sale con el anticipo ENTERO en contra del
    // chofer, y bastaba un "ya voy" mal leído —hasta AUD3 AG-A1 `pareceCierre`
    // empataba "ya" seguido de cualquier cosa; hoy el "ya" pelón ya no cierra,
    // pero el freno se queda: un turno en que el modelo se adelante a la tool
    // sigue siendo posible.
    //
    // El freno pregunta UNA sola vez por viaje. No se vuelve a preguntar aunque
    // insista, y por eso se guarda la marca: repreguntar en bucle es el otro
    // modo de falla de este archivo, el que dejó al chofer recibiendo "Perdón,
    // no te entendí" para siempre.
    //
    // EN EL CASO NORMAL NO CUESTA NADA: solo se consulta si el mensaje parece un
    // cierre, y con un solo comprobante registrado el freno no existe.
    if (pareceCierre(msg.text) && !conv.cierreSinComprobantes) {
      // FAIL-OPEN: si no se puede contar, no se frena. Un error de lectura no
      // puede impedirle cerrar a quien SÍ mandó sus comprobantes; el freno
      // existe para el caso raro, no para volverse el camino.
      const cuantos = await getGastos(viajeId, op.tenantId)
        .then((g) => g.filter((x) => x.monto > 0).length)
        .catch((e) => {
          logger.warn('cierre.freno_no_contado', { viaje: viajeId, err: e instanceof Error ? e.message : String(e) });
          return -1;
        });
      if (cuantos === 0) {
        logger.warn('cierre.sin_comprobantes_preguntado', { viaje: viajeId, tenant: op.tenantId });
        const aviso = 'Ojo antes de cerrar ⚠️ — no tengo *ningún comprobante* registrado en este viaje.\n\n' +
          'Si lo cierro así, tu liquidación va a decir que no comprobaste nada y el anticipo completo queda en tu contra. ' +
          'Y una vez cerrada ya no puedo agregarte tickets.\n\n' +
          'Si te faltan fotos, mándalas ahora. Si de verdad no traes comprobantes, escríbeme *listo* otra vez y lo cierro así.';
        const entregado = await say(aviso);
        const turnos: ConvTurn[] = [...conv.turns, { role: 'user', content: msg.text }];
        await saveConversation(
          conv.id,
          entregado ? [...turnos, { role: 'assistant', content: aviso }] : turnos,
          viajeId,
          // La marca solo se pone si el aviso SALIÓ. Si rebotó, el chofer no vio
          // la advertencia y su siguiente "listo" no puede contar como respuesta
          // a una pregunta que nunca leyó.
          { intentosConfirmacion: conv.intentosConfirmacion, cierreSinComprobantes: entregado },
        );
        return;
      }
    }

    const turns: ConvTurn[] = [...conv.turns, { role: 'user', content: msg.text }];
    const history: OpenAI.Chat.ChatCompletionMessageParam[] = turns.map((t) => ({ role: t.role, content: t.content }));

    let reply = '';
    let closed = false;
    let agentTools: ToolCallRecord[] = [];
    // Texto que se PEGA al final del `reply` después de las guardias (AGEN-10):
    // «no cerré» explícito en los degradados. Ver `COLOFON_NO_CERRE`.
    let colofon = '';

    // ── ¿ALCANZA PARA EL AGENTE? ─────────────────────────────────────────────
    // El agente es lo caro y lo último: si la barrera y el mutex se comieron el
    // presupuesto, lanzarlo garantiza que Vercel corte a media ejecución y el
    // operador no reciba NADA.
    //
    // El motor no necesita al LLM para cuadrar. Se manda el resumen
    // determinístico —los mismos números, calculados en milisegundos— y el
    // operador se queda con una respuesta correcta en vez de con silencio.
    const COSTO_AGENTE_MS = 15_000;   // mínimo realista de un turno con tools
    if (!reloj.alcanza(COSTO_AGENTE_MS)) {
      logger.error('agente.sin_presupuesto', { viaje: viajeId, gastadoMs: reloj.gastado(), restanteMs: reloj.restante() });
      try {
        const liq = await cuadrarDesdeDB(op.tenantId, viajeId);
        // AGEN-10: el degradado dice sin rodeos que el viaje sigue abierto.
        await say(`${resumenCuadre(liq, false, 'operador')}\n\n${COLOFON_NO_CERRE}`);
      } catch (e) {
        logger.error('agente.sin_presupuesto_fallback', { err: e instanceof Error ? e.message : String(e) });
        await say(`Ya tengo tus comprobantes 👍. ${COLOFON_NO_CERRE}`);
      }
      return;
    }

    try {
      const res = await runAgent({
        agent: 'liquidacion',
        tenant,
        ctx: {
          tenantId: op.tenantId, operadorId: op.operadorId, viajeId, telefono: msg.from, conversationId: conv.id,
          // La marca del freno de cierre-sin-comprobantes viaja a la tool: el
          // candado real vive en `guardar_liquidacion` (QA 16-ago: una frase
          // que `pareceCierre` no reconoce esquivaba el freno de arriba).
          cierreEnCerosConfirmado: conv.cierreSinComprobantes === true,
          // DAT-22: el cierre lo pide el OPERADOR, no el modelo. Sin esta marca
          // `guardar_liquidacion` se niega: es la única acción irreversible del
          // sistema y estaba disponible en todos los turnos.
          cierrePedidoPorTexto: pidioCerrar(msg.text),
        },
        history,
        timeoutMs: reloj.acotar(40_000),
      });
      // "Listo. 👍" SOLO si de verdad se hizo algo. Un turno sin texto y sin
      // ninguna tool no es un turno exitoso y callado: es un turno en el que no
      // pasó nada, y confirmarlo hace que el chofer deje de mandar comprobantes
      // creyendo que su viaje cerró. Cuando sí corrieron tools, el silencio del
      // modelo sí es benigno: el efecto ya ocurrió.
      reply = res.finalText || (res.toolCalls.length > 0
        ? 'Listo. 👍'
        : 'Perdón, no alcancé a procesar eso. ¿Me lo repites?');
      agentTools = res.toolCalls;
      closed = res.toolCalls.some((t) => t.toolName === 'guardar_liquidacion' && !t.error);
      // ── AUDITORÍA 24, AGEN-1 (CRÍTICO, 3ª ronda): LA BASE ES LA AUTORIDAD
      // TAMBIÉN EN EL CAMINO FELIZ. La tool puede reportar `error` con el
      // RPC ya commiteado (`acotada` a 8 s; el servidor termina a los 8.4).
      // El modelo lee `{error}` y escribe «no pude cerrar»; el viaje está
      // `liquidado`; `guardiaEstado(cerro:false)` lo refuerza; y el segundo
      // «listo» del chofer choca con «ya quedó liquidado, pídele el PDF a tu
      // contralor». Hasta aquí la relectura vivía SOLO en el `catch`.
      if (!closed && res.toolCalls.some((t) => t.toolName === 'guardar_liquidacion')) {
        const enBase = await confirmarCierreEnBase(op.tenantId, viajeId);
        if (enBase.estado === 'cerrado') {
          // `error`, no `warn`: un cierre que la tool narró como fallo es un
          // estado que hay que mirar (Sentry), aunque aquí se repare.
          logger.error('agent.cierre_commiteado_tras_fallo_tool', { tenant: op.tenantId, viaje: viajeId, liquidacion: enBase.liqId });
          closed = true;
          agentTools = [...res.toolCalls.filter((t) => t.toolName !== 'guardar_liquidacion'), enBase.registro];
          try {
            reply = resumenCuadre(await cuadrarDesdeDB(op.tenantId, viajeId), true, 'operador');
          } catch {
            reply = 'Ya cerré tu liquidación ✅. Te mando el PDF.';
          }
        } else if (enBase.estado === 'no_verificable') {
          // Fail-closed y DICHO: no se afirma ni «cerré» ni «no cerré».
          logger.error('agent.cierre_no_verificable', { tenant: op.tenantId, viaje: viajeId, err: enBase.err });
          // Redactado para que `guardiaEstado` no lo lea como afirmación de
          // cierre: no dice ni «quedó cerrada» ni «no cerré».
          reply = 'No pude confirmar cómo va tu liquidación. En un minuto escríbeme *listo* otra vez y te lo digo. 🙏';
        } else {
          logger.warn('agent.cierre_fallido_viaje_sigue_abierto', { tenant: op.tenantId, viaje: viajeId });
          colofon = 'Tu viaje sigue abierto (todavía *NO* cerré tu liquidación).';
        }
      }
      ctxCerro = closed;
      // AUDITORÍA 10, MEDIO REINCIDENTE: si el ciclo cruzó de proveedor a medio
      // camino (primario en 3 rondas + fallback en la 4ª), `res.model` es solo
      // el modelo de la ÚLTIMA ronda — una sola fila con esa etiqueta le
      // atribuye TODO el gasto a un modelo que solo respondió una parte.
      // `res.costoPorModelo` viene de `generateWithTools` partido por modelo
      // real; con más de uno, se registra UNA FILA POR MODELO. Con uno solo
      // (el caso normal, sin fallback) o si el campo no viene —algún mock
      // viejo en pruebas— se conserva EXACTO el camino de siempre: una fila,
      // `res.model`.
      const modelosDelCiclo = Object.keys(res.costoPorModelo ?? {});
      if (modelosDelCiclo.length > 1) {
        for (const modelo of modelosDelCiclo) {
          const c = res.costoPorModelo[modelo];
          await registrarCosto({ tenantId: op.tenantId, viajeId, fase: faseDeModelo(modelo, 'cuadre'), modelo, tokensIn: c.tokensIn, tokensOut: c.tokensOut, costoUsd: c.cost });
        }
      } else {
        await registrarCosto({ tenantId: op.tenantId, viajeId, fase: faseDeModelo(res.model, 'cuadre'), modelo: res.model, tokensIn: res.tokensIn, tokensOut: res.tokensOut, costoUsd: res.costUsd });
      }
      if (closed) {
        const call = res.toolCalls.find((t) => t.toolName === 'guardar_liquidacion' && !t.error);
        const liqId = (call?.result as { liquidacion_id?: string } | undefined)?.liquidacion_id;
        if (liqId) await vincularCostosALiquidacion(op.tenantId, viajeId, liqId);
      }
      logger.info('agent.run', { tenant: op.tenantId, viaje: viajeId, tools: res.toolCalls.map((t) => t.toolName), costUsd: res.costUsd });
    } catch (e) {
      // AUDIT_V3 orquestación CRÍTICO (huérfano de cierre parcial): si el agente
      // YA guardó la liquidación (guardar_liquidacion OK) pero una ronda posterior
      // o el timeout tiró el ciclo, PartialExecutionError trae esas tools en
      // partialToolCalls. Sin recuperación: liquidacion persistida en DB pero el
      // operador recibe "se trabó" y NUNCA su PDF → huérfano. Se recupera tratando
      // el cierre como válido, vinculando costos y armando el resumen REAL del motor.
      // AUDITORÍA 21, CRÍTICO (C1): esto era opt-in (`=== '1'`) con default
      // APAGADO, así que el comportamiento de fábrica era exactamente el peor
      // caso que el comentario de arriba describe: liquidación persistida,
      // chofer con "se me trabó", y su reintento chocando con "no tienes viaje
      // abierto". La recuperación decide por EVIDENCIA —`partialToolCalls` trae
      // `guardar_liquidacion` exitoso o no la trae—, no por configuración de
      // infraestructura. Default ENCENDIDO; `=0` queda como apagador de
      // emergencia (`.env.example` ya recomendaba prenderlo desde AUDIT_V3).
      const recuperar = process.env.LIKIDA_RECUPERAR_CIERRE_PARCIAL !== '0';
      const parcial = e instanceof PartialExecutionError ? e.partialToolCalls : null;

      // LO QUE SE GASTÓ ANTES DE CAERSE TAMBIÉN SE PAGÓ. Esta rama nunca llamaba
      // a `registrarCosto`, así que una liquidación recuperada por cierre parcial
      // salía con su PDF y su costo real quedaba invisible. En un negocio que
      // cobra POR LIQUIDACIÓN, el costo unitario se subestima justo en el caso
      // que más consume. Va antes del `if` para que se registre igual aunque el
      // cierre no se pueda recuperar: el dinero se fue de todos modos.
      if (e instanceof PartialExecutionError && (e.tokensIn > 0 || e.tokensOut > 0)) {
        try {
          await registrarCosto({
            tenantId: op.tenantId, viajeId, fase: faseDeModelo('', 'cuadre'),
            modelo: 'parcial', tokensIn: e.tokensIn, tokensOut: e.tokensOut, costoUsd: e.cost,
          });
        } catch (err2) {
          logger.error('agent.costo_parcial_no_registrado', { viaje: viajeId, err: err2 instanceof Error ? err2.message : String(err2) });
        }
      }
      // ── AUDITORÍA 22, AGEN-C1 (CRÍTICO): LA BASE ES LA AUTORIDAD ─────────
      // Esto miraba `!t.error` sobre el resultado de la tool. Pero
      // `guardar_liquidacion` NO lee `ctx.signal` (`grep -c signal tools.ts`
      // = 0), así que cuando el reloj del agente vence a mitad de las dos
      // subidas a Storage, `raceAbort` devuelve `{success:false,
      // error:'Timeout'}` y el handler SIGUE VIVO: segundos después
      // `guardar_liquidacion_tx` commitea, el viaje queda `liquidado`, los PDF
      // quedan en el bucket y los triggers 0036/0037 lo vuelven irreversible.
      //
      // Resultado: el cierre EXISTE y el chofer recibía lo contrario — «se
      // trabó, vuelve a intentar» sobre un viaje ya cerrado que no se puede
      // volver a cerrar. La base dice una cosa y el humano cree otra, que es
      // exactamente el estado que las anclas de este rubro puntúan más bajo.
      //
      // Preguntarle a la base cuesta una consulta y solo ocurre en el camino
      // de excepción. Si la lectura truena, `getLiquidacionDeViaje` LANZA: un
      // error de red no puede leerse como «no se cerró».
      let cierreParcial: ToolCallRecord | undefined =
        recuperar ? parcial?.find((t) => t.toolName === 'guardar_liquidacion' && !t.error) : undefined;
      if (recuperar && !cierreParcial && parcial?.some((t) => t.toolName === 'guardar_liquidacion')) {
        // AGEN-A1/BE-1: el MISMO registro sintético que el camino feliz, con
        // el vocabulario de la tool (`pdf_generado`), que es lo que leen los
        // consumidores de abajo. El anterior traía `pdf_url` y nadie lo leía.
        const enBase = await confirmarCierreEnBase(op.tenantId, viajeId);
        if (enBase.estado === 'cerrado') {
          logger.warn('agent.cierre_commiteado_tras_abortar', { viaje: viajeId, liquidacion: enBase.liqId });
          cierreParcial = enBase.registro;
        } else if (enBase.estado === 'no_verificable') {
          logger.error('agent.cierre_no_verificable', { viaje: viajeId, err: enBase.err });
        }
      }
      if (cierreParcial) {
        // Sin el registro con `error:'Timeout'`: la guardia y el bloque del
        // PDF buscan `guardar_liquidacion && !t.error`, y con los dos en la
        // lista el `find` podía caer en el fallido según el orden.
        agentTools = [...parcial!.filter((t) => t.toolName !== 'guardar_liquidacion'), cierreParcial];
        closed = true;
        // AUDITORÍA 7, ALTO REINCIDENTE de ronda 6: `ctxCerro` es el Único campo
        // que el log del catch general trae para distinguir "no pasó nada" de
        // "la liquidación YA se cerró y el operador se quedó sin nada". Faltaba
        // esta línea gemela a la de la línea ~623 (camino feliz) — sin ella, si
        // algo tronaba DESPUÉS de esta recuperación (p. ej. `saveConversation`),
        // el log mentía diciendo `cerroSinEntregar: false` sobre un cierre real.
        ctxCerro = closed;
        const liqId = (cierreParcial.result as { liquidacion_id?: string } | undefined)?.liquidacion_id;
        if (liqId) {
          try { await vincularCostosALiquidacion(op.tenantId, viajeId, liqId); } catch { /* best-effort */ }
        }
        // Resumen determinístico del motor (nunca cifras del modelo). Fail-closed:
        // si no se puede recalcular, se avisa el cierre sin números (el PDF va abajo).
        try {
          // Va por WhatsApp AL OPERADOR: sin veredicto fiscal (EFOS, cancelado,
          // RFC receptor). Eso es del contralor; al operador se le pide lo que falta.
          reply = resumenCuadre(await cuadrarDesdeDB(op.tenantId, viajeId), true, 'operador');
        } catch {
          reply = 'Ya cerré tu liquidación ✅. Te mando el PDF.';
        }
        logger.warn('agent.cierre_parcial_recuperado', { viaje: viajeId, liqId });
      } else {
        // Con tenant y viaje: sin ellos, a las 3am el log dice que algo falló
        // pero no qué liquidación, y hay que cruzarlo a mano con la hora.
        //
        // AUDITORÍA 19 (tool-calling, CRÍTICO): el tope de $/día apagaba el
        // producto EN SILENCIO. `LlmBudgetExceededError` no es un error de
        // red — `isTransientError` no lo clasifica como transitorio, así que
        // el degradado de abajo (RES-15) nunca corría, y encima el chofer
        // recibía el mismo "se me trabó" que un bug de programación real.
        // No es lo mismo agotar el presupuesto (el motor SÍ puede cuadrar
        // solo, con las cifras reales de la base) que un error de código (ahí
        // sí hay que decir "se me trabó" y no inventar que se resolvió).
        //
        // AUDITORÍA 24, TC-N1 (CRÍTICO): ese `instanceof` se hacía sobre el
        // ENVOLTORIO (`PartialExecutionError`), así que en producción daba
        // `false` siempre y esta rama seguía muerta. Se decide sobre la causa
        // de fondo, atravesando envoltorios (`esErrorDePresupuesto`).
        const agotoPresupuesto = esErrorDePresupuesto(e);
        const transitorio = isTransientError(causaDeFondo(e)) || agotoPresupuesto;
        logger.error('agent.fail', { tenant: op.tenantId, viaje: viajeId, operador: op.operadorId, transitorio, agotoPresupuesto, err: e instanceof Error ? e.message : String(e) });
        reply = agotoPresupuesto
          ? COLOFON_SIN_PRESUPUESTO
          : 'Perdón, se me trabó el sistema tantito. ¿Me reenvías tu último mensaje?';

        // ── EL MOTOR NO NECESITA AL LLM PARA CUADRAR (RES-15) ─────────────
        //
        // Auditoría prod 22-ago-2026: con OpenRouter caído —429, 5xx, un
        // provider que no contesta— el operador recibía "¿me reenvías tu
        // último mensaje?", reenviaba, y volvía a fallar igual. Le pedimos
        // que repita un trabajo que no era suyo y que no arregla nada,
        // mientras sus comprobantes YA están en la base.
        //
        // El cuadre es determinístico: `cuadrarDesdeDB` + `resumenCuadre` dan
        // los MISMOS números en milisegundos y sin modelo — es el mismo
        // camino que ya se usa cuando el presupuesto no alcanza para el
        // agente (arriba, `agente.sin_presupuesto`). Solo para fallos
        // TRANSITORIOS: un error de programación no se disfraza de cuadre.
        //
        // Lo que NO hace: cerrar la liquidación. Cerrar es una escritura y
        // decidirlo sin el agente sería inventar la decisión; esto informa
        // con cifras reales y deja el cierre para el turno siguiente. Por eso
        // `cerrado: false` en el resumen.
        if (transitorio) {
          try {
            reply = resumenCuadre(await cuadrarDesdeDB(op.tenantId, viajeId), false, 'operador');
            // AGEN-10: el cuadre degradado dice que NO cerró; con el tope de
            // IA, además, por qué y qué hacer (TC-N1). Se pega tras las guardias.
            colofon = agotoPresupuesto ? COLOFON_SIN_PRESUPUESTO : COLOFON_NO_CERRE;
            logger.warn('agent.degradado_a_cuadre', { tenant: op.tenantId, viaje: viajeId, agotoPresupuesto });
          } catch (eDeg) {
            // Si NI ESO se puede, se queda el mensaje de arriba: es la verdad.
            logger.error('agent.degradado_fallo', { viaje: viajeId, err: eDeg instanceof Error ? eDeg.message : String(eDeg) });
          }
        }
      }
    }

    // ── EL RELOJ SE VUELVE A MIRAR DESPUÉS DEL AGENTE (auditoría 21, C2) ─────
    //
    // Hasta aquí la última consulta al reloj era el `timeoutMs` del agente: la
    // cola de cierre entera corría a ciegas contra los techos reales de sus
    // pasos (10s por envío de WhatsApp, 9.5s por consulta). Si el agente
    // devoró el presupuesto y Meta/Supabase están lentos, Vercel mata el
    // proceso a media cola: sin excepción, sin catch, sin log — con la
    // liquidación YA persistida.
    //
    // `margenDuro()` es lo que queda hasta `maxDuration`, sin descontar nada.
    // Si ya no alcanza el margen real del cierre, se deja rastro RUIDOSO (la
    // muerte del proceso no deja ninguno; esto sí) y los pasos ACCESORIOS se
    // omiten con su propio log — el aviso al jefe y el de barrera vencida —
    // para gastar lo que queda en los irrenunciables: la respuesta y el PDF
    // del chofer. Recortar también esos sería fabricar a propósito el mismo
    // silencio que se viene a evitar; se intentan igual, cada uno acotado por
    // su propio techo.
    // AGEN-A1: se compara contra lo IRRENUNCIABLE, no contra la reserva
    // entera. `restante()` ya descontó `MARGEN_CIERRE_MS` antes de dárselo al
    // agente; exigirlo otra vez aquí es contarlo dos veces, y por la identidad
    // `margenDuro() = restante() + MARGEN_CIERRE_MS` el chequeo daba falso
    // DETERMINÍSTICAMENTE cada vez que el agente consumía su tope recortado —
    // apagando el único aviso de que la liquidación salió corta justo en el
    // caso que existe para vigilar. Ver el comentario de
    // `MARGEN_CIERRE_CRITICO_MS`.
    const margenRealMs = reloj.margenDuro();
    const cierreConMargen = margenRealMs >= MARGEN_CIERRE_CRITICO_MS;
    if (!cierreConMargen) {
      logger.error('cierre.sin_margen', {
        tenant: op.tenantId, viaje: viajeId, cerro: closed,
        gastadoMs: reloj.gastado(), margenRealMs, requeridoMs: MARGEN_CIERRE_CRITICO_MS,
      });
    }

    // GUARDIA DETERMINÍSTICA (código, no prompt): el LLM NUNCA reporta cifras que
    // no vengan de una tool. Si la respuesta trae dinero y no hubo cuadrar_viaje,
    // se descarta el texto del modelo y se responde con el cuadre REAL. (f/g)
    let textoDeterminista = false;
    try {
      const g = await guardiaCifras(reply, agentTools, op.tenantId, viajeId);
      if (g.forzado) {
        logger.warn('agent.cifras_forzadas', { viaje: viajeId });
        reply = g.reply;
        textoDeterminista = true;
      }
    } catch (e) {
      logger.warn('guardia.fail', { err: e instanceof Error ? e.message : String(e) });
    }

    // GUARDIA DE FUNDAMENTO: el modelo solo puede citar una norma que una tool le
    // devolvió EN ESTE TURNO. Lo demás se le quita del mensaje.
    //
    // Va DESPUÉS de la guardia de cifras a propósito: si aquella sustituyó el
    // texto por el resumen determinístico, este ya no trae citas y esto no hace
    // nada. Al revés se estaría limpiando un texto que iba a descartarse.
    //
    // Se lee de lo que las tools DEVOLVIERON, no de lo que el modelo diga que le
    // devolvieron: leerlo del texto sería preguntarle a la guardia por sí misma.
    //
    // NO CORRE SI EL TEXTO YA ES DETERMINÍSTICO. Cuando `guardiaCifras` sustituye
    // la respuesta por `resumenCuadre`, ese texto lo escribió el MOTOR y sus
    // citas salen de `engine.ts`, no del modelo. Correr esta guardia encima con
    // `permitidas` vacío se las quitaba: la guardia corrompiendo justamente la
    // fuente autoritativa que existe para no depender del modelo.
    //
    // (Aquí había un comentario que afirmaba que ese texto "ya no trae citas".
    // Era falso, y lo demostró la auditoría 3.)
    // AUDITORÍA 8, ALTO REINCIDENTE (AG-2): sin ninguna tool en el turno,
    // `permitidas` salía vacío y la guardia borraba a media frase CUALQUIER
    // cita — incluida la que el propio sistema ya le mandó al operador en un
    // turno anterior de este MISMO viaje (el resumen de `engine.ts`, o una
    // respuesta de `consultar_politica` que ya pasó por esta misma guardia).
    // Repetir una cita que YA se entregó no es alucinar: es memoria.
    //
    // AUDITORÍA 9, ALTO: ese arreglo concedía la memoria por `norma_id` SOLO,
    // sin comprobar que la afirmación actual fuera la misma que la justificó
    // la primera vez — "RFA 2026 regla 2.9" (tope de diésel en efectivo) se
    // podía pegar sin tool en una frase sobre una caseta, y la guardia la
    // dejaba pasar porque el id ya se había visto en el viaje. Por eso ya no
    // se calcula aquí una lista de ids permitidos por memoria: se le pasa a
    // `guardiaFundamento` el HISTORIAL crudo, y es ella quien decide —oración
    // por oración, por tema— si la cita de hoy es la misma afirmación de ayer.
    //
    // `turns` (arriba) trae el historial persistido más el mensaje del
    // operador de ESTE turno; se filtra a `assistant` porque lo que el
    // operador escribe no pasa por aquí — ampliar el permiso con texto del
    // usuario sería dejar que él mismo se autorizara una cita.
    if (!textoDeterminista) try {
      const historialAsistente = turns.filter((t) => t.role === 'assistant').map((t) => t.content).join('\n');
      const permitidas = normasDeToolCalls(agentTools.filter((t) => !t.error).map((t) => t.result));
      const f = guardiaFundamento(reply, permitidas, historialAsistente);
      if (f.forzado) {
        logger.warn('agent.fundamento_forzado', { viaje: viajeId, tenant: op.tenantId, quitadas: f.quitadas });
        reply = f.reply;
      }
    } catch (e) {
      logger.warn('guardia_fundamento.fail', { err: e instanceof Error ? e.message : String(e) });
    }

    // ── La afirmación de ESTADO, contra el hecho que el servidor ya tiene ─────
    //
    // `guardiaCifras` impide inventar un número; nada impedía inventar un HECHO.
    // "Ya quedó cerrada tu liquidación ✅" pasaba entera con `toolCalls: []`: el
    // viaje seguía `abierto`, no había liquidación ni PDF, y el operador dejaba
    // de mandar comprobantes esperando algo que nadie iba a generar.
    //
    // No es una heurística sobre el mundo: `closed` sale de las tool calls, así
    // que la guardia no adivina, COTEJA. Va después del fundamento y antes de
    // `say` porque es lo último que puede desmentir el texto.
    if (!textoDeterminista) {
      // `entrego` NO es `false` aquí, y esa fue la regresión de la auditoría 6:
      // el PDF se intenta 30 líneas más abajo, así que en este punto el envío
      // está PENDIENTE, no descartado. Con `false` la guardia leía como mentira
      // cualquier pretérito del modelo y sustituía el mensaje por "todavía no he
      // cerrado tu liquidación" — justo antes de mandar el PDF de la liquidación
      // cerrada. Ver `EstadoReal.entrego`.
      const est = guardiaEstado(reply, { cerro: closed, entrego: closed ? 'pendiente' : false });
      if (est.forzado) {
        logger.error('agent.estado_falso', { viaje: viajeId, tenant: op.tenantId, motivos: est.motivos });
        reply = est.reply;
      }
    }
    // El colofón «no cerré» va DESPUÉS de las guardias (AGEN-10): la de cifras
    // sustituye el texto entero y lo perdía. Solo se pone si de verdad no
    // cerró — un cierre recuperado por la base lo deja sin efecto.
    if (colofon && !closed && !reply.includes(colofon)) reply = `${reply}\n\n${colofon}`;

    const entregado = await say(reply);

    // Si la barrera de intake venció (un OCR tardó demasiado), avisa que se
    // cuadró con lo que alcanzó — falla visible, no silenciosa.
    // EL `try` ENVUELVE TAMBIÉN EL `getGastos`, y esa es la corrección.
    //
    // Estaba FUERA: si `getGastos` lanzaba —un blip de Supabase, justo cuando la
    // barrera venció porque la base ya iba lenta— el control saltaba al `catch`
    // general, que está DESPUÉS del bloque del PDF. Resultado con la liquidación
    // ya cerrada y los dos PDF ya en storage: el operador recibía "Perdón, se me
    // trabó tantito, ¿me reenvías tu último mensaje?", obedecía, y `getOpenViaje`
    // ya no encontraba nada porque el viaje estaba `liquidado`. Callejón sin
    // salida: liquidación cerrada, PDF existente, y ningún camino por el que
    // llegue. `pdf.no_entregado` tampoco se disparaba, porque vive dentro del
    // bloque que se saltó.
    //
    // Un aviso accesorio no puede tirar la entrega del entregable.
    //
    // AUDITORÍA 8, ALTO: "reenvíalo y escribe *listo* otra vez" se escribió
    // cuando reenviar funcionaba. Con `closed`, la liquidación YA se emitió y
    // las dos instrucciones son imposibles: reenviar truena con el trigger de
    // la 0036 (`trg_gasto_no_tras_liquidar`) y "listo" ya no encuentra viaje
    // abierto. El consejo se distingue por `closed`, igual que el mensaje
    // gemelo de `llegoTarde` (arriba, línea ~526) para el mismo hecho.
    // AUDITORÍA 9, MEDIO agéntico: la primera mitad del aviso ("cuadré con los
    // N comprobantes") afirmaba un cuadre que, sin `closed`, no ocurrió —el
    // agente pudo simplemente haber contestado un saludo sin llamar ninguna
    // tool, el viaje sigue `abierto`, y no hay liquidación ni PDF. Es la misma
    // clase de mentira que `guardiaEstado` existe para tapar, solo que este
    // texto no pasa por ninguna guardia. Se bifurca la frase ENTERA por
    // `closed`, no solo el consejo (que ya se bifurcaba desde la ronda 8).
    if (!intakeOk && !cierreConMargen) {
      // Sin margen, este aviso accesorio no puede costarle al chofer su PDF:
      // se omite con rastro (auditoría 21, C2). El dato de fondo —cuántos
      // comprobantes entraron— sigue visible para el contralor en el panel.
      logger.warn('cierre.aviso_barrera_omitido_sin_margen', { tenant: op.tenantId, viaje: viajeId, margenRealMs });
    } else if (!intakeOk) {
      try {
        const n = (await getGastos(viajeId, op.tenantId)).length;
        const aviso = closed
          ? `⚠️ Ojo: cuadré con los ${n} comprobantes que alcancé a procesar. Guárdalo: mándalo en tu siguiente viaje o pídele a la oficina que lo agregue desde el panel.`
          : `⚠️ Ojo: uno de tus comprobantes tardó más de lo normal en procesarse — llevo ${n} guardados de este viaje, pero todavía no cuadro nada. Si te faltó alguno, reenvíalo y escribe *listo* cuando quieras que cuadre.`;
        await say(aviso);
      } catch (e) {
        logger.warn('intake.aviso', { viaje: viajeId, tenant: op.tenantId, err: e instanceof Error ? e.message : String(e) });
      }
    }

    if (closed) {
      // `guardar_liquidacion` devuelve `pdf_generado` y ese dato se tiraba. Si el
      // PDF no se generó —o el upload a storage falló— se pedía igual una URL
      // firmada de un objeto que no existe: `createSignedUrl` no lanza, devuelve
      // `{ data: null, error }`, el error se descartaba en el destructuring, no
      // había `else` y el `catch` nunca se disparaba. El operador se queda
      // esperando el documento que el prompt le prometió, y en los logs no hay
      // NADA. En el demo es el paso 3 del guion fallando en silencio.
      const guardado = agentTools.find((t) => t.toolName === 'guardar_liquidacion' && !t.error);
      const pdfGenerado = Boolean((guardado?.result as { pdf_generado?: boolean } | undefined)?.pdf_generado);
      // AUDITORÍA 8/9, MEDIO REINCIDENTE (backend): el ejemplar del CONTRALOR
      // —quien decide la compra— es el que queda en `liquidacion.pdf_path` y
      // el botón de descarga del panel. Su fallo era invisible: nada lo
      // revisaba, así que un upload roto solo del lado del contralor pasaba
      // exactamente igual que el camino feliz. No hay a quién avisarle por
      // WhatsApp (el contralor no tiene este chat), así que la única
      // reparación disponible es hacerlo RUIDOSO en el log — mismo criterio
      // que ya usa `pdf.no_entregado` dos líneas abajo para el caso gemelo
      // del operador.
      const pdfContralorGenerado = Boolean((guardado?.result as { pdf_contralor_generado?: boolean } | undefined)?.pdf_contralor_generado);
      const liqIdCerrada = (guardado?.result as { liquidacion_id?: string } | undefined)?.liquidacion_id;
      if (!pdfContralorGenerado) {
        logger.error('pdf.contralor_no_generado', { tenant: op.tenantId, viaje: viajeId, liqId: liqIdCerrada });
      }
      try {
        if (!pdfGenerado) throw new Error('la tool reportó pdf_generado=false');
        // El ejemplar del OPERADOR, no el completo: ver `tools.ts`.
        const path = `${op.tenantId}/${viajeId}-operador.pdf`;
        // AUDITORÍA 8, ALTO REINCIDENTE: `createSignedUrl` seguía crudo, sin
        // `acotada` — el único de los 13 pasos del cierre que faltaba en este
        // archivo. Ya está dentro de un try/catch que lo maneja bien; lo que
        // faltaba era no colgarse 300s antes de llegar a ese catch.
        //
        // AUDITORÍA 9, MEDIO REINCIDENTE ×4 (rondas 5, 6, 8 y 9): el TTL seguía
        // en 3600s aunque el único consumidor es Meta, que descarga en
        // segundos, y el objeto lleva folio y montos de un ticket de un bucket
        // privado. `api/export/pdf/[id]/route.ts:59` ya nació con el TTL
        // correcto (60s, "la necesidad dura lo que tarda la descarga") — se
        // copia el mismo número aquí en vez del que se copió de más viejo.
        //
        // AUDITORÍA 13, seguridad (verificación con lectura real, reincidente
        // "TTL de 7 días" heredado desde la ronda 11): se reconsideró subir
        // este número, porque `sendDocument` acepta el mensaje y Meta descarga
        // el `link` DESPUÉS, por su cuenta (`meta/client.ts`) — asíncrono, no
        // simultáneo al POST. Se dejó en 60s a la espera de evidencia de un
        // fallo de Storage; la evidencia llegó en la 24 (AGEN-9) por el
        // camino del OUTBOX, que reintenta el MISMO `link` a los 5 minutos.
        // El porqué del número vive con la constante.
        const { data, error } = await acotada(supabaseAdmin().storage.from('liquidaciones').createSignedUrl(path, TTL_FIRMA_PDF_SEGUNDOS), 'createSignedUrl');
        if (error || !data?.signedUrl) throw new Error(error?.message ?? 'storage no devolvió URL firmada');
        // AUDITORÍA 12, ALTO (backend, reincidente de ronda 10): `sendDocument`
        // NO lanza — devuelve { ok: false, error } cuando Meta rechaza el
        // documento. Sin comprobar el resultado, un PDF rechazado por Meta se
        // leía como entregado: el chofer se queda esperando su liquidación y en
        // los logs no hay NADA. Mismo criterio que `pdf.contralor_no_generado`
        // dos bloques arriba: la reparación es hacerlo RUIDOSO.
        const enviado = await sendDocument(msg.from, data.signedUrl, 'liquidacion.pdf', 'Aquí está tu liquidación 📄');
        if (!enviado.ok) {
          logger.error('pdf.no_entregado', {
            viaje: viajeId, tenant: op.tenantId, codigo: enviado.codigo, error: enviado.error,
          });
          await alertarOperador('pdf.no_entregado', {
            viaje: viajeId, tenant: op.tenantId, codigo: enviado.codigo, error: enviado.error,
          });
          // AUDITORÍA 13, BAJO (residual del cierre de la ronda 12): el rechazo
          // de Meta dejaba rastro pero SILENCIO en el teléfono del chofer — se
          // quedaba esperando el PDF que el prompt le prometió. Se le dice la
          // verdad y a quién pedirlo; la liquidación ya está cerrada y el
          // contralor la tiene en el panel.
          await sendText(msg.from, 'Tu liquidación ya quedó cerrada ✅, pero el PDF no se te entregó por un problema del chat. Pídeselo a tu contralor: él ya lo tiene en el panel. 🙏').catch(() => {});
        } else {
          await registrarCostoWhatsApp(op.tenantId, viajeId);
          // AGEN-4: sello de entrega — el reintento de un «listo» no vuelve a
          // mandar este PDF.
          await sellarEntregaLiquidacion(op.tenantId, liqIdCerrada, 'entregada_operador_en');
        }

      } catch (e) {
        // Ruidoso a propósito: la liquidación SÍ quedó cerrada en la base, así que
        // esto no es recuperable por reintento y nadie lo va a notar salvo por el log.
        // `codigo` (AUDITORÍA 18, M14): sin él, el fingerprint de este catch
        // era el mismo para «storage no devolvió URL firmada» hoy y un TypeError
        // de pdf-lib mañana — la segunda causa caía en el issue viejo y no
        // notificaba. Mismo discriminador que los cron.
        logger.error('pdf.no_entregado', {
          tenant: op.tenantId, viaje: viajeId, pdfGenerado,
          err: e instanceof Error ? e.message : String(e),
          codigo: codigoDeError(e),
        });
        await alertarOperador('pdf.no_entregado', {
          tenant: op.tenantId, viaje: viajeId, pdfGenerado,
          err: e instanceof Error ? e.message : String(e),
          codigo: codigoDeError(e),
        });
        // Y se le dice al operador, en vez de dejarlo esperando: el cierre es
        // real, lo que falta es el papel.
        try {
          await say('Tu liquidación ya quedó cerrada ✅, pero no pude generarte el PDF. Tu contralor ya la tiene en el panel; si necesitas el documento, pídeselo. 🙏');
        } catch { /* best-effort */ }
      }

      // ── Y LA OFICINA SE ENTERA, CON EL PDF COMPLETO ──────────────────────
      //
      // Cierra el circuito: el trabajo entró por WhatsApp y el resultado sale
      // por WhatsApp. Si para tener el PDF hubiera que entrar a una pantalla,
      // la mitad de las veces nadie entra — y la liquidación existe pero no la
      // mira quien tiene que firmarla.
      //
      // FUERA del try del PDF del operador (auditoría 18, M27): el aviso de
      // TEXTO al jefe no depende del papel del chofer. Antes vivía anidado
      // bajo `if (!pdfGenerado) throw`, así que un upload caído del ejemplar
      // del operador dejaba al único humano que decide sin texto y sin PDF.
      //
      // Y CON EL EJEMPLAR DEL CONTRALOR (M26): la URL que se le pasaba era la
      // del operador, el ejemplar con los veredictos `SOLO_CONTRALOR`
      // recortados — justo los que el contador, a quien el jefe le pasa este
      // PDF, tiene que resolver. Se firma el completo (`${tenant}/${viaje}.pdf`,
      // `tools.ts`), con el mismo TTL de 60s y el mismo criterio.
      //
      // BEST-EFFORT DURO: la liquidación YA está cerrada y el chofer YA tiene
      // su PDF. Un jefe sin teléfono registrado o un WhatsApp caído no pueden
      // costar una liquidación, así que esto no puede lanzar hacia arriba.
      // SE ESPERA, no se deja flotando. En serverless una promesa suelta puede
      // quedarse a medias cuando la invocación termina: el aviso al jefe
      // saldría "a veces", que es peor que no salir nunca porque nadie lo
      // reproduce. El try/catch es lo que impide que este await cueste el
      // cierre; son dos lecturas y un envío, no un presupuesto — y están
      // contados en `PASOS_CIERRE` (A24).
      if (!cierreConMargen) {
        // AUDITORÍA 21, C2: el aviso al jefe son hasta 5 viajes de red más
        // (dos consultas, una firma y dos envíos). Sin margen, correrlos
        // arriesga que Vercel mate el proceso ANTES de `saveConversation` y
        // del release del lock. Se omite con rastro; el contralor tiene la
        // liquidación y su PDF en el panel, y este log es la señal para
        // avisarle por otra vía.
        // `warn` y no `error`: el error RUIDOSO de este estado ya quedó arriba
        // (`cierre.sin_margen`); esto es el detalle de QUÉ se recortó.
        logger.warn('cierre.jefe_omitido_sin_margen', { tenant: op.tenantId, viaje: viajeId, margenRealMs });
      } else try {
        let urlPdfJefe: string | null = null;
        if (pdfContralorGenerado) {
          const firma = await acotada(supabaseAdmin().storage.from('liquidaciones').createSignedUrl(`${op.tenantId}/${viajeId}.pdf`, TTL_FIRMA_PDF_SEGUNDOS), 'createSignedUrl.contralor');
          if (firma.error || !firma.data?.signedUrl) {
            logger.warn('cierre.pdf_jefe_sin_url', { viaje: viajeId, err: firma.error?.message ?? 'storage no devolvió URL firmada' });
          } else {
            urlPdfJefe = firma.data.signedUrl;
          }
        }
        const rj = await avisarCierreAlJefe({ tenantId: op.tenantId, viajeId, urlPdf: urlPdfJefe, telefonoOperador: msg.from });
        // AUDITORÍA 25 (MEDIO, agentico.md:526): antes se sellaba con solo
        // `rj.enviado` — que es "el TEXTO salió", no "el jefe tiene su
        // PDF". Si había un PDF del contralor y no llegó (createSignedUrl
        // falló arriba, o `sendDocument` falló dentro de
        // `avisarCierreAlJefe`), el sello se ponía igual y
        // `entregarCierrePendiente` nunca volvía a intentar el PDF: el
        // ejemplar que el contralor necesita para su contador se perdía
        // para siempre detrás de un sello que decía "ya avisado".
        const pdfJefeOk = !pdfContralorGenerado || rj.pdfEnviado === true;
        if (!rj.enviado) logger.warn('cierre.jefe_no_avisado', { viaje: viajeId, motivo: rj.motivo });
        else if (!pdfJefeOk) logger.warn('cierre.jefe_avisado_sin_pdf', { viaje: viajeId, teniaUrlFirmada: urlPdfJefe != null });
        // AGEN-4: sello — el reintento de un «listo» no vuelve a avisar.
        else await sellarEntregaLiquidacion(op.tenantId, liqIdCerrada, 'avisada_oficina_en');
      } catch (e) {
        logger.error('cierre.aviso_jefe_falló', { viaje: viajeId, err: e instanceof Error ? e.message : String(e) });
      }
    }

    // LA CONVERSACIÓN GUARDA LO QUE EL OPERADOR LEYÓ, no lo que se intentó
    // decirle. Si el envío rebotó, ese turno NO entra: dejarlo haría que el
    // agente diera por dicho algo que el operador nunca vio, y en el siguiente
    // mensaje respondiera desde una charla que solo existió de este lado.
    //
    // Los turnos del OPERADOR sí se guardan siempre: ésos sí ocurrieron, y
    // perderlos borraría lo único que él sí mandó.
    await saveConversation(
      conv.id,
      entregado ? [...turns, { role: 'assistant', content: reply }] : turns,
      closed ? null : viajeId,
      // Las marcas se ARRASTRAN, no se recalculan: este turno no las tocó. Si se
      // omitieran, `saveConversation` las borraría (reescribe el jsonb entero) y
      // un error transitorio del atajo de confirmación —que cae al agente por su
      // try/catch— reiniciaría el contador de intentos.
      { intentosConfirmacion: conv.intentosConfirmacion, cierreSinComprobantes: conv.cierreSinComprobantes },
    );
    if (!entregado) logger.error('wa.respuesta_no_entregada', { tenant: op.tenantId, viaje: viajeId });
  } catch (e) {
    // CR-2: si el procesamiento crashea, liberar el claim para que el retry de
    // Meta lo reprocese (at-least-once). El OCR/agente ya tienen sus propios
    // catch; esto atrapa lo inesperado (descarga, DB, red) antes de perder dinero.
    //
    // `ConsultaFallida` se distingue a propósito: significa que la BASE NO
    // CONTESTÓ, no que el operador o su viaje no existan. Antes esa misma
    // situación devolvía `null` y el producto afirmaba un hecho falso —"no te
    // tengo registrado", "ese viaje ya quedó cerrado 👍"— sobre un operador dado
    // de alta y un viaje abierto. Aquí no se afirma nada: se dice que no se pudo
    // consultar, que es lo único cierto, y se le pide reintentar.
    const noSePudoConsultar = e instanceof ConsultaFallida;
    const ambiguo = e instanceof OperadorAmbiguo;
    logger.error(
      ambiguo ? 'processInbound.operador_ambiguo'
        : noSePudoConsultar ? 'processInbound.consulta_fallida'
        : 'processInbound.fail',
      {
        id: msg.waMessageId, de: msg.from,
        tenant: ctxTenant, viaje: ctxViaje,
        // Si esto sale `true`, la liquidación YA está cerrada en la base y el
        // operador acaba de recibir "se me trabó": hay un PDF sin entregar y
        // reenviar el mensaje NO lo va a arreglar, porque el viaje ya no está
        // abierto. Es la señal de que alguien tiene que entrar a mano.
        cerroSinEntregar: ctxCerro,
        err: e instanceof Error ? e.message : String(e),
      },
    );
    await soltarClaim();
    // Al operador se le dice lo que es cierto en cada caso. Reintentar sirve
    // cuando falló la red; NO sirve cuando su número está duplicado en la base,
    // y decirle "inténtalo de nuevo" ahí lo deja en un bucle.
    const aviso = ambiguo
      ? 'Tu número aparece dado de alta más de una vez y no puedo saber a qué viaje pertenece 😕 Avísale a tu flota para que lo corrija; ya lo reporté.'
      : noSePudoConsultar
        ? 'No pude consultar tus datos en este momento 😕 No es que no estés registrado: es que la conexión falló. Vuelve a intentarlo en un minuto.'
        : 'Perdón, se me trabó tantito. ¿Me reenvías tu último mensaje? 🙏';
    try { await sendText(msg.from, aviso); } catch { /* best-effort */ }
  } finally {
    if (lockedViaje) await releaseViajeLock(lockedViaje, tokenViaje);
  }
}
