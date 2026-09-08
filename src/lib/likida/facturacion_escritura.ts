// ═══════════════════════════════════════════════════════════════════════════
// FACTURACIÓN EMITIDA Y PAGOS — la captura que le faltaba al lado del ingreso.
//
// La 0049 creó `factura_emitida`, `factura_viaje` y `pago_recibido` y dejó
// escrito el contrato: "Likida NO timbra (no es PAC), así que este dato
// [`cfdi_uuid`] llega de fuera". Desde entonces las tres tablas tuvieron
// lectores (`facturacion_clientes.ts`, `comercial.ts`, `libro_viaje.ts`) y
// ningún escritor: `/dashboard/facturacion` era un EstadoVacío permanente, no
// por falta de clientes sino porque no había dónde teclear (hallazgo A1,
// auditoría 4). `pago_recibido` ni siquiera aparecía en código ejecutable (A2).
//
// ESTE MÓDULO ES ESA CAPTURA, y respeta el contrato de la 0049:
//
//  · La factura NACE EN BORRADOR si no trae UUID, y EMITIDA si lo trae. El
//    constraint `factura_borrador_sin_uuid` vigila la mitad de esa verdad
//    desde la base; la otra mitad (emitida sin UUID) se rechaza aquí, porque
//    "emitida" significa "el SAT la conoce" y sin UUID nadie puede cruzarla.
//  · EL TOTAL NO SE TECLEA: se calcula subtotal + IVA. El constraint
//    `factura_total_cuadra` lo vigilaría de todas formas, pero pedirle a una
//    persona que teclee tres números que deben cuadrar entre sí es fabricar el
//    descuadre de centavos que el contralor persigue media tarde.
//  · `vence_en` SALE DE `cliente.dias_credito`, nunca de un default. Sin días
//    pactados la factura nace sin vencimiento y la cartera dice "sin
//    condiciones registradas" — ponerle 30 días pintaría de rojo lo que nadie
//    pactó (es el comentario de la propia 0049).
//  · EL SALDO NO SE GUARDA: lo deriva la vista `factura_saldo`. Aquí solo se
//    decide el ESTATUS, y `pagada` se escribe únicamente cuando la suma de
//    pagos cubre el total.
//  · UNA FACTURA SE IDENTIFICA POR SERIE + FOLIO + EJERCICIO (RES-22, mig.
//    0166). La 0049 dejó el consecutivo en `(tenant_id, folio)` y la 0158 le
//    sumó `(tenant_id, upper(folio))`: ninguno miraba la serie ni el año, así
//    que la flota que reinicia folios cada 1 de enero —lo normal en México—
//    no podía capturar su cobranza. La 0166 sustituye los dos por
//    `(tenant_id, upper(coalesce(serie,'')), upper(folio), año de la fecha)`.
//
// El `tenant_id` viene SIEMPRE por argumento desde la sesión del servidor, y
// toda escritura sobre fila existente se ancla con `.eq('tenant_id', …)` Y
// comprueba filas afectadas — las mismas tres reglas de `clientes.ts`.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase/admin';
import { anotarBitacora, type EntidadBitacora } from '@/lib/likida/bitacora_escritura';
import { logger } from '@/lib/logger';
import { mxn, TOLERANCIA_ABONO_MXN } from '@/lib/formato';
import { DatoInvalido, AbonoYaRegistrado } from './errores';
import { esUuidValido } from './intake/cfdi';
import { acotada } from './presupuesto';

// ── Validación (pura, sin base) ────────────────────────────────────────────

export interface FacturaCruda {
  clienteId: string;
  /** `YYYY-MM-DD`, como la teclea el `<input type="date">`. */
  fecha: string;
  subtotal: string;
  iva: string;
  /** Retención del 4% de IVA (FIS-M3, mig. 0351). Vacía = sin retención (el
   *  caso común hoy: ningún formulario la teclea todavía). */
  retencion?: string;
  /** La SERIE del CFDI (0166, RES-22). Vacía = la flota no usa series. */
  serie: string;
  folio: string;
  cfdiUuid: string;
  viajeIds: string[];
}

export interface FacturaValida {
  clienteId: string;
  fecha: string;
  subtotal: number;
  iva: number;
  retencion: number;
  total: number;
  serie: string | null;
  folio: string | null;
  cfdiUuid: string | null;
  estatus: 'borrador' | 'emitida';
  viajeIds: string[];
}

/** `2026-02-30` cumple el regex y no es un día. Mismo criterio que la API v1. */
function fechaValida(t: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) return false;
  const [a, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(a, mes - 1, dia));
  return d.getUTCFullYear() === a && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
}

/**
 * Un monto tecleado, con la misma limpieza que `ingreso_viaje.ts`: coma
 * decimal como se teclea en México, separador de millares pegado de un Excel.
 * MÁS DE DOS DECIMALES SE RECHAZAN en vez de redondearse: `numeric(12,2)`
 * redondearía en silencio y la factura guardada diría otra cifra que la
 * tecleada — el descuadre exacto que esta pantalla existe para evitar.
 */
function montoTecleado(crudo: string, campo: string, opciones: { obligatorio: boolean }): number | null {
  const t = crudo.trim();
  if (t === '') {
    if (opciones.obligatorio) throw new DatoInvalido(`${campo} es obligatorio.`);
    return null;
  }
  const limpio = t.replace(/[$\s]/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(limpio)) throw new DatoInvalido(`${campo} tiene que ser un número (sin letras ni signos).`);
  const n = Number(limpio);
  if (!Number.isFinite(n)) throw new DatoInvalido(`${campo} tiene que ser un número.`);
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
    throw new DatoInvalido(`${campo} no puede traer más de dos decimales: la base guarda centavos y redondear en silencio descuadraría la factura.`);
  }
  if (n > 999_999_999) throw new DatoInvalido(`${campo} no cabe en una factura: revisa si sobra un cero.`);
  return n;
}

/** Tope del atributo `Serie` del CFDI 4.0 en el SAT, y el del CHECK de la 0166. */
const SERIE_MAX = 25;

/**
 * La SERIE, normalizada IGUAL que se compara (RES-22, mig. 0166).
 *
 * `factura_serie_btrim` (0166) exige que la serie guardada esté sin espacios
 * de sobra y nunca vacía, con el mismo criterio que la 0158 (DAT-36) le puso
 * al folio: si el texto guardado no es el texto comparado, «A », «A» y «» son
 * tres series para la base y una sola para la flota. Aquí se hace la
 * normalización; el CHECK es la red por si algún día entra por otro camino.
 *
 * Vacía → NULL, que en `factura_folio_unico` entra como `coalesce(serie,'')`:
 * todas las facturas sin serie comparten consecutivo, que es lo que significa
 * «no uso series».
 */
function normalizarSerie(crudo: string): string | null {
  const s = crudo.trim();
  if (s === '') return null;
  if (s.length > SERIE_MAX) {
    throw new DatoInvalido(`La serie no puede pasar de ${SERIE_MAX} caracteres: es el tope del atributo Serie del CFDI.`);
  }
  // Un salto de línea o un tabulador PEGADOS DE UN EXCEL sobreviven al trim de
  // los extremos si van en medio, y no existen en ninguna serie del SAT.
  if (/\s/.test(s)) {
    throw new DatoInvalido('La serie no lleva espacios: cópiala tal como aparece en el CFDI (por ejemplo «A» o «FAC»).');
  }
  return s;
}

export function validarFactura(c: FacturaCruda): FacturaValida {
  if (!esUuidValido(c.clienteId)) {
    throw new DatoInvalido('Elige el cliente de la lista. Si no aparece, dalo de alta primero en Clientes.');
  }
  const fecha = c.fecha.trim();
  if (!fechaValida(fecha)) throw new DatoInvalido('La fecha de la factura tiene que ser un día real (AAAA-MM-DD).');

  const subtotal = montoTecleado(c.subtotal, 'El subtotal', { obligatorio: true }) as number;
  // El IVA vacío NO se inventa: sin teclear no hay factura. Un CFDI real
  // siempre declara su IVA, aunque sea $0 (tasa 0% o exento) — y ese $0
  // tecleado es una medición, no un relleno.
  const iva = montoTecleado(c.iva, 'El IVA', { obligatorio: true }) as number;
  // FIS-M3 (mig. 0351): retención del 4% de IVA, opcional — sin ella (el
  // caso de hoy) el cálculo es idéntico al de siempre.
  const retencion = montoTecleado(c.retencion ?? '', 'La retención', { obligatorio: false }) ?? 0;
  // Redondeo a centavos ANTES de sumar: 0.1 + 0.2 en binario no es 0.30, y el
  // constraint `factura_total_cuadra` tolera un centavo, no una cola binaria.
  const total = Math.round((subtotal + iva - retencion) * 100) / 100;

  const folio = c.folio.trim() === '' ? null : c.folio.trim();
  if (folio !== null && folio.length > 40) throw new DatoInvalido('El folio no puede pasar de 40 caracteres.');
  const serie = normalizarSerie(c.serie);

  let cfdiUuid: string | null = null;
  if (c.cfdiUuid.trim() !== '') {
    const u = c.cfdiUuid.trim().toLowerCase();
    if (!esUuidValido(u)) {
      throw new DatoInvalido(
        'El folio fiscal (UUID) no tiene la forma de un UUID del SAT (8-4-4-4-12 caracteres hexadecimales). ' +
        'Cópialo del XML o del PDF del CFDI, o déjalo vacío para registrar la factura como borrador.',
      );
    }
    cfdiUuid = u;
  }

  const viajeIds: string[] = [];
  for (const v of c.viajeIds) {
    const id = v.trim();
    if (id === '') continue;
    if (!esUuidValido(id)) throw new DatoInvalido('Uno de los viajes marcados no se reconoce. Recarga la pantalla.');
    if (!viajeIds.includes(id)) viajeIds.push(id);
  }

  return { clienteId: c.clienteId, fecha, subtotal, iva, retencion, total, serie, folio, cfdiUuid, estatus: cfdiUuid ? 'emitida' : 'borrador', viajeIds };
}

export interface PagoCrudo {
  facturaId: string;
  fecha: string;
  monto: string;
  metodo: string;
  referencia: string;
}

export interface PagoValido {
  facturaId: string;
  fecha: string;
  monto: number;
  metodo: string | null;
  referencia: string | null;
}

export function validarPago(c: PagoCrudo): PagoValido {
  if (!esUuidValido(c.facturaId)) throw new DatoInvalido('No se reconoce esa factura. Recarga la pantalla.');
  const fecha = c.fecha.trim();
  if (!fechaValida(fecha)) throw new DatoInvalido('La fecha del pago tiene que ser un día real (AAAA-MM-DD).');
  const monto = montoTecleado(c.monto, 'El monto del pago', { obligatorio: true }) as number;
  if (monto <= 0) throw new DatoInvalido('Un pago tiene que ser mayor que cero. Para corregir una factura, cancélala y captúrala de nuevo.');
  const metodo = c.metodo.trim() === '' ? null : c.metodo.trim().slice(0, 40);
  const referencia = c.referencia.trim() === '' ? null : c.referencia.trim();
  if (referencia !== null && referencia.length > 80) throw new DatoInvalido('La referencia no puede pasar de 80 caracteres.');
  return { facturaId: c.facturaId, fecha, monto, metodo, referencia };
}

/**
 * La decisión de dinero de un abono, PURA para que se pueda probar sin base:
 * a qué facturas se les puede abonar, cuánto cabe, y cuándo el abono la salda.
 *
 * `sumarDias` y esto son las dos reglas que el contralor va a cruzar contra su
 * papel; el resto de `registrarPago` es plomería.
 */
export type MotivoRechazoAbono = 'cancelada' | 'borrador' | 'pagada' | 'sobrepago';

/**
 * La redacción de cada rechazo, en UN solo lugar.
 *
 * Existe porque desde la 0159 el veredicto lo da la base (`registrar_pago_tx`,
 * bajo el `for update` de la factura) y el texto lo escribe TypeScript. Si cada
 * uno redactara el suyo, el contralor vería dos mensajes distintos para el
 * mismo rechazo según por dónde entrara — y el de la base, además, sin el monto
 * formateado en pesos.
 */
export function mensajeRechazoAbono(motivo: MotivoRechazoAbono, saldo: number, monto: number): string {
  switch (motivo) {
    case 'cancelada':
      return 'Esa factura está cancelada: no se le abonan pagos.';
    case 'borrador':
      return 'Esa factura sigue en borrador. Márcala como emitida (con su UUID) antes de registrarle pagos: un cobro sin CFDI es lo que el contralor no puede cruzar.';
    case 'pagada':
      return 'Esa factura ya está saldada. Si el cliente pagó de más, eso se aclara con él, no capturándolo aquí.';
    case 'sobrepago':
      return (
        `Ese pago (${mxn(monto)}) rebasa el saldo de la factura (${mxn(saldo)}). ` +
        'Revisa el monto; si el cliente de verdad pagó de más, se aclara con una nota de crédito, no capturando de más aquí.'
      );
  }
}

export function evaluarAbono(
  f: { estatus: string; total: number; pagado: number },
  monto: number,
): { rechazo: string | null; saldo: number; quedaSaldada: boolean } {
  // El `+ 0` mata el `-0` que deja la resta binaria: un saldo de "-$0.00" en
  // un mensaje es la clase de cifra que hace dudar de todas las demás.
  const saldo = Math.round((f.total - f.pagado) * 100) / 100 + 0;
  const rechazar = (motivo: MotivoRechazoAbono) =>
    ({ rechazo: mensajeRechazoAbono(motivo, saldo, monto), saldo, quedaSaldada: false });

  if (f.estatus === 'cancelada') return rechazar('cancelada');
  if (f.estatus === 'borrador') return rechazar('borrador');
  if (f.estatus === 'pagada') return rechazar('pagada');
  // La tolerancia se IMPORTA (`c7-6`): este 0.005 y el de `registrar_pago_tx`
  // tienen que ser el mismo medio centavo, y el portal de pago tenía una
  // tercera copia con otro valor. Ver `TOLERANCIA_ABONO_MXN` en `formato.ts`.
  if (monto > saldo + TOLERANCIA_ABONO_MXN) return rechazar('sobrepago');
  return { rechazo: null, saldo, quedaSaldada: monto >= saldo - TOLERANCIA_ABONO_MXN };
}

// ── Escrituras ─────────────────────────────────────────────────────────────

/** Constancia best-effort, igual que `clientes.ts`: si la bitácora falla, la
 *  escritura YA ocurrió y tirarla dejaría el sistema peor que sin registro. */
async function anotar(
  tenantId: string, accion: string, entidad: EntidadBitacora, entidadId: string,
  detalle: Record<string, unknown>, actor?: { id?: string; email?: string },
): Promise<void> {
  await anotarBitacora(
    { tenantId, actor: actor ?? {}, accion, entidad, entidadId, detalle },
    { evento: 'facturacion.bitacora_no_escribio' },
  );
}

/** El contexto del choque, para que el mensaje diga QUÉ se comparó. */
export interface LlaveFolio {
  serie: string | null;
  folio: string | null;
  /** `YYYY-MM-DD`. NULL cuando quien traduce el choque no la tiene a mano
   *  (`marcarEmitida` sella una fila que ya existe y cuya fecha no viaja en el
   *  formulario): entonces el mensaje dice «ese mismo ejercicio» en vez de
   *  inventar un año, que es la regla de la casa. */
  fecha: string | null;
}

/**
 * El folio duplicado, dicho con la llave COMPLETA contra la que se comparó.
 *
 * RES-22 (auditoría prod) · Desde la 0166 el consecutivo es
 * `(tenant_id, upper(coalesce(serie,'')), upper(folio), año de la fecha)`, no
 * `(tenant_id, folio)`. El mensaje viejo —«Ya tienes registrada una factura con
 * ese folio»— mandaba a buscar una factura que podía ser de otra serie o de
 * otro ejercicio, y para colmo era cierto: la base tampoco las distinguía.
 * Ahora sí las distingue, y el mensaje nombra las tres dimensiones para que
 * quien capturó sepa dónde está la gemela en vez de adivinar.
 */
export function mensajeFolioRepetido(k: LlaveFolio): string {
  const ejercicio = k.fecha === null ? 'ese mismo ejercicio' : `el ejercicio ${k.fecha.slice(0, 4)}`;
  const donde = k.serie === null ? 'sin serie' : `de la serie «${k.serie}»`;
  return (
    `Ya tienes registrada una factura con el folio «${k.folio ?? ''}» ${donde} en ${ejercicio}. ` +
    'El folio se compara por flota, serie y año (sin distinguir mayúsculas), así que el mismo folio en OTRA serie o en OTRO ejercicio sí cabe: ' +
    'revisa que la serie y la fecha sean las de este CFDI. Si la factura anterior está cancelada, su folio sigue ocupado — es un consecutivo fiscal, no una lista de pendientes.'
  );
}

/** Los índices únicos de la 0049 y la 0166, dichos en palabras de quien capturó. */
function traducirChoque(mensaje: string, llave: LlaveFolio): DatoInvalido | null {
  if (mensaje.includes('factura_cfdi_unico')) {
    return new DatoInvalido('Ese folio fiscal (UUID) ya está registrado en otra factura tuya. El mismo CFDI no se registra dos veces: el saldo del cliente saldría al doble.');
  }
  if (mensaje.includes('factura_serie_btrim')) {
    return new DatoInvalido('La serie no puede ir vacía ni con espacios: cópiala tal como aparece en el CFDI, o déjala en blanco si tu flota no usa series.');
  }
  if (mensaje.includes('factura_folio_unico')) {
    return new DatoInvalido(mensajeFolioRepetido(llave));
  }
  return null;
}

/** `fecha` + `dias` en calendario, sin zonas horarias de por medio. Exportada
 *  porque de aquí sale `vence_en`, y un vencimiento corrido un día pinta de
 *  rojo (o de verde) una factura que no lo está. */
export function sumarDias(fecha: string, dias: number): string {
  const [a, m, d] = fecha.split('-').map(Number);
  const f = new Date(Date.UTC(a, m - 1, d + dias));
  return f.toISOString().slice(0, 10);
}

/**
 * Registra la factura que la flota emitió (o empezó a emitir) a su cliente.
 *
 * `vence_en` se deriva de `cliente.dias_credito` EN ESTE MOMENTO y queda
 * congelado en la fila: si mañana renegocian los días de crédito, las facturas
 * ya emitidas conservan el vencimiento con el que nacieron, que es como
 * funciona el papel.
 */
export async function crearFactura(
  tenantId: string,
  f: FacturaValida,
  actor?: { id?: string; email?: string },
): Promise<string> {
  // ── El cliente es de esta flota, y de paso sus días de crédito ───────────
  const { data: cli, error: errCli } = await acotada(
    supabaseAdmin().from('cliente').select('id, dias_credito')
      .eq('id', f.clienteId).eq('tenant_id', tenantId).maybeSingle(),
    'crearFactura.cliente',
  );
  if (errCli) throw new Error(`crearFactura: no se pudo leer el cliente: ${errCli.message}`);
  if (!cli) throw new DatoInvalido('Ese cliente no está en tu flota. Recarga la pantalla y vuelve a elegirlo.');
  const diasCredito = (cli as { dias_credito: number | null }).dias_credito;
  const venceEn = diasCredito === null ? null : sumarDias(f.fecha, diasCredito);

  // ── Los viajes amparados son de esta flota ───────────────────────────────
  if (f.viajeIds.length > 0) {
    const { data: viajes, error: errV } = await acotada(
      supabaseAdmin().from('viaje').select('id').eq('tenant_id', tenantId).in('id', f.viajeIds),
      'crearFactura.viajes',
    );
    if (errV) throw new Error(`crearFactura: no se pudieron verificar los viajes: ${errV.message}`);
    const propios = new Set((viajes ?? []).map((v) => String((v as { id: unknown }).id)));
    if (propios.size !== f.viajeIds.length) {
      throw new DatoInvalido('Uno de los viajes marcados ya no está en tu flota. Recarga la pantalla.');
    }
  }

  const { data, error } = await acotada(supabaseAdmin().from('factura_emitida').insert({
    // El tenant viene por argumento desde la sesión, NUNCA del formulario.
    tenant_id: tenantId,
    cliente_id: f.clienteId,
    // La liga fina vive en `factura_viaje`; la columna directa solo se llena
    // cuando la factura ampara EXACTAMENTE un viaje (el caso común y el que
    // `libro_viaje.ts:599` lee directo).
    viaje_id: f.viajeIds.length === 1 ? f.viajeIds[0] : null,
    // RES-22 (0166): la serie es la mitad que le faltaba al folio. NULL cuando
    // la flota no usa series, y así entra al índice como `coalesce(serie,'')`.
    serie: f.serie,
    folio: f.folio,
    cfdi_uuid: f.cfdiUuid,
    fecha: f.fecha,
    subtotal: f.subtotal,
    iva: f.iva,
    retencion_iva: f.retencion,
    total: f.total,
    moneda: 'MXN',
    estatus: f.estatus,
    vence_en: venceEn,
  }).select('id').single(), 'crearFactura');

  if (error) {
    const choque = traducirChoque(error.message, { serie: f.serie, folio: f.folio, fecha: f.fecha });
    if (choque) throw choque;
    throw new Error(`crearFactura: ${error.message}`);
  }
  const id = (data as { id?: unknown } | null)?.id;
  if (!id) throw new Error('crearFactura: el insert no devolvió id');
  const facturaId = String(id);

  // ── Las ligas a los viajes ───────────────────────────────────────────────
  // PostgREST no da transacciones: si las ligas fallan, se compensa el alta y
  // se reporta el fallo COMPLETO. Una factura sin sus ligas contaría el
  // ingreso sin decir de qué viajes salió — peor que pedir que se recapture.
  //
  // LA COMPENSACIÓN CANCELA, NO BORRA (auditoría 18, DAT-27). Era un
  // `.delete()`, y un DELETE sobre `factura_emitida` es exactamente lo que la
  // 0158 dejó de permitir a la ligera: la FK de `pago_recibido` pasó a NO
  // ACTION para que borrar una factura no se lleve por delante los abonos
  // registrados. Esta factura acaba de nacer y no tiene abonos —el borrado
  // habría funcionado— pero la asimetría es la que enseña: un folio que
  // existió y se fue no deja rastro de haber existido, y en un consecutivo
  // fiscal eso es justo lo que no se hace. `cancelada` es un estatus del
  // dominio (0049) y la fila queda contando la verdad: se intentó, no se
  // completó.
  //
  // CONSECUENCIA VISIBLE: recapturar la MISMA factura con la misma serie, el
  // mismo folio y el mismo ejercicio choca ahora contra `factura_folio_unico`
  // (la fila cancelada sigue ahí) y `traducirChoque` lo dice con su mensaje de
  // folio repetido. Antes se podía reintentar a ciegas; ahora hay que mirar la
  // cancelada y decidir. Que la cancelada siga ocupando su lugar es
  // deliberado (0166): es un consecutivo fiscal, no una lista de pendientes.
  if (f.viajeIds.length > 0) {
    const { error: errLigas } = await supabaseAdmin().from('factura_viaje')
      .insert(f.viajeIds.map((v) => ({ factura_id: facturaId, viaje_id: v })));
    if (errLigas) {
      const { error: errDeshacer } = await supabaseAdmin().from('factura_emitida')
        .update({ estatus: 'cancelada' }).eq('id', facturaId).eq('tenant_id', tenantId);
      if (errDeshacer) {
        logger.error('facturacion.alta_a_medias', {
          tenantId, facturaId,
          msg: `La factura quedó creada SIN sus ligas a viajes y no se pudo cancelar: ${errDeshacer.message}. Revisar a mano.`,
        });
      }
      throw new Error(`crearFactura: no se pudieron ligar los viajes: ${errLigas.message}`);
    }
  }

  await anotar(tenantId, 'factura.creada', 'factura_emitida', facturaId, {
    clienteId: f.clienteId, fecha: f.fecha, total: f.total, estatus: f.estatus,
    folio: f.folio, cfdiUuid: f.cfdiUuid, viajes: f.viajeIds.length,
  }, actor);
  return facturaId;
}

/**
 * Un borrador se vuelve `emitida` cuando llega el UUID del PAC. Es el único
 * tránsito que esta función hace: anclado al estatus para que marcar dos veces
 * (o marcar una cancelada) toque cero filas y LO DIGA.
 */
export async function marcarEmitida(
  tenantId: string,
  facturaId: string,
  sello: { serie?: string; folio: string; cfdiUuid: string },
  actor?: { id?: string; email?: string },
): Promise<void> {
  if (!esUuidValido(facturaId)) throw new DatoInvalido('No se reconoce esa factura. Recarga la pantalla.');
  const uuid = sello.cfdiUuid.trim().toLowerCase();
  if (!esUuidValido(uuid)) {
    throw new DatoInvalido('El folio fiscal (UUID) no tiene la forma de un UUID del SAT. Cópialo del XML o del PDF del CFDI.');
  }
  const folio = sello.folio.trim() === '' ? undefined : sello.folio.trim();
  if (folio !== undefined && folio.length > 40) throw new DatoInvalido('El folio no puede pasar de 40 caracteres.');

  // RES-22 (0166) · LA SERIE VIAJA CON EL FOLIO O NO VIAJA.
  // El sello llega del CFDI ya timbrado, y ahí serie y folio son UNA sola
  // identificación. Si esta función escribiera el folio y dejara la serie como
  // estaba, la factura sellada quedaría diciendo «serie B, folio 1» cuando el
  // PAC timbró «A-1»: el consecutivo de la 0166 se calcularía sobre una serie
  // que no es la del papel. `undefined` (el campo ni se manda) deja la serie
  // intacta; una cadena vacía la BORRA a propósito, para la flota que timbró
  // sin serie un borrador que sí la traía.
  const serie = sello.serie === undefined ? undefined : normalizarSerie(sello.serie);

  const { data, error } = await acotada(supabaseAdmin().from('factura_emitida').update({
    cfdi_uuid: uuid,
    estatus: 'emitida',
    ...(folio !== undefined ? { folio } : {}),
    ...(serie !== undefined ? { serie } : {}),
  }).eq('id', facturaId).eq('tenant_id', tenantId).eq('estatus', 'borrador').select('id'), 'marcarEmitida');

  if (error) {
    // La fecha de la factura no viaja en este formulario y NO se adivina: el
    // mensaje dice «ese mismo ejercicio» en vez de inventar un año.
    const choque = traducirChoque(error.message, { serie: serie ?? null, folio: folio ?? null, fecha: null });
    if (choque) throw choque;
    throw new Error(`marcarEmitida: ${error.message}`);
  }
  if (!Array.isArray(data) || data.length === 0) {
    throw new DatoInvalido('Esa factura no está en borrador en tu flota: puede que ya esté emitida o cancelada. Recarga la pantalla.');
  }
  await anotar(tenantId, 'factura.emitida', 'factura_emitida', facturaId, {
    cfdiUuid: uuid, folio: folio ?? null, ...(serie !== undefined ? { serie } : {}),
  }, actor);
}

// ── Los SQLSTATE propios de `registrar_pago_tx` (0159) ─────────────────────
//
// Código propio y no un 23505, por la misma razón que el `CU001` de la 0036: lo
// que hay que hacer es distinto. Un rechazo de regla se le cuenta al contralor
// con sus palabras; cualquier otra cosa es un error y se grita.
const FACTURA_FUERA_DE_FLOTA = 'CU010';
const ABONO_RECHAZADO = 'CU011';
/** El choque contra un índice único, que en este insert solo puede ser uno:
 *  `pago_recibido_propuesta_unica` (0237). La clase que lo cuenta hacia arriba
 *  vive en `errores.ts` — ver ahí el porqué. */
const CHOQUE_UNICO = '23505';

/** El motivo y el saldo que manda la base, convertidos en el mensaje de siempre. */
function traducirErrorDelPago(error: { code?: string; message?: string }, monto: number): Error {
  if (error.code === FACTURA_FUERA_DE_FLOTA) {
    return new DatoInvalido('Esa factura no está en tu flota. Recarga la pantalla.');
  }
  if (error.code === ABONO_RECHAZADO) {
    const leido = /motivo=([a-z]+)\s+saldo=(-?[\d.]+)/.exec(error.message ?? '');
    if (leido) {
      return new DatoInvalido(
        mensajeRechazoAbono(leido[1] as MotivoRechazoAbono, Number(leido[2]), monto),
      );
    }
    // Un CU011 que no se puede leer sigue siendo un rechazo de negocio: se
    // rechaza igual, sin inventar la cifra que no llegó.
    return new DatoInvalido('Ese pago no se puede registrar contra esa factura. Revisa el estatus y el saldo antes de volver a intentarlo.');
  }
  // Todo lo demás —incluido el RPC ausente y el tope de consulta de `acotada`—
  // es un error de verdad: nada de tragárselo como si la factura tuviera la
  // culpa.
  return new Error(`registrarPago: ${error.message}`);
}

/** El rechazo de `cancelar_factura_tx` (0284), en las palabras del contralor.
 *  `CU016` es el código del RPC de cancelación; `CU010`, factura ajena. */
const CANCELACION_RECHAZADA = 'CU016';
function traducirErrorDeCancelacion(error: { code?: string; message?: string }): Error {
  if (error.code === FACTURA_FUERA_DE_FLOTA) {
    return new DatoInvalido('Esa factura no está en tu flota. Recarga la pantalla.');
  }
  if (error.code === CANCELACION_RECHAZADA) {
    const motivo = /motivo=([a-z_]+)/.exec(error.message ?? '')?.[1];
    if (motivo === 'con_pagos') {
      return new DatoInvalido('Esa factura tiene pagos registrados. Primero aclara ese dinero (con el cliente y con el SAT); cancelarla de un clic dejaría cobros contra nada.');
    }
    return new DatoInvalido('Esa factura no se pudo cancelar: puede que ya esté cancelada o pagada. Recarga la pantalla.');
  }
  // Base caída, RPC ausente, tope de `acotada`: un error de verdad, no un
  // rechazo de negocio — no se le dice al contralor que su factura tiene la culpa.
  return new Error(`cancelarFactura: ${error.message}`);
}

/**
 * Registra un abono contra una factura EMITIDA.
 *
 * Un pago sobre un borrador se rechaza: sería dinero cobrado contra un CFDI
 * que el SAT no conoce, y la cartera diría "cobrado" sobre papel inexistente.
 * Un pago que rebasa el saldo también: los pagos parciales son la norma, los
 * sobrepagos son casi siempre un dedazo, y el que no lo es se captura cuando
 * exista la nota de crédito que lo explique.
 *
 * DEVUELVE EL ID DEL PAGO. Antes devolvía `void` y el id se calculaba aquí
 * dentro solo para la bitácora. Lo necesita quien concilia una propuesta del
 * portal de pago (0228): esa fila tiene que quedar APUNTANDO al pago real, y
 * sin el id la única alternativa era volver a consultar `pago_recibido`
 * adivinando cuál de los abonos de la factura acababa de nacer — una carrera
 * en el peor lugar posible. Los llamadores que no lo usan no cambian.
 */
export async function registrarPago(
  tenantId: string,
  p: PagoValido,
  actor?: { id?: string; email?: string },
  /**
   * La propuesta del portal de pago que originó este abono, cuando lo hay.
   *
   * Es la LLAVE DE IDEMPOTENCIA: viaja hasta `pago_recibido.propuesta_id`
   * DENTRO de la transacción del RPC, donde el índice único parcial de la 0237
   * la vigila. Si otra sesión ya concilió esta propuesta, la base devuelve
   * 23505 y aquí sale como `AbonoYaRegistrado` — nunca como un segundo abono.
   * El pago tecleado a mano no la pasa y no compite con nada.
   */
  propuestaId?: string,
): Promise<string> {
  // ── DAT-05 · EL SALDO SE LEE CON LA FACTURA TRABADA, NO ANTES ────────────
  //
  // Esto eran cuatro viajes a la base: leer la factura, sumar los pagos,
  // decidir aquí, insertar. Entre el segundo y el cuarto cabe otra petición —
  // y a 50k viajes con dos pestañas abiertas, cabe. Dos abonos de $10,000
  // simultáneos sobre un saldo de $11,600 pasaban LOS DOS, porque cada uno leyó
  // $0 pagados: $20,000 cobrados contra $11,600 y `factura_saldo` en negativo,
  // sin un solo error en el log.
  //
  // `registrar_pago_tx` (0159) hace lo mismo con la factura tomada `for
  // update`: el segundo abono suma DESPUÉS del primero y ve el saldo de verdad.
  // El estatus `pagada` entra en la misma transacción, así que también
  // desaparece el estado "el pago quedó registrado pero la factura no pasó a
  // pagada" que este archivo tenía que avisar a gritos.
  //
  // La decisión de dinero sigue siendo la de `evaluarAbono` —las mismas cuatro
  // reglas, en el mismo orden, ahora también en SQL (bloque 131 de
  // verificaciones.sql las corre contra Postgres)— y la REDACCIÓN sigue siendo
  // de aquí: la base manda el motivo y el saldo, `mensajeRechazoAbono` escribe.
  const { data, error } = await acotada(supabaseAdmin().rpc('registrar_pago_tx', {
    p_tenant: tenantId,
    p_factura: p.facturaId,
    p_fecha: p.fecha,
    p_monto: p.monto,
    p_metodo: p.metodo,
    p_referencia: p.referencia,
    p_propuesta: propuestaId ?? null,
  }), 'registrarPago');

  if (error) {
    // El 23505 solo puede venir de `pago_recibido_propuesta_unica` (0237): es
    // el único índice único que este insert puede tocar. No se disfraza de
    // error genérico ni se reintenta — quien llamó tiene que decidir, y para
    // eso necesita saber que el abono ya está.
    if (error.code === CHOQUE_UNICO && propuestaId) throw new AbonoYaRegistrado(propuestaId);
    throw traducirErrorDelPago(error, p.monto);
  }

  const pagoId = (data as { pago_id?: unknown } | null)?.pago_id;
  if (!pagoId) throw new Error('registrarPago: el RPC no devolvió el id del pago');

  await anotar(tenantId, 'pago.registrado', 'pago_recibido', String(pagoId), {
    facturaId: p.facturaId, fecha: p.fecha, monto: p.monto, metodo: p.metodo, referencia: p.referencia,
    ...(propuestaId ? { propuestaId } : {}),
  }, actor);

  return String(pagoId);
}

/**
 * Cancela una factura SIN pagos. Con pagos encima no se cancela desde aquí:
 * ese dinero ya contado tiene que aclararse primero (¿se devuelve? ¿se aplica
 * a otra factura?), y esa decisión no es de un botón.
 *
 * ── AUDITORÍA 24, BE-3: EL CONTEO Y LA CANCELACIÓN VAN EN LA MISMA TRANSACCIÓN
 *
 * Esto eran dos viajes: `count` de `pago_recibido` y después el UPDATE. Entre
 * los dos cabía un abono —el contador conciliando $10,000 mientras el
 * contralor pulsaba Cancelar—: `registrar_pago_tx` trababa la factura,
 * insertaba y la dejaba `emitida` (no saldaba); el UPDATE de aquí la
 * encontraba `emitida` y cancelaba. $10,000 contra un CFDI que ante el SAT ya
 * no existe. Es el mismo select-luego-update que `registrarPago` abandonó por
 * un RPC, y aquí se hace lo mismo: `cancelar_factura_tx` (0284) toma la
 * factura `for update`, cuenta con la fila trabada y cancela; un abono
 * concurrente espera y lo rechaza el trigger de la 0284 (la factura ya está
 * cancelada), o entra antes y entonces el conteo lo ve. La REDACCIÓN sigue
 * siendo de aquí: la base manda el motivo, este archivo escribe.
 *
 * ── Y APAGA SU ENLACE PÚBLICO DE PAGO (`c7-7`) ──────────────────────────
 *
 * Cancelar dejaba viva la liga de `/pago/<token>`: el cliente abría el mismo
 * link y seguía viendo «Saldo pendiente $34,800.00» con el formulario activo,
 * porque la vista `factura_saldo` calcula `total − pagos` sin mirar el estatus.
 * Cobrarle a alguien por un CFDI cancelado es lo peor que este producto puede
 * hacer.
 *
 * La revocación va DESPUÉS del cambio de estatus y no antes: si el RPC
 * fallara, habríamos matado el enlace de una factura que sigue viva. Y si la
 * revocación falla, se LANZA —no se traga—, porque el contralor tiene que
 * enterarse de que le quedó un enlace suelto. Aun así, el enlace suelto ya no
 * cobra: `vistaDelPortal` degrada a `no_cobrable` mirando el estatus real. Dos
 * capas, y la de la lectura pública es la que no depende de que esta escritura
 * haya salido bien.
 *
 * El UPDATE de las ligas se hace aquí con `supabaseAdmin` en vez de llamar a
 * `revocarLigaPago`: ese verbo vive en `portal_pago_escritura.ts`, que a su vez
 * importa `registrarPago` DE ESTE ARCHIVO. Importarlo de vuelta sería un ciclo
 * entre dos módulos de dinero, y no vale un `import` circular ahorrarse seis
 * líneas.
 */
export async function cancelarFactura(
  tenantId: string,
  facturaId: string,
  actor?: { id?: string; email?: string },
): Promise<void> {
  if (!esUuidValido(facturaId)) throw new DatoInvalido('No se reconoce esa factura. Recarga la pantalla.');

  const { error } = await acotada(supabaseAdmin().rpc('cancelar_factura_tx', {
    p_tenant: tenantId,
    p_factura: facturaId,
  }), 'cancelarFactura');
  if (error) throw traducirErrorDeCancelacion(error);

  const { data: ligas, error: errL } = await acotada(supabaseAdmin().from('portal_pago_liga')
    .update({ revocada_en: new Date().toISOString(), revocada_por: actor?.id ?? null })
    .eq('tenant_id', tenantId).eq('factura_id', facturaId)
    .is('revocada_en', null)
    .select('id'), 'cancelarFactura.revocarLigas');

  await anotar(tenantId, 'factura.cancelada', 'factura_emitida', facturaId, {
    ligasRevocadas: Array.isArray(ligas) ? ligas.length : null,
  }, actor);

  if (errL) {
    throw new Error(
      `La factura SÍ quedó cancelada, pero no se pudo revocar su enlace de pago: ${errL.message}. `
      + 'El enlace ya no cobra —la página pública mira el estatus de la factura—, pero revísalo en la sección del portal de pago.',
    );
  }
  for (const l of (ligas ?? []) as Array<{ id: unknown }>) {
    await anotar(tenantId, 'portal_pago.liga_revocada', 'portal_pago_liga', String(l.id), {
      facturaId, nota: 'Se revocó al cancelar la factura: un CFDI cancelado no cobra.',
    }, actor);
  }
}
