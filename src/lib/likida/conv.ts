// Resolución de operador por teléfono + estado de conversación WhatsApp.
// El estado (últimos turnos + viaje activo) vive en wa_conversacion.estado jsonb.

import { TZ_MX } from '@/lib/formato';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/lib/agents/types';
import { randomUUID } from 'crypto';
import { acotada, PRESUPUESTO_WEBHOOK_MS } from './presupuesto';
import { violaIndice } from './pg_errores';
import { destinatarioEnmascarado } from '@/lib/meta/client';

export interface ResolvedOperador {
  tenantId: string;
  operadorId: string;
  nombre: string;
  telefono: string;
}

export interface ConvTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * LO QUE LA CONVERSACIÓN RECUERDA ADEMÁS DE LOS TURNOS.
 *
 * Viven en el MISMO jsonb (`wa_conversacion.estado`) y se descartan junto con
 * los turnos cuando cambia el viaje: son estado de ESTA charla sobre ESTE
 * viaje, no del viaje —el viaje tiene sus propias columnas—.
 *
 * ── POR QUÉ NO SE DEDUCEN DEL TEXTO ──────────────────────────────────────
 *
 * Las dos cosas que el pipeline necesita recordar entre mensajes se deducían
 * leyendo el TEXTO de los turnos con un regex. Un regex se desincroniza del
 * texto en cuanto alguien lo edita, y eso YA PASÓ: el contador de intentos de
 * confirmación era
 *
 *     turns.filter(t => t.role === 'assistant' && /confirma|¿cu[áa]l de|arranco/i.test(t.content))
 *
 * y esa expresión no empata con NINGUNO de los mensajes que `inicio_viaje.ts`
 * manda de verdad ("¿Arrancas este viaje?", "✅ Va, arrancamos:", "Sí, pero
 * ¿cuál? Traes 2."). El contador valía 1 para siempre, el freno del segundo
 * intento era inalcanzable, y el chofer recibía "Perdón, no te entendí" sin
 * final. Un número contado por su cuenta no se puede romper editando una frase.
 */
export interface MarcasConversacion {
  /**
   * Cuántas veces se le ha preguntado ya CUÁL viaje arranca.
   *
   * `decidirInicio` es puro y no tiene memoria: sin este número, "se repregunta
   * UNA vez" no se puede cumplir.
   */
  intentosConfirmacion?: number;
  /**
   * Ya se le advirtió que iba a cerrar SIN comprobantes y aun así insistió.
   *
   * Es lo que hace que el freno del cierre pregunte una vez y no se convierta
   * en el mismo bucle que ya costó el hallazgo de arriba.
   */
  cierreSinComprobantes?: boolean;
}

/**
 * Las formas en que el MISMO número mexicano puede llegar desde WhatsApp.
 *
 * México arrastra el "1" que Telmex metió entre la lada de país y el número de
 * celular. WhatsApp lo dejó de usar en 2020 para los `wa_id` nuevos, pero sigue
 * apareciendo: el mismo teléfono llega como `529993700779` o como
 * `5219993700779` según por dónde entre, y la búsqueda del operador es una
 * igualdad exacta contra la columna.
 *
 * El modo de fallo es el peor de todos para depurar: el sistema contesta
 * "no te tengo registrado" —una frase que suena a dato mal capturado— cuando el
 * operador SÍ está dado de alta y lo único que sobra es un dígito. Y como el
 * mensaje es amable y el webhook devolvió 200, nada en los logs dice "error".
 *
 * Se generan las variantes en vez de normalizar a una sola forma porque la
 * columna ya puede tener cualquiera de las dos: hay flotas capturadas a mano.
 * Aquí no se decide cuál es la buena, se aceptan las dos.
 *
 * Y el "+" es el mismo problema con otra cara, encontrado en la propia semilla
 * del demo: los operadores están guardados como `+521111111101` mientras que
 * Meta manda el `wa_id` sin signo (`521111111101`). Con la igualdad exacta que
 * había, NINGUNO de los operadores de demostración habría resuelto nunca.
 */
export function variantesTelefono(telefono: string): string[] {
  const limpio = telefono.replace(/[^\d]/g, '');
  const nums = new Set<string>([limpio]);
  // 52 + 1 + 10 dígitos → también sin el 1.
  const con1 = /^521(\d{10})$/.exec(limpio);
  if (con1) nums.add(`52${con1[1]}`);
  // 52 + 10 dígitos → también con el 1.
  const sin1 = /^52(\d{10})$/.exec(limpio);
  if (sin1) nums.add(`521${sin1[1]}`);
  // AUDITORÍA FABLE CICLO 4 (c4-4): la forma NACIONAL de 10 dígitos — lo que
  // el placeholder de captura invita a teclear ("10 dígitos"). El wa_id de
  // Meta siempre trae lada de país, así que el gruero capturado como
  // `5512345678` no matcheaba ninguna variante y recibía "no te tengo
  // registrado" con su cotización en la mano. Las dos direcciones:
  if (con1) nums.add(con1[1]);
  if (sin1) nums.add(sin1[1]);
  const nacional = /^(\d{10})$/.exec(limpio);
  if (nacional) { nums.add(`52${nacional[1]}`); nums.add(`521${nacional[1]}`); }
  // Cada forma, con y sin "+": la columna tiene una y el webhook trae la otra.
  const vistas = new Set<string>([telefono]);
  for (const n of nums) { vistas.add(n); vistas.add(`+${n}`); }
  return [...vistas];
}


/** Resuelve el operador (y su flota) por número de WhatsApp. */
export async function resolveOperador(telefono: string): Promise<ResolvedOperador | null> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('operador')
    .select('id, tenant_id, nombre, telefono')
    .in('telefono', variantesTelefono(telefono))
    .eq('activo', true)
    // DOS, no una. `.limit(1)` recortaba ANTES de que `maybeSingle()` mirara, así
    // que ante dos filas no fallaba: devolvía una arbitraria —sin `order by`— y
    // con ella se decidía el `tenant_id` con el que se escriben el gasto y la
    // liquidación. En un producto multi-tenant eso es dinero de una flota
    // anotado en la de otra, y en silencio.
    //
    // Esta función es la que DETERMINA el tenant, así que no puede filtrar por
    // él: lo único correcto ante la ambigüedad es negarse.
    .limit(2), 'resolveOperador');
  // "No está dado de alta" y "no pude preguntar" NO son lo mismo, y `error || !data`
  // los volvía la misma cosa. Con un fallo transitorio de Supabase, un operador que
  // SÍ existe recibía "no te tengo registrado" —una frase que suena a dato mal
  // capturado— y no quedaba una sola línea en el log. Es la misma confusión que ya
  // se corrigió en el diagnóstico de migraciones el 28-jul; vivía aquí también.
  //
  // Sin respuesta no se afirma nada: se lanza, y el llamador decide qué decirle al
  // operador. `null` queda reservado para lo que de verdad significa: no existe.
  if (error) throw new ConsultaFallida(`operador por teléfono: ${error.message}`);
  const filas = data ?? [];
  if (filas.length === 0) return null;
  if (filas.length > 1) {
    // Se registra con los tenants implicados: es lo único que permite arreglar el
    // dato. No se elige uno "por si acaso" — adivinar aquí escribe dinero en la
    // flota equivocada y nadie lo nota hasta la conciliación.
    logger.error('operador.ambiguo', {
      // Enmascarado (SEG-7): el redactor del logger solo cacha los dígitos
      // pegados, y este teléfono viene de la base tal como se capturó. Los
      // cuatro últimos alcanzan para encontrar las filas que hay que arreglar
      // —los ids de operador van completos aquí al lado—, y ninguna alerta
      // vale filtrar el número entero de un chofer.
      para: destinatarioEnmascarado(telefono),
      tenants: [...new Set(filas.map((f) => f.tenant_id as string))],
      operadores: filas.map((f) => f.id as string),
    });
    throw new OperadorAmbiguo(`el teléfono ${telefono} corresponde a más de un operador activo`);
  }
  const fila = filas[0];
  return { tenantId: fila.tenant_id as string, operadorId: fila.id as string, nombre: fila.nombre as string, telefono: fila.telefono as string };
}

/**
 * La base no contestó. NO es "no existe": es que no se sabe.
 *
 * Existe como tipo propio para que el llamador pueda distinguirla de cualquier
 * otro error y decirle al operador algo cierto —"no pude consultar, inténtalo de
 * nuevo"— en vez de una negación inventada.
 */
export class ConsultaFallida extends Error {
  constructor(mensaje: string) { super(mensaje); this.name = 'ConsultaFallida'; }
}

/**
 * El mismo teléfono resuelve a más de un operador activo.
 *
 * No se puede decidir de quién es el dinero, así que no se decide. Es un dato
 * que hay que corregir en la base, no una situación que el código deba salvar
 * eligiendo uno.
 */
export class OperadorAmbiguo extends Error {
  constructor(mensaje: string) { super(mensaje); this.name = 'OperadorAmbiguo'; }
}

/** Viaje abierto del operador (el que se está liquidando). */
export async function getOpenViaje(tenantId: string, operadorId: string): Promise<string | null> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('viaje')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('operador_id', operadorId)
    .in('estatus', ['abierto', 'en_cuadre'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle(), 'getOpenViaje');
  // Misma distinción que en `resolveOperador`, y aquí es peor: un error de red en
  // la RE-VERIFICACIÓN posterior al mutex hacía que el operador recibiera "ese
  // viaje ya quedó cerrado 👍" sobre un viaje que sigue `abierto`, sin liquidación,
  // sin PDF y sin log. El producto afirmaba un hecho falso sobre su dinero.
  if (error) throw new ConsultaFallida(`viaje abierto: ${error.message}`);
  if (!data) return null;
  return data.id as string;
}

/** Lo que se sabe de la última liquidación reciente de un operador. */
export interface LiquidacionReciente {
  viajeId: string;
  liquidacionId: string;
  /** Ruta del PDF del contralor en Storage (`${tenant}/${viaje}.pdf`), o null
   *  si el cierre no generó papel. */
  pdfUrl: string | null;
  /** Sellos de entrega (0279, AGEN-4): null = falta hacerlo. */
  entregadaOperadorEn: string | null;
  avisadaOficinaEn: string | null;
}

/** Los dos sellos de entrega de `liquidacion` (0279). */
export type SelloEntrega = 'entregada_operador_en' | 'avisada_oficina_en';

/**
 * Marca que la entrega ocurrió (AGEN-4). Escribe SOLO si el sello está en
 * null: es idempotente y una segunda entrega no reescribe la hora de la
 * primera. Best-effort y nunca lanza: la liquidación ya está cerrada y el PDF
 * ya salió; perder el sello cuesta a lo sumo un reenvío, no un cierre.
 */
export async function sellarEntregaLiquidacion(tenantId: string, liquidacionId: string | null | undefined, sello: SelloEntrega): Promise<boolean> {
  if (!liquidacionId) return false;
  try {
    const { error } = await acotada(supabaseAdmin()
      .from('liquidacion')
      .update({ [sello]: new Date().toISOString() })
      .eq('tenant_id', tenantId).eq('id', liquidacionId)
      .is(sello, null), 'sellarEntregaLiquidacion');
    if (error) {
      logger.warn('liquidacion.sello_entrega', { tenant: tenantId, liq: liquidacionId, sello, err: error.message });
      return false;
    }
    return true;
  } catch (e) {
    logger.warn('liquidacion.sello_entrega', { tenant: tenantId, liq: liquidacionId, sello, err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/** Ventana en la que un cierre cuenta como "reciente" para el reintento. */
const VENTANA_LIQUIDACION_RECIENTE_MS = 24 * 60 * 60 * 1000;

/**
 * La liquidación MÁS RECIENTE del operador (últimas 24h), o `null`.
 *
 * AUDITORÍA 21, CRÍTICO (C1): cuando el ciclo del agente muere DESPUÉS de que
 * `guardar_liquidacion` ya persistió el cierre, el chofer recibe "se me trabó"
 * y obedece reenviando. Su reintento cae en la rama sin viaje abierto —el
 * viaje ya es `liquidado`— y el fallback le afirmaba "No tienes un viaje
 * abierto", que él lee como "tu cierre no existió". Esta consulta es lo que
 * permite decirle la verdad completa: tu viaje YA quedó liquidado.
 *
 * FAIL-OPEN Y NUNCA LANZA, igual que `viajeAbiertoDesdeMs` y al revés que
 * `getOpenViaje`: `null` significa "no se supo", y con eso el llamador cae al
 * mensaje genérico — que sigue siendo verdad (`getOpenViaje` ya estableció,
 * sin error, que no hay viaje abierto). Un blip de red aquí no puede tirar el
 * turno entero ni inventar un cierre.
 */
export async function liquidacionRecienteDe(tenantId: string, operadorId: string): Promise<LiquidacionReciente | null> {
  const desde = new Date(Date.now() - VENTANA_LIQUIDACION_RECIENTE_MS).toISOString();
  const { data, error } = await acotada(supabaseAdmin()
    .from('liquidacion')
    // Anclado a `viaje_id` (regla de embeds del repo): `liquidacion` no trae
    // operador, se filtra por el del viaje embebido.
    // Con `pdf_url` y los dos sellos (0279, AGEN-4): el reintento del «listo»
    // entrega lo que falte en vez de afirmar «pídeselo a tu contralor».
    .select('id, viaje_id, pdf_url, entregada_operador_en, avisada_oficina_en, viaje:viaje_id!inner(operador_id)')
    .eq('tenant_id', tenantId)
    .eq('viaje.operador_id', operadorId)
    .gte('created_at', desde)
    .order('created_at', { ascending: false })
    .order('id')
    .limit(1)
    .maybeSingle(), 'liquidacionRecienteDe');
  if (error) {
    logger.warn('liquidacion_reciente.fallo', { tenant: tenantId, operador: operadorId, err: error.message });
    return null;
  }
  if (!data) return null;
  const f = data as { id: unknown; viaje_id: unknown; pdf_url?: unknown; entregada_operador_en?: unknown; avisada_oficina_en?: unknown };
  const texto = (v: unknown) => (v == null ? null : String(v));
  return {
    viajeId: String(f.viaje_id), liquidacionId: String(f.id),
    pdfUrl: texto(f.pdf_url),
    entregadaOperadorEn: texto(f.entregada_operador_en),
    avisadaOficinaEn: texto(f.avisada_oficina_en),
  };
}

/**
 * DESDE CUÁNDO está abierto este viaje (epoch en ms), o `null` si no se supo.
 *
 * DAT-21 · es lo que permite reconocer un mensaje VIEJO. Un operador sólo puede
 * tener UN viaje abierto a la vez (`uq_viaje_abierto_por_operador`, 0029), así
 * que un texto que Meta recibió ANTES de que ESTE viaje se abriera pertenece,
 * por construcción, al anterior — que ya está liquidado. Sin este dato no había
 * forma de distinguirlo, y un "listo" rescatado por la bandeja durable dos
 * vueltas de cron después cerraba el viaje EQUIVOCADO.
 *
 * FAIL-OPEN Y NUNCA LANZA, al revés que sus vecinas de este archivo: `null`
 * significa "no se pudo saber", y con eso el llamador NO descarta nada — sigue
 * el camino de siempre. Es lo correcto aquí porque el error de tirar un "listo"
 * bueno (el chofer se queda sin cerrar y sin entender por qué) es peor que el de
 * dejar pasar uno viejo, que además es rarísimo y que la re-verificación
 * posterior al mutex todavía puede atrapar.
 *
 * Se consulta SÓLO cuando hace falta —un texto que parece cierre y que trae la
 * hora de Meta—, no en cada mensaje.
 */
export async function viajeAbiertoDesdeMs(tenantId: string, viajeId: string): Promise<number | null> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('viaje')
    .select('created_at')
    .eq('id', viajeId)
    .eq('tenant_id', tenantId)
    .maybeSingle(), 'viajeAbiertoDesdeMs');
  if (error || !data?.created_at) return null;
  const ms = Date.parse(data.created_at as string);
  return Number.isFinite(ms) ? ms : null;
}

export async function getTenantContext(tenantId: string): Promise<TenantContext> {
  const { data, error } = await acotada(supabaseAdmin().from('tenant').select('nombre').eq('id', tenantId).maybeSingle(), 'getTenantContext');
  // El `|| 'la flota'` de abajo es un default para una flota SIN nombre
  // capturado, no una tapadera para una base que no contestó. Sin este chequeo
  // los dos casos se veían igual, y el segundo sale impreso en el aviso de
  // privacidad que el operador lee en su primer contacto: "Likida procesa esta
  // información por cuenta de la flota" en vez del nombre de su empresa. Un
  // texto legal con el nombre del responsable borrado no es una degradación
  // cosmética. Misma decisión que sus vecinas `resolveOperador` y
  // `getOpenViaje`: no se sabe, se dice.
  if (error) throw new ConsultaFallida(`getTenantContext: ${error.message}`);
  return {
    tenantId,
    nombreFlota: (data?.nombre as string) || 'la flota',
    // EL NOMBRE QUE EL OPERADOR LEE PRIMERO. Decía 'Cuadra', que es el nombre
    // viejo del repo, y el operador terminaba leyendo LOS DOS en la misma
    // pantalla: el aviso de privacidad dice "Likida procesa esta información por
    // cuenta de la empresa" y tres líneas después llegaba "Soy Cuadra".
    //
    // Dos nombres para lo mismo, en el primer contacto, ante alguien que no sabe
    // nada del producto. Se detectó el 1-ago mirando la conversación real, no el
    // código: en el fuente `agentName: 'Cuadra'` se lee como una constante
    // cualquiera.
    //
    // Misma familia que `cuadra.mx` impreso en el pie del PDF. `marca.test.ts`
    // vigila que no vuelvan a separarse.
    agentName: 'Likida',
    timezone: TZ_MX,
  };
}

const MAX_TURNS = 12;

/**
 * Carga la conversación del teléfono, con los turnos DE ESTE VIAJE.
 *
 * `viaje_id` se guardaba en la fila y no se usaba nunca como condición de
 * lectura: la conversación estaba modelada por (tenant, teléfono) y arrastraba
 * los turnos del viaje anterior al prompt del siguiente. `saveConversation` pone
 * `viaje_id = null` al cerrar pero CONSERVA los turnos, así que el último
 * "Listo, cuadré tu viaje 👇 • Comprobado: $5,000.00 • Anticipo: $6,000.00" del
 * viaje A entraba como contexto del viaje B, que tiene otro anticipo.
 *
 * Si el modelo repite una cifra, `guardiaCifras` lo tapa. Si concluye "eso ya lo
 * cerré", no lo tapa nada — es munición para la afirmación de estado falsa. Y
 * encima se pagan tokens de un viaje ajeno en cada turno.
 */
/** Los índices únicos de `wa_conversacion` contra los que choca el insert que
 *  pierde la carrera: el crudo de la 0005 y el normalizado de la 0274. */
export const ES_CARRERA_DE_CONVERSACION: readonly string[] = ['wa_conversacion_tenant_tel_uidx', 'uq_wa_conversacion_tenant_telefono_norm'];

export async function loadConversation(tenantId: string, telefono: string, viajeId: string | null): Promise<Conversacion> {
  const admin = supabaseAdmin();
  const { data, error } = await acotada(admin
    .from('wa_conversacion')
    .select('id, estado, viaje_id')
    .eq('tenant_id', tenantId)
    // ── AUDITORÍA 22, DATOS-1 (ALTO) ──────────────────────────────────────
    // Era `.eq('telefono', telefono)`: igualdad EXACTA sobre el texto crudo,
    // mientras `resolveOperador` —dos funciones más arriba, en este mismo
    // archivo— resuelve al chofer por cualquiera de las seis `variantesTelefono`
    // precisamente porque el comentario de la línea 64 documenta que «el mismo
    // teléfono llega como 529993700779 o como 5219993700779 según por dónde
    // entre».
    //
    // Con la igualdad exacta, el MISMO chofer entrando por otro camino no
    // encontraba fila y caía al INSERT de abajo: estrenaba conversación, y su
    // `estado` —el viaje en curso, la barrera de ráfaga, la constancia del
    // aviso de privacidad— quedaba partido entre dos filas, ninguna con la
    // historia completa. Es el mismo defecto que la 0024 cerró para `operador`
    // y que `wa_conversacion` nunca recibió (índice único en la 0274).
    .in('telefono', variantesTelefono(telefono))
    .order('updated_at', { ascending: false }).order('id', { ascending: false })
    .limit(1)
    .maybeSingle(), 'loadConversation');
  // AUDITORÍA 8, ALTO: era la única vecina de `getOpenViaje`/`resolveOperador`
  // que descartaba `error`. Un blip de Supabase se leía como "no existe la
  // conversación", caía al INSERT de abajo, chocaba con
  // `wa_conversacion_tenant_tel_uidx` (23505), y el turno del asistente que el
  // operador SÍ leyó se perdía — el agente arrancaba el siguiente mensaje sin
  // memoria de lo que ya se dijo.
  if (error) throw new ConsultaFallida(`loadConversation: ${error.message}`);
  if (data) return desdeFila(data, viajeId, telefono);

  // EL INSERT PIERDE UNA CARRERA QUE EL PRODUCTO PROVOCA A DIARIO.
  //
  // El caso normal —un operador mandando 22 fotos seguidas— arranca varias
  // invocaciones concurrentes de `after()` para el MISMO (tenant, teléfono).
  // Todas leen arriba, ninguna encuentra fila, todas insertan: una gana y las
  // demás chocan contra `wa_conversacion_tenant_tel_uidx` (23505). Sin mirar
  // `error`, `created` quedaba `undefined` y se devolvía `id: ''`, con lo que el
  // `saveConversation` posterior hacía `.eq('id', '')` —cero filas actualizadas—
  // y el turno del asistente que el operador SÍ leyó desaparecía. El agente
  // arrancaba el siguiente mensaje sin memoria de lo que ya se había dicho.
  //
  // No es un upsert porque el upsert PISARÍA el `estado` de la fila que ganó:
  // sobrescribir con `{ turns: [] }` borra justamente el historial que se está
  // tratando de conservar. Chocar y releer devuelve la fila real, con sus turnos.
  const { data: creada, error: errInsert } = await acotada(admin
    .from('wa_conversacion')
    .insert({ tenant_id: tenantId, telefono, viaje_id: viajeId, estado: { turns: [] } })
    .select('id, estado, viaje_id')
    .single(), 'loadConversation.insert');
  if (!errInsert && creada) return desdeFila(creada, viajeId, telefono);
  // Cualquier otro fallo —red, permisos, un choque contra OTRO índice— no es
  // esta carrera y tragárselo escondería un bug distinto.
  //
  // AUDITORÍA 24 · BE-4 (MEDIO, reincidente): desde la 0274 el índice que
  // gana la carrera es `uq_wa_conversacion_tenant_telefono_norm` (teléfono
  // NORMALIZADO); el viejo `wa_conversacion_tenant_tel_uidx` puede seguir
  // existiendo en bases que no lo soltaron. Un choque contra cualquiera de los
  // dos ES esta carrera — reconocer solo el viejo convertía la carrera normal
  // de dos invocaciones con distinta forma del número en «No pude consultar
  // tus datos» sobre una conversación sana.
  if (errInsert && !ES_CARRERA_DE_CONVERSACION.some((idx) => violaIndice(errInsert, idx))) {
    throw new ConsultaFallida(`loadConversation.insert: ${errInsert.message}`);
  }

  // La relectura busca como la lectura de arriba: por las seis variantes, no
  // por el texto exacto (BE-4). La fila que ganó pudo nacer con la OTRA forma
  // del número, y con `.eq` no aparecía aunque el índice acababa de decir
  // que existe.
  const { data: ganadora, error: errRelectura } = await acotada(admin
    .from('wa_conversacion')
    .select('id, estado, viaje_id')
    .eq('tenant_id', tenantId)
    .in('telefono', variantesTelefono(telefono))
    .order('updated_at', { ascending: false }).order('id', { ascending: false })
    .limit(1)
    .maybeSingle(), 'loadConversation.relectura');
  if (errRelectura) throw new ConsultaFallida(`loadConversation.relectura: ${errRelectura.message}`);
  // Chocó con el índice y aun así no está: la fila no se puede nombrar, y
  // devolver `id: ''` es exactamente lo que hacía perderse el historial en
  // silencio. Se lanza para que el llamador sepa que no hay dónde guardar.
  if (!ganadora) throw new ConsultaFallida('loadConversation: la conversación chocó con el índice único y no apareció al releerla');
  // `para` y no `telefono` crudo (auditoría prod, SEG-7): el redactor del
  // logger pide los dígitos pegados y aquí el número puede venir como lo
  // guardó la base o como lo mandó Meta. Los últimos 4 alcanzan para cruzar
  // con `operador` y no reconstruyen a nadie desde el log.
  logger.info('conv.carrera_insert', { para: destinatarioEnmascarado(telefono), viaje: viajeId });
  return desdeFila(ganadora, viajeId, telefono);
}

/**
 * Una fila de `wa_conversacion` → lo que el agente necesita.
 *
 * El historial pertenece al viaje en el que se dijo. Si la fila viene de otro
 * viaje —o de ninguno, porque el anterior ya cerró— se empieza limpio.
 */
function desdeFila(
  fila: { id: unknown; estado: unknown; viaje_id: unknown },
  viajeId: string | null,
  telefono: string,
): Conversacion {
  const estado = (fila.estado as { turns?: ConvTurn[] } & MarcasConversacion) || {};
  const mismoViaje = viajeId !== null && fila.viaje_id === viajeId;
  if (!mismoViaje && (estado.turns?.length ?? 0) > 0) {
    logger.info('conv.historial_descartado', { para: destinatarioEnmascarado(telefono), de: (fila.viaje_id as string | null) ?? null, a: viajeId });
  }
  return {
    id: fila.id as string,
    turns: mismoViaje ? (estado.turns ?? []).slice(-MAX_TURNS) : [],
    // LAS MARCAS SIGUEN LA MISMA REGLA QUE LOS TURNOS. Un contador de intentos
    // del viaje anterior aplicado al de hoy mandaría al chofer con su encargado
    // a la primera respuesta que no se entienda de un viaje que acaba de
    // empezar.
    intentosConfirmacion: mismoViaje ? (estado.intentosConfirmacion ?? 0) : 0,
    cierreSinComprobantes: mismoViaje ? (estado.cierreSinComprobantes ?? false) : false,
  };
}

/** La conversación tal como la usa el pipeline: turnos + lo que hay que recordar. */
export interface Conversacion extends MarcasConversacion {
  id: string;
  turns: ConvTurn[];
}

/**
 * Resultado de reclamar un mensaje. Son CUATRO estados, no dos: la diferencia
 * entre "ya lo procesamos", "lo está procesando otro" y "no pude averiguarlo"
 * decide si el operador recibe respuesta, si la bandeja durable lo reintenta,
 * o si se queda sin nada.
 */
export type Claim = 'nuevo' | 'duplicado' | 'en_curso' | 'indeterminado';

/**
 * CUÁNTO VIVE UN CLAIM SIN COMPLETARSE antes de considerarlo huérfano.
 *
 * AUDITORÍA 18, CRÍTICO (C5): el claim se toma en la primera línea de
 * `processInbound` y solo se soltaba en el `catch` o en cuatro `return`
 * tempranos. Una muerte por `maxDuration` no ejecuta ninguno: la fila quedaba
 * tomada 30 días (la purga de la 0072), y el reintento de la bandeja durable
 * recibía 'duplicado' —que significaba "ya hecho"— sobre un mensaje que NUNCA
 * se procesó. Con la mig. 0149 la fila distingue reclamado de completado
 * (`completado_en`), y un claim sin completar más viejo que este lease es de
 * un proceso muerto: se retoma.
 *
 * Mayor que el `maxDuration` de la invocación a propósito: un claim más joven
 * puede pertenecer a una invocación que sigue viva. 30s de holgura sobre 120s.
 * El cron drena cada 5 min, así que el huérfano se retoma a la primera vuelta.
 */
export const LEASE_CLAIM_MS = PRESUPUESTO_WEBHOOK_MS + 30_000;

/**
 * Reclama un mensaje de WhatsApp de forma atómica (idempotencia).
 *
 * ANTES devolvía un booleano y trataba cualquier error de DB como "duplicado",
 * con el argumento de que "el retry de Meta lo reprocesará cuando la DB
 * responda". Ese retry NO EXISTE: `route.ts` responde 200 y hace el trabajo en
 * `after()`, así que Meta ya recibió su acuse y no reintenta nunca —lo dice el
 * propio comentario de `presupuesto.ts`—. Un blip de Supabase en el insert hacía
 * que el "listo" del operador desapareciera para siempre, con un log de nivel
 * info que además mentía llamándolo duplicado.
 *
 * Ahora el caso indeterminado se distingue y lo decide el llamador, que es quien
 * sabe si lo que está en juego es dinero o una respuesta.
 *
 * Y cuando la fila YA EXISTE se mira qué es (auditoría 18, C5/A3/A27):
 *   · `completado_en` puesto → 'duplicado' de verdad (ya se procesó).
 *   · sin completar y más vieja que `LEASE_CLAIM_MS` → claim huérfano de un
 *     proceso muerto: se RETOMA con un UPDATE anclado (atómico entre dos
 *     corridas) y se devuelve 'nuevo'.
 *   · sin completar y fresca → 'en_curso': otra invocación lo está procesando;
 *     el llamador no lo procesa ni lo da por hecho, lo deja para después.
 */
export interface MessageClaimHandle {
  status: Claim;
  token?: string;
  owner: string;
}

const leaseSeconds = Math.ceil(LEASE_CLAIM_MS / 1000);

export function crearMessageLeaseOwner(): string {
  return `wa-message:${randomUUID()}`;
}

export async function claimMessage(waMessageId: string): Promise<Claim>;
export async function claimMessage(waMessageId: string, owner: string, detailed: true): Promise<MessageClaimHandle>;
export async function claimMessage(
  waMessageId: string,
  owner = crearMessageLeaseOwner(),
  detailed = false,
): Promise<Claim | MessageClaimHandle> {
  if (!waMessageId) return detailed ? { status: 'nuevo', owner } : 'nuevo';
  try {
    const { data, error } = await acotada(supabaseAdmin().rpc('claim_wa_mensaje_procesado', {
      p_wa_message_id: waMessageId,
      p_lease_owner: owner,
      p_lease_seconds: leaseSeconds,
    }), 'claimMessage');
    if (error) throw error;
    const fila = (Array.isArray(data) ? data : data ? [data] : [])[0] as {
      estado?: Claim; lease_token?: string | null;
    } | undefined;
    const status: Claim = fila?.estado === 'nuevo' || fila?.estado === 'duplicado' || fila?.estado === 'en_curso'
      ? fila.estado
      : 'indeterminado';
    const result: MessageClaimHandle = {
      status,
      token: fila?.lease_token ? String(fila.lease_token) : undefined,
      owner,
    };
    return detailed ? result : status;
  } catch (e) {
    logger.error('wa.claim_error', { id: waMessageId, err: e instanceof Error ? e.message : String(e) });
    const result: MessageClaimHandle = { status: 'indeterminado', owner };
    return detailed ? result : result.status;
  }
}

/**
 * Sella el claim como COMPLETADO: a partir de aquí 'duplicado' vuelve a
 * significar "ya hecho". Best-effort con aviso — para cuando esto corre la
 * respuesta ya salió; fallar aquí solo hace que un reintento futuro espere el
 * lease en vez de rebotar de inmediato.
 */
export async function completarMessageClaim(waMessageId: string, leaseToken?: string, leaseOwner?: string): Promise<void> {
  if (!waMessageId) return;
  try {
    if (!leaseToken || !leaseOwner) {
      logger.warn('wa.claim_sin_token', { id: waMessageId, operacion: 'complete' });
      return;
    }
    const { data, error } = await acotada(supabaseAdmin().rpc('complete_wa_mensaje_procesado', {
      p_wa_message_id: waMessageId, p_lease_token: leaseToken, p_lease_owner: leaseOwner,
    }), 'completarMessageClaim');
    if (error) throw error;
    if (data !== true && !(Array.isArray(data) && data[0] === true)) logger.warn('wa.claim_complete_fenced', { id: waMessageId });
  } catch (e) {
    logger.warn('wa.claim_sin_completar', { id: waMessageId, err: e instanceof Error ? e.message : String(e) });
  }
}

/** Renueva el claim downstream mientras OCR/LLM siguen vivos. */
export async function renovarMessageClaim(waMessageId: string, leaseToken: string, leaseOwner: string): Promise<boolean> {
  try {
    const { data, error } = await acotada(supabaseAdmin().rpc('renew_wa_mensaje_procesado', {
      p_wa_message_id: waMessageId, p_lease_token: leaseToken,
      p_lease_owner: leaseOwner, p_lease_seconds: Math.ceil(LEASE_CLAIM_MS / 1000),
    }), 'renovarMessageClaim');
    if (error) throw error;
    return data === true || (Array.isArray(data) && data[0] === true);
  } catch (e) {
    logger.warn('wa.claim_lease_no_renovado', { id: waMessageId, err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

export function iniciarRenovacionMessageClaim(waMessageId: string, leaseToken: string, leaseOwner: string): () => void {
  let enVuelo = false;
  const timer = setInterval(() => {
    if (enVuelo) return;
    enVuelo = true;
    void renovarMessageClaim(waMessageId, leaseToken, leaseOwner).finally(() => { enVuelo = false; });
  }, 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

// AUDITORÍA 8, ALTO: no lanza a propósito — para cuando esto corre, la
// respuesta (y el PDF) ya pudieron haberse entregado, y el catch general de
// `processInbound` mandaría un segundo mensaje "se me trabó" contradiciendo
// una respuesta que sí llegó. Pero antes tampoco miraba `error`: un `.eq('id',
// '')` sobre un `convId` vacío (el que devuelve `loadConversation` cuando su
// propio INSERT choca) no actualizaba nada y no lo decía nadie. Ahora al
// menos queda un ERROR en el log — se pierde el turno, no el rastro de que se
// perdió.
/**
 * `marcas` OMITIDAS SE BORRAN, y sigue siendo a propósito — eso NO cambió.
 * `turns`/`intentosConfirmacion`/`cierreSinComprobantes` son las llaves de
 * ESTE módulo, y quien guarda sin marcas es el turno normal del agente (sin
 * pregunta nuestra pendiente): el default sigue siendo el estado limpio DE
 * SUS PROPIAS llaves.
 *
 * LO QUE SÍ CAMBIÓ (auditoría 2, ronda 2 — defensa en profundidad): esta fila
 * también la escriben `despacho_wa.ts` (`viajePendiente`) y `asignar_wa.ts`
 * (`asignacionPendiente`) bajo la MISMA llave única (tenant, teléfono) cuando
 * el número es a la vez chofer y oficina (dueño-que-maneja). Antes este
 * UPDATE reemplazaba `estado` entero con solo `{turns, marcas}` — un
 * despacho pendiente armado un instante antes desaparecía sin que el jefe se
 * enterara, y el "sí" que mandara después no encontraba nada que confirmar.
 *
 * Se lee la fila (por `convId`, la misma que identifica esta conversación) y
 * se preserva lo ajeno por debajo de lo propio: `turns` y las marcas se
 * escriben siempre (reemplazando lo que hubiera de este módulo, que es la
 * regla de arriba), y cualquier otra llave que ya estuviera —los pendientes
 * de los otros dos escritores— pasa intacta. Antes esto exigía releer la
 * fila, y releerla habría abierto una carrera con las fotos —pero las fotos
 * no tocan `wa_conversacion.estado`, escriben `viaje.intake_pendientes`
 * (ver `intakeDelta`/`intakePendientes` abajo): esa carrera nunca existió
 * aquí, era una fila distinta.
 *
 * LA CARRERA QUE SÍ QUEDA es la misma que documentan `despacho_wa.ts` y
 * `asignar_wa.ts`: el SELECT y el UPDATE no son un solo statement (un merge
 * `estado || jsonb` de Postgres sí lo sería, pero exige una función RPC nueva,
 * fuera del alcance de este fix). Se acepta por la misma razón: ventana de
 * milisegundos, exige el mismo teléfono en dos roles y dos mensajes casi
 * simultáneos, y lo peor que se pierde es un pendiente de despacho (se vuelve
 * a pedir el "sí"), no un cobro ni un despacho duplicado.
 */
export async function saveConversation(
  convId: string,
  turns: ConvTurn[],
  viajeId: string | null,
  marcas: MarcasConversacion = {},
): Promise<void> {
  // Un fallo de lectura no bloquea el guardado del turno —eso perdería la
  // respuesta que el operador SÍ leyó, el hallazgo original de esta
  // función—: se degrada a escribir solo las llaves propias, tal como se
  // hacía antes de esta ronda, y queda anotado para diagnóstico.
  const { data: filaActual, error: errLectura } = await acotada(supabaseAdmin()
    .from('wa_conversacion')
    .select('estado')
    .eq('id', convId)
    .maybeSingle(), 'saveConversation.leerEstado');
  if (errLectura) {
    logger.warn('conv.estado_previo_ilegible', { convId, err: errLectura.message });
  }
  const nuevoEstado: Record<string, unknown> = { ...((filaActual?.estado as Record<string, unknown> | null) ?? {}) };
  nuevoEstado.turns = turns.slice(-MAX_TURNS);
  // Solo las que valen algo: escribir `0`/`false` en cada guardado ensucia
  // el jsonb de todas las conversaciones para no decir nada.
  if (marcas.intentosConfirmacion) nuevoEstado.intentosConfirmacion = marcas.intentosConfirmacion;
  else delete nuevoEstado.intentosConfirmacion;
  if (marcas.cierreSinComprobantes) nuevoEstado.cierreSinComprobantes = true;
  else delete nuevoEstado.cierreSinComprobantes;

  const { error } = await acotada(supabaseAdmin()
    .from('wa_conversacion')
    .update({
      estado: nuevoEstado,
      viaje_id: viajeId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', convId), 'saveConversation');
  if (error) logger.error('conv.no_se_guardo', { convId, err: error.message });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * ¿El error dice que la función NO EXISTE? Eso es una migración sin aplicar, no
 * un tropiezo de red: reintentarlo no cambia nada.
 *
 * PGRST202 es el código de PostgREST para "no encontré esa función"; el texto se
 * revisa además por si la capa de error cambia de forma.
 */
function rpcAusente(error: { code?: string; message?: string }): boolean {
  if (error.code === 'PGRST202' || error.code === '42883') return true;
  const m = (error.message ?? '').toLowerCase();
  return m.includes('could not find the function') || m.includes('does not exist');
}

/**
 * Qué pasó al pedir el mutex del viaje. Tres estados, no dos, porque las
 * respuestas correctas son distintas (DAT-21):
 *
 *   · 'obtenido'      — es tuyo, procede.
 *   · 'ocupado'       — otro turno lo tiene VIGENTE. Ese otro va a responder a
 *                       SU mensaje; éste se aplaza.
 *   · 'indeterminado' — la RPC no contestó en toda la ventana. NO se sabe si
 *                       está libre, y eso NO es lo mismo que estar ocupado:
 *                       hay que decírselo al operador de otra manera.
 */
export type ResultadoLockViaje = 'obtenido' | 'ocupado' | 'indeterminado';

/**
 * CUÁNTO DURA EL LEASE DEL CIERRE.
 *
 * AUDITORÍA PROD 22-ago-2026, DAT-21: el default de 60 s es MENOR que el peor
 * caso del cierre, y el cierre es lo único irreversible que hace este sistema.
 * Sumado: el cuadre, DOS PDFs generados y subidos a storage, la RPC de guardado
 * y el envío del documento por WhatsApp. Con el agente de por medio
 * (`timeoutMs` acotado a 40 s) el turno completo cabe holgadamente por encima
 * de los 60 s, y cuando el lease vence A MEDIO CIERRE el mutex deja de existir:
 * un segundo "listo" entra, corre el agente otra vez y paga el LLM otra vez —
 * exactamente lo que el mutex vino a impedir.
 *
 * 120 s es el `PRESUPUESTO_WEBHOOK_MS`: el lease dura lo que puede durar la
 * invocación que lo tomó, ni más ni menos. Más sería dejar trabado un viaje
 * cuyo dueño ya murió; menos es la ventana de arriba.
 */
export const TTL_LOCK_CIERRE_MS = PRESUPUESTO_WEBHOOK_MS;

/**
 * Mutex por viaje (AL-1/CR-1): serializa el procesamiento de mensajes del mismo
 * viaje para que un "listo" no cierre la liquidación antes de que el OCR de la
 * última foto haya guardado su gasto. Reintenta con backoff hasta maxWaitMs.
 *
 * Booleano por compatibilidad con los llamadores a los que sólo les importa
 * "¿lo tengo o no?" (`administracion.ts`, el brazo del XML). Quien necesite
 * distinguir OCUPADO de NO SE SUPO usa `intentarLockViaje`.
 */
export async function acquireViajeLock(viajeId: string, opts?: { ttlMs?: number; maxWaitMs?: number; token?: string }): Promise<boolean> {
  return (await intentarLockViaje(viajeId, opts)) === 'obtenido';
}

/**
 * El token con el que se firma un lease del viaje (AUDITORÍA 24 · BE-11).
 *
 * `unlock_viaje` borraba el lease de QUIEN FUERA. Escenario medido: el XML
 * toma el lock con TTL 60 s, tarda más bajo carga, el «listo» toma el lease ya
 * vencido y empieza a cuadrar, y el `finally` del XML borra el lock del
 * cierre — dejando entrar un segundo «listo» completo. Quien toma el lock lo
 * firma, y solo con esa firma se suelta.
 */
export function nuevoTokenDeLock(): string {
  return randomUUID();
}

/**
 * El mutex con su resultado completo.
 *
 * ── DAT-21 · EL FAIL-OPEN SE QUEDA SÓLO DONDE ESTABA JUSTIFICADO ──────────
 *
 * Había DOS fail-open y sólo uno merecía serlo:
 *
 *   · RPC AUSENTE (la 0005 sin aplicar): reintentar no la hace aparecer y
 *     bloquear dejaría al operador sin respuesta por un problema de despliegue.
 *     Se abre — y el arranque ya falla ruidoso por esto. Se queda.
 *
 *   · ERROR PERSISTENTE (12 s de timeouts, pool agotado, 503): esto devolvía
 *     `true`, o sea "el lock es tuyo", sobre una base que NO contestó. Y quien
 *     recibe ese `true` en el camino del cierre se pone a cuadrar, generar los
 *     PDFs y CERRAR — irreversiblemente— sin exclusividad ninguna. Con Supabase
 *     degradado, los dos "listo" del operador impaciente cierran los dos: dos
 *     ciclos de agente, dos PDFs, y la carrera que la 0158 tuvo que atrapar en
 *     la base. Un mutex que se abre justo cuando la infraestructura está mal es
 *     un mutex que no protege el caso para el que existe.
 *
 * Ahora eso es 'indeterminado' y decide el llamador. Fallar cerrado cuesta un
 * mensaje de "vuelve a intentar" y un reintento de la bandeja durable; fallar
 * abierto cuesta una liquidación cerrada dos veces.
 */
export async function intentarLockViaje(viajeId: string, opts?: { ttlMs?: number; maxWaitMs?: number; token?: string }): Promise<ResultadoLockViaje> {
  // BE-11: el TTL por omisión sube al del cierre. Los dos usuarios de este
  // mutex son el XML y el «listo», y tenerlos con TTLs distintos (60 s contra
  // 120 s) era la mitad del hallazgo: el corto vencía a media escritura y el
  // largo entraba encima.
  const ttlMs = opts?.ttlMs ?? TTL_LOCK_CIERRE_MS;
  const maxWaitMs = opts?.maxWaitMs ?? 12_000;
  const admin = supabaseAdmin();
  const start = Date.now();
  let delay = 150;
  let ultimoError: { code?: string; message?: string } | null = null;
  for (;;) {
    // AUDITORÍA 2 (backend): el ÚNICO punto de espera del bucle. Sin `acotada`,
    // un socket que Supabase acepta y no contesta se queda aquí sin volver, así
    // que el `maxWaitMs` de abajo nunca se revisa y la función muere al
    // `maxDuration` sin tomar el lock ni cuadrar. Con `acotada` cada intento
    // corta en el tope de consulta y el bucle sí puede revisar su `maxWaitMs`.
    const args: Record<string, unknown> = { p_viaje: viajeId, p_ttl_ms: ttlMs };
    if (opts?.token) args.p_token = opts.token;
    const { data, error } = await acotada(admin.rpc('try_lock_viaje', args), 'acquireViajeLock');
    if (!error && data === true) return 'obtenido';
    if (error) {
      ultimoError = error;
      // Se distingue el error PERMANENTE del TRANSITORIO. Antes los dos abrían
      // el mutex de inmediato, y solo uno de los dos lo merece.
      //
      // AUSENTE (la migración 0005 no está aplicada): se cae el mutex Y el
      // unique(viaje_id) juntos. Reintentar no va a hacer aparecer la función, y
      // bloquear dejaría al operador sin respuesta por un problema de
      // despliegue. Se abre — con ERROR, no warn, porque es la protección de
      // doble cierre — y el arranque ya falla ruidoso por esto
      // (ver instrumentation.ts).
      if (rpcAusente(error)) {
        // AUDITORÍA 24 · BE-11: `p_token` es de la 0280. Durante la ventana de
        // despliegue (código nuevo, migración sin aplicar) PostgREST no
        // encuentra la firma de TRES argumentos — y eso NO es «no hay mutex»:
        // el de dos argumentos sigue ahí. Se reintenta sin token antes de
        // concluir nada, porque la conclusión de aquí es ABRIR el mutex.
        if (opts?.token) {
          const viejo = await acotada(admin.rpc('try_lock_viaje', { p_viaje: viajeId, p_ttl_ms: ttlMs }), 'acquireViajeLock.sinToken');
          if (!viejo.error && viejo.data === true) {
            logger.warn('viaje.lock_sin_token', { nota: 'la 0280 no está aplicada; el lease queda sin dueño' });
            return 'obtenido';
          }
          if (!viejo.error) {
            // Existía y está OCUPADO: el bucle sigue como siempre.
            ultimoError = null;
            if (Date.now() - start >= maxWaitMs) return 'ocupado';
            await sleep(delay);
            delay = Math.min(delay * 2, 1500);
            continue;
          }
          // ALT-151 (auditoría 25, REINCIDENTE): la SEGUNDA llamada (sin
          // token) también falló. Antes esto caía por gravedad al
          // `return 'obtenido'` de abajo — abriendo el mutex sobre una base
          // que no contestó dos veces seguidas. Si el error de la segunda
          // llamada es OTRO "función ausente" (las dos firmas faltan, no solo
          // la de tres argumentos), sí es el caso legítimo de "no hay mutex
          // desplegado" y se abre igual que antes. Cualquier otro error es
          // TRANSITORIO: se trata como el resto del bucle, sin abrir nada.
          if (!rpcAusente(viejo.error)) {
            ultimoError = viejo.error;
            logger.warn('viaje.lock_error_transitorio', { code: viejo.error.code, msg: viejo.error.message });
            if (Date.now() - start >= maxWaitMs) {
              logger.error('viaje.lock_error_persistente', { code: viejo.error.code, msg: viejo.error.message });
              return 'indeterminado';
            }
            await sleep(delay);
            delay = Math.min(delay * 2, 1500);
            continue;
          }
        }
        logger.error('viaje.lock_rpc_ausente', { code: error.code, msg: error.message });
        return 'obtenido';
      }
      // TRANSITORIO (timeout, pool agotado, 503): un error no significa que el
      // lock esté libre, significa que no se supo. Abrir de golpe deja correr
      // dos "listo" completos sobre el mismo viaje — dos ciclos de agente, dos
      // cierres. Se reintenta como si estuviera ocupado; abajo decide qué hacer
      // si la ventana se agota.
      logger.warn('viaje.lock_error_transitorio', { code: error.code, msg: error.message });
    }
    if (Date.now() - start >= maxWaitMs) {
      // Se agotó la ventana. Ocupado de verdad → 'ocupado' (otro lo tiene, y
      // ese otro va a responder). Fallando todo el rato → 'indeterminado':
      // NO se sabe si está libre, y hasta hoy eso se devolvía como "es tuyo".
      // Ver el bloque de arriba: abrirlo aquí es abrirlo justo cuando la base
      // está mal, que es cuando el doble cierre es más probable.
      if (ultimoError) {
        logger.error('viaje.lock_error_persistente', { code: ultimoError.code, msg: ultimoError.message });
        return 'indeterminado';
      }
      return 'ocupado';
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 1500);
  }
}

/**
 * ¿Quedó una FOTO de este chofer, más vieja que este mensaje, sin procesar?
 *
 * AUDITORÍA 24 · AGEN-6 (MEDIO). El orden del inbox lo daba `recibido_en`, que
 * es la hora en que el POST llegó a NUESTRO servidor. Meta entrega los
 * mensajes de una ráfaga en POSTs distintos y no garantiza el orden entre
 * ellos: la foto que el chofer mandó a las 10:40:00.2 puede aterrizar a las
 * 10:40:03 (un reintento de Meta de por medio) y el «listo» que escribió a las
 * 10:40:01.1 a las 10:40:01.4. La 0280 arregla el ORDEN de la cola; lo que no
 * puede arreglar es el turno que ya está corriendo: cuando el webhook del
 * «listo» lo procesa, la foto todavía no existe en la tabla, `esperarIntake`
 * ve el contador en cero porque nadie hizo `+1`, y la liquidación cierra sin
 * el último ticket — irreversible por la 0036/0037.
 *
 * Esto se pregunta DESPUÉS de la barrera de ráfaga, que es cuando la foto ya
 * tuvo tiempo de llegar a la tabla: si está ahí, el «listo» se aplaza y el
 * cron lo vuelve a tomar, ahora sí después de ella.
 *
 * TRES estados: `true` = existe una foto anterior pendiente (incluidas las que
 * agotaron intentos), `false` = la lectura completa confirma que no existe,
 * `null` = no se pudo saber. Quien pretende CERRAR debe tratar `null` igual que
 * `true`: una falla de infraestructura no es evidencia de que el fajo terminó.
 */
export async function fotoAnteriorSinProcesar(telefono: string, mensajeMs: number): Promise<boolean | null> {
  if (!telefono || !Number.isFinite(mensajeMs) || mensajeMs <= 0) return false;
  try {
    return await consultarFotoAnterior(telefono, mensajeMs);
  } catch (e) {
    logger.warn('inbox.foto_anterior_ilegible', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

async function consultarFotoAnterior(telefono: string, mensajeMs: number): Promise<boolean | null> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('wa_evento_pendiente')
    .select('id')
    .is('procesado_en', null)
    .in('evento->>from', variantesTelefono(telefono))
    .eq('evento->>type', 'image')
    // `->` (jsonb) y no `->>`: con texto, «999…» compararía como cadena.
    .lt('evento->timestampMs', mensajeMs)
    // orden-no-importa: esto pregunta si EXISTE alguna, no cuál. Con `limit(1)`
    // el resultado es «hay» o «no hay», y las dos respuestas son las mismas sin
    // importar qué fila devuelva la base.
    .limit(1), 'fotoAnteriorSinProcesar');
  if (error) {
    logger.warn('inbox.foto_anterior_ilegible', { err: error.message });
    return null;
  }
  return (data?.length ?? 0) > 0;
}

/**
 * Barrera de ráfaga (contador de OCR en vuelo). Incremento/decremento atómico;
 * devuelve el nuevo contador. Las fotos hacen +1 al entrar y -1 al terminar.
 */
/**
 * Devuelve `null` cuando NO se pudo consultar. NO cero.
 *
 * Devolvía 0 ante cualquier error, y 0 significa además "no hay nada en vuelo",
 * así que un blip de la RPC ABRÍA la barrera: `esperarIntake` sondea con
 * `intakeDelta(id, 0)`, veía 0, y devolvía `true` de inmediato.
 *
 * Escenario medido: el operador manda 5 fotos, la #5 sigue en OCR cuando llega
 * "listo", y el sondeo cae por un 503 transitorio. La barrera se abre, el agente
 * cuadra con 4 comprobantes, y si el #5 era el diésel de $8,000 la liquidación
 * cierra con $8,000 menos comprobados —con el PDF emitido y el viaje ya
 * `liquidado`—. El operador termina debiendo de su bolsa un gasto que sí hizo. Y
 * como `intakeOk` salía `true`, tampoco se le avisaba.
 *
 * Es la misma confusión que ya se corrigió hoy en el diagnóstico de migraciones y
 * en `resolveOperador`: un fallo de consulta disfrazado del valor que significa
 * "no hay". Aquí el disfraz cuesta dinero del operador.
 */
export async function intakeDelta(viajeId: string, delta: number): Promise<number | null> {
  const { data, error } = await acotada(supabaseAdmin().rpc('intake_delta', { p_viaje: viajeId, p_delta: delta }), 'intakeDelta');
  if (error) {
    // El viaje va en el log: sin él, a la mañana siguiente no se puede saber CUÁL
    // liquidación salió corta.
    logger.warn('intake.delta', { viaje: viajeId, delta, code: error.code, msg: error.message });
    return null;
  }
  return typeof data === 'number' ? data : null;
}

/**
 * Cuántos OCR hay en vuelo, SIN escribir. `null` = no se pudo consultar.
 *
 * ── POR QUÉ EXISTE: EL SONDEO ERA UNA ESCRITURA ────────────────────────────
 *
 * `esperarIntake` sondeaba con `intakeDelta(viajeId, 0)`, y `intake_delta` es un
 * UPDATE aunque el delta sea 0 (mig. 0011/0031: la fila se reescribe entera para
 * poder aplicar el `greatest(0, …)` de forma atómica). O sea que la barrera
 * hacía un UPDATE cada 500 ms sobre la MISMA fila de `viaje` que las 22 fotos de
 * la ráfaga están actualizando con sus `+1`/`-1`. Es la RPC más llamada del
 * sistema, y cada sondeo compite por el mismo row lock que el trabajo de verdad.
 *
 * ── LO QUE NO SE PUEDE PERDER AL CAMBIARLO ─────────────────────────────────
 *
 * La 0031 dice, con todas sus letras, que el olvido del contador muerto ocurre
 * TAMBIÉN en el sondeo: sin eso, el primer "listo" después de una invocación
 * muerta ve un `+1` huérfano, espera la barrera completa y le miente al operador
 * diciéndole que su liquidación salió corta. Ese olvido lo hacía la escritura.
 *
 * Por eso este SELECT trae las DOS columnas y aplica la misma regla de los 10
 * minutos del lado del cliente: un contador vivo con sello vencido —o sin
 * sello— es basura de un proceso que no volvió, y vale 0. El `-1` de la foto y
 * el `+1` que sella siguen siendo la RPC, que es donde la atomicidad importa;
 * lo único que deja de escribir es la pregunta.
 */
export async function intakePendientes(viajeId: string): Promise<number | null> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('viaje')
    .select('intake_pendientes, intake_pendientes_en')
    .eq('id', viajeId)
    .maybeSingle(), 'intakePendientes');
  if (error) {
    // Mismo contrato que `intakeDelta`: `null` es "no sé", y "no sé" NO abre la
    // barrera. Devolver 0 aquí sería el fallo que su comentario documenta.
    logger.warn('intake.sondeo', { viaje: viajeId, code: error.code, msg: error.message });
    return null;
  }
  // La fila no existe (viaje borrado a media ráfaga): no hay nada en vuelo que
  // esperar, y quedarse esperando a un viaje que no está sería colgar al
  // operador hasta el tope.
  if (!data) return 0;
  const n = typeof data.intake_pendientes === 'number' ? data.intake_pendientes : 0;
  if (n <= 0) return 0;
  const sello = data.intake_pendientes_en ? Date.parse(String(data.intake_pendientes_en)) : NaN;
  if (!Number.isFinite(sello) || Date.now() - sello > TTL_INTAKE_MS) {
    logger.info('intake.contador_vencido', { viaje: viajeId, pendientes: n });
    return 0;
  }
  return n;
}

/**
 * Los 10 minutos de la 0031. Un `+1` más viejo que esto es de un proceso que no
 * volvió: el tope de la función son 120 s, así que son 5× el peor caso legítimo.
 * El número vive aquí Y en la migración; `barrera.test.ts` fija la regla.
 */
const TTL_INTAKE_MS = 10 * 60_000;

/**
 * Espera a que NO haya OCR de fotos en vuelo para el viaje (contador = 0). Es la
 * barrera que garantiza que el "listo" cuadre sobre TODOS los gastos, no parciales.
 * NUNCA espera indefinido: tope configurable (env LIKIDA_INTAKE_ESPERA_MS, default
 * 20s — NO 60s: el presupuesto de la función es maxDuration=120 (webhook) y por debajo de
 * esta barrera todavía corren el lock y el agente). Devuelve true si se vació,
 * false si venció el tope (→ el caller avisa al operador y cuadra con lo que
 * alcanzó). El decremento vive en el `finally` del intake, así que un OCR que
 * truena igual libera su +1.
 */
export async function esperarIntake(
  viajeId: string,
  timeoutMs?: number,
  // probe inyectable SOLO para test (default = el contador real). No cambia el
  // comportamiento en runtime; permite probar la gracia anti-carrera sin DB.
  //
  // El default era `intakeDelta(id, 0)` — una ESCRITURA por sondeo, cada 500 ms,
  // sobre la misma fila que la ráfaga está actualizando. Ver `intakePendientes`.
  probe: (id: string) => Promise<number | null> = intakePendientes,
): Promise<boolean> {
  // Default 20s, NO 60s. El presupuesto de la función es maxDuration=60 y por
  // debajo de esta barrera todavía corren el lock (12s) y el agente (40s): con
  // 60s aquí el peor caso son 112s, y cuando revienta Meta YA recibió su 200 OK
  // y el mensaje quedó marcado como procesado. Ese "listo" se pierde sin
  // reintento y sin que nadie se entere. El env puede subirlo si el plan aguanta.
  const tope = timeoutMs ?? (Number(process.env.LIKIDA_INTAKE_ESPERA_MS) || 20_000);
  // AUDIT_V3 orquestación CRÍTICO (carrera de barrera): cuando fotos y "listo"
  // llegan en el MISMO lote, corren en Promise.all; el "listo" puede leer el
  // contador ANTES de que una foto registre su +1 → ve 0 → cuadra sobre parciales.
  // GRACIA inicial: si el contador arranca en 0, se espera una ventana corta para
  // dar tiempo a que las fotos de la ráfaga incrementen antes de confiar en el 0.
  // FLAG (HARD RULE 3): configurable por env LIKIDA_INTAKE_GRACE_MS. Default 2s;
  // con 0 la carrera fotos+"listo" cierra sobre datos parciales, y es el ÚNICO
  // camino que no le avisa nada al operador: su liquidación sale corta.
  const grace = Number(process.env.LIKIDA_INTAKE_GRACE_MS) || 2_000;
  const start = Date.now();
  // `null` es "no sé", y no puede abrir la barrera. Fail-CLOSED: se sigue
  // esperando hasta el tope y se devuelve `false`, que es lo que hace que el
  // operador reciba el aviso de "cuadré con los N que alcancé a procesar". Antes
  // un error de RPC devolvía 0 y abría la barrera en silencio, que es el único
  // camino en el que la liquidación sale corta SIN decírselo a nadie.
  const vacio = async (): Promise<boolean> => {
    const n = await probe(viajeId);
    return n !== null && n <= 0;
  };
  if (grace > 0 && (await vacio())) {
    await sleep(Math.min(grace, tope));
  }
  for (;;) {
    if (await vacio()) return true;
    if (Date.now() - start >= tope) return false;
    await sleep(500);
  }
}

/**
 * Libera el mutex del viaje (best-effort; si falla, expira por TTL).
 *
 * AUDITORÍA 24 · BE-11: con `token`, la base solo borra el lease SI ES EL
 * SUYO. Sin token se conserva el contrato viejo —soltar el lease sin firma—,
 * que es lo único que puede soltar los leases que ya estén vivos cuando la
 * 0280 se aplique.
 */
export async function releaseViajeLock(viajeId: string, token?: string): Promise<void> {
  try {
    const args: Record<string, unknown> = { p_viaje: viajeId };
    if (token) args.p_token = token;
    await acotada(supabaseAdmin().rpc('unlock_viaje', args), 'releaseViajeLock');
  } catch (e) {
    logger.warn('viaje.unlock', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Libera el claim de idempotencia de un mensaje (CR-2): si el procesamiento
 * crashea, se borra la marca para que el retry de Meta lo reprocese (at-least-once).
 */
export async function releaseMessageClaim(waMessageId: string, leaseToken?: string, leaseOwner?: string): Promise<void> {
  if (!waMessageId) return;
  try {
    if (!leaseToken || !leaseOwner) {
      logger.warn('wa.release_claim_sin_token', { id: waMessageId });
      return;
    }
    const { data, error } = await acotada(supabaseAdmin().rpc('fail_wa_mensaje_procesado', {
      p_wa_message_id: waMessageId, p_lease_token: leaseToken, p_lease_owner: leaseOwner,
    }), 'releaseMessageClaim');
    if (error) throw error;
    if (data !== true && !(Array.isArray(data) && data[0] === true)) logger.warn('wa.release_claim_fenced', { id: waMessageId });
  } catch (e) {
    logger.warn('wa.release_claim', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Devuelve el tenant de un teléfono SIN el filtro de `activo` — para atender
 * el medio ARCO de un operador DADO DE BAJA (auditoría 12, MEDIO legal):
 * `resolveOperador` filtra `activo = true`, así que quien ya no trabaja en la
 * flota —la población más probable de ejercer cancelación/oposición— no podía
 * ser resuelto y el canal le decía "no te tengo registrado".
 */
export async function buscarTenantPorTelefono(telefono: string): Promise<string | null> {
  // AUDITORÍA 13, MEDIO (legal): sin `order` ni `.limit(2)`, un teléfono en DOS
  // flotas elegía un tenant ARBITRARIO y le decía al titular que el responsable
  // era la empresa equivocada. Mismo criterio que `resolveOperador`: ante la
  // ambigüedad se niega (null → el caller le pide identificar la flota).
  const { data, error } = await acotada(supabaseAdmin()
    .from('operador')
    .select('tenant_id')
    .in('telefono', variantesTelefono(telefono))
    .limit(2), 'buscarTenantPorTelefono');
  if (error) throw new Error(`buscarTenantPorTelefono: ${error.message}`);
  const filas = data ?? [];
  if (filas.length !== 1) return null;
  return (filas[0]?.tenant_id as string | undefined) ?? null;
}
