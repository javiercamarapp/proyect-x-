// ═══════════════════════════════════════════════════════════════════════════
// EL JOIN DEL CFDI CONSOLIDADO — auditoría 10, hallazgo CRÍTICO fiscal.
//
// Diésel por monedero y peaje por TAG son, por estimación interna SIN FUENTE
// CONFIRMADA (ver la nota en `intake/cfdi_xml.ts`), una fracción grande del
// gasto real de una flota, y NUNCA generan un ticket por transacción: llegan como UN
// CFDI que ampara muchos días de consumo. `cfdi_xml.ts` ya sabe extraer esas
// líneas (`CfdiLineaXml[]`, ver ese archivo). Este módulo hace lo que falta:
// decidir a qué `gasto` ya capturado pertenece cada línea, o admitir que no
// se sabe y dejarlo para un humano.
//
// ── EL CANAL: WHATSAPP, NO UNO NUEVO ─────────────────────────────────────
//
// El operador YA manda el XML del CFDI por WhatsApp (`processor.ts`, camino
// de `document`) y la oficina/contador YA tiene un número reconocido
// (`contactos.ts:resolverCuentaOficina`). Construir un buzón de correo nuevo
// (`facturas-<tenant>@likida.ai`, decidido el 29-jul y nunca hecho) habría
// significado IMAP, un dominio de correo entrante y una superficie de ataque
// nueva — para resolver un problema que el canal existente ya resuelve al
// 90%: SUBIR un archivo. Lo único que faltaba era reconocer que un XML con
// más de una línea NO es un ticket 1:1 y darle un camino distinto. Ese es el
// alcance real de esta ronda; el buzón de correo sigue sin construirse y
// sigue siendo una opción legítima para cuando WhatsApp no alcance (p. ej. si
// el emisor manda el XML solo por correo y nadie en la flota lo reenvía).
//
// ── LA REGLA DURA, LA MISMA DE `emparejar.ts` ────────────────────────────
//
// "Ante la duda no se adivina." Una línea con más de un candidato razonable,
// o con cero, NO se liga a nada — se queda en `cfdi_consolidado_linea` con
// `estatus = 'por_conciliar'` para que un contador la resuelva viendo el
// mismo CFDI que va a defender ante el SAT. Colgarle a una línea el gasto
// equivocado es peor que dejarla suelta: mueve litros/IVA/IEPS de un viaje a
// otro sin que nadie lo note hasta el cuadre.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase/admin';
import { acotada } from '../presupuesto';
import { traerTodo, conteo } from '../pg';
import { logger } from '@/lib/logger';
import { enLotes } from '../lotes';
import { strip_accents } from '../cuadre/util';
import type { Gasto } from '@/types/likida';
import type { CfdiLineaXml, CfdiXmlData } from './cfdi_xml';

/**
 * Tolerancia de monto: rondeos entre lo que el ticket fotografiado (u OCR)
 * capturó y lo que el emisor del monedero/TAG declara en su propio estado de
 * cuenta. NO es margen para una cifra distinta — una diferencia de $10 o más
 * es otra transacción (o un error de OCR que se corrige por su propio
 * camino), no algo que este módulo deba perdonar en silencio.
 */
export const TOLERANCIA_MONTO_MXN = 1;

/**
 * Ventana de fecha: ±1 día alrededor de la fecha real de la línea. Cubre
 * compras cerca de medianoche y el rezago normal entre "el chofer cargó" y
 * "la oficina capturó el ticket" — NO una ventana ancha: entre más días se
 * acepten, más probable que dos comprobantes distintos del mismo monto caigan
 * dentro y la línea se vuelva ambigua por diseño de este mismo código.
 */
export const VENTANA_DIAS_FECHA = 1;

// Exportada porque `desglose_peaje.ts` cruza con la MISMA regla de ventana:
// dos copias de este cálculo serían dos oportunidades de que una redondee
// distinto y los dos cruces dejen de significar lo mismo.
export function diasDeDiferencia(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Infinity;
  return Math.abs(ta - tb) / 86_400_000;
}

function sumarDias(fechaIso: string, delta: number): string {
  const d = new Date(`${fechaIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** El rango [desde, hasta] que cubre TODAS las líneas con fecha, con la
 *  ventana ya aplicada — o `null` si NINGUNA línea trae fecha (consolidado
 *  tipo TAG sin ECC12: ver `cfdi_xml.ts`). Sin rango no se trae ni un
 *  candidato: filtrar por monto solo, contra el historial entero de la
 *  flota, es justo lo que este módulo existe para no hacer. */
export function rangoFechasLineas(lineas: CfdiLineaXml[]): { desde: string; hasta: string } | null {
  const fechas = lineas.map((l) => l.fecha?.slice(0, 10)).filter((f): f is string => !!f);
  if (fechas.length === 0) return null;
  const ordenadas = [...fechas].sort();
  return {
    desde: sumarDias(ordenadas[0], -VENTANA_DIAS_FECHA),
    hasta: sumarDias(ordenadas[ordenadas.length - 1], VENTANA_DIAS_FECHA),
  };
}

/**
 * FASE 1 (docs/asistencia/PLAN-FASES.md): identifica diésel de una línea del
 * consolidado y su clave SAT. concepto_base trae `claveProdServ` nativo;
 * ecc12 NO (la ECC12 v1.2 no da ClaveProdServ por transacción) — solo
 * `tipoCombustible`, catálogo cerrado del SAT. Se traduce ÚNICAMENTE
 * diésel a 15101505 (la clave que `config.ts:130` reconoce para el
 * estímulo LIF 2026 art. 20 ap. A): el estímulo es diésel, no "cualquier
 * combustible", así que Magna/Premium/Gas/Otros se quedan sin clave a
 * propósito, no por omisión.
 *
 * ═══ POR QUÉ SE NORMALIZA EL TEXTO Y HASTA DÓNDE ═════════════════════════
 *
 * Hasta hoy la comparación era `l.tipoCombustible === 'Diesel'`, EXACTA:
 * mayúscula inicial, sin acento, sin espacios. El repo no tiene —ni ha
 * tenido nunca— un solo CFDI con complemento ECC emitido de verdad (los tres
 * fixtures del repo son strings sintéticos; ver `pruebas-manuales/
 * consolidado-real.prueba.ts`, que dice literal "real en estructura"), así
 * que nadie ha visto con qué exactitud tipográfica timbra un emisor real ese
 * atributo. Un `"DIESEL"`, un `"Diésel"` o un `" Diesel "` —las tres formas
 * en que un emisor puede escribir LA MISMA PALABRA— devolvían `undefined`, y
 * entonces `datosDieselDeLinea` no propagaba nada: los litros del mes
 * entero se guardaban en la línea y no llegaban NUNCA al gasto ni al motor.
 * Cero litros acreditables por una mayúscula. Ese es el mismo hueco que la
 * Fase 1 vino a cerrar, sobreviviendo dentro del arreglo.
 *
 * Se normaliza mayúsculas, acentos y espacios — es la MISMA palabra escrita
 * distinto, no una clave distinta.
 *
 * LO QUE NO SE HACE, A PROPÓSITO: no se mapea ninguna clave numérica de
 * catálogo (`"01"`, `"02"`…). El SAT publica `c_ClaveTipoCombustible` y este
 * repo NO tiene ese catálogo verificado contra fuente (ni en `normas/`, ni
 * en `normas/datos/`, ni en `docs/conocimiento/05-hidrocarburos.md`, que
 * documenta el complemento pero no el catálogo de ese atributo). Adivinar
 * que "02" es diésel acreditaría litros de gasolina — una cifra fiscal
 * inventada, exactamente lo que la casa prohíbe. Cuando exista el catálogo
 * con su fuente (mismo patrón que `normas/datos/cuota-ieps-diesel.yaml`),
 * esta función es el único lugar donde hay que agregarlo.
 */
export function claveProdServDeLinea(l: Pick<CfdiLineaXml, 'claveProdServ' | 'tipoCombustible'>): string | undefined {
  if (l.claveProdServ?.startsWith('15101')) return l.claveProdServ;
  if (esDieselTexto(l.tipoCombustible)) return '15101505';
  return undefined;
}

/** ¿Este `TipoCombustible` de una línea ECC12 dice "diésel"? Solo texto: la
 *  misma palabra escrita con otra caja, con acento o con espacios de más
 *  sigue siendo la misma palabra. Una clave numérica de catálogo NO entra
 *  aquí — ver el bloque de arriba. */
function esDieselTexto(tipo: string | undefined): boolean {
  if (!tipo) return false;
  return strip_accents(tipo).trim().toUpperCase() === 'DIESEL';
}

/**
 * ¿La `Cantidad` de esta línea son LITROS de combustible?
 *
 * La columna se llama `litros` (mig. 0168) y hasta hoy se llenaba con
 * `linea.cantidad` de CUALQUIER línea. En un consolidado de TAG —el otro uso
 * de esta tabla, casetas por `concepto_base`— cada `cfdi:Concepto` trae
 * `Cantidad="1"`: UN CRUCE, no un litro. La tabla quedaba diciendo que una
 * caseta de $118 tuvo "1 litro", y el propio comentario de la columna 0168
 * ("NULL = la linea no trae Cantidad, p.ej. una caseta") describía algo que
 * no pasaba. Ningún cálculo de dinero lo leía todavía —`datosDieselDeLinea`
 * y `resolverLineaAMano` exigen `clave_prod_serv`, que una caseta no tiene—,
 * pero es una cifra falsa esperando a que alguien la sume en un reporte.
 *
 * Se guarda `litros` cuando:
 *   · la línea es `ecc12` — el complemento se llama Estado de Cuenta de
 *     COMBUSTIBLES y su `Cantidad` es volumen por definición del estándar
 *     (sea diésel, magna o gas: son litros aunque no sean acreditables); o
 *   · la línea es `concepto_base` CON clave de combustible (`15101…`).
 *
 * En cualquier otro caso queda `null`, que es la verdad: no se midió un
 * volumen. `null` ≠ 0 y `null` ≠ "1 litro".
 */
export function litrosDeLinea(l: Pick<CfdiLineaXml, 'cantidad' | 'fuente' | 'claveProdServ' | 'tipoCombustible'>): number | null {
  if (l.cantidad == null || !Number.isFinite(l.cantidad)) return null;
  if (l.fuente === 'ecc12') return l.cantidad;
  return l.claveProdServ?.startsWith('15101') ? l.cantidad : null;
}

export type EstatusLineaConsolidado = 'conciliada' | 'por_conciliar';

export interface CandidatoConciliacion { gastoId: string; monto: number; fecha: string | null }

export interface ResultadoLinea {
  linea: CfdiLineaXml;
  estatus: EstatusLineaConsolidado;
  gastoId: string | null;
  /** Solo cuando `estatus === 'por_conciliar'`: por qué no fue automático —
   *  vacío (0 candidatos) o varios (ambiguo). Se guarda para que un humano no
   *  tenga que volver a correr el matcher a mano. */
  candidatos: CandidatoConciliacion[];
}

/**
 * El JOIN. Puro: no toca la base, para poder probarlo sin mockear Supabase.
 *
 * Un `gasto` que ya se le asignó a una línea SALE del fondo antes de evaluar
 * la siguiente — dos líneas de un mismo consolidado no pueden reclamar el
 * mismo comprobante, y quitar al ya-asignado puede volver ÚNICO a un
 * candidato que antes era ambiguo (misma idea que `emparejarPorMonto` en
 * `emparejar.ts`).
 */
export function conciliarLineas(lineas: CfdiLineaXml[], gastosDisponibles: Gasto[]): ResultadoLinea[] {
  let disponibles = [...gastosDisponibles];
  const resultados: ResultadoLinea[] = [];

  for (const linea of lineas) {
    // Sin fecha, CERO intento de match automático. Ver el porqué en el
    // encabezado del archivo y en `cfdi_xml.ts`.
    if (!linea.fecha) {
      resultados.push({ linea, estatus: 'por_conciliar', gastoId: null, candidatos: [] });
      continue;
    }

    const dia = linea.fecha.slice(0, 10);
    const candidatos = disponibles.filter((g) =>
      g.fecha != null &&
      Math.abs(g.monto - linea.monto) <= TOLERANCIA_MONTO_MXN &&
      diasDeDiferencia(g.fecha.slice(0, 10), dia) <= VENTANA_DIAS_FECHA);

    if (candidatos.length === 1) {
      const [match] = candidatos;
      disponibles = disponibles.filter((g) => g.id !== match.id);
      resultados.push({ linea, estatus: 'conciliada', gastoId: match.id, candidatos: [] });
    } else {
      resultados.push({
        linea,
        estatus: 'por_conciliar',
        gastoId: null,
        candidatos: candidatos.map((g) => ({ gastoId: g.id, monto: g.monto, fecha: g.fecha ?? null })),
      });
    }
  }
  return resultados;
}

export interface ResumenConciliacion {
  cfdiXmlId: string;
  totalLineas: number;
  conciliadas: number;
  porConciliar: number;
}

/**
 * Escribe `cfdi_uuid` + `cfdi_orden` en el `gasto` que gana el match — el
 * ÚNICO lugar que decide qué significa "ligar" una línea del consolidado a
 * un gasto. Lo usan los dos caminos: el JOIN automático de
 * `guardarYConciliarConsolidado` y la resolución a mano de
 * `resolverLineaAMano`. Dos copias de este `update` habrían sido dos
 * oportunidades de que una se quedara sin el guardia `.is('cfdi_uuid', null)`
 * y ligara el mismo comprobante dos veces.
 *
 * El guardia existe porque entre "se calculó el candidato" y "se escribe" hay
 * una ventana: en el camino automático son milisegundos (mismo request); en
 * el manual pueden ser MINUTOS —lo que tarda un contador en mirar la pantalla
 * y hacer clic—, tiempo de sobra para que otra línea, u otro humano resolviendo
 * en paralelo, ya se haya llevado ese mismo gasto. Devuelve `false`, no lanza:
 * el llamador decide qué hacer con eso (best-effort en el automático, un error
 * explícito para el humano en el manual).
 */
async function ligarLineaAGasto(
  tenantId: string,
  cfdiUuid: string,
  orden: number,
  gastoId: string,
  // FASE 1: presente solo cuando la línea es diésel identificable (ver
  // `claveProdServDeLinea`) y trae litros > 0 — cualquier otro concepto
  // (caseta, gasolina, …) liga igual que siempre, sin tocar ocr_extra.
  diesel?: { litros: number; claveProdServ: string },
): Promise<boolean> {
  // AUDITORÍA 19 (fiscal, CRÍTICO F1): sin esto, un gasto ligado a un CFDI
  // consolidado nunca marcaba `xml_verificado`, y `cuadre/engine.ts:1248`
  // (`if (!g.xmlVerificado) continue;`) gatea TODO el bloque de acreditamiento
  // — no solo el IVA, también el estímulo de peaje y los litros de diésel que
  // la Fase 1 ya captura en `ocr_extra.litros`. El resultado: el litro se
  // guardaba y nunca se usaba, y el IVA/estímulo de un monedero o TAG salían
  // en $0 sin avisar — la MISMA garantía que ya vale para el CFDI 1:1
  // (`repo.ts:updateGastoCfdiXml`, `processor.ts` al crear desde XML), porque
  // el match monto+fecha contra la línea del CFDI (`conciliarLineas`, o un
  // humano vía `resolverLineaAMano`) es la misma verificación que un CFDI
  // suelto. NO se copian `iva_traslado`/`ieps_traslado` del documento: el
  // estándar (ECC12/concepto_base) no los da POR LÍNEA, solo en el total del
  // CFDI completo, y asignarle el total del documento a una sola transacción
  // sería inventar un desglose que no existe — se deja `null`, que es lo que
  // hace que el motor avise "IEPS no desglosado" en vez de acreditar de más.
  const cambios: Record<string, unknown> = { cfdi_uuid: cfdiUuid, cfdi_orden: orden, xml_verificado: true };
  if (diesel) {
    // Lectura + fusión + escritura sobre `ocr_extra` — mismo patrón que
    // `updateGastoCfdiXml` en repo.ts (auditoría 12): el jsonb ya guarda
    // producto/estación/fechaImpresa del OCR y una escritura a ciegas lo
    // borraría.
    //
    // `acotada()` NO lanza al agotar el tope: resuelve `{ data: null, error }`.
    // Sin mirar `error`, un SELECT mudo se lee como "sin ocr_extra" y el
    // UPDATE posterior borra producto/estación/fechaImpresa, dejando solo
    // `{ litros }`. La clave SAT es columna, no jsonb: se puede escribir
    // igual. Los litros esperan a poder fusionar.
    const leido = await acotada(supabaseAdmin().from('gasto')
      .select('ocr_extra').eq('id', gastoId).eq('tenant_id', tenantId).maybeSingle(), 'consolidado.ligar_leer_ocr_extra') as {
        data: { ocr_extra?: unknown } | null; error: { message: string } | null;
      };
    cambios.clave_prod_serv = diesel.claveProdServ;
    if (leido.error) {
      logger.warn('consolidado.ligar_ocr_extra_ilegible', { tenant: tenantId, gasto: gastoId, err: leido.error.message });
    } else {
      const ocrExtra = { ...((leido.data?.ocr_extra as Record<string, unknown> | null) ?? {}) };
      ocrExtra.litros = diesel.litros;
      cambios.ocr_extra = ocrExtra;
    }
  }
  const { data, error } = await acotada(supabaseAdmin()
    .from('gasto')
    .update(cambios)
    .eq('id', gastoId)
    .eq('tenant_id', tenantId)
    .is('cfdi_uuid', null)
    .select('id'), 'consolidado.ligar_gasto');
  if (error) {
    logger.error('consolidado.ligar_gasto_error', { tenant: tenantId, gasto: gastoId, err: error.message });
    return false;
  }
  return (data?.length ?? 0) > 0;
}

/** `cantidad`/`claveProdServ` de una `CfdiLineaXml` → el `diesel` que espera
 *  `ligarLineaAGasto`, o `undefined` si la línea no es diésel identificable. */
function datosDieselDeLinea(l: Pick<CfdiLineaXml, 'cantidad' | 'claveProdServ' | 'tipoCombustible'>): { litros: number; claveProdServ: string } | undefined {
  if (l.cantidad == null || l.cantidad <= 0) return undefined;
  const clave = claveProdServDeLinea(l);
  return clave ? { litros: l.cantidad, claveProdServ: clave } : undefined;
}

/**
 * Guarda el CFDI consolidado, corre el JOIN contra el `gasto` del tenant y
 * deja rastro de las dos cosas: lo que ligó solo y lo que le tocó a un
 * humano. Idempotente por `(tenant_id, cfdi_uuid)` / `(cfdi_xml_id, indice)`:
 * reenviar el mismo XML dos veces (WhatsApp reintenta) no duplica nada.
 *
 * NO toca `monto`/`fecha` del gasto que concilia: ya coincidían —fue la
 * llave del match— y tocarlos aquí solo abriría la puerta a mover dinero por
 * un bug de este archivo. Solo se escribe `cfdi_uuid` + `cfdi_orden`
 * (migración 0065 — el mismo mecanismo que ya usa CAPUFE para "N gastos, un
 * solo CFDI").
 */
export async function guardarYConciliarConsolidado(
  tenantId: string,
  xml: CfdiXmlData,
  xmlText: string,
): Promise<ResumenConciliacion> {
  // Defensa del escritor: también puede llamarse sin pasar por esConsolidado.
  if (xml.tipoComprobante === 'E') {
    throw new Error('guardarYConciliarConsolidado: una nota de crédito no es un consolidado de gastos');
  }
  if (!xml.uuid) throw new Error('guardarYConciliarConsolidado: el CFDI no trae UUID');

  const { data: filaXml, error: errXml } = await acotada(supabaseAdmin()
    .from('cfdi_xml')
    .upsert(
      {
        tenant_id: tenantId,
        cfdi_uuid: xml.uuid,
        gasto_id: null, // un consolidado no es 1:1 con un solo gasto
        xml: xmlText,
        tiene_multiples_conceptos: true,
        total_conceptos: xml.lineas.length,
      },
      { onConflict: 'tenant_id,cfdi_uuid' },
    )
    .select('id')
    .single(), 'consolidado.guardar_cfdi_xml');
  if (errXml || !filaXml) {
    throw new Error(`guardarYConciliarConsolidado: ${errXml?.message ?? 'sin id de cfdi_xml'}`);
  }
  const cfdiXmlId = filaXml.id as string;

  // ── IDEMPOTENCIA REAL, no solo del upsert de arriba ──────────────────────
  // Si este CFDI YA se conció una vez (reenvío del mismo archivo — humano o
  // reintento), las líneas ya están escritas. NO se vuelve a correr el JOIN:
  // un `gasto` que la primera pasada ya ligó sale de `candidatosDb` (su
  // `cfdi_uuid` deja de ser null), así que una segunda pasada lo vería como
  // "no disponible" y reportaría esa línea como huérfana — un reenvío
  // legítimo desligaría en apariencia lo que ya estaba bien ligado.
  // Paginado con `traerTodo` (auditoría de escala 15k): un consolidado mensual
  // de una flota de 500 viajes/día trae MILES de líneas, y el `.select()` sin
  // rango se recortaba a 1,000 en silencio — el acuse del reenvío reportaba
  // 1,000 líneas donde había más, con toda la pinta de un total. El error de
  // lectura conserva su camino de siempre (seguir al JOIN, que la reanudación
  // de abajo protege), pero ahora con su línea de log.
  let existentes: Array<{ estatus: unknown }> | null = null;
  try {
    existentes = await traerTodo<{ estatus: unknown }>(
      (d, h) => acotada(supabaseAdmin()
        .from('cfdi_consolidado_linea')
        .select('estatus', conteo(d))
        // `tenant_id` además del id del XML: todas sus vecinas del archivo lo
        // filtran y esta era la única que no (misma auditoría).
        .eq('tenant_id', tenantId)
        .eq('cfdi_xml_id', cfdiXmlId)
        .order('id').range(d, h), 'consolidado.lineas_existentes'),
      'consolidado.lineas_existentes',
    );
  } catch (e) {
    logger.warn('consolidado.lineas_existentes_ilegibles', {
      tenant: tenantId, cfdiXmlId, err: e instanceof Error ? e.message : String(e),
    });
    existentes = null;
  }
  if (existentes && existentes.length > 0) {
    const conciliadasYa = existentes.filter((f) => f.estatus === 'conciliada').length;
    return { cfdiXmlId, totalLineas: existentes.length, conciliadas: conciliadasYa, porConciliar: existentes.length - conciliadasYa };
  }

  // ── REANUDACIÓN TRAS FALLA PARCIAL (auditoría 3, BE-A4) ──────────────────
  // Si una corrida anterior selló gastos con ESTE uuid pero murió antes de
  // escribir sus líneas (el throw de abajo), la decisión de aquella pasada ya
  // está grabada en el propio sello: `cfdi_orden` = índice de la línea. Esas
  // líneas se respetan tal cual — re-correr el JOIN para ellas las reportaría
  // como huérfanas (su gasto ya no es candidato: `cfdi_uuid` dejó de ser
  // null) y el reenvío "desligaría" en apariencia lo que quedó bien ligado.
  // Falla CERRADO: sin poder leer los sellos no se corre el JOIN a ciegas.
  // `traerTodo` (escala 15k): un consolidado sella un gasto POR LÍNEA. Con más
  // de 1,000 sellados, el mapa salía incompleto y el reenvío re-corría el JOIN
  // sobre líneas ya resueltas — reportando como huérfano lo que estaba bien
  // ligado, que es EXACTAMENTE el fallo que este bloque dice venir a evitar.
  const yaSellados = await traerTodo<{ id: unknown; cfdi_orden: unknown }>(
    (d, h) => acotada(supabaseAdmin()
      .from('gasto')
      .select('id, cfdi_orden', conteo(d))
      .eq('tenant_id', tenantId)
      .eq('cfdi_uuid', xml.uuid)
      .order('id').range(d, h), 'consolidado.gastos_ya_sellados'),
    'consolidado.gastos_ya_sellados',
  );
  const selladoPorIndice = new Map(
    yaSellados
      .filter((g) => g.cfdi_orden !== null && g.cfdi_orden !== undefined)
      .map((g) => [Number(g.cfdi_orden), String(g.id)]),
  );

  const rango = rangoFechasLineas(xml.lineas);
  let candidatosDb: Gasto[] = [];
  if (rango) {
    // `traerTodo` (escala 15k): el rango es el del estado de cuenta —un mes—
    // y con ~45,000 gastos/mes los candidatos sin CFDI pasan de 1,000 con
    // holgura. El recorte silencioso marcaba `por_conciliar`/`sin_match`
    // líneas perfectamente conciliables: fraude aparente por truncamiento.
    const data = await traerTodo<{ id: unknown; concepto: unknown; monto: unknown; fecha: unknown }>(
      (d, h) => acotada(supabaseAdmin()
        .from('gasto')
        .select('id, concepto, monto, fecha', conteo(d))
        .eq('tenant_id', tenantId)
        .is('cfdi_uuid', null)
        .gte('fecha', rango.desde)
        .lte('fecha', rango.hasta)
        .order('id').range(d, h), 'consolidado.candidatos_gasto'),
      'consolidado.candidatos_gasto',
    );
    candidatosDb = data.map((g) => ({
      id: g.id as string,
      concepto: g.concepto as Gasto['concepto'],
      monto: Number(g.monto),
      fecha: (g.fecha as string | null) ?? undefined,
    }));
  }

  // Las líneas cuya decisión YA quedó sellada en `gasto` no se re-adivinan;
  // el JOIN corre solo para el resto.
  const preClamadas: ResultadoLinea[] = xml.lineas
    .filter((l) => selladoPorIndice.has(l.indice))
    .map((l) => ({ linea: l, estatus: 'conciliada' as const, gastoId: selladoPorIndice.get(l.indice) as string, candidatos: [] }));
  const resultados = [
    ...preClamadas,
    ...conciliarLineas(xml.lineas.filter((l) => !selladoPorIndice.has(l.indice)), candidatosDb),
  ];

  // EN LOTES DE 10, NO EN SERIE (auditoría 3, REND-C1): el UPDATE por línea
  // en serie sumaba ~300s con 1,000 conciliadas contra maxDuration=120 —
  // morir a la mitad dejaba gastos sellados sin su fila de línea y el
  // reenvío corrompía la conciliación. Best-effort por línea CONSERVADO:
  // que una falle no pierde el resto (`enLotes` atrapa el error en su
  // lugar); un `false` sin error (el guardia negó la fila) se registra
  // porque en el camino automático es señal de carrera real.
  // Las pre-clamadas NO se re-ligan: su gasto ya trae el sello.
  const porLigar = resultados.filter((r) =>
    r.estatus === 'conciliada' && r.gastoId && !selladoPorIndice.has(r.linea.indice));
  const ligados = await enLotes(porLigar, 10, (r) =>
    ligarLineaAGasto(tenantId, xml.uuid!, r.linea.indice, r.gastoId as string, datosDieselDeLinea(r.linea)));
  ligados.forEach((l, i) => {
    if ('error' in l) {
      logger.error('consolidado.ligar_lanzo', { tenant: tenantId, gasto: porLigar[i].gastoId, err: l.error instanceof Error ? l.error.message : String(l.error) });
    } else if (!l.ok) {
      logger.error('consolidado.marcar_gasto_no_disponible', { tenant: tenantId, gasto: porLigar[i].gastoId });
    }
  });

  const filasLinea = resultados.map((r) => ({
    tenant_id: tenantId,
    cfdi_xml_id: cfdiXmlId,
    indice: r.linea.indice,
    fuente: r.linea.fuente,
    fecha: r.linea.fecha ? r.linea.fecha.slice(0, 10) : null,
    monto: r.linea.monto,
    descripcion: r.linea.descripcion ?? null,
    estacion_rfc: r.linea.estacionRfc ?? null,
    estacion_clave: r.linea.estacionClave ?? null,
    folio_operacion: r.linea.folioOperacion ?? null,
    estatus: r.estatus,
    gasto_id: r.gastoId,
    candidatos: r.candidatos.length ? r.candidatos : null,
    // FASE 1: se guarda para que la resolución a mano y el barrido —que
    // vuelven a leer esta fila, nunca el XML— liguen con los mismos litros
    // sin recalcular nada (`claveProdServDeLinea` corrió una sola vez, aquí).
    // `litrosDeLinea` (no `cantidad` a secas) porque la `Cantidad` de una
    // caseta es un cruce, no un litro — ver el bloque de esa función.
    litros: litrosDeLinea(r.linea),
    clave_prod_serv: claveProdServDeLinea(r.linea) ?? null,
  }));
  const { error: errLineas } = await acotada(supabaseAdmin()
    .from('cfdi_consolidado_linea')
    .upsert(filasLinea, { onConflict: 'cfdi_xml_id,indice' }), 'consolidado.guardar_lineas');
  if (errLineas) {
    // SE PROPAGA, no se traga (auditoría 3, BE-A4): devolver el resumen
    // normal aquí era un acuse que mentía — "están en el panel" con el panel
    // en cero, porque la cola del contador ES esta tabla y los candidatos
    // calculados se acaban de perder. Los gastos ya sellados arriba NO se
    // deshacen: el reenvío los reconoce por su sello (bloque de reanudación)
    // y reconstruye sus líneas sin re-adivinar.
    logger.error('consolidado.guardar_lineas_error', { tenant: tenantId, cfdiXmlId, err: errLineas.message });
    throw new Error(`guardarYConciliarConsolidado: no se pudieron guardar las líneas — ${errLineas.message}`);
  }

  const conciliadas = resultados.filter((r) => r.estatus === 'conciliada').length;
  return { cfdiXmlId, totalLineas: resultados.length, conciliadas, porConciliar: resultados.length - conciliadas };
}

// ═══════════════════════════════════════════════════════════════════════════
// LA RESOLUCIÓN A MANO — el otro lado del hallazgo CRÍTICO de auditoría 10.
//
// `guardarYConciliarConsolidado` deja las líneas ambiguas o sin candidato en
// `cfdi_consolidado_linea` con `estatus = 'por_conciliar'` y sus candidatos
// en JSON — pero hasta esta ronda no había ninguna función (ni pantalla) que
// pudiera CERRAR esa línea. Un contador que abría el panel de Combustible &
// Casetas veía "3 por revisar" y no tenía dónde revisarlas: quedaban ahí para
// siempre, un contador que no lee árabe leyendo un número que nunca baja.
// ═══════════════════════════════════════════════════════════════════════════

export type ResolucionLineaManual =
  | { tipo: 'ligar'; gastoId: string }
  | { tipo: 'sin_match' };

export interface ResultadoResolverLinea {
  ok: boolean;
  /** Presente solo cuando `ok === false` — por qué no se pudo cerrar. */
  motivo?: 'linea_no_encontrada' | 'ya_resuelta' | 'candidato_no_ofrecido' | 'gasto_ya_no_disponible' | 'error_bd';
}

/**
 * La resolución A MANO de una línea que el JOIN automático no pudo ligar
 * sola. Un contador ve LOS MISMOS candidatos que calculó `conciliarLineas`
 * (columna `candidatos`, JSON — no se vuelve a correr el matcher) y elige
 * uno —liga la línea al gasto, con EXACTAMENTE el mismo mecanismo que el
 * camino automático (`ligarLineaAGasto`, no una copia)— o declara que
 * ninguno corresponde (`estatus = 'sin_match'`, migración 0077), lo que la
 * saca de la cola sin inventarle un gasto que no tiene.
 *
 * SOLO SE PUEDE ELEGIR UN CANDIDATO QUE EL JOIN AUTOMÁTICO YA OFRECIÓ (la
 * propia columna `candidatos` de la línea): esta función no es un buscador
 * libre de gastos. Es una decisión de diseño, no un descuido — un buscador
 * libre necesitaría su propia UI de búsqueda y su propia superficie de
 * error, y el caso real (0, 2 o 3 candidatos por ambigüedad de fecha/monto)
 * no lo pide. Si el gasto correcto NUNCA apareció como candidato —porque
 * cayó fuera de la ventana de fecha del JOIN (`VENTANA_DIAS_FECHA`)— hoy no
 * hay forma de ligarlo desde este panel; se documenta como límite conocido
 * en `docs/auditoria-10/fiscal.md`, no se resuelve aquí.
 *
 * Vuelve a comprobar `estatus === 'por_conciliar'` antes de escribir, con el
 * mismo `estatus = 'por_conciliar'` repetido en el `WHERE` del UPDATE: dos
 * personas mirando el mismo panel al mismo tiempo (o un humano resolviendo
 * mientras un reenvío de WhatsApp corre el JOIN automático otra vez) no
 * pueden cerrar la misma línea dos veces — la segunda escritura no encuentra
 * fila que actualizar y vuelve `ya_resuelta`, no un éxito silencioso que
 * pisa al primero.
 */
export async function resolverLineaAMano(
  tenantId: string,
  lineaId: string,
  resolucion: ResolucionLineaManual,
  resueltoPor: string,
): Promise<ResultadoResolverLinea> {
  const { data: fila, error: errFila } = await acotada(supabaseAdmin()
    .from('cfdi_consolidado_linea')
    .select('id, cfdi_xml_id, indice, estatus, candidatos, litros, clave_prod_serv')
    .eq('id', lineaId)
    .eq('tenant_id', tenantId)
    .maybeSingle(), 'consolidado.leer_linea');
  if (errFila) return { ok: false, motivo: 'error_bd' };
  if (!fila) return { ok: false, motivo: 'linea_no_encontrada' };
  if (fila.estatus !== 'por_conciliar') return { ok: false, motivo: 'ya_resuelta' };

  if (resolucion.tipo === 'sin_match') {
    const { data, error } = await acotada(supabaseAdmin()
      .from('cfdi_consolidado_linea')
      .update({ estatus: 'sin_match', resuelto_por: resueltoPor, resuelto_en: new Date().toISOString() })
      .eq('id', lineaId).eq('tenant_id', tenantId).eq('estatus', 'por_conciliar')
      .select('id'), 'consolidado.marcar_sin_match');
    if (error) return { ok: false, motivo: 'error_bd' };
    if (!data || data.length === 0) return { ok: false, motivo: 'ya_resuelta' };
    return { ok: true };
  }

  // tipo === 'ligar' — el candidato tiene que ser uno de los que ya se ofrecieron.
  const candidatos = (fila.candidatos as CandidatoConciliacion[] | null) ?? [];
  const elegido = candidatos.find((c) => c.gastoId === resolucion.gastoId);
  if (!elegido) return { ok: false, motivo: 'candidato_no_ofrecido' };

  const { data: filaXml, error: errXml } = await acotada(supabaseAdmin()
    .from('cfdi_xml')
    .select('cfdi_uuid')
    .eq('id', fila.cfdi_xml_id as string)
    .eq('tenant_id', tenantId)
    .maybeSingle(), 'consolidado.leer_cfdi_xml');
  if (errXml || !filaXml?.cfdi_uuid) return { ok: false, motivo: 'error_bd' };

  // FASE 1: litros/clave ya quedaron resueltos y guardados al persistir la
  // línea (`guardarYConciliarConsolidado`) — se leen tal cual, no se
  // recalculan aquí.
  const litrosFila = fila.litros != null ? Number(fila.litros) : null;
  const claveFila = (fila.clave_prod_serv as string | null) ?? null;
  const diesel = litrosFila != null && litrosFila > 0 && claveFila ? { litros: litrosFila, claveProdServ: claveFila } : undefined;
  const ligado = await ligarLineaAGasto(tenantId, filaXml.cfdi_uuid as string, fila.indice as number, resolucion.gastoId, diesel);
  if (!ligado) return { ok: false, motivo: 'gasto_ya_no_disponible' };

  const { data: actualizado, error: errUpdate } = await acotada(supabaseAdmin()
    .from('cfdi_consolidado_linea')
    .update({ estatus: 'conciliada', gasto_id: resolucion.gastoId, resuelto_por: resueltoPor, resuelto_en: new Date().toISOString() })
    .eq('id', lineaId).eq('tenant_id', tenantId).eq('estatus', 'por_conciliar')
    .select('id'), 'consolidado.marcar_conciliada_a_mano');
  if (errUpdate) {
    // El gasto YA quedó ligado (paso anterior) pero la línea no se pudo
    // marcar — inconsistencia rara (carrera) que se deja en el log en vez de
    // deshacer el `update` del gasto: revertirlo sin saber por qué falló el
    // segundo `update` podría desligar un gasto que otra línea ya reclamó
    // mientras tanto. Se documenta, no se adivina.
    logger.error('consolidado.marcar_conciliada_a_mano_error', { tenant: tenantId, linea: lineaId, gasto: resolucion.gastoId, err: errUpdate.message });
    return { ok: false, motivo: 'error_bd' };
  }
  if (!actualizado || actualizado.length === 0) {
    logger.error('consolidado.marcar_conciliada_a_mano_carrera', { tenant: tenantId, linea: lineaId, gasto: resolucion.gastoId });
    return { ok: false, motivo: 'ya_resuelta' };
  }
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// EL BARRIDO — la tercera vía, y la que faltaba (auditoría 4, B1).
//
// El JOIN automático corre cuando LLEGA el XML; la resolución a mano corre
// cuando un HUMANO abre la mesa. Ninguna de las dos vuelve a mirar una línea
// `por_conciliar` cuando el gasto que le faltaba llega DESPUÉS del XML — el
// caso real de una oficina que sube el estado de cuenta del TAG el día de
// corte y captura los tickets rezagados durante la semana. Sin esto, esa
// línea solo se cerraba si un contador la ligaba a mano... contra una lista
// de candidatos congelada el día del XML, en la que el gasto nuevo NI
// APARECE. El barrido re-corre el mismo matcher sobre la cola completa del
// tenant: liga lo que ahora es único y refresca los candidatos del resto.
// ═══════════════════════════════════════════════════════════════════════════

export interface ResumenBarrido {
  /** Cuántas líneas `por_conciliar` se revisaron. */
  revisadas: number;
  /** Cuántas quedaron conciliadas en esta pasada (contra gastos que llegaron
   *  después, o que un desligue dejó disponibles). */
  conciliadas: number;
  /** Cuántas siguen pendientes pero con su lista de candidatos puesta al día. */
  candidatosRefrescados: number;
  /** Cuántas siguen esperando a un humano. */
  siguenPendientes: number;
}

/** Una fila de `cfdi_consolidado_linea` tal como la devuelve el SELECT del
 *  barrido — snake_case de la base, sin convertir todavía. */
interface FilaPendiente {
  id: unknown; cfdi_xml_id: unknown; indice: unknown; fuente: unknown;
  fecha: unknown; monto: unknown; descripcion: unknown; estacion_rfc: unknown;
  estacion_clave: unknown; folio_operacion: unknown; candidatos: unknown;
  litros: unknown; clave_prod_serv: unknown;
}

/** La fila de la base, de vuelta a la forma que `conciliarLineas` espera.
 *  `fecha` viene como date de Postgres ('YYYY-MM-DD'); el matcher hace
 *  `.slice(0, 10)`, así que el formato corto entra igual que el dateTime del
 *  XML original. Lo que la base guardó como `null` vuelve a `undefined`, que
 *  es como el parser lo entrega. */
function lineaDesdeFila(f: FilaPendiente): CfdiLineaXml {
  return {
    indice: Number(f.indice),
    fuente: f.fuente as CfdiLineaXml['fuente'],
    fecha: (f.fecha as string | null) ?? undefined,
    monto: Number(f.monto),
    descripcion: (f.descripcion as string | null) ?? undefined,
    estacionRfc: (f.estacion_rfc as string | null) ?? undefined,
    estacionClave: (f.estacion_clave as string | null) ?? undefined,
    folioOperacion: (f.folio_operacion as string | null) ?? undefined,
    // FASE 1: ya resueltos al persistir la línea — se cargan tal cual, el
    // barrido no vuelve a decidir qué es diésel.
    cantidad: f.litros != null ? Number(f.litros) : undefined,
    claveProdServ: (f.clave_prod_serv as string | null) ?? undefined,
  };
}

/** ¿La lista nueva dice lo mismo que la guardada? Se compara SIN orden: el
 *  fondo de candidatos sale de un SELECT sin ORDER BY, y un "cambio" que es
 *  puro reordenamiento reescribiría la columna en cada barrido sin darle al
 *  contador nada nuevo que elegir. */
function mismosCandidatos(a: CandidatoConciliacion[], b: CandidatoConciliacion[]): boolean {
  if (a.length !== b.length) return false;
  const llave = (c: CandidatoConciliacion) => `${c.gastoId}|${c.monto}|${c.fecha ?? ''}`;
  const aa = a.map(llave).sort();
  const bb = b.map(llave).sort();
  return aa.every((v, i) => v === bb[i]);
}

/**
 * Barre la cola `por_conciliar` del tenant contra los gastos DISPONIBLES de
 * hoy. Es lo que el botón «Ejecutar ahora» del Agente de Peajes dispara.
 *
 * Corre el matcher POR GRUPO de `cfdi_xml` —igual que la ingesta— para que
 * sus reglas de unicidad apliquen dentro de cada consolidado; entre grupos,
 * un gasto que un grupo ya ligó sale del fondo del siguiente. La escritura
 * reusa `ligarLineaAGasto` (el mismo sello y el mismo guardia de los otros
 * dos caminos): si el guardia niega el gasto —otro proceso se lo llevó entre
 * la lectura y aquí—, la línea SE QUEDA `por_conciliar` y se cuenta como
 * pendiente, no se marca.
 *
 * Y el refresco de `candidatos` no es cosmético: esa columna es lo que
 * `resolverLineaAMano` le ofrece al contador. Sin refrescarla, un gasto que
 * llegó después del XML JAMÁS se puede elegir a mano — el hueco que este
 * barrido existe para cerrar.
 */
export async function barrerPorConciliar(tenantId: string): Promise<ResumenBarrido> {
  // 1) La cola completa del tenant. Error de lectura LANZA: "no hay nada que
  //    barrer" y "no pude leer la cola" llevan a acuses opuestos. El límite es
  //    explícito porque PostgREST recorta a 1,000 en silencio (CLAUDE.md); el
  //    barrido es re-entrante — lo que no quepa en esta pasada lo barre la
  //    siguiente, y el acuse solo afirma lo que sí revisó.
  const { data: filas, error: errFilas } = await acotada(supabaseAdmin()
    .from('cfdi_consolidado_linea')
    .select('id, cfdi_xml_id, indice, fuente, fecha, monto, descripcion, estacion_rfc, estacion_clave, folio_operacion, candidatos, litros, clave_prod_serv')
    .eq('tenant_id', tenantId)
    .eq('estatus', 'por_conciliar')
    .limit(1000), 'barrido.lineas_pendientes');
  if (errFilas) throw new Error(`barrerPorConciliar: ${errFilas.message}`);

  const pendientes = (filas ?? []) as FilaPendiente[];
  const resumen: ResumenBarrido = {
    revisadas: pendientes.length, conciliadas: 0, candidatosRefrescados: 0, siguenPendientes: 0,
  };
  if (pendientes.length === 0) {
    logger.info('peajes.barrido', { tenant: tenantId, ...resumen });
    return resumen;
  }

  // 2a) El folio fiscal de cada consolidado — sin `cfdi_uuid` no hay sello
  //     que escribir en `gasto`.
  const xmlIds = [...new Set(pendientes.map((f) => String(f.cfdi_xml_id)))];
  const { data: filasXml, error: errXml } = await acotada(supabaseAdmin()
    .from('cfdi_xml')
    .select('id, cfdi_uuid')
    .eq('tenant_id', tenantId)
    .in('id', xmlIds), 'barrido.cfdi_xml');
  if (errXml) throw new Error(`barrerPorConciliar: ${errXml.message}`);
  const uuidPorXmlId = new Map(
    (filasXml ?? []).map((r) => [r.id as string, (r.cfdi_uuid as string) || null]),
  );

  // 2b) Los gastos disponibles de HOY, con el mismo criterio que la ingesta
  //     (`cfdi_uuid` null + rango de fechas de las líneas ± la ventana). Las
  //     líneas sin fecha no aportan rango ni pueden ligar solas — misma regla
  //     dura de `conciliarLineas`.
  const rango = rangoFechasLineas(pendientes.map(lineaDesdeFila));
  let disponibles: Gasto[] = [];
  if (rango) {
    // `traerTodo` por la misma razón que `consolidado.candidatos_gasto`: el
    // recorte a 1,000 dejaba al barrido cruzando contra una fracción del
    // universo y las líneas cuyo gasto quedó fuera nunca se conciliaban.
    const data = await traerTodo<{ id: unknown; concepto: unknown; monto: unknown; fecha: unknown }>(
      (d, h) => acotada(supabaseAdmin()
        .from('gasto')
        .select('id, concepto, monto, fecha', conteo(d))
        .eq('tenant_id', tenantId)
        .is('cfdi_uuid', null)
        .gte('fecha', rango.desde)
        .lte('fecha', rango.hasta)
        .order('id').range(d, h), 'barrido.candidatos_gasto'),
      'barrido.candidatos_gasto',
    );
    disponibles = data.map((g) => ({
      id: g.id as string,
      concepto: g.concepto as Gasto['concepto'],
      monto: Number(g.monto),
      fecha: (g.fecha as string | null) ?? undefined,
    }));
  }

  // 3) El matcher, POR GRUPO de cfdi_xml y en el orden del XML (`indice`),
  //    como en la ingesta. Los grupos se recorren en serie a propósito: un
  //    gasto que un grupo liga sale de `disponibles` antes de que el
  //    siguiente lo evalúe.
  const grupos = new Map<string, FilaPendiente[]>();
  for (const f of pendientes) {
    const k = String(f.cfdi_xml_id);
    const g = grupos.get(k);
    if (g) g.push(f); else grupos.set(k, [f]);
  }

  for (const [xmlId, filasGrupo] of grupos) {
    filasGrupo.sort((a, b) => Number(a.indice) - Number(b.indice));
    const uuid = uuidPorXmlId.get(xmlId) ?? null;
    const resultados = conciliarLineas(filasGrupo.map(lineaDesdeFila), disponibles);

    // `conciliarLineas` devuelve un resultado por línea EN EL MISMO ORDEN, así
    // que el índice del arreglo alinea resultado con su fila de la base.
    for (let i = 0; i < resultados.length; i++) {
      const r = resultados[i];
      const lineaId = String(filasGrupo[i].id);

      if (r.estatus === 'conciliada' && r.gastoId) {
        if (!uuid) {
          // El cfdi_xml no se pudo leer o no trae uuid: sin folio fiscal el
          // sello sería inventado. Se grita y la línea espera a la siguiente
          // pasada — nunca se liga a ciegas.
          logger.error('barrido.cfdi_sin_uuid', { tenant: tenantId, cfdiXmlId: xmlId, linea: lineaId });
          resumen.siguenPendientes++;
          continue;
        }
        // 4) El MISMO sello y el MISMO guardia de los otros dos caminos. Un
        //    `false` es que otro proceso reclamó ese gasto entre la lectura y
        //    aquí: la línea se queda por_conciliar y cuenta como pendiente.
        const ligado = await ligarLineaAGasto(tenantId, uuid, r.linea.indice, r.gastoId, datosDieselDeLinea(r.linea));
        if (!ligado) {
          resumen.siguenPendientes++;
          continue;
        }
        disponibles = disponibles.filter((g) => g.id !== r.gastoId);

        const { data: marcada, error: errMarcar } = await acotada(supabaseAdmin()
          .from('cfdi_consolidado_linea')
          .update({
            estatus: 'conciliada',
            gasto_id: r.gastoId,
            resuelto_por: 'barrido',
            resuelto_en: new Date().toISOString(),
          })
          .eq('id', lineaId)
          .eq('tenant_id', tenantId)
          .eq('estatus', 'por_conciliar')
          .select('id'), 'barrido.marcar_conciliada');
        if (errMarcar) {
          // El gasto YA quedó sellado y la línea no se pudo marcar — el mismo
          // dilema documentado en `resolverLineaAMano`: no se deshace el sello
          // sin saber por qué falló el segundo UPDATE. En la base la línea
          // sigue por_conciliar, así que se cuenta como pendiente y se grita.
          logger.error('barrido.marcar_conciliada_error', { tenant: tenantId, linea: lineaId, gasto: r.gastoId, err: errMarcar.message });
          resumen.siguenPendientes++;
          continue;
        }
        if (!marcada || marcada.length === 0) {
          // Otro (un humano en la mesa) la resolvió entre la lectura y aquí:
          // ni conciliada de esta pasada ni pendiente — se documenta y ya.
          logger.error('barrido.marcar_conciliada_carrera', { tenant: tenantId, linea: lineaId, gasto: r.gastoId });
          continue;
        }
        resumen.conciliadas++;
        continue;
      }

      // 5) Sigue por_conciliar. Si el fondo de hoy cambió lo que hay para
      //    elegir, la columna se refresca; anclada a `estatus` para no pisar
      //    una resolución que un humano cerró en paralelo. Best-effort: que
      //    un refresco falle no aborta el barrido — se grita y la lista vieja
      //    sigue siendo la verdad de su momento.
      resumen.siguenPendientes++;
      const guardados = (filasGrupo[i].candidatos as CandidatoConciliacion[] | null) ?? [];
      if (!mismosCandidatos(guardados, r.candidatos)) {
        const { data: refrescada, error: errRefrescar } = await acotada(supabaseAdmin()
          .from('cfdi_consolidado_linea')
          .update({ candidatos: r.candidatos.length ? r.candidatos : null })
          .eq('id', lineaId)
          .eq('tenant_id', tenantId)
          .eq('estatus', 'por_conciliar')
          .select('id'), 'barrido.refrescar_candidatos');
        if (errRefrescar) {
          logger.error('barrido.refrescar_candidatos_error', { tenant: tenantId, linea: lineaId, err: errRefrescar.message });
        } else if ((refrescada?.length ?? 0) > 0) {
          resumen.candidatosRefrescados++;
        }
      }
    }
  }

  logger.info('peajes.barrido', { tenant: tenantId, ...resumen });
  return resumen;
}

/**
 * El acuse por WhatsApp. Dice la verdad de las tres formas en que puede salir
 * — nunca "listo" cuando quedó pendiente, ni "revísalo" cuando ya no hace
 * falta: un contador que lee "0 pendientes" dos veces deja de abrir el panel.
 */
export function mensajeConsolidadoRecibido(r: ResumenConciliacion): string {
  const n = r.totalLineas === 1 ? '1 movimiento' : `${r.totalLineas} movimientos`;
  if (r.porConciliar === 0) {
    return `Recibí tu XML consolidado (${n}) y ya quedó ligado ✅. Los ${r.totalLineas} coincidieron uno a uno contra tickets que ya tenías cargados.`;
  }
  if (r.conciliadas === 0) {
    return `Recibí tu XML consolidado con ${n} 📄. Ninguno lo pude ligar solo contra un ticket ya cargado — quedaron en el panel, en *Combustible & Casetas*, para que tu contador los revise a mano.`;
  }
  return `Recibí tu XML consolidado (${n}) ✅. *${r.conciliadas}* ya quedaron ligados a su ticket; *${r.porConciliar}* necesitan revisión — están en el panel, en *Combustible & Casetas*.`;
}
