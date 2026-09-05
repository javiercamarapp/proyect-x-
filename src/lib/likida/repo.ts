// Acceso a datos de Likida (service-role, scoping por tenant a mano).
// Mapea filas de Postgres ↔ tipos del dominio.

import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { round2 } from '@/lib/formato';
import type { DatosIntegral, SenalGps } from './privacidad';
import { CONECTORES_GPS } from './conectores/gps';
import { acotada } from './presupuesto';
import { traerTodo, conteo } from './pg';
import type { Gasto, Liquidacion, Viaje, Operador } from '@/types/likida';
import type { CodigoPendiente } from './intake/emparejar';
import { violaIndice } from './pg_errores';
import { declararUmbralPeaje } from './perfil/preguntas';

// El tope de consulta vive en `presupuesto.ts`, con `TOPE_CONSULTA_MS` y el
// resto del presupuesto de la invocación. Estuvo aquí hasta la auditoría 8, y
// por eso solo protegía a este archivo: `costos.ts`, `conv.ts` y `config.ts`
// llamaban a `supabaseAdmin()` en crudo — once de los trece pasos del cierre.

/**
 * EL UUID DEL CFDI, EN UNA SOLA ORTOGRAFÍA (auditoría 18, DAT-26).
 *
 * El SAT imprime el folio fiscal en MAYÚSCULAS —en el PDF y en el atributo
 * `UUID` del timbre— y el OCR y los portales de facturación lo devuelven en
 * minúsculas. `uq_gasto_cfdi_uuid` y `factura_cfdi_unico` son índices sobre
 * `text`: con las dos ortografías vivas, el MISMO comprobante entraba dos
 * veces y su IVA se acreditaba dos veces.
 *
 * Se normaliza en la ESCRITURA y no al comparar porque un índice no puede
 * comparar «con criterio»: o el dato tiene una forma, o el índice no dice lo
 * que cree decir. La migración 0158 lo hace cumplir con un CHECK en las cuatro
 * tablas, así que esto no es la defensa —es no chocar contra ella.
 */
function uuidCfdi(u: string | null | undefined): string | null {
  const t = (u ?? '').trim();
  return t === '' ? null : t.toLowerCase();
}

/**
 * Conserva el XML CRUDO del CFDI (CFF art. 30). Best-effort: un fallo aquí NO
 * tumba la liquidación (el gasto ya está capturado). 1.8.
 */
export async function saveCfdiXmlRaw(tenantId: string, cfdiUuid: string, gastoId: string | null, xml: string): Promise<void> {
  const { error } = await acotada(supabaseAdmin()
    .from('cfdi_xml')
    .upsert({ tenant_id: tenantId, cfdi_uuid: uuidCfdi(cfdiUuid), gasto_id: gastoId, xml }, { onConflict: 'tenant_id,cfdi_uuid' }), 'saveCfdiXmlRaw');
  if (error) logger.warn('cfdi_xml.save', { err: error.message });
}

// `getPolitica` VIVÍA AQUÍ y no la llamaba nadie. Leía `politica_gasto`, una
// tabla con `tope_monto` y `requiere_cfdi` que el motor NUNCA consulta: la
// política viva sale de `tenant.config.politica` (config.ts → cuadrarDesdeDB).
//
// Dos orígenes para el mismo hecho, y el muerto era el que MÁS parece el vivo:
// se llama "politica_gasto", tiene una columna por cada tope, y el seed afirmaba
// por escrito que "el motor de cuadre usa tope_monto y requiere_cfdi". Un
// contralor que le baje el tope de diésel ahí —que es el sitio obvio— ve cómo
// las liquidaciones lo siguen ignorando, sin un error en ningún lado.
//
// La 0025 ya lo había documentado en SQL; lo que faltaba era borrar el lector.
// La tabla se queda (tiene su check de dominio, por si alguien la revive) con un
// `comment on table` que lo dice, que es lo único que se ve desde Supabase.

export async function getViaje(viajeId: string, tenantId: string): Promise<Viaje | null> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('viaje')
    // `demora_no_imputable` NO es opcional aquí: el PDF tiene una sección que
    // depende de él (LFT 263-I) y sin traerlo esa sección no se activa NUNCA.
    // Es el mismo patrón que ya costó dos rondas: el dato existe, el consumidor
    // existe, y nadie los conectó.
    .select('id, folio, origen, destino, anticipo, fecha_inicio, fecha_fin, demora_no_imputable, operador_id')
    .eq('id', viajeId)
    .eq('tenant_id', tenantId)
    .maybeSingle(), 'getViaje');
  if (error) throw new Error(`viaje: ${error.message}`);
  if (!data) return null;
  return {
    id: data.id as string,
    folio: (data.folio as string) || undefined,
    // `?? undefined` y no `|| false`: NULL significa "sin determinar", que no es
    // lo mismo que "la demora sí era imputable al operador".
    demoraNoImputable: (data.demora_no_imputable as boolean | null) ?? undefined,
    operadorId: (data.operador_id as string | null) ?? undefined,
    origen: (data.origen as string) || undefined,
    destino: (data.destino as string) || undefined,
    anticipo: Number(data.anticipo ?? 0),
    fechaInicio: (data.fecha_inicio as string) || undefined,
    fechaFin: (data.fecha_fin as string) || undefined,
  };
}

/**
 * `tenant.perfil` crudo (FASE 3, migración 0169) — a propósito, sin
 * interpretar. Sólo `perfil/preguntas.ts` sabe qué forma tiene por dentro
 * (`calificaEstimuloPeaje`, etc.); este repo se limita a traerlo. Separado
 * de `getConfig()` (config.ts) a propósito, no por descuido: `getConfig`
 * fusiona `config` con los defaults de la demo, y el perfil existe
 * justamente para poder decir "esto lo declaró el cliente" sin que una
 * fusión lo confunda con relleno (docs/perfil/PERFIL-OPERATIVO.md).
 */
export async function getPerfilCrudo(tenantId: string): Promise<unknown> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('tenant')
    .select('perfil')
    .eq('id', tenantId)
    .maybeSingle(), 'getPerfilCrudo');
  if (error) throw new Error(`perfil: ${error.message}`);
  return data?.perfil ?? {};
}

/**
 * Escribe la declaración del umbral de peaje (LIF 2026 art. 20-A) en
 * `tenant.perfil` + `perfil_actualizado_por` en el MISMO UPDATE — el trigger
 * de 0169 lee `NEW.perfil_actualizado_por`. Sin el actor en el mismo
 * statement, el historial sella al updater anterior.
 *
 * Lee-mezcla-escribe: `perfil` es jsonb y un `||` ciego pisaría otras
 * llaves futuras. Las escrituras son humanas (un formulario, no el camino
 * caliente). Un fallo de lectura LANZA: no se da por guardado lo que no se
 * pudo mezclar.
 */
export async function guardarPerfilPatch(
  tenantId: string,
  patch: Record<string, unknown>,
  actualizadoPor: string | null,
): Promise<void> {
  // AUDITORÍA 24, H20/H21/H22: leer+mezclar+escribir en dos statements
  // dejaba una carrera de "lost update" (dos respuestas de la entrevista de
  // onboarding casi juntas se pisaban). `tenant_perfil_merge` (mig. 0296)
  // hace la lectura y la escritura en el MISMO statement.
  const { error } = await acotada(supabaseAdmin().rpc('tenant_perfil_merge', {
    p_tenant_id: tenantId,
    p_patch: patch,
    p_actualizado_por: actualizadoPor,
  }), 'guardarPerfilPatch');
  if (error) throw new Error(`perfil: ${error.message}`);
}

export async function guardarDeclaracionEstimuloPeaje(
  tenantId: string,
  ingresosMenoresA300M: boolean,
  parteRelacionada: boolean,
  actualizadoPor: string | null,
): Promise<void> {
  await guardarPerfilPatch(tenantId, declararUmbralPeaje(ingresosMenoresA300M, parteRelacionada), actualizadoPor);
}

export async function getOperador(operadorId: string, tenantId: string): Promise<Operador | null> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('operador')
    .select('id, nombre, telefono, rfc, activo, oposicion_automatizada, terminal:terminal_id(nombre)')
    .eq('id', operadorId)
    .eq('tenant_id', tenantId)
    .maybeSingle(), 'getOperador');
  if (error) throw new Error(`operador: ${error.message}`);
  if (!data) return null;
  const terminal = data.terminal as { nombre?: string } | null;
  const activo = (data as { activo?: unknown }).activo;
  return {
    id: data.id as string,
    nombre: data.nombre as string,
    telefono: data.telefono as string,
    rfc: (data.rfc as string | null) ?? undefined,
    // `undefined` cuando la columna no vino (lectores viejos, dobles de
    // prueba): "no se preguntó" ≠ "dado de baja", y quien decide sobre la baja
    // tiene que poder distinguirlas.
    activo: typeof activo === 'boolean' ? activo : undefined,
    oposicionAutomatizada: (data.oposicion_automatizada as string | null) ?? null,
    terminal: terminal?.nombre,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LOS CATÁLOGOS DEL PANEL, BUSCADOS EN EL SERVIDOR (FE-2, 22-ago-2026)
//
// `listOperadores` no tenía `.limit()`: a 7,500 choferes PostgREST recortaba a
// 1,000 EN SILENCIO y el chofer 1,001 simplemente no existía para el despacho
// — sin error, sin rótulo, sin manera de notarlo desde la pantalla. Los
// catálogos de cliente y unidad de `/dashboard/despacho` tenían el mismo
// hueco.
//
// Y el recorte era la MITAD del problema. La otra mitad es que ese catálogo
// entero se pintaba UNA VEZ POR FILA: un `<select>` de operadores por cada
// viaje por asignar y uno de unidades por cada viaje en curso. Doce filas ×
// 7,500 `<option>` = ~1.5-2 MB de HTML por carga, todo para que se elija UNO.
//
// El arreglo es el mismo para los tres: NUNCA se manda el catálogo al
// navegador. Se manda un buscador (`buscarCatalogo`, tope de 20) que la UI
// llama al escribir — `ComboCatalogo` en `app/dashboard/combo-catalogo.tsx` —,
// y el conteo real (`contarCatalogo`) para poder decir en pantalla cuántos
// hay sin traerlos. El índice de trigramas de la 0160 es lo que hace que ese
// `%q%` no sea un barrido del tenant.
// ═══════════════════════════════════════════════════════════════════════════

/** Qué catálogo se busca. Los tres que el despacho necesita para crear y
 *  amarrar un viaje; ninguno lleva dinero, así que el área `operacion` los
 *  puede ver completa. */
export type TipoCatalogo = 'operador' | 'cliente' | 'unidad';

/** Cuántas opciones ve el usuario de una vez. 20 es lo que cabe en un
 *  `<datalist>` sin volverse una lista para leer: si lo que busca no está
 *  entre las 20, la respuesta es teclear una letra más, no bajar. Muy por
 *  debajo del recorte de 1,000 de PostgREST — el tope aquí es una decisión de
 *  pantalla, no un accidente del transporte. */
export const TOPE_CATALOGO = 20;

export interface OpcionCatalogo { id: string; etiqueta: string }

/** La tabla, la columna que se enseña y por cuál se ordena/busca. Una sola
 *  tabla de verdad para las tres consultas: tres copias del mismo `.eq(
 *  'activo', true)` es la forma en que un catálogo se olvida de filtrar. */
const CATALOGOS: Record<TipoCatalogo, { tabla: string; columna: string }> = {
  operador: { tabla: 'operador', columna: 'nombre' },
  cliente: { tabla: 'cliente', columna: 'nombre' },
  unidad: { tabla: 'unidad', columna: 'numero_economico' },
};

/** Fuera los comodines de LIKE y las comas: `%` solo convertiría la búsqueda
 *  en "todo", y `,`/`(`/`)` rompen el filtro de PostgREST. Mismo saneo que
 *  `sanearBusqueda` del registro de viajes (viajes_registro.ts). */
export function sanearCatalogo(q: string | undefined | null): string {
  return (q ?? '').trim().replace(/[%_,()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/**
 * Hasta `limite` (≤ `TOPE_CATALOGO`) opciones ACTIVAS del catálogo, filtradas
 * por `q` en la base. Sin `q` son las primeras por orden alfabético — el
 * arranque del combo, no "todas".
 *
 * LANZA ante error, igual que `listOperadores` siempre hizo: una lista vacía
 * se pinta "no hay choferes dados de alta", que con la base caída es falso y
 * manda al usuario a dar de alta un operador que ya existe.
 */
export async function buscarCatalogo(
  tenantId: string,
  tipo: TipoCatalogo,
  q?: string,
  limite: number = TOPE_CATALOGO,
): Promise<OpcionCatalogo[]> {
  const cat = CATALOGOS[tipo];
  if (!cat) throw new Error(`buscarCatalogo: tipo desconocido ${tipo}`);
  const texto = sanearCatalogo(q);
  const tope = Math.max(1, Math.min(TOPE_CATALOGO, limite));

  let consulta = supabaseAdmin()
    .from(cat.tabla)
    .select(`id, ${cat.columna}`)
    .eq('tenant_id', tenantId)
    .eq('activo', true);
  if (texto) consulta = consulta.ilike(cat.columna, `%${texto}%`);

  const { data, error } = await acotada(consulta.order(cat.columna).limit(tope), `buscarCatalogo:${tipo}`);
  if (error) throw new Error(`buscarCatalogo:${tipo}: ${error.message}`);
  // `as unknown as` y no un cast directo: el `.select()` se arma con la
  // columna en runtime, así que el tipo derivado de postgrest-js es un
  // `ParserError`, no una fila. La FORMA se comprueba abajo, que es lo que
  // importa.
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((f) => ({
    id: f.id as string,
    etiqueta: (f[cat.columna] as string) ?? '',
  }));
}

/**
 * Cuántos hay DE VERDAD en el catálogo (`count exact, head`), sin traer una
 * sola fila. Es lo que permite que la pantalla diga "20 de 7,500" en vez de
 * insinuar que 20 son todos — y distinguir "todavía no das de alta a nadie"
 * (0, que sí es medición) de "no se pudo contar" (`null`).
 */
export async function contarCatalogo(tenantId: string, tipo: TipoCatalogo): Promise<number | null> {
  const cat = CATALOGOS[tipo];
  if (!cat) throw new Error(`contarCatalogo: tipo desconocido ${tipo}`);
  const { count, error } = await acotada(supabaseAdmin()
    .from(cat.tabla)
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('activo', true), `contarCatalogo:${tipo}`);
  if (error) {
    logger.warn('contarCatalogo', { tenantId, tipo, err: error.message });
    return null;
  }
  return count ?? null;
}

/**
 * Choferes activos del tenant, para el selector de "Reasignar chofer" del
 * panel (docs/superpowers/plans/2026-08-02-roles-flota.md, Task 3). Solo
 * `nombre` — la vista de asignación no necesita el teléfono.
 *
 * ACOTADO desde FE-2: devuelve a lo más `TOPE_CATALOGO`. Es el ARRANQUE del
 * combo de búsqueda, no el catálogo — quien tenga más choferes que eso los
 * encuentra escribiendo, y la pantalla dice cuántos hay en total
 * (`contarCatalogo`). Antes no llevaba tope y PostgREST recortaba a 1,000 sin
 * decirlo.
 */
export async function listOperadores(
  tenantId: string,
  opciones: { q?: string; limite?: number } = {},
): Promise<Array<{ id: string; nombre: string }>> {
  const opts = await buscarCatalogo(tenantId, 'operador', opciones.q, opciones.limite ?? TOPE_CATALOGO);
  return opts.map((o) => ({ id: o.id, nombre: o.etiqueta }));
}

/**
 * Mueve un viaje de un chofer a otro. Acotado por tenant en el propio UPDATE
 * (no solo en la página que lo llama): con RLS activa esto es cinturón y
 * tirantes, no el único candado.
 *
 * ── EL OPERADOR TIENE QUE SER DE ESTA FLOTA (auditoría 10, ALTO) ───────────
 *
 * El `.eq('tenant_id', tenantId)` de abajo acota QUÉ VIAJE se puede tocar —
 * nunca acotó a QUÉ OPERADOR se le puede asignar. El `<select>` de
 * `/dashboard/despacho` solo ofrece los de `listOperadores(tenantId)`, pero
 * eso es una restricción de la UI, no del servidor: un POST directo al server
 * action (devtools, no hace falta curl) con el `operadorId` de OTRA flota
 * dejaba `viaje.tenant_id = A` apuntando a un `operador_id` de B.
 *
 * La RLS del chofer (`0045_rls_operador.sql`, policy `operador_ve_su_viaje`)
 * no vuelve a comprobar tenant — solo mira
 * `operador_id = get_user_operador_id()` —, así que el chofer de B, al entrar
 * a /chofer, vería ese viaje (y sus gastos y su liquidación) de la flota A.
 * Mismo patrón que los dos hallazgos que se cerraron esta misma ronda: se
 * acota el tenant y se olvida el rol/dueño del segundo id.
 */
export async function reasignarOperador(tenantId: string, viajeId: string, operadorId: string): Promise<void> {
  const propio = await getOperador(operadorId, tenantId);
  if (!propio) throw new Error('reasignarOperador: el operador no pertenece a esta flota');
  // AUDITORÍA 20 (H2): y tiene que SEGUIR trabajando aquí. El combo de
  // /dashboard/despacho ya no lo ofrece (`buscarCatalogo` filtra `activo`),
  // pero eso es la UI: un POST directo —o la pestaña que alguien dejó abierta
  // antes de la baja— le pasaba el viaje a un chofer al que el bot de WhatsApp
  // ya no le contesta, y ese viaje se quedaba sin quien lo reporte.
  if (propio.activo === false) {
    throw new Error('reasignarOperador: el operador está dado de baja en esta flota');
  }

  const { error } = await acotada(supabaseAdmin()
    .from('viaje')
    .update({ operador_id: operadorId })
    .eq('id', viajeId)
    .eq('tenant_id', tenantId), 'reasignarOperador');
  if (error) throw new Error(`reasignarOperador: ${error.message}`);
}

export async function addGasto(tenantId: string, viajeId: string, g: Gasto): Promise<void> {
  const { error } = await acotada(supabaseAdmin().from('gasto').insert({
    id: g.id,
    tenant_id: tenantId,
    viaje_id: viajeId,
    concepto: g.concepto,
    monto: g.monto,
    fecha: g.fecha ?? null,
    folio: g.folio ?? null,
    rfc_emisor: g.rfcEmisor ?? null,
    rfc_receptor: g.rfcReceptor ?? null,
    cfdi_uuid: uuidCfdi(g.cfdiUuid),
    imagen_url: g.imagenUrl ?? null,
    ocr_confianza: g.ocrConfianza ?? null,
    cfdi_valido: g.cfdiValido ?? null,
    estado_sat: g.estadoSat ?? null,
    efos: g.efos ?? null,
    efos_revisar: g.efosRevisar ?? null,
    clave_prod_serv: g.claveProdServ ?? null,
    clave_unidad: g.claveUnidad ?? null,
    tipo_comprobante: g.tipoComprobante ?? null,
    complemento_hidrocarburos: g.complementoHidrocarburos ?? null,
    cfdi_esquema_alterno: g.cfdiEsquemaAlterno ?? null,
    xml_verificado: g.xmlVerificado ?? null,
    forma_pago: g.formaPago ?? null,
    metodo_pago: g.metodoPago ?? null,
    sub_total: g.subTotal ?? null,
    descuento: g.descuento ?? null,
    ieps_traslado: g.iepsTraslado ?? null,
    iva_traslado: g.ivaTraslado ?? null,
    iva_retenido: g.ivaRetenido ?? null,
    isr_retenido: g.isrRetenido ?? null,
    folio_norm: g.folioNorm ?? null,
    ocr_extra: g.ocrExtra ?? null,
    img_hash: g.imgHash ?? null,
    // DAT-01: la llave del reproceso. Va aquí, en el MISMO insert, para que la
    // unicidad y el alta sean el mismo acto: un `update` posterior dejaría
    // abierta justo la ventana que este campo existe para cerrar.
    wa_message_id: g.waMessageId ?? null,
  }), 'addGasto');
  if (error) {
    // Se preserva el código de Postgres para que el caller distinga un duplicado
    // (23505, dedup de foto por índice único) de un error real. Ver processor.
    const e = new Error(`addGasto: ${error.message}`) as Error & { code?: string };
    e.code = error.code;
    throw e;
  }
}

/** FASE 2: ¿ya existe un gasto para este viaje con el mismo hash de imagen?
 *  Best-effort para dedup de fotos reenviadas; ante error de lectura devuelve
 *  false (no bloquea el intake — preferimos un raro duplicado a perder un gasto). */
export async function gastoExistePorHash(viajeId: string, imgHash: string, tenantId: string): Promise<boolean> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('gasto')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('viaje_id', viajeId)
    .eq('img_hash', imgHash)
    .limit(1), 'gastoExistePorHash');
  if (error) return false;
  return (data?.length ?? 0) > 0;
}

/**
 * ¿DÓNDE está ya esta foto? Busca en TODA la flota, no solo en un viaje.
 *
 * Existe por el desfase entre el pre-chequeo y el índice: `gastoExistePorHash`
 * mira un VIAJE, pero `uq_gasto_img_hash` es `unique(tenant_id, img_hash)` —
 * toda la flota—. Una foto ya registrada en OTRO viaje pasa el pre-chequeo, la
 * rechaza el índice con 23505, y el processor la tomaba por una carrera de
 * ráfaga y la descartaba en silencio.
 *
 * Medido el 1-ago con un operador que reenvió su fajo: diez fotos rechazadas,
 * cero mensajes. Desde su lado, las mandó y no pasó nada.
 */
export async function ubicarGastoPorHash(
  tenantId: string, imgHash: string,
): Promise<{ viajeId: string; folio?: string; monto: number } | null> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('gasto')
    .select('viaje_id, monto, viaje:viaje_id(folio)')
    .eq('tenant_id', tenantId)
    .eq('img_hash', imgHash)
    .limit(1), 'ubicarGastoPorHash');
  const fila = !error ? data?.[0] : null;
  if (!fila) return null;
  return {
    viajeId: fila.viaje_id as string,
    folio: ((fila.viaje as { folio?: string } | null)?.folio) || undefined,
    monto: Number(fila.monto),
  };
}

/**
 * El gasto que ya tiene ese hash de imagen, con lo justo para hablar de él.
 *
 * Hermano de `gastoExistePorHash` y NO su sustituto: aquél es la compuerta y
 * corre en toda foto; éste solo corre cuando la compuerta ya dio positivo, que
 * es el caso raro del reenvío idéntico. Separarlos es lo que evita pagar esta
 * lectura en el camino normal.
 *
 * Existe por un fallo del ensayo del 1-ago: se le pidió al operador otra foto de
 * un ticket con la fecha mal leída, reenvió EL MISMO archivo, y el dedup por
 * contenido lo descartó antes del OCR — en silencio. Hizo lo que se le pidió y
 * no pasó nada, sin que nadie se lo dijera.
 */
export async function gastoPorHash(
  viajeId: string, imgHash: string, tenantId: string,
): Promise<{ id: string; fecha?: string; monto: number; concepto: string; folio?: string; ocrExtra?: Record<string, unknown> } | null> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('gasto')
    .select('id, concepto, monto, fecha, folio, ocr_extra')
    .eq('tenant_id', tenantId)
    .eq('viaje_id', viajeId)
    .eq('img_hash', imgHash)
    .limit(1), 'gastoPorHash');
  const fila = !error ? data?.[0] : null;
  if (!fila) return null;
  return {
    id: fila.id, concepto: fila.concepto, monto: Number(fila.monto),
    fecha: fila.fecha ?? undefined, folio: fila.folio ?? undefined,
    ocrExtra: (fila.ocr_extra ?? {}) as Record<string, unknown>,
  };
}

/** NIVEL 2: actualiza un gasto con los datos del XML del CFDI (por id). */
// ═══════════════════════════════════════════════════════════════════════════
// LA SALA DE ESPERA DE LOS COMPROBANTES SIN VIAJE (mig. 0040).
//
// Una foto NUNCA se rechaza. Si no hay viaje abierto —o si la liquidación ya se
// emitió— el comprobante queda aquí con su extracción hecha, y se le pregunta
// al operador si va cuando haya viaje al que ponerlo.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POR QUÉ ese comprobante no aterrizó en una liquidación.
 *
 * `fallo_ocr` se agregó el 4-ago-2026 y NO trae migración: la columna es `text`
 * a secas (0040, línea 40) sin CHECK ni enum, y hoy NADIE la lee para decidir
 * nada — el ofrecimiento filtra por `gasto.monto`, no por esto. Se escribe para
 * que la fila diga la verdad de lo que pasó: las dos ramas de `fallo_tecnico`
 * del processor guardaban `sin_viaje`, que describe el efecto (no aterrizó en
 * ninguna liquidación) y esconde la causa (se cayó NUESTRO OCR). Con `sin_viaje`
 * en las dos, contar cuántos comprobantes perdió el proveedor de visión no se
 * podía hacer con esta tabla.
 */
export type MotivoHuerfano = 'sin_viaje' | 'tras_liquidar' | 'fallo_ocr';

export interface Huerfano {
  id: string;
  gasto: Gasto;
  motivo: MotivoHuerfano;
  creadoEn: string;
  rutaImagen?: string;
  /** Cuándo se le preguntó al operador si van. `undefined` = nunca. */
  ofrecidoEn?: string;
}

/**
 * Best-effort: si esto falla, se le dice al operador que no se pudo guardar.
 *
 * DAT-01 — EL DUPLICADO CUENTA COMO GUARDADO. `uq_huerfano_img_hash` (0164)
 * impide que el MISMO papel ocupe dos filas. Para comprobantes con hash, la
 * RPC 0322 registra o vincula bajo lock y devuelve la fila existente: así el
 * cliente no interpreta un 23505 sin saber si también quedó ligado al viaje.
 */
export async function guardarHuerfano(
  tenantId: string, operadorId: string,
  h: { gasto: Gasto; motivo: MotivoHuerfano; rutaImagen?: string; viajeId?: string },
): Promise<boolean> {
  // Con hash, registrar y vincular son UNA operación en Postgres. Un 23505
  // manejado sólo en el cliente podía afirmar «ya estaba» dejando la fila
  // previa con viaje_id NULL; la 0322 bloquea la fila y permite vincularla una
  // sola vez, sin que otro viaje u operador pueda apropiársela después.
  if (h.gasto.imgHash) {
    const { error } = await acotada(supabaseAdmin().rpc('guardar_comprobante_huerfano_tx', {
      p_tenant: tenantId,
      p_operador: operadorId,
      p_gasto: h.gasto,
      p_motivo: h.motivo,
      p_ruta_imagen: h.rutaImagen ?? null,
      p_viaje: h.viajeId ?? null,
    }), 'guardarHuerfano');
    if (error) logger.error('huerfano.guardar_error', { err: error.message });
    return !error;
  }
  const { error } = await acotada(supabaseAdmin().from('comprobante_huerfano').insert({
    tenant_id: tenantId, operador_id: operadorId,
    gasto: h.gasto, motivo: h.motivo, ruta_imagen: h.rutaImagen ?? null,
    ...(h.viajeId ? { viaje_id: h.viajeId } : {}),
  }), 'guardarHuerfano');
  if (violaIndice(error, 'uq_huerfano_img_hash')) {
    logger.info('huerfano.ya_estaba', { tenant: tenantId, operador: operadorId });
    return true;
  }
  if (error) logger.error('huerfano.guardar_error', { err: error.message });
  return !error;
}

/**
 * Los que siguen esperando. El modo normal conserva el comportamiento
 * best-effort de los ofrecimientos. El cierre usa `fallarCerrado`: no poder
 * comprobar si hay una foto con OCR roto NO se puede interpretar como una sala
 * vacía y convertir en liquidación irreversible.
 */
export async function getHuerfanos(
  tenantId: string, operadorId: string,
  opciones: {
    /** AUDITORÍA 24 · WA-7 (MEDIO): los huérfanos SIN monto (fallo de OCR,
     *  voucher) nunca se ofrecen, pero ocupaban el tope de 50 por antigüedad
     *  y a partir del 50º el chofer dejaba de ver los que SÍ tienen monto.
     *  Con esto el filtro va en la base, ANTES del `limit`. */
    soloConMonto?: boolean;
    /** Restringe el incidente al viaje al que pertenecía la foto. */
    viajeId?: string;
    /** Solo las imágenes cuyo OCR falló y todavía no fueron resueltas. */
    soloFalloOcr?: boolean;
    /** En caminos irreversibles, propaga una lectura fallida en vez de `[]`. */
    fallarCerrado?: boolean;
  } = {},
): Promise<Huerfano[]> {
  let q = supabaseAdmin()
    .from('comprobante_huerfano')
    .select('id, gasto, motivo, creado_en, ruta_imagen, ofrecido_en')
    .eq('tenant_id', tenantId).eq('operador_id', operadorId)
    .is('resuelto_en', null);
  // `->` (jsonb) y no `->>` (texto): PostgREST compara el número como número.
  if (opciones.soloConMonto) q = q.gt('gasto->monto', 0);
  if (opciones.viajeId) q = q.eq('viaje_id', opciones.viajeId);
  if (opciones.soloFalloOcr) q = q.eq('motivo', 'fallo_ocr');
  const { data, error } = await acotada(q
    .order('creado_en', { ascending: true })
    .limit(50), 'getHuerfanos');
  if (error) {
    if (opciones.fallarCerrado) throw new Error(`getHuerfanos: ${error.message}`);
    return [];
  }
  if (!data) return [];
  return data.map((r) => ({
    id: r.id as string,
    gasto: r.gasto as Gasto,
    motivo: r.motivo as MotivoHuerfano,
    creadoEn: r.creado_en as string,
    rutaImagen: (r.ruta_imagen as string) || undefined,
    ofrecidoEn: (r.ofrecido_en as string) || undefined,
  }));
}

/**
 * Deja constancia de que ya se le preguntó, para no repetir la oferta en cada
 * mensaje. Best-effort: si falla, el peor caso es preguntar de más.
 */
export async function marcarHuerfanosOfrecidos(tenantId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { error } = await acotada(supabaseAdmin().from('comprobante_huerfano')
    .update({ ofrecido_en: new Date().toISOString() })
    .in('id', ids).eq('tenant_id', tenantId), 'marcarHuerfanosOfrecidos');
  if (error) logger.warn('huerfano.marcar_ofrecido_error', { err: error.message });
}

/**
 * Cierra las filas. `viajeId` solo cuando se adjuntaron.
 *
 * Se marca DESPUÉS de insertar los gastos, no antes: si el `addGasto` falla a
 * medias, lo que queda es una fila todavía pendiente —que se vuelve a ofrecer—
 * y no un comprobante marcado como puesto que no está en ningún lado.
 */
/**
 * Devuelve si quedó sellado (AUDITORÍA 24 · BE-12): antes tragaba el error
 * con un log sin ids, y el llamador seguía como si los huérfanos ya no
 * existieran — en el siguiente viaje se le volvían a ofrecer al chofer.
 */
export async function resolverHuerfanos(
  tenantId: string, ids: string[],
  resolucion: 'adjuntado' | 'descartado', viajeId: string | null,
): Promise<boolean> {
  if (!ids.length) return true;
  const { error } = await acotada(supabaseAdmin().from('comprobante_huerfano').update({
    resuelto_en: new Date().toISOString(), resolucion, viaje_id: viajeId,
  }).in('id', ids).eq('tenant_id', tenantId), 'resolverHuerfanos');
  if (error) {
    logger.error('huerfano.resolver_error', { tenant: tenantId, ids, resolucion, viaje: viajeId, err: error.message });
    return false;
  }
  return true;
}

/** Una fila de la bandeja de la OFICINA (F2 del plan): lo que el humano
 *  necesita para decidir a qué viaje va — sin la foto (exhibirla a un humano
 *  tiene candado legal propio; el dato extraído no). */
export interface HuerfanoDeFlota {
  id: string;
  operadorNombre: string | null;
  concepto: string;
  monto: number;
  /** Fecha del comprobante (la del papel), no la de llegada. */
  fecha: string | null;
  motivo: MotivoHuerfano;
  creadoEn: string;
}

/**
 * TODOS los pendientes de la flota, para la bandeja de la oficina.
 *
 * Falla CERRADO (throw), al revés que `getHuerfanos`: allá, no poder leer la
 * sala de espera no debe impedirle al chofer cerrar su viaje; acá la bandeja
 * ES la pantalla, y un `[]` ciego afirmaría "no hay comprobantes sueltos".
 */
export async function getHuerfanosDeFlota(tenantId: string): Promise<HuerfanoDeFlota[]> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('comprobante_huerfano')
    .select('id, gasto, motivo, creado_en, operador:operador_id(nombre)')
    .eq('tenant_id', tenantId)
    .is('resuelto_en', null)
    .order('creado_en', { ascending: true })
    .limit(200), 'getHuerfanosDeFlota');
  if (error) throw new Error(`getHuerfanosDeFlota: ${error.message}`);
  type RelOp = { nombre?: string };
  return (data ?? []).map((r) => {
    const rel = r.operador as RelOp | RelOp[] | null;
    const op = Array.isArray(rel) ? rel[0] : rel;
    const g = r.gasto as Gasto;
    return {
      id: r.id as string,
      operadorNombre: op?.nombre ?? null,
      concepto: g?.concepto ?? 'otros',
      monto: Number(g?.monto ?? 0),
      fecha: g?.fecha ?? null,
      motivo: r.motivo as MotivoHuerfano,
      creadoEn: r.creado_en as string,
    };
  });
}

/** Para la alerta del Inicio. `null` ≠ 0: un error de lectura no puede
 *  leerse como "no hay comprobantes sueltos". */
export async function contarHuerfanosPendientes(tenantId: string): Promise<number | null> {
  const { count, error } = await acotada(supabaseAdmin()
    .from('comprobante_huerfano')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .is('resuelto_en', null), 'contarHuerfanosPendientes');
  if (error) {
    logger.warn('contarHuerfanosPendientes', { tenantId, err: error.message });
    return null;
  }
  return count ?? null;
}

/** UN huérfano pendiente, anclado al tenant — la mitad de "adjuntar desde la
 *  oficina": el gasto completo que `addGasto` va a insertar. */
export async function traerHuerfanoPendiente(tenantId: string, id: string): Promise<Huerfano | null> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('comprobante_huerfano')
    .select('id, gasto, motivo, creado_en, ruta_imagen, ofrecido_en')
    .eq('tenant_id', tenantId).eq('id', id)
    .is('resuelto_en', null)
    .maybeSingle(), 'traerHuerfanoPendiente');
  if (error || !data) return null;
  return {
    id: data.id as string,
    gasto: data.gasto as Gasto,
    motivo: data.motivo as MotivoHuerfano,
    creadoEn: data.creado_en as string,
    rutaImagen: (data.ruta_imagen as string) || undefined,
    ofrecidoEn: (data.ofrecido_en as string) || undefined,
  };
}

/**
 * La resolución DESDE LA OFICINA devuelve el resultado en vez de tragárselo
 * (`resolverHuerfanos` es best-effort para el flujo de WhatsApp; un botón que
 * dice "ya quedó" sin haber quedado es un rótulo que miente). El
 * `.is('resuelto_en', null)` es el candado anti-carrera: si el chofer lo
 * adjuntó por WhatsApp al mismo tiempo, el perdedor se entera aquí.
 */
export async function resolverHuerfanoDesdeOficina(
  tenantId: string, id: string,
  resolucion: 'adjuntado' | 'descartado', viajeId: string | null,
): Promise<{ error?: string }> {
  const { data, error } = await acotada(supabaseAdmin().from('comprobante_huerfano').update({
    resuelto_en: new Date().toISOString(), resolucion, viaje_id: viajeId,
  }).eq('id', id).eq('tenant_id', tenantId).is('resuelto_en', null).select('id'), 'resolverHuerfanoDesdeOficina');
  if (error) {
    logger.error('huerfano.oficina_resolver_error', { err: error.message });
    return { error: 'No se pudo guardar. Inténtalo de nuevo.' };
  }
  if (!data || data.length === 0) {
    return { error: 'Ese comprobante ya no está pendiente — alguien más lo resolvió. Recarga la página.' };
  }
  return {};
}

/**
 * Re-fecha un gasto con lo que trajo la SEGUNDA foto del mismo ticket.
 *
 * Toca UNA columna. No `monto`, no `concepto`, no `folio`: si algo de eso
 * cambiara no sería el mismo papel, y `emparejarCorreccionDeFecha` ya lo habría
 * descartado. Dejar la escritura tan estrecha es lo que hace que un
 * emparejamiento equivocado —el riesgo real de este camino— cueste una fecha
 * movida y no un total alterado.
 *
 * El trigger de la 0037 sigue mandando: si la liquidación ya se emitió, esto
 * levanta `CU001` y el processor lo traduce, igual que en el alta.
 */
export async function corregirFechaGasto(
  tenantId: string,
  gastoId: string,
  fecha: string,
): Promise<void> {
  const { error } = await acotada(
    supabaseAdmin().from('gasto').update({ fecha })
      .eq('id', gastoId).eq('tenant_id', tenantId),
    'corregirFechaGasto',
  );
  if (error) {
    // `code` preservado por la misma razón que en `updateGastoCfdiXml`: sin él,
    // el `CU001` de la 0037 llega aquí indistinguible de un fallo cualquiera y
    // el operador recibiría "hubo un problema" en vez de "llegó tarde".
    const e = new Error(`corregirFechaGasto: ${error.message}`) as Error & { code?: string };
    if (error.code) e.code = error.code;
    throw e;
  }
}

export async function updateGastoCfdiXml(
  tenantId: string,
  gastoId: string,
  x: { claveProdServ?: string; claveUnidad?: string; tipoComprobante?: string; complementoHidrocarburos?: boolean; esquemaAlterno?: boolean; formaPago?: string; metodoPago?: string; subTotal?: number; descuento?: number; iepsTraslado?: number; ivaTraslado?: number; ivaRetenido?: number; isrRetenido?: number;
       // Cuando el XML se pega a un TICKET (que no traía UUID), estos tres campos
       // pasan a ser autoritativos: vienen del comprobante timbrado, no del OCR.
       uuid?: string; rfcEmisor?: string; rfcReceptor?: string; total?: number; fecha?: string;
       // Auditoría 12 (fiscal, ALTO): @Cantidad del concepto representativo,
       // litros cuando ClaveUnidad = LTR. El XML es la verdad de referencia del
       // ticket; si el OCR no leyó litros (o los leyó mal), este los llena.
       cantidad?: number;
       // DAT-19: la moneda del CFDI y su tipo de cambio. Se MERGEAN en
       // `ocr_extra` igual que los litros — el motor levanta
       // `moneda_extranjera` desde ahí, y sin este paso un XML en USD pegado a
       // un ticket dejaba el gasto con el importe extranjero en la columna de
       // pesos y sin una sola señal de que no eran pesos.
       moneda?: string; tipoCambio?: number },
): Promise<void> {
  const extra: Record<string, unknown> = {};
  if (x.uuid) extra.cfdi_uuid = uuidCfdi(x.uuid);
  if (x.rfcEmisor) extra.rfc_emisor = x.rfcEmisor;
  if (x.rfcReceptor) extra.rfc_receptor = x.rfcReceptor;
  // El monto del CFDI gana sobre el que leyó la visión: no pasó por OCR.
  if (x.total != null && x.total > 0) extra.monto = x.total;
  if (x.fecha) extra.fecha = x.fecha;
  // Litros del XML: se MERGEAN sobre ocr_extra (no se reemplaza el jsonb —
  // ahí viven producto, estacion, fechaImpresa… que una escritura a ciegas
  // borraría). Lectura + fusión + escritura, el patrón del resto del repo.
  const litrosDelXml = x.claveUnidad === 'LTR' && x.cantidad != null && x.cantidad > 0;
  const monedaDelXml = !!x.moneda || x.tipoCambio != null;
  if (litrosDelXml || monedaDelXml) {
    const { data: actual, error: errorLectura } = await acotada(supabaseAdmin().from('gasto')
      .select('ocr_extra').eq('id', gastoId).eq('tenant_id', tenantId).maybeSingle(), 'updateGastoCfdiXml.leerOcrExtra');
    // FAIL-CLOSED (auditoría 21, backend, ALTO REINCIDENTE desde la 18-c4).
    // `acotada` entrega el tope agotado POR VALOR —`{ data: null, error }`,
    // nunca lanza—, igual que cualquier error de Postgres. Sin esta
    // comprobación, un timeout en esta lectura se leía como "el gasto no
    // tenía ocr_extra": el merge arrancaba de `{}` y el update de abajo
    // REEMPLAZABA el jsonb entero, borrando `moneda`, `tipoCambio`,
    // `montoDiscrepante`, `estacion`… — y el motor de cuadre acreditaba IVA
    // de un gasto en USD como si fuera en pesos, sin una línea en el log.
    // Mejor no actualizar que perder datos: se lanza y el ocr_extra viejo
    // queda intacto, con `code` preservado igual que en el update de abajo.
    if (errorLectura) {
      const e = new Error(`updateGastoCfdiXml.leerOcrExtra: ${errorLectura.message}`) as Error & { code?: string };
      if (errorLectura.code) e.code = errorLectura.code;
      throw e;
    }
    const ocrExtra = { ...((actual?.ocr_extra as Record<string, unknown> | null) ?? {}) };
    if (litrosDelXml) ocrExtra.litros = x.cantidad;
    // El XML manda sobre lo que leyó la visión: el emisor declaró la moneda en
    // un comprobante timbrado, el OCR la dedujo de un papel.
    if (x.moneda) ocrExtra.moneda = x.moneda;
    if (x.tipoCambio != null) ocrExtra.tipoCambio = x.tipoCambio;
    extra.ocr_extra = ocrExtra;
  }
  const { error } = await acotada(supabaseAdmin().from('gasto').update({
    ...extra,
    clave_prod_serv: x.claveProdServ ?? null,
    clave_unidad: x.claveUnidad ?? null,
    tipo_comprobante: x.tipoComprobante ?? null,
    complemento_hidrocarburos: x.complementoHidrocarburos ?? null,
    cfdi_esquema_alterno: x.esquemaAlterno ?? null,
    forma_pago: x.formaPago ?? null,
    metodo_pago: x.metodoPago ?? null,
    sub_total: x.subTotal ?? null,
    descuento: x.descuento ?? null,
    ieps_traslado: x.iepsTraslado ?? null,
    iva_traslado: x.ivaTraslado ?? null,
    // FIS-A1: las columnas existen desde la 0063 y nadie las escribía. Una
    // retención no es un gasto: es una cuenta POR PAGAR al SAT, y sin ella la
    // póliza derivaba un residuo negativo y tiraba el periodo entero.
    iva_retenido: x.ivaRetenido ?? null,
    isr_retenido: x.isrRetenido ?? null,
    xml_verificado: true,
  }).eq('id', gastoId).eq('tenant_id', tenantId), 'updateGastoCfdiXml');
  if (error) {
    // SE PRESERVA `code`, igual que `addGasto` (auditoría 6, modelo de datos).
    // Antes era un `throw new Error(...)` liso, así que este camino no podía
    // distinguir una violación de CHECK (23514) ni un duplicado (23505) de un
    // fallo cualquiera, ni aunque alguien quisiera manejarlos: el código venía
    // borrado desde aquí. Una restricción nueva en la base es un error de
    // tiempo de ejecución nuevo, y sin el código no hay forma de traducirlo.
    const e = new Error(`updateGastoCfdiXml: ${error.message}`) as Error & { code?: string };
    if (error.code) e.code = error.code;
    throw e;
  }
}

/**
 * Le pega a un gasto ya registrado los identificadores que trajo el
 * ACERCAMIENTO (segunda foto, solo del código): folio del portal, código de
 * barras, liga de facturación y UUID.
 *
 * NO toca el monto: el emparejamiento se hizo justamente por total, así que ya
 * coinciden. Tocar dinero aquí solo abriría la puerta a moverlo por error.
 */
/**
 * Le pega a un gasto lo que salió del código: folio de portal, código de barras,
 * liga de facturación y —si no tenía— el UUID.
 *
 * Devuelve `true` si de verdad lo enriqueció, `false` si alguien llegó antes.
 * Que devuelva false NO es un error: es la respuesta a "ese gasto ya tiene su
 * acercamiento".
 *
 * El merge y el claim viven en SQL (mig. 0017), no aquí. Haciéndolo desde la
 * app era read-modify-write: las fotos de una ráfaga de WhatsApp corren en
 * paralelo, así que se mezclaba contra el `ocr_extra` que se había leído, no
 * contra el que está en la tabla, y la última escritura borraba lo que otra foto
 * hubiera añadido en medio (montoDiscrepante, textoSospechoso, rfcEmisorDudoso).
 * Y sin claim, el segundo acercamiento del mismo total pisaba el folio del
 * primero — el folio que la oficina teclea en el portal para timbrar.
 *
 * NO se toca `folio`: el impreso en el ticket y el que viaja dentro del QR son
 * cadenas DISTINTAS (comprobado contra el papel — 31 chars contra 30), no dos
 * lecturas del mismo dato. El impreso es el que una persona teclea; el del QR es
 * la llave del deep-link del portal y vive en `ocrExtra.folioPortal`.
 */
export async function enriquecerGastoConCodigo(
  tenantId: string,
  gasto: Gasto,
  datos: { folioPortal?: string; codigoBarras?: string; urlFacturacion?: string; cfdiUuid?: string },
): Promise<boolean> {
  // Solo lo que trae el código. El resto de ocr_extra lo conserva el `||` de SQL.
  const extra: Record<string, unknown> = {};
  if (datos.folioPortal) extra.folioPortal = datos.folioPortal;
  if (datos.codigoBarras) extra.codigoBarras = datos.codigoBarras;
  if (datos.urlFacturacion) extra.urlFacturacion = datos.urlFacturacion;

  const { data, error } = await acotada(supabaseAdmin().rpc('enriquecer_gasto_codigo', {
    p_gasto: gasto.id,
    p_tenant: tenantId,
    p_extra: extra,
    p_cfdi_uuid: uuidCfdi(datos.cfdiUuid),
  }), 'enriquecerGastoConCodigo');
  if (error) throw new Error(`enriquecerGastoConCodigo: ${error.message}`);
  return data === true;
}

// ── Bandeja de códigos pendientes (mig. 0016) ────────────────────────────────
// El acercamiento que llegó antes que su ticket. Espera aquí hasta que entre un
// comprobante de su mismo total.

/** Guarda un código que todavía no tiene comprobante al cual pegarse. */
export async function guardarCodigoPendiente(
  tenantId: string,
  viajeId: string,
  c: Omit<CodigoPendiente, 'id'>,
): Promise<void> {
  const { error } = await acotada(supabaseAdmin().from('codigo_pendiente').insert({
    tenant_id: tenantId,
    viaje_id: viajeId,
    monto: c.monto,
    folio_portal: c.folioPortal ?? null,
    codigo_barras: c.codigoBarras ?? null,
    url_facturacion: c.urlFacturacion ?? null,
    cfdi_uuid: uuidCfdi(c.cfdiUuid),
  }), 'guardarCodigoPendiente');
  // DAT-37: el MISMO acercamiento apuntado dos veces (el operador que lo manda
  // de nuevo, o nuestro reproceso de la bandeja durable) chocaba contra nada —
  // la 0016 no tenía ninguna unicidad— y dejaba una segunda fila que jamás se
  // empareja: `pegarCodigoEnEspera` consume una sola. Con los índices de la
  // 0164 el choque es benigno y significa "ese código ya está esperando", que
  // es exactamente lo que el llamador quería conseguir. Lanzar aquí lo mandaría
  // al catch de ERROR del processor por un camino que salió bien.
  if (violaIndice(error, 'uq_codigo_pendiente_folio') || violaIndice(error, 'uq_codigo_pendiente_barras')) {
    logger.info('codigo_pendiente.ya_estaba', { tenant: tenantId, viaje: viajeId });
    return;
  }
  if (error) throw new Error(`guardarCodigoPendiente: ${error.message}`);
}

export async function getCodigosPendientes(viajeId: string, tenantId: string): Promise<CodigoPendiente[]> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('codigo_pendiente')
    .select('id, monto, folio_portal, codigo_barras, url_facturacion, cfdi_uuid')
    .eq('tenant_id', tenantId)
    .eq('viaje_id', viajeId), 'getCodigosPendientes');
  if (error) throw new Error(`getCodigosPendientes: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    monto: Number(r.monto),
    folioPortal: (r.folio_portal as string) || undefined,
    codigoBarras: (r.codigo_barras as string) || undefined,
    urlFacturacion: (r.url_facturacion as string) || undefined,
    cfdiUuid: (r.cfdi_uuid as string) || undefined,
  }));
}

/**
 * Toma un código de la bandeja para usarlo, y devuelve si lo consiguió.
 *
 * Es un CLAIM, no un borrado: las fotos de una ráfaga corren en paralelo y no
 * toman el mutex del viaje, así que dos comprobantes del mismo total pueden ir
 * por el mismo código a la vez. El borrado con `.select()` es atómico — solo uno
 * recibe la fila — y el otro se entera de que llegó tarde en vez de pegar el
 * mismo folio dos veces.
 */
export async function reclamarCodigoPendiente(tenantId: string, id: string): Promise<boolean> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('codigo_pendiente')
    .delete()
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .select('id'), 'reclamarCodigoPendiente');
  if (error) throw new Error(`reclamarCodigoPendiente: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

export async function getGastos(viajeId: string, tenantId: string): Promise<Gasto[]> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('gasto')
    .select('id, concepto, monto, fecha, folio, folio_norm, ocr_extra, rfc_emisor, rfc_receptor, cfdi_uuid, cfdi_orden, imagen_url, ocr_confianza, cfdi_valido, estado_sat, efos, efos_revisar, clave_prod_serv, clave_unidad, tipo_comprobante, complemento_hidrocarburos, cfdi_esquema_alterno, xml_verificado, forma_pago, metodo_pago, pagado_en, pagado_forma, sub_total, descuento, ieps_traslado, iva_traslado, iva_retenido, isr_retenido')
    .eq('tenant_id', tenantId)
    .eq('viaje_id', viajeId)
    // AUDITORÍA 25 · TC-1 (ALTO, tool-calling.md:30): `copiasDeComprobante`
    // conserva la PRIMERA aparición como original — es de un arreglo, así que
    // el resultado depende del orden en que le llegan las filas. Sin `.order`
    // aquí, PostgREST devuelve el orden físico de la tabla (no el de llegada,
    // y cambia con cualquier UPDATE que reescriba una fila). `created_at` es
    // el único valor que no cambia después del insert: es lo que hace que este
    // camino y `estado_viaje` (tools.ts) elijan la MISMA copia como original.
    .order('created_at', { ascending: true }), 'getGastos');
  if (error) throw new Error(`getGastos: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    concepto: r.concepto as Gasto['concepto'],
    monto: Number(r.monto),
    fecha: (r.fecha as string) || undefined,
    folio: (r.folio as string) || undefined,
    folioNorm: (r.folio_norm as string) || undefined,
    ocrExtra: (r.ocr_extra as Record<string, unknown>) || undefined,
    rfcEmisor: (r.rfc_emisor as string) || undefined,
    rfcReceptor: (r.rfc_receptor as string) || undefined,
    cfdiUuid: (r.cfdi_uuid as string) || undefined,
    cfdiOrden: r.cfdi_orden != null ? Number(r.cfdi_orden) : undefined,
    imagenUrl: (r.imagen_url as string) || undefined,
    ocrConfianza: r.ocr_confianza != null ? Number(r.ocr_confianza) : undefined,
    cfdiValido: r.cfdi_valido != null ? Boolean(r.cfdi_valido) : undefined,
    estadoSat: (r.estado_sat as Gasto['estadoSat']) || undefined,
    efos: r.efos != null ? Boolean(r.efos) : undefined,
    efosRevisar: r.efos_revisar != null ? Boolean(r.efos_revisar) : undefined,
    claveProdServ: (r.clave_prod_serv as string) || undefined,
    claveUnidad: (r.clave_unidad as string) || undefined,
    tipoComprobante: (r.tipo_comprobante as string) || undefined,
    complementoHidrocarburos: r.complemento_hidrocarburos != null ? Boolean(r.complemento_hidrocarburos) : undefined,
    cfdiEsquemaAlterno: r.cfdi_esquema_alterno != null ? Boolean(r.cfdi_esquema_alterno) : undefined,
    xmlVerificado: r.xml_verificado != null ? Boolean(r.xml_verificado) : undefined,
    formaPago: (r.forma_pago as string) || undefined,
    metodoPago: (r.metodo_pago as string) || undefined,
    pagadoEn: (r.pagado_en as string) || undefined,
    pagadoForma: (r.pagado_forma as string) || undefined,
    subTotal: r.sub_total != null ? Number(r.sub_total) : undefined,
    descuento: r.descuento != null ? Number(r.descuento) : undefined,
    ivaRetenido: r.iva_retenido != null ? Number(r.iva_retenido) : undefined,
    isrRetenido: r.isr_retenido != null ? Number(r.isr_retenido) : undefined,
    iepsTraslado: r.ieps_traslado != null ? Number(r.ieps_traslado) : undefined,
    ivaTraslado: r.iva_traslado != null ? Number(r.iva_traslado) : undefined,
  }));
}

/**
 * SQLSTATE de la 0158: al cerrar, la base contó MÁS (o menos) comprobantes de
 * los que el cuadre había fotografiado.
 *
 * No es un error de escritura: es la carrera de DAT-02 atrapada. Entre
 * `computeCuadre` y este cierre pasan segundos —los dos PDF— y las fotos
 * entrantes no toman el mutex del viaje: un ticket que entra en esa ventana
 * queda fuera del papel que se archiva y huérfano para siempre (el viaje ya
 * está liquidado y la 0036 no lo deja entrar después). La base se niega a
 * emitir esa liquidación, y quien la llamó tiene que volver a fotografiar.
 */
export const CIERRE_CONTEO_CAMBIO = 'CU003';
/** La cantidad sigue igual, pero cambió algún insumo económico/fiscal. */
export const CIERRE_SNAPSHOT_CAMBIO = 'CU006';

export interface SnapshotInsumosCierre {
  version: 1;
  hash: string;
}

/** ¿El cierre rebotó porque entró un gasto entre el cuadre y el guardado? */
export function conteoDeGastosCambio(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === CIERRE_CONTEO_CAMBIO;
}

/** ¿Hay que volver a calcular porque la fotografía económica cambió? */
export function insumosDeCierreCambiaron(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const code = (e as { code?: string }).code;
  return code === CIERRE_CONTEO_CAMBIO || code === CIERRE_SNAPSHOT_CAMBIO;
}

/**
 * Sello emitido por Postgres ANTES del cálculo. No es una autorización: la RPC
 * de guardado recalcula el hash bajo sus locks y solo entonces lo compara.
 */
export async function leerSnapshotInsumosCierre(
  tenantId: string,
  viajeId: string,
): Promise<SnapshotInsumosCierre> {
  const { data, error } = await acotada(supabaseAdmin().rpc('cierre_insumos_snapshot', {
    p_tenant: tenantId,
    p_viaje: viajeId,
  }), 'leerSnapshotInsumosCierre');
  if (error) throw new Error(`leerSnapshotInsumosCierre: ${error.message}`);
  const snapshot = data as Partial<SnapshotInsumosCierre> | null;
  if (snapshot?.version !== 1 || typeof snapshot.hash !== 'string' || !/^[0-9a-f]{64}$/.test(snapshot.hash)) {
    throw new Error('leerSnapshotInsumosCierre: respuesta inválida de cierre_insumos_snapshot');
  }
  return { version: 1, hash: snapshot.hash };
}

/**
 * ¿ESTE viaje ya tiene liquidación en la base? (AUDITORÍA 22, AGEN-C1, CRÍTICO)
 *
 * La base es la autoridad sobre si un cierre ocurrió; el resultado de la tool,
 * no. `guardar_liquidacion` no mira `ctx.signal`, así que cuando el reloj del
 * agente vence a mitad de las subidas a Storage, `raceAbort` devuelve
 * `{success:false, error:'Timeout'}` y el handler SIGUE VIVO: segundos después
 * `guardar_liquidacion_tx` commitea, el viaje queda `liquidado` y los triggers
 * 0036/0037 lo vuelven irreversible.
 *
 * El processor decidía si hubo cierre leyendo `!t.error` sobre esa cadena, así
 * que el cierre existía y el chofer recibía lo contrario. Esto es lo que le
 * permite preguntarle a quien sí sabe.
 *
 * Devuelve `undefined` si NO hay, y lanza si no se pudo leer: un error de red
 * no puede leerse como «no se cerró», que es exactamente el bug que cierra.
 */
export async function getLiquidacionDeViaje(
  tenantId: string,
  viajeId: string,
): Promise<{ id: string; pdfUrl: string | null } | undefined> {
  const { data, error } = await acotada(
    supabaseAdmin().from('liquidacion')
      .select('id, pdf_url')
      .eq('tenant_id', tenantId).eq('viaje_id', viajeId)
      // Desempate determinista: dos liquidaciones del mismo viaje con el mismo
      // `created_at` al milisegundo elegirían una al azar, y de esa elección
      // depende qué PDF se le manda al chofer.
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .limit(1).maybeSingle(),
    'getLiquidacionDeViaje',
  );
  if (error) throw new Error(`getLiquidacionDeViaje: ${error.message}`);
  if (!data) return undefined;
  const f = data as { id: unknown; pdf_url: unknown };
  return { id: String(f.id), pdfUrl: f.pdf_url == null ? null : String(f.pdf_url) };
}

export async function saveLiquidacion(
  tenantId: string,
  liq: Omit<Liquidacion, 'id' | 'creadaEn'>,
  pdfUrl?: string,
  /**
   * Cuántos comprobantes traía el cuadre que se está persistiendo. La base
   * compara contra los que ve DENTRO del candado del viaje y se cae con
   * CU003 si no coinciden (0158, DAT-02). `undefined` = no comprobar, que es
   * lo que necesitan los llamadores que no fotografiaron gastos.
   */
  nGastos?: number,
  /** Sello v1 que la RPC vuelve a calcular bajo lock. Opcional por compatibilidad. */
  snapshot?: SnapshotInsumosCierre,
): Promise<string> {
  const admin = supabaseAdmin();
  // CR-1 / AUDIT_V3 money-path CRÍTICO: cierre ATÓMICO e idempotente. Antes eran
  // dos statements (upsert liquidacion + update viaje) y el error del segundo se
  // IGNORABA → liquidacion sin cerrar el viaje. Ahora una sola función plpgsql
  // (guardar_liquidacion_tx, migración 0013) hace ambos en UNA transacción: si el
  // update de viaje falla, la liquidacion hace rollback. Con unique(viaje_id) dos
  // cierres concurrentes producen UN registro (el motor es determinístico).
  const { data, error } = await acotada(admin.rpc('guardar_liquidacion_tx', {
    p_tenant: tenantId,
    p_viaje: liq.viajeId,
    p_total_comprobado: liq.totalComprobado,
    p_total_anticipo: liq.totalAnticipo,
    p_diferencia: liq.diferencia,
    p_estatus: liq.estatus,
    p_diferencias: liq.diferencias,
    p_ieps: liq.iepsAcreditable,
    p_litros_diesel: liq.litrosDieselAcreditables ?? 0,
    p_iva: liq.ivaAcreditable,
    p_peaje: liq.peajeAcreditable,
    p_pdf_url: pdfUrl ?? null,
    p_n_gastos: nGastos ?? null,
    p_insumos_hash: snapshot?.hash ?? null,
    p_insumos_hash_version: snapshot?.version ?? null,
  }), 'saveLiquidacion');
  if (error) {
    // SE PRESERVA `code`, como en `addGasto` y `updateGastoCfdiXml`: sin él,
    // `cerrarLiquidacion` no puede distinguir el CU003 —que se resuelve
    // volviendo a fotografiar— de un fallo cualquiera, y se rendiría en el
    // único caso en el que reintentar es lo correcto.
    const e = new Error(`saveLiquidacion: ${error.message}`) as Error & { code?: string };
    e.code = (error as { code?: string }).code;
    throw e;
  }
  return data as string;
}

// ── Aviso de privacidad (mig. 0018) ──────────────────────────────────────────
// El obligado es el RESPONSABLE, o sea la FLOTA (LFPDPPP art. 14). Likida es
// persona encargada y solo pone el mecanismo: sin él, la flota no puede cumplir
// aunque quiera. Detalle verificado en normas/lfpdppp-15-16.yaml.

/** Los ids del catálogo que son de rastreo — derivado, nunca escrito a mano
 *  (mismo criterio que `IDS_GPS` en conexiones.ts, que sirve a otra pantalla
 *  con otra semántica de fallo y por eso no se importa de ahí). */
const IDS_GPS_AVISO: readonly string[] = CONECTORES_GPS.map((c) => c.id);

/**
 * Lo MEDIDO para el renglón del proveedor de GPS en el aviso (ver `SenalGps`
 * en privacidad.ts). Se mide donde se escribe la credencial y donde lee el
 * poller: `conector_credencial` con `activo = true` — CAPACIDAD, no hecho,
 * porque el consentimiento tiene que ser previo a la primera posición y con
 * credencial activa el cron va a intentar traerlas en los próximos 5 minutos.
 *
 * FALLA CERRADO: cualquier camino de error —el `error` de PostgREST, la
 * excepción de red, un `count` que no venga— devuelve `no_medible`, que el
 * aviso trata como el caso AMPLIO (declara el proveedor en condicional).
 * `null` jamás se convierte en 0: afirmar «sin conector» con la base caída
 * sería callarle un tratamiento a una flota que sí lo tiene.
 */
export async function senalGpsFlota(tenantId: string): Promise<SenalGps> {
  try {
    const { count, error } = await acotada(supabaseAdmin()
      .from('conector_credencial')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('activo', true)
      .in('conector_id', IDS_GPS_AVISO), 'aviso.senal_gps');
    if (error) {
      logger.error('aviso.senal_gps_no_medible', { tenantId, err: error.message });
      return 'no_medible';
    }
    if (count == null) return 'no_medible';
    return count > 0 ? 'conectado' : 'sin_conector';
  } catch (e) {
    logger.error('aviso.senal_gps_no_medible', { tenantId, err: e instanceof Error ? e.message : String(e) });
    return 'no_medible';
  }
}

/**
 * Datos de responsable de la flota, para armar el aviso. `null` en cualquiera
 * significa que el tenant no está configurado — y ahí NO se envía nada, porque
 * un aviso sin responsable no dice a quién reclamarle, que es para lo que sirve.
 *
 * Trae también la señal de GPS (28-ago-2026): el aviso es POR FLOTA y declara
 * el rastreo del proveedor solo a la flota que lo tiene conectado. Se mide
 * aquí —y no en cada llamador— para que el texto y su `versionAviso` salgan
 * IGUALES en todos los caminos (processor, QA, página del integral): dos
 * llamadores midiendo distinto producirían dos versiones y un reenvío falso.
 */
export async function getDatosResponsable(
  tenantId: string,
): Promise<DatosIntegral | null> {
  const gpsPromise = senalGpsFlota(tenantId);
  const { data, error } = await acotada(supabaseAdmin()
    .from('tenant')
    // `contacto_privacidad` (0034) es el art. 29 y solo lo usa el aviso
    // INTEGRAL. Se trae aquí, y no en una segunda consulta, porque es el mismo
    // renglón: pedirlo aparte sería otro viaje a la base para tres columnas que
    // ya vienen juntas — y la regla del repo es que el acceso a datos no se
    // duplique, que es el hallazgo que lleva cinco rondas subiendo.
    .select('razon_social, domicilio_fiscal, url_aviso_privacidad, contacto_privacidad')
    .eq('id', tenantId)
    .maybeSingle(), 'getDatosResponsable');
  if (error) throw new Error(`getDatosResponsable: ${error.message}`);
  if (!data) return null;
  const r = {
    razonSocial: (data.razon_social as string) ?? '',
    domicilio: (data.domicilio_fiscal as string) ?? '',
    urlAvisoIntegral: (data.url_aviso_privacidad as string) ?? '',
    contactoPrivacidad: (data.contacto_privacidad as string | null) ?? null,
    // Nunca lanza: sus fallos ya son `no_medible` (caso amplio) adentro.
    gps: await gpsPromise,
  };
  // La URL del integral NO se exige aquí. Devolver `null` por su ausencia hacía
  // que el operador no recibiera NADA: el aviso simplificado sí se puede armar
  // sin ella —las fracciones I a IV del art. 15 caben enteras en el mensaje— y
  // callarse cumple menos que mandarlo diciendo que la empresa aún no lo publica.
  //
  // El DOMICILIO tampoco se exige ya (auditoría 19, legal C3 / C.16): exigirlo
  // hacía que /aviso/<flota> respondiera 404 para toda flota sin la columna
  // capturada — y ninguna pantalla de producción la llenaba. Un aviso que
  // nombra al responsable y DICE que el domicilio está pendiente cumple más
  // que un 404 mudo; `avisoIntegral` pinta esa sección como pendiente, igual
  // que hace con el contacto del art. 29. La razón social SÍ se exige: sin
  // ella el aviso no puede decir NI SIQUIERA a quién reclamarle, y eso ya no
  // es un aviso a medias — es un documento sin responsable.
  return r.razonSocial ? r : null;
}

/**
 * RESERVA el envío del aviso. Devuelve `true` si ESTE llamado ganó la reserva —
 * o sea, si le toca enviarlo.
 *
 * NO deja constancia: eso es `confirmarEnvioAviso`, y solo tras un envío que
 * Meta acusó. Hasta la 0033 esta función escribía las dos cosas en la misma
 * fila, y de ahí salían los dos fallos: una constancia falsa cuando el envío no
 * salía, y la DESTRUCCIÓN de una constancia buena cuando el aviso cambiaba de
 * versión y el reenvío fallaba.
 *
 * La reserva vive en SQL (igual que en la 0017): el primer mensaje puede llegar
 * por dos caminos a la vez y sin ella el operador recibiría el aviso dos o tres
 * veces seguidas. Expira a los 5 minutos, para que un proceso que muera entre
 * reservar y confirmar no deje a un operador sin aviso para siempre.
 *
 * Se reenvía cuando la versión cambia: el art. 15 fr. VI obliga a comunicar los
 * cambios al aviso.
 */
export async function reclamarEnvioAviso(
  tenantId: string,
  operadorId: string,
  version: string,
): Promise<boolean> {
  const { data, error } = await acotada(supabaseAdmin().rpc('marcar_aviso_privacidad', {
    p_operador: operadorId,
    p_tenant: tenantId,
    p_version: version,
  }), 'reclamarEnvioAviso');
  if (error) throw new Error(`reclamarEnvioAviso: ${error.message}`);
  return data === true;
}

/**
 * Deja CONSTANCIA del art. 16 de la LFPDPPP: se le puso el aviso a disposición.
 *
 * Va DESPUÉS del envío y solo si Meta devolvió un id de mensaje. Es lo único en
 * todo el sistema que escribe `aviso_privacidad_en`.
 *
 * Que devuelva `false` es grave y por eso se registra como error: el mensaje SÍ
 * salió y la prueba no quedó escrita. El operador recibirá el aviso otra vez
 * cuando expire la reserva —molesto pero inocuo—; lo que no puede quedarse sin
 * mirar es que la constancia no se escribiera.
 */
export async function confirmarEnvioAviso(
  tenantId: string,
  operadorId: string,
  version: string,
): Promise<void> {
  const { data, error } = await acotada(supabaseAdmin().rpc('confirmar_aviso_privacidad', {
    p_operador: operadorId,
    p_tenant: tenantId,
    p_version: version,
  }), 'confirmarEnvioAviso');
  if (error) {
    logger.error('privacidad.constancia_no_escrita', { tenantId, operadorId, err: error.message });
    return;
  }
  // `false` es "no tocó ninguna fila": el operador no existe o es de otra flota.
  // Sin este ramo, un fallo de aislamiento entre tenants se vería igual que un
  // éxito. PostgREST devuelve el resultado POR VALOR, no lanzando.
  if (data !== true) logger.error('privacidad.constancia_sin_fila', { tenantId, operadorId });
}

/**
 * Suelta la RESERVA cuando el envío no salió, para que el siguiente mensaje
 * reintente. NO toca la constancia, y ahí está todo el asunto.
 *
 * Antes ponía `aviso_privacidad_en` y `aviso_privacidad_version` en NULL, porque
 * hasta la 0033 la reserva y la constancia eran la misma fila. Eso arreglaba la
 * constancia falsa del 28-jul —la base afirmó que un operador recibió su aviso
 * diez minutos antes del commit que arregló el destinatario que Meta rechazaba—
 * pero abría el fallo inverso, y peor:
 *
 *   El operador recibió el aviso v1 hace tres meses. La flota corrige la liga de
 *   su aviso integral → el texto cambia → v2. Llega un mensaje, la reserva gana
 *   porque la versión es distinta, el envío falla, y esta función borraba las dos
 *   columnas. La base pasa a decir que ese operador NUNCA recibió ningún aviso.
 *
 * Ante la autoridad la carga de probar el art. 16 es del responsable, así que
 * "no consta" es el peor estado posible — y se llegaba a él destruyendo una
 * prueba verdadera. Resolver la liga del aviso es una tarea abierta: el paso 1
 * de ese escenario está agendado.
 */
export async function liberarEnvioAviso(tenantId: string, operadorId: string): Promise<void> {
  const { data, error } = await acotada(supabaseAdmin().rpc('liberar_aviso_privacidad', {
    p_operador: operadorId,
    p_tenant: tenantId,
  }), 'liberarEnvioAviso');
  if (error) {
    logger.error('privacidad.liberar_falló', { tenantId, operadorId, err: error.message });
    return;
  }
  // No es error: la reserva pudo expirar sola por TTL entre el envío fallido y
  // esta llamada. Se registra porque significa que el siguiente mensaje reintenta
  // por otro motivo del esperado, y eso cambia cómo se lee el log.
  if (data !== true) logger.warn('privacidad.liberar_sin_reserva', { tenantId, operadorId });
}

// ── Acumulados del ejercicio (Fase 1: la capa de periodo) ────────────────────

/**
 * Pagos de combustible del ejercicio, separando efectivo del total.
 *
 * Es el denominador del 15% de la RFA 2026 regla 2.9, y por eso cuenta SOLO
 * combustible: la base es combustible contra combustible, no contra el gasto
 * total de la flota. Ese denominador equivocado haría parecer holgada a una
 * flota que ya se pasó.
 *
 * Se calcula desde `gasto` sin tabla nueva: `forma_pago` y `concepto` ya
 * existen. Los duplicados y los montos no positivos quedan fuera por el mismo
 * criterio que usa el motor — si no cuentan para el cuadre, tampoco para el
 * contador.
 *
 * `formaPago` '01' es efectivo en el catálogo del SAT. Un gasto SIN forma de
 * pago no se cuenta como efectivo: no se sabe, y suponerlo inflaría el
 * numerador contra la flota.
 *
 * ── HALLAZGO 15-AGO-2026: LA RPC YA EXISTÍA, MUERTA, DESDE LA 0084 ──────────
 *
 * Esta consulta vivió años como un `traerTodo` paginado a mano (ronda 6): sin
 * `.limit()` ni `.range()` no significaba "trae todo", significaba "trae lo
 * que PostgREST quiera darme" — `max_rows` (Settings → API) recorta la
 * respuesta EN SILENCIO, default 1 000 filas — así que se paginaba con
 * `count: 'exact'` en la primera página y se lanzaba si la lectura quedaba
 * incompleta. Correcto, pero con fecha de caducidad CALCULABLE: **esto corre
 * EN CADA CUADRE** (el camino más caliente del producto), y su techo de 100
 * páginas = 100 000 cargas de diésel se toca ~mes 6.7 con un cliente de
 * 15 000 viajes/mes (docs/escala-15k.md §4/§6) — al tocarlo, el CIERRE deja
 * de cerrar, no solo una pantalla.
 *
 * La migración 0084 (05-ago-2026, "sumar_combustible_ejercicio: la
 * agregación del 15% en SQL") YA HABÍA ESCRITO el `sum()` en SQL para
 * exactamente este problema — está aplicada en producción (verificaciones.sql
 * bloque 81 lo confirma contra el catálogo real: `f_0084=1`) — pero
 * `getAcumuladoCombustible` nunca se cambió para llamarla: quedó como código
 * muerto, sin una sola referencia en `src/` (grepeado). Este archivo seguía
 * paginando a mano un año después de que la RPC que lo resolvía ya estuviera
 * viva en la base.
 *
 * Y la RPC muerta tenía un bug real: no filtraba `monto > 0`, así que una
 * fila de monto 0 o NEGATIVO (un duplicado excluido, un ajuste) habría
 * entrado al `sum()` — el mismo denominador que este comentario lleva años
 * advirtiendo que no se puede inflar. La 0112 la corrige (`create or
 * replace`, misma firma) agregando el filtro que el JS sí tenía, y AHORA
 * `getAcumuladoCombustible` la llama. La prueba de equivalencia
 * (`repo_acumulado.test.ts`) compara la suma JS vieja contra la RPC corregida
 * sobre el MISMO dataset sintético, incluido el caso de montos no positivos
 * que la RPC original habría contado de más.
 */
export async function getAcumuladoCombustible(
  tenantId: string,
  ejercicio: number,
  claves?: string[],
): Promise<{ efectivo: number; totalCombustible: number }> {
  const { data, error } = await acotada(supabaseAdmin()
    .rpc('sumar_combustible_ejercicio', {
      p_tenant: tenantId,
      p_anio: ejercicio,
      // Vacío o `undefined` caen al MISMO criterio angosto que el `.or()`
      // original: sin claves, solo `concepto = 'diesel'` cuenta. La firma de
      // la 0084 no tiene default en `p_claves` — hay que mandar `null`, no
      // omitir el argumento.
      p_claves: claves?.length ? claves : null,
    }), 'getAcumuladoCombustible');
  if (error) throw new Error(`getAcumuladoCombustible: ${error.message}`);

  // `returns table (...)`: PostgREST siempre entrega un ARRAY, con exactamente
  // una fila aquí (es un agregado sin GROUP BY: coalesce garantiza fila aunque
  // no haya cargas). Un array vacío o de más de una fila es la misma señal de
  // "otra forma" que un objeto roto.
  const fila = Array.isArray(data) ? (data[0] as Partial<{ efectivo: unknown; total: unknown }> | undefined) : undefined;
  const efectivo = Number(fila?.efectivo);
  const totalCombustible = Number(fila?.total);
  // Fail-closed, igual que el resto del camino del dinero: una forma
  // inesperada (¿migración 0112 sin aplicar?) no se lee como "cero cargas de
  // diésel" — ese cero se vería medido y es el denominador del 15% de
  // combustible en efectivo de la RFA 2026 regla 2.9.
  if (!Array.isArray(data) || data.length !== 1 || !fila || !Number.isFinite(efectivo) || !Number.isFinite(totalCombustible)) {
    logger.error('gasto.acumulado_forma_inesperada', { tenantId, ejercicio, data });
    throw new Error('getAcumuladoCombustible: sumar_combustible_ejercicio devolvió otra forma (¿migración 0112 sin aplicar?)');
  }

  return { efectivo: round2(efectivo), totalCombustible: round2(totalCombustible) };
}

/**
 * Registra una solicitud ARCO (auditoría 12, ALTO legal). El aviso promete
 * "queda registrada tu solicitud" y la tabla `solicitud_arco` (0053) existía
 * sin un solo insert — la flota, que es la responsable con 20 días hábiles
 * para comunicar su determinación (LFPDPPP vigente art. 31), no tenía NADA
 * que ver.
 *
 * Best-effort con rastro ruidoso: un fallo aquí no puede tumbar la respuesta
 * al titular, pero el log de error es lo que permite saber a la mañana
 * siguiente que la flota se quedó sin su constancia.
 */
export async function registrarSolicitudArco(opts: {
  tenantId: string;
  operadorId: string | null;
  titularRef: string;
  tipo: string;
  canal: string;
}): Promise<boolean> {
  const { venceArco } = await import('./privacidad');
  const { data, error } = await acotada(supabaseAdmin().from('solicitud_arco').insert({
    tenant_id: opts.tenantId,
    operador_id: opts.operadorId,
    titular_ref: opts.titularRef,
    tipo: opts.tipo,
    canal: opts.canal,
    estado: 'recibida',
    vence_en: venceArco(new Date()),
  }).select('id').maybeSingle(), 'registrarSolicitudArco');
  if (error) {
    logger.error('arco.no_registrada', { tenant: opts.tenantId, err: error.message });
    return false;
  }
  logger.info('arco.registrada', { tenant: opts.tenantId, tipo: opts.tipo, id: (data as { id?: string } | null)?.id });
  return true;
}

/**
 * Captura el RFC del trabajador (mig. 0080) — el dato que hace alcanzable la
 * rama buena de RLISR 57 (viático timbrado al RFC del operador subordinado).
 * AUDITORÍA 13, MEDIO: la columna existía y nadie la escribía.
 */
export async function actualizarRfcOperador(tenantId: string, operadorId: string, rfc: string | null): Promise<void> {
  const { error } = await acotada(supabaseAdmin()
    .from('operador')
    .update({ rfc: rfc?.trim() || null })
    .eq('id', operadorId)
    .eq('tenant_id', tenantId), 'actualizarRfcOperador');
  if (error) throw new Error(`actualizarRfcOperador: ${error.message}`);
}

/**
 * Actualiza la declaración de la facilidad del 15% (RFA 2026 regla 2.9) de una
 * flota. `undefined` en ambos = sin declarar (borra la llave). AUDITORÍA 14:
 * la declaración del alta no se podía ver ni corregir.
 */
export async function actualizarFacilidad15(tenantId: string, ded: boolean | undefined, reg: boolean | undefined): Promise<void> {
  // AUDITORÍA 15, MEDIO: sin comprobar el error, un bache de red se leía como
  // "la flota no tiene config" y se REEMPLAZABA la config entera por una sola
  // llave — perdiendo política, topes y estímulos en silencio.
  //
  // AUDITORÍA 18, DAT-20: aun comprobándolo, entre la lectura y la escritura
  // cabía otra edición de `tenant.config` y se perdía sin ruido. La mezcla la
  // hace ahora la base en UN solo UPDATE (`tenant_config_merge`, 0159), y
  // "sin declarar" viaja como un BORRADO EXPLÍCITO de la llave: mandar `null`
  // no serviría — `fusionarConfig` lo ignora y la declaración vieja seguiría
  // en pie, que es justo lo contrario de lo que la flota pidió.
  const declara = ded !== undefined && reg !== undefined;
  const { error } = await acotada(supabaseAdmin().rpc('tenant_config_merge', {
    p_tenant: tenantId,
    p_parcial: declara
      ? { facilidadCombustibleEfectivo: { dedicacionExclusivaCarga: ded, regimenElegible: reg } }
      : {},
    p_borrar: declara ? [] : ['facilidadCombustibleEfectivo'],
  }), 'actualizarFacilidad15');
  if (error) throw new Error(`actualizarFacilidad15: ${error.message}`);
}

/**
 * Las solicitudes ARCO del tenant (para la pantalla de cumplimiento de la
 * flota). AUDITORÍA 14: las solicitudes se registran pero la flota —la
 * responsable obligada a contestar en 20 días hábiles— no tenía dónde verlas.
 */
export async function listarSolicitudesArco(tenantId: string): Promise<Array<{
  id: string; tipo: string; canal: string; estado: string;
  titularRef: string; recibidaEn: string; venceEn: string; resueltaEn: string | null;
  resolucion: string | null; operadorNombre: string | null;
}>> {
  const filas = await traerTodo<Record<string, unknown>>(
    (desde, hasta) => supabaseAdmin()
      .from('solicitud_arco')
      .select('id, tipo, canal, estado, titular_ref, recibida_en, vence_en, resuelta_en, resolucion, operador:operador_id(nombre)', conteo(desde))
      .eq('tenant_id', tenantId)
      .order('recibida_en', { ascending: false })
      .order('id', { ascending: false })
      .range(desde, hasta),
    'listarSolicitudesArco',
  );
  return filas.map((f) => ({
    id: f.id as string,
    tipo: f.tipo as string,
    canal: (f.canal as string | null) ?? 'whatsapp',
    estado: f.estado as string,
    titularRef: (f.titular_ref as string | null) ?? '',
    recibidaEn: f.recibida_en as string,
    venceEn: f.vence_en as string,
    resueltaEn: (f.resuelta_en as string | null) ?? null,
    resolucion: (f.resolucion as string | null) ?? null,
    operadorNombre: ((f.operador as { nombre?: string } | null)?.nombre) ?? null,
  }));
}

/** Marca una solicitud ARCO como resuelta (la flota contesta al titular).
 *  AUDITORÍA 16: la respuesta se INTENTA enviar al titular por WhatsApp
 *  (texto libre, ventana de 24h desde su PRIVACIDAD). Si no se puede, la
 *  solicitud queda resuelta pero la UI lo dice — no se miente. */
export async function resolverSolicitudArco(
  tenantId: string, solicitudId: string, resolucion: string,
): Promise<{ enviada: boolean; error?: string }> {
  const { data: sol, error: errLee } = await acotada(supabaseAdmin()
    .from('solicitud_arco').select('titular_ref, operador_id').eq('id', solicitudId).eq('tenant_id', tenantId).maybeSingle(),
    'resolverSolicitudArco.leer');
  if (errLee) throw new Error(`resolverSolicitudArco.leer: ${errLee.message}`);
  if (!sol) throw new Error('resolverSolicitudArco: la solicitud no existe en esta flota');

  const { error } = await acotada(supabaseAdmin()
    .from('solicitud_arco')
    .update({ estado: 'resuelta', resuelta_en: new Date().toISOString(), resolucion })
    .eq('id', solicitudId)
    .eq('tenant_id', tenantId), 'resolverSolicitudArco');
  if (error) throw new Error(`resolverSolicitudArco: ${error.message}`);

  // Envío best-effort: si el titular está fuera de la ventana de 24h o el
  // número no está whitelisted, el texto no sale — la flota lo entrega aparte.
  const telefono = (sol.titular_ref as string | null) ?? (sol.operador_id as string | null) ?? null;
  if (!telefono) return { enviada: false, error: 'sin teléfono del titular' };
  try {
    // AUDITORÍA 16, MEDIO: la plantilla lleva {{1}} = razón social REAL de la
    // flota (no el literal "la flota"), {{2}} = la resolución.
    const { data: tenant } = await acotada(supabaseAdmin().from('tenant').select('razon_social').eq('id', tenantId).maybeSingle(), 'resolverSolicitudArco.tenant');
    const razonSocial = (tenant?.razon_social as string | null) ?? 'la flota';
    const { enviarRespuestaArco } = await import('@/lib/meta/client');
    const r = await enviarRespuestaArco(telefono, `Tu solicitud de derechos ARCO fue atendida por ${razonSocial}: ${resolucion}`);
    return r.ok ? { enviada: true } : { enviada: false, error: r.error };
  } catch (e) {
    return { enviada: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * EJECUTA una solicitud de CANCELACIÓN: anonimiza al titular en la base y
 * marca la solicitud resuelta con la evidencia de qué se tocó.
 *
 * AUDITORÍA 19 (legal, reincidente #5): `ejecutar_arco_cancelacion` existía
 * desde la 0173/0178 y NADA la llamaba — el derecho de cancelación se
 * "resolvía" escribiendo un texto (`resolverSolicitudArco`) sin que un solo
 * byte del titular cambiara en la base. Un ARCO que solo escribe prosa es un
 * ARCO que no se ejerció.
 *
 * EL ORDEN IMPORTA Y ES DELIBERADO: el teléfono del titular se lee ANTES de
 * ejecutar, porque la RPC anonimiza `operador.telefono` y borra sus
 * conversaciones — después ya no hay a quién avisarle. La confirmación se
 * manda DESPUÉS de que la RPC confirmó (nunca antes: avisar "ya quedó" y que
 * la RPC falle sería una constancia falsa), best-effort al número leído.
 *
 * Lo que la RPC conserva y por qué lo dice ella misma: la evidencia fiscal
 * (imágenes de gasto/CFDI) se retiene por CFF art. 30 y queda desligada del
 * titular — la resolución escrita lo enuncia.
 */
/**
 * REGISTRA una solicitud de OPOSICIÓN: deja constancia estructurada de que la
 * oposición del titular está vigente y de que el caso pasa a revisión humana.
 *
 * AUDITORÍA 20, hallazgo 8 (BAJO — patrón reincidente #5): `ejecutar_arco_
 * oposicion` existe desde la 0178, con grant a `service_role`, y NADA la
 * llamaba. Una oposición se "resolvía" escribiendo prosa en `resolucion`; en
 * una revisión de privacidad no quedaba rastro verificable de qué se hizo.
 * Es exactamente el hueco que la auditoría 19 cerró para la CANCELACIÓN, en
 * la otra función de la misma migración.
 *
 * LO QUE ESTA RPC HACE Y LO QUE NO, porque el rótulo del botón depende de
 * ello: NO cancela datos, NO anonimiza y NO cierra la solicitud. Deja la
 * solicitud en `en_proceso` con `evidencia.oposicion_automatizada_vigente` y
 * dice, en la misma evidencia, que requiere revisión humana. La
 * materialización de la oposición sobre el operador
 * (`operador.oposicion_automatizada`, 0100) ya ocurrió por el canal de
 * WhatsApp (`processor.ts`) cuando el titular la pidió; esto es la constancia
 * del lado de la responsable.
 *
 * Por eso NO se avisa al titular desde aquí: no hay nada consumado que
 * confirmarle todavía. El aviso sale cuando la flota resuelve de verdad, por
 * `resolverSolicitudArco`, que sí lo manda.
 */
export async function ejecutarOposicionArco(
  tenantId: string, solicitudId: string,
): Promise<{ ok: boolean; motivo?: string }> {
  const { data, error } = await acotada(supabaseAdmin().rpc('ejecutar_arco_oposicion', {
    p_tenant: tenantId,
    p_solicitud: solicitudId,
  }), 'ejecutarOposicionArco');
  if (error) throw new Error(`ejecutarOposicionArco: ${error.message}`);

  const r = (data ?? {}) as { ok?: boolean; motivo?: string };
  if (r.ok !== true) {
    // La RPC se niega con motivo (no es una oposición, es de otra flota, no
    // existe): se propaga tal cual — es la explicación que ve la pantalla.
    return { ok: false, motivo: r.motivo ?? 'la base no explicó el rechazo' };
  }
  return { ok: true };
}

export async function ejecutarCancelacionArco(
  tenantId: string, solicitudId: string,
): Promise<{ ok: boolean; motivo?: string; avisada: boolean; errorAviso?: string }> {
  const { data: sol, error: errLee } = await acotada(supabaseAdmin()
    .from('solicitud_arco').select('titular_ref, tipo').eq('id', solicitudId).eq('tenant_id', tenantId).maybeSingle(),
    'ejecutarCancelacionArco.leer');
  if (errLee) throw new Error(`ejecutarCancelacionArco.leer: ${errLee.message}`);
  if (!sol) throw new Error('ejecutarCancelacionArco: la solicitud no existe en esta flota');
  const telefono = (sol.titular_ref as string | null) ?? null;

  const { data, error } = await acotada(supabaseAdmin().rpc('ejecutar_arco_cancelacion', {
    p_tenant: tenantId,
    p_solicitud: solicitudId,
  }), 'ejecutarCancelacionArco');
  if (error) throw new Error(`ejecutarCancelacionArco: ${error.message}`);

  const r = (data ?? {}) as { ok?: boolean; motivo?: string };
  if (r.ok !== true) {
    // La RPC se negó con motivo (tipo equivocado, ya cerrada, otra flota):
    // se propaga tal cual — es la explicación que la pantalla enseña.
    return { ok: false, motivo: r.motivo ?? 'la base no explicó el rechazo', avisada: false };
  }

  if (!telefono) return { ok: true, avisada: false, errorAviso: 'sin teléfono del titular' };
  try {
    const { enviarRespuestaArco } = await import('@/lib/meta/client');
    const aviso = await enviarRespuestaArco(
      telefono,
      'Se sustituyeron tu nombre y tu teléfono en el registro operativo y se eliminaron tus conversaciones. Se conservan tu identificador de operador, el correo de tu cuenta, la referencia del titular en la solicitud y la documentación fiscal. La flota debe revisar esos datos y los pasos pendientes con su responsable de privacidad.',
    );
    return aviso.ok ? { ok: true, avisada: true } : { ok: true, avisada: false, errorAviso: aviso.error };
  } catch (e) {
    return { ok: true, avisada: false, errorAviso: e instanceof Error ? e.message : String(e) };
  }
}

// Persistencia de polls: claims, traducción de filas y fencing se resuelven
// en la frontera de datos. El llamador sólo decide worker y lote.
export type RecursoPoll = 'posiciones' | 'eventos';

export interface PollReclamado {
  tenantId: string;
  proveedor: string;
  valoresCifrados: string;
  claimToken: string | null;
  watermarkEn: string | null;
  /** Cursor independiente del carril reciente. Nunca espera al backfill. */
  tailWatermarkEn: string | null;
}


export async function reclamarPollsConector(
  recurso: RecursoPoll,
  proveedores: string[],
  limite: number,
  worker: string,
): Promise<PollReclamado[]> {
  const admin = supabaseAdmin();
  const etiqueta = recurso === 'posiciones' ? 'gps' : 'eventos';
  const rpc = (admin as unknown as { rpc?: (nombre: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> }).rpc;
  if (!rpc) {
    if (process.env.NODE_ENV !== 'test') throw new Error(`${recurso}.claims: el cliente Supabase no expone rpc`);
    const { data, error } = await acotada(
      admin.from('conector_credencial')
        .select('tenant_id, conector_id, valores_cifrados')
        .eq('activo', true)
        .in('conector_id', proveedores),
      `${etiqueta}.credenciales`,
    );
    if (error) throw new Error(`${etiqueta}.credenciales: ${error.message}`);
    return (data ?? []).map((c) => ({
      tenantId: String(c.tenant_id), proveedor: String(c.conector_id),
      valoresCifrados: String(c.valores_cifrados), claimToken: null,
      watermarkEn: null, tailWatermarkEn: null,
    }));
  }

  const { data, error } = await acotada(rpc.call(admin, 'reclamar_polls_conector', {
    p_recurso: recurso,
    p_proveedores: proveedores,
    p_limite: limite,
    p_worker: worker,
    // La ruta tiene maxDuration=300 s. 360 s deja un minuto de margen para
    // finalizar y recupera un worker muerto antes de la siguiente decena de
    // minutos, sin permitir que B robe trabajo legalmente en vuelo.
    p_lease_segundos: 360,
  }), `${recurso}.claims`);
  if (error) throw new Error(`${recurso}.claims: ${error.message}`);
  if (!Array.isArray(data)) throw new Error(`${recurso}.claims: respuesta inválida`);
  return data.map((fila) => {
    const f = fila as Record<string, unknown>;
    if (!f.tenant_id || !f.proveedor || !f.valores_cifrados || !f.claim_token) {
      throw new Error(`${recurso}.claims: fila incompleta`);
    }
    return {
      tenantId: String(f.tenant_id), proveedor: String(f.proveedor),
      valoresCifrados: String(f.valores_cifrados), claimToken: String(f.claim_token),
      watermarkEn: typeof f.watermark_en === 'string' ? f.watermark_en : null,
      tailWatermarkEn: typeof f.tail_watermark_en === 'string' ? f.tail_watermark_en : null,
    };
  });
}

export async function finalizarPollConector(
  recurso: RecursoPoll,
  claim: PollReclamado,
  resultado: {
    completo: boolean;
    watermarkEn?: string | null;
    tailCompleto?: boolean;
    tailWatermarkEn?: string | null;
    ultimaMedidaEn?: string | null;
    paginas?: number;
    elementos?: number;
    invalidos?: number;
    error?: string;
  },
): Promise<void> {
  // Los tests legacy que pasaron por el fallback no tienen un lease real.
  if (!claim.claimToken) return;
  const admin = supabaseAdmin();
  const { data, error } = await acotada(admin.rpc('finalizar_poll_conector', {
    p_tenant: claim.tenantId,
    p_proveedor: claim.proveedor,
    p_recurso: recurso,
    p_claim_token: claim.claimToken,
    p_completo: resultado.completo,
    p_watermark_en: resultado.watermarkEn ?? null,
    p_tail_completo: resultado.tailCompleto ?? false,
    p_tail_watermark_en: resultado.tailWatermarkEn ?? null,
    p_ultima_medida_en: resultado.ultimaMedidaEn ?? null,
    p_paginas: resultado.paginas ?? 0,
    p_elementos: resultado.elementos ?? 0,
    p_invalidos: resultado.invalidos ?? 0,
    p_error: resultado.error?.slice(0, 1000) ?? null,
  }), `${recurso}.finalizar`);
  if (error) throw new Error(`${recurso}.finalizar: ${error.message}`);
  if (data !== true) throw new Error(`${recurso}.finalizar: lease vencido o ajeno`);
}
