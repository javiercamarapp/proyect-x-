// ═══════════════════════════════════════════════════════════════════════════
// ÉXITO DEL CLIENTE (0218) — los seis agentes del departamento que vigila a la
// flota que YA firmó: onboarding_cliente, exito_cliente, retencion,
// cobranza_saas, soporte y atencion_faq.
//
// Los cinco de este archivo son DETERMINISTAS: cero modelo. La sexta rama
// (atencion_faq) sí redacta con LLM y vive aparte, en `./faq`, con su propio
// presupuesto y sus dos guardias — se importa dinámicamente para no arrastrar
// el registro de tools del analista a cada corrida del runner.
//
// LAS REGLAS QUE GOBIERNAN TODO EL ARCHIVO:
//
//  1. HONESTIDAD DE VACÍO. Hoy Likida tiene CERO clientes de pago. Un agente
//     de éxito del cliente sin clientes tiene que decir eso — «0 flotas»,
//     «0 suscripciones», «sin actividad en la ventana» — y no fabricar una
//     lista de nada. Cada motor de aquí produce el parte que corresponde al
//     mundo que midió, incluido el mundo vacío.
//  2. NULL JAMÁS ES 0. Una casilla del checklist que no se pudo medir se
//     reporta como «no se pudo medir», que no es «pendiente»; un conteo que
//     PostgREST no devolvió LANZA en vez de convertirse en cero.
//  3. EL AGENTE PREPARA, EL HUMANO DECIDE Y MANDA. Ninguno de los seis toca
//     un canal hacia el cliente. La secuencia día 0/1/3/7 del onboarding sale
//     como AVISOS AL OPERADOR; el reporte de valor y los recordatorios de
//     cobranza salen como BORRADORES a la bandeja de /admin/aprobaciones para
//     que Javier los edite y los mande. Lo único que sale solo es la alerta al
//     OPERADOR (alertarOperador), que va a Javier, no al cliente.
//  4. IDEMPOTENCIA POR CONSTRAINT, NUNCA POR `if`. Cada pieza lleva título
//     determinista por periodo (o por factura, o por ticket) y el árbitro es
//     el índice único parcial `cola_parte_exito_por_periodo` de la 0218: el
//     pre-check de aquí ahorra lecturas, la garantía la da la base.
//  5. FAIL CLOSED Y DICHO. Una lectura caída deja la corrida en 'fallo' y
//     NINGÚN parte — un parte de «0 flotas atoradas» sobre una base ciega
//     afirmaría exactamente lo contrario de lo que pasó.
// ═══════════════════════════════════════════════════════════════════════════
import { supabaseAdmin } from '@/lib/supabase/admin';
import { acotada } from '../presupuesto';
import { traerTodo, conteo } from '../pg';
import { hoyMx, round2, mxn, numero, litros, pctCambio, fechaMx } from '@/lib/formato';
import { telefonosJefe } from '../contactos';
import { getOnboardingFlotas, type OnboardingFlota } from '@/lib/admin/onboarding';
import { getPorCobrar, type FacturaPorCobrar } from '@/lib/saas/transferencia';
import { alertarOperador } from '@/lib/observability/alerta';
import { encolarPieza } from './cola';
import { registrarCorrida, type DisparoCorrida } from './corridas';
import { logger } from '@/lib/logger';

export const AGENTES_EXITO = [
  'onboarding_cliente', 'exito_cliente', 'retencion',
  'cobranza_saas', 'soporte', 'atencion_faq',
] as const;
export type AgenteExito = (typeof AGENTES_EXITO)[number];

export function esAgenteExito(id: string): id is AgenteExito {
  return (AGENTES_EXITO as readonly string[]).includes(id);
}

/** Lo que una corrida de éxito del cliente le reporta al runner. Misma forma
 *  que la de dirección (0216): `resultado` distingue «no tocaba» de «corrió y
 *  no fabricó», que en un cron cada 4 horas no es lo mismo. */
export interface ResultadoExito {
  resultado: 'corrio' | 'saltado';
  /** Piezas que ENTRARON a la bandeja en esta corrida. */
  piezas: number;
  /** Por qué no se fabricó, cuando piezas = 0 y no es un fallo. */
  motivo?: string;
  /**
   * Gasto de modelo MEDIDO. $0 en los cinco deterministas.
   *
   * `null` = NO MEDIDO (auditoría 22, ARQ-2), que no es lo mismo que cero: el
   * proveedor omitió `usage` y anotar un 0 dejaba ciego al techo diario.
   * Es pegajoso — una llamada sin medir vuelve incierta la corrida entera.
   */
  costoUsd: number | null;
  /** EL RELOJ DE LA VUELTA se agotó a media faena y quedó trabajo sin mirar.
   *  No es un fallo y tampoco es «no había nada que hacer»: es la tercera cosa,
   *  y sin ella el runner pintaría la vuelta completa. El runner la sube a
   *  `saltadosPorReloj` (regla de la #152), que es lo que hace que el latido
   *  diga `'parcial'` en vez de `'ok'`. */
  sinTurno?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// EL RELOJ DE LA VUELTA — Y POR QUÉ NO SE LLAMA `venceEn` EN ESTE ARCHIVO
// (auditoría ciclo 7, c7-1).
//
// CUIDADO: en este módulo `venceEn` YA SIGNIFICA OTRA COSA, y confundirlas
// sería un error caro. `TicketVigilado.venceEn` es el SLA DEL TICKET —la
// columna `ticket_soporte.vence_en`, un ISO de calendario escrito al abrir el
// ticket, que `semaforoTicket` resta contra ahora para pintar el semáforo
// (0051)—. Es un plazo DEL CLIENTE, medido en horas o días, y no tiene nada
// que ver con si esta invocación de Vercel todavía cabe.
//
// Lo que este archivo NO tenía es el otro reloj: el PRESUPUESTO DE TIEMPO DE
// LA INVOCACIÓN, un epoch en milisegundos que vale para la vuelta entera del
// runner y que se apaga a los ~270 s. Para que nadie los mezcle —ni al leer ni
// al escribir la próxima rama— aquí se llama `venceEnVuelta`, con `Vuelta` de
// «la vuelta del runner». Un `venceEn: number` suelto al lado de un
// `venceEn: string` que significa el SLA de un cliente es una trampa puesta
// para el siguiente que toque el archivo.
//
// Los dos incidentes que justifican meterlo: el 25-ago-2026 («Sin latido:
// runner hace 286 min») y el 28-ago-2026 00:03 UTC —32 corridas, todas en
// `ok`, y aun así ni un latido escrito—. En los dos, un motor que iteraba por
// dentro entró UNA vez por la puerta del reloj del despacho y ya no volvió a
// mirarlo: se comió lo que quedaba del presupuesto y Vercel mató la función
// antes de que la ruta pudiera latir.
//
// Se redefine aquí en vez de importar `relojAgotado` de `runner.ts` por lo
// mismo que lo hicieron `direccion.ts` y `leads.ts` en la #158: el runner carga
// este módulo por import dinámico justo para no arrastrarlo en cada vuelta, y
// un import de vuelta cerraría el ciclo. Dos líneas no valen esa dependencia.
// ═══════════════════════════════════════════════════════════════════════════
//
// Se EXPORTA porque `faq.ts` —el sexto agente de éxito, que vive en su propio
// archivo por el peso del corpus— necesita exactamente la misma pregunta, y ya
// importa de aquí `encolarPiezaExito`, `piezaExistente` y `cuentaComoRespuesta`.
// Una segunda copia allá sería la tercera definición de dos líneas idénticas, y
// lo que se busca es justo lo contrario: que buscar `relojAgotado` en el fuente
// encuentre a TODOS los que preguntan la hora — y, por omisión, a los que no.
export function relojAgotado(venceEnVuelta: number | undefined): boolean {
  return venceEnVuelta !== undefined && Date.now() >= venceEnVuelta;
}

// ── Topes declarados ───────────────────────────────────────────────────────

/** Flotas que una corrida mira. Muy por encima de la escala real (hoy son
 *  unidades); si algún día se rebasa, el parte lo DICE en vez de callar las
 *  que no cupieron — una lista truncada en silencio es una lista falsa. */
export const TOPE_FLOTAS = 500;
/** Tickets que una corrida de soporte revisa. */
export const TOPE_TICKETS = 200;
/** Mensajes que se miran por ticket para decidir si hay respuesta (c6-5).
 *  Un hilo de soporte son decenas de filas; 500 es techo, no expectativa —
 *  y con 500 mensajes públicos la pregunta «¿alguien contestó?» ya está
 *  contestada por cualquiera de los primeros. */
export const TOPE_MENSAJES_POR_TICKET = 500;

/** Días sin NINGUNA señal de vida a partir de los cuales una flota entra al
 *  parte de silencio. Dos semanas: una flota que liquida viajes toca el
 *  sistema varias veces por semana, y una semana sola se la come un puente. */
export const DIAS_SILENCIO = 14;
/** Caída de uso semana contra semana que enciende el gatillo de riesgo. */
export const CAIDA_RIESGO_PCT = 40;
/** Subida que enciende el gatillo de expansión. */
export const SUBIDA_EXPANSION_PCT = 40;
/** Piso de viajes de la semana base: caer de 2 a 1 es −50% y no es señal de
 *  nada — un porcentaje sobre base chica grita por ruido. */
export const PISO_VIAJES_SEMANA = 3;
/** Corridas en 'fallo' de la MISMA flota en 7 días que encienden riesgo. */
export const FALLOS_RIESGO = 3;
/** Los cinco toques de la cadencia de dunning, en días contra el vencimiento
 *  (diseño agente-cobranza-saas.md): tres días antes, el día, y +3/+7/+15. */
export const HITOS_COBRANZA = [-3, 0, 3, 7, 15] as const;

// ── Fechas (día de México, aritmética UTC pura — `hoy` es inyectable) ──────

/** El lunes de la semana de `hoy` ('YYYY-MM-DD'). Mismo ancla que el parte
 *  semanal de finanzas: la semana tiene UN parte, lo fabrique la pasada del
 *  runner que lo fabrique. */
export function lunesDeSemana(hoy: string): string {
  const d = new Date(`${hoy}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** El mes ANTERIOR al de `hoy`, 'YYYY-MM'. */
export function mesAnterior(hoy: string): string {
  const d = new Date(`${hoy.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10).slice(0, 7);
}

/** Días completos entre dos instantes ISO (b − a). Negativo si b es antes. */
export function diasEntreIso(a: string, b: string): number {
  return Math.floor((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/** Días entre dos fechas 'YYYY-MM-DD' (b − a), en calendario. */
export function diasEntreDias(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** El instante ISO de hace `dias` días contado desde el mediodía de `hoy`
 *  (mediodía para que el propio cálculo no cruce de fecha). */
function hace(dias: number, hoy: string): string {
  return new Date(Date.parse(`${hoy}T12:00:00Z`) - dias * 86_400_000).toISOString();
}

// ── La pieza hacia la bandeja, con su idempotencia ─────────────────────────

/** ¿Ya existe esta pieza (cualquier estado)? LANZA si no se puede saber:
 *  sin poder verificar, no se fabrica (fail closed). El árbitro REAL de la
 *  carrera sigue siendo el índice único de la 0218 — esto solo ahorra el
 *  trabajo de armarla. */
export async function piezaExistente(agente: AgenteExito, titulo: string): Promise<boolean> {
  const { count, error } = await acotada(supabaseAdmin()
    .from('cola_aprobacion')
    .select('id', { count: 'exact', head: true })
    .eq('agente', agente)
    .eq('titulo', titulo), 'exito.pieza_existente');
  if (error) throw new Error(`piezaExistente(${agente}): ${error.message}`);
  if (typeof count !== 'number') throw new Error(`piezaExistente(${agente}): PostgREST no devolvió el conteo.`);
  return count > 0;
}

/** Encola la pieza. El índice único de la 0218 es el árbitro: si otra corrida
 *  ganó la carrera del mismo título, el duplicado rebota y se trata como «ya
 *  existía», no como fallo. */
export async function encolarPiezaExito(
  agente: AgenteExito, tipo: string, titulo: string, cuerpo: string,
  fuentes: Record<string, unknown>,
  tenantId?: string | null,
): Promise<'encolada' | 'ya_existia'> {
  try {
    await encolarPieza({ tipo, prioridad: 'normal', agente, titulo, cuerpo, fuentes, tenantId: tenantId ?? null });
    return 'encolada';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('duplicate key') || msg.includes('cola_parte_exito_por_periodo')) return 'ya_existia';
    throw e;
  }
}

/** Registra la corrida. Jamás lanza (contrato de corridas.ts). Todas van con
 *  tenant NULL: una pasada barre TODAS las flotas, así que la corrida no es
 *  de ninguna en particular — las PIEZAS sí llevan tenant cuando toca. */
async function anotar(
  agente: AgenteExito, inicio: Date, estado: 'ok' | 'fallo', disparo: DisparoCorrida,
  resumen: Record<string, unknown>, error?: string, costoUsd = 0,
): Promise<void> {
  await registrarCorrida(null, agente, {
    inicio, fin: new Date(), estado, disparo, costoUsd,
    ...(estado === 'ok' ? { tareasHechas: 1, tareasTotal: 1 } : {}),
    resumen,
    ...(error ? { error } : {}),
  });
}

// ── Lecturas compartidas ───────────────────────────────────────────────────

export interface Flota {
  id: string;
  nombre: string;
  /** Alta de la flota — `tenant.created_at`. Es el día 0 del onboarding. */
  creadaEn: string;
  /** Override CRUDO de política de gastos (`tenant.config.politica`), el
   *  mismo criterio que `getResumenNegocio`: `getConfig()` fusiona con los
   *  defaults y no distingue «propia» de «heredada». */
  politicaPropia: boolean;
}

/** AGB-10 (auditoría 24, 1-sep-2026): los tenants de QA se siembran con el
 *  prefijo `ZZZ QA ` a propósito (para ordenar al final en listas por
 *  nombre) — pero ningún agente los excluía. Medido en producción: de 24
 *  `tenant`, 2 son "ZZZ QA …" y el parte de onboarding decía "Flotas en
 *  seguimiento: 3" contándolas como reales. Vive aquí (no una columna
 *  `es_qa`, que exigiría migración) porque es el mismo criterio que ya
 *  siembra los datos de prueba: el nombre lo dice. */
const PREFIJO_TENANT_QA = 'ZZZ QA %';

/** Las flotas del sistema. LANZA ante un error de lectura. `truncado` avisa
 *  de que hay más de las que caben — el parte lo dice, no lo esconde.
 *  AGB-10: excluye los tenants "ZZZ QA …" — no son flotas reales. */
export async function leerFlotas(): Promise<{ flotas: Flota[]; truncado: boolean }> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('tenant')
    .select('id, nombre, created_at, config')
    .not('nombre', 'ilike', PREFIJO_TENANT_QA)
    .order('created_at', { ascending: true })
    .limit(TOPE_FLOTAS + 1), 'exito.flotas');
  if (error) throw new Error(`leerFlotas: ${error.message}`);
  const filas = (data ?? []) as Array<{ id: string; nombre: string; created_at: string; config: unknown }>;
  const truncado = filas.length > TOPE_FLOTAS;
  return {
    truncado,
    flotas: filas.slice(0, TOPE_FLOTAS).map((t) => ({
      id: t.id,
      nombre: t.nombre,
      creadaEn: t.created_at,
      politicaPropia: Array.isArray((t.config as { politica?: unknown } | null)?.politica),
    })),
  };
}

/** Conteo EXACTO en la base de una tabla por tenant y ventana. Un `count` que
 *  no llegó como número NO es 0 — es «no se pudo contar», y LANZA. */
export async function contarDeFlota(
  tabla: string, columnaFecha: string, tenantId: string,
  desdeIso: string | null, hastaIso: string | null, etiqueta: string,
): Promise<number> {
  let q = supabaseAdmin().from(tabla).select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
  if (desdeIso !== null) q = q.gte(columnaFecha, desdeIso);
  if (hastaIso !== null) q = q.lt(columnaFecha, hastaIso);
  const { count, error } = await acotada(q, etiqueta);
  if (error) throw new Error(`${etiqueta}: ${error.message}`);
  if (typeof count !== 'number') throw new Error(`${etiqueta}: PostgREST no devolvió el conteo — no se afirma un 0 que nadie midió.`);
  return count;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · ONBOARDING DEL CLIENTE — de la firma al primer viaje liquidado
// (03-Atencion-al-Cliente/agente-onboarding-cliente.md)
//
// El motor NO inventa un checklist propio: mide EXACTAMENTE las cinco
// casillas que /admin/flotas ya pinta (auditoría D9), porque son las cinco que
// hoy se pueden medir con datos reales. Cada casilla trae el día de la
// secuencia 0/1/3/7 del diseño en que debería estar hecha; una casilla
// pendiente pasado su día es un ATORO, y el parte dice cuál, de qué flota,
// desde hace cuánto y DÓNDE se resuelve.
//
// LA SECUENCIA SALE COMO AVISO AL OPERADOR, NO COMO CORREO AL CLIENTE. No hay
// canal de correo al cliente aprobado, así que el «día 1: llámalo» es una
// línea del parte para Javier y el cierre es humano — el agente no escribe a
// nadie.
// ═══════════════════════════════════════════════════════════════════════════

export type ClavePaso = 'telefono' | 'conectores' | 'politica' | 'avisos' | 'primer_viaje';

export interface PasoOnboarding {
  clave: ClavePaso;
  /** Día de la secuencia del diseño en que este paso debería estar hecho. */
  dia: number;
  /** Qué falta, dicho para una persona. */
  falta: string;
  /** La acción sugerida y dónde se resuelve (la misma ruta del checklist). */
  accion: string;
  /** false = su ausencia NO está rota (los avisos corren con los defaults del
   *  código). Se reporta como nota, nunca como atoro. */
  bloqueante: boolean;
}

export const PASOS_ONBOARDING: readonly PasoOnboarding[] = [
  {
    clave: 'telefono', dia: 0, bloqueante: true,
    falta: 'sin teléfono de jefe ni de dueño — la escalación por WhatsApp no tiene a quién avisar',
    accion: 'capturarlo en /admin/usuarios/nuevo',
  },
  {
    clave: 'conectores', dia: 1, bloqueante: true,
    falta: 'sin credenciales de conectores PROBADAS (guardar no es conectar: la prueba real es probada_en)',
    accion: 'probarlas en /dashboard/conexiones',
  },
  {
    clave: 'politica', dia: 3, bloqueante: true,
    falta: 'sin política de gastos propia — el motor cuadra con los topes de demo',
    accion: 'configurarla en /dashboard/politicas',
  },
  {
    clave: 'avisos', dia: 7, bloqueante: false,
    falta: 'avisos de agentes sin ajustar — corren los defaults del código (no está roto, pero nadie los decidió)',
    accion: 'ajustarlos en /dashboard/agentes/liquidacion',
  },
  {
    clave: 'primer_viaje', dia: 7, bloqueante: true,
    falta: 'ni un viaje registrado todavía — el ciclo de arranque no cerró',
    accion: 'ver /dashboard/viajes con la flota',
  },
] as const;

/** El estado de las cinco casillas. `null` = NO SE PUDO MEDIR, que no es
 *  «pendiente»: una casilla ciega jamás se cuenta como atoro. */
export interface CasillasFlota {
  telefono: boolean | null;
  conectoresProbados: number | null;
  avisos: number | null;
  politicaPropia: boolean;
  viajes: number;
}

export interface FlotaEnOnboarding {
  flota: Flota;
  /** Días desde el alta de la flota (día 0 de la secuencia). */
  dias: number;
  casillas: CasillasFlota;
}

export interface Atoro { flota: string; dias: number; paso: PasoOnboarding }

/** ¿Está hecha esta casilla? `null` = no se pudo medir. PURA. */
export function casillaHecha(c: CasillasFlota, clave: ClavePaso): boolean | null {
  switch (clave) {
    case 'telefono': return c.telefono;
    case 'conectores': return c.conectoresProbados === null ? null : c.conectoresProbados > 0;
    case 'politica': return c.politicaPropia;
    case 'avisos': return c.avisos === null ? null : c.avisos > 0;
    case 'primer_viaje': return c.viajes > 0;
  }
}

/** Los pasos VENCIDOS de una flota: pendientes y con su día ya pasado. Una
 *  casilla ciega no entra — «no se pudo medir» no es «falta». PURA. */
export function detectarAtoros(f: FlotaEnOnboarding): Atoro[] {
  return PASOS_ONBOARDING
    .filter((p) => f.dias >= p.dia && casillaHecha(f.casillas, p.clave) === false)
    .map((p) => ({ flota: f.flota.nombre, dias: f.dias, paso: p }));
}

/** Los pasos cuyo día de la secuencia cae HOY: el aviso 0/1/3/7 que le toca
 *  al operador dar hoy, esté o no hecha la casilla. PURA. */
export function avisosDeHoy(f: FlotaEnOnboarding): PasoOnboarding[] {
  return PASOS_ONBOARDING.filter((p) => p.dia === f.dias).slice();
}

/** Días desde el alta a partir de los cuales una flota SIN un solo viaje es
 *  un ROJO que no espera a la bandeja: el onboarding se murió. */
export const DIAS_ONBOARDING_MUERTO = 14;

export function armarParteOnboarding(
  flotas: FlotaEnOnboarding[], hoy: string, truncado: boolean,
): { cuerpo: string; atoros: Atoro[]; muertas: string[] } {
  const atoros = flotas.flatMap(detectarAtoros);
  const muertas = flotas
    .filter((f) => f.dias >= DIAS_ONBOARDING_MUERTO && f.casillas.viajes === 0)
    .map((f) => f.flota.nombre);

  const lineas: string[] = [`ONBOARDING — ${hoy}`, ''];

  if (flotas.length === 0) {
    lineas.push('0 flotas dadas de alta: no hay onboarding que vigilar. No es un fallo — es el estado real del sistema (tabla tenant, conteo en base).');
  } else {
    lineas.push(`Flotas en seguimiento: ${numero(flotas.length)}${truncado ? ` (SOLO LAS PRIMERAS ${numero(TOPE_FLOTAS)} — hay más y este parte no las cubre)` : ''}`);
    lineas.push('');
    for (const f of flotas) {
      const propios = detectarAtoros(f);
      const ciegas = PASOS_ONBOARDING.filter((p) => casillaHecha(f.casillas, p.clave) === null);
      const hechas = PASOS_ONBOARDING.filter((p) => casillaHecha(f.casillas, p.clave) === true).length;
      lineas.push(`${f.flota.nombre} — día ${numero(f.dias)} desde el alta (${fechaMx(f.flota.creadaEn)}) · ${numero(hechas)} de ${numero(PASOS_ONBOARDING.length)} casillas hechas`);
      for (const a of propios) {
        lineas.push(`  ${a.paso.bloqueante ? '[ATORO]' : '[NOTA] '}  día ${a.paso.dia} · ${a.paso.falta}`);
        lineas.push(`           acción sugerida: ${a.paso.accion}`);
      }
      for (const c of ciegas) {
        lineas.push(`  [CIEGO]  ${c.clave}: no se pudo medir — que NO es lo mismo que «pendiente». No se cuenta como atoro.`);
      }
      const hoyToca = avisosDeHoy(f);
      for (const p of hoyToca) {
        lineas.push(`  [AVISO]  hoy es el día ${p.dia} de la secuencia: toca el contacto de ${p.clave}. Lo hace un humano — el agente no le escribe al cliente.`);
      }
      if (propios.length === 0 && ciegas.length === 0 && hoyToca.length === 0) {
        lineas.push('  Sin atoros: todas las casillas medibles están hechas.');
      }
    }
  }

  if (muertas.length > 0) {
    lineas.push('');
    lineas.push(`[ROJO]  ${muertas.length === 1 ? 'Una flota lleva' : `${numero(muertas.length)} flotas llevan`} ${numero(DIAS_ONBOARDING_MUERTO)} días o más sin UN solo viaje: ${muertas.join(', ')}. El arranque no ocurrió; esto se resuelve con una llamada, no con otro correo.`);
  }

  lineas.push('');
  lineas.push('La secuencia día 0/1/3/7 del diseño sale AQUÍ, como aviso al operador: no hay canal de correo al cliente aprobado, así que el agente no manda nada — prepara, y el cierre es humano.');
  lineas.push('Fuentes: tenant (alta y política propia) · telefonosJefe (app_user) · getOnboardingFlotas (conector_credencial.probada_en, agente_notificacion_config) · conteo de viaje por flota. Las cinco casillas son las de /admin/flotas (auditoría D9).');
  return { cuerpo: lineas.join('\n'), atoros, muertas };
}

async function correrOnboarding(disparo: DisparoCorrida, hoy: string, venceEnVuelta?: number): Promise<ResultadoExito> {
  const inicio = new Date();
  const agente = 'onboarding_cliente';
  const titulo = `Onboarding — ${hoy}`;
  try {
    if (await piezaExistente(agente, titulo)) {
      await anotar(agente, inicio, 'ok', disparo, { parte: 'ya_existia', titulo });
      return { resultado: 'corrio', piezas: 0, motivo: 'el parte de hoy ya está en la bandeja', costoUsd: 0 };
    }

    const { flotas, truncado } = await leerFlotas();
    const ids = flotas.map((f) => f.id);

    // Las dos lecturas cross-tenant son BEST-EFFORT a propósito: si una se
    // cae, sus casillas quedan en `null` («no se pudo medir») y el parte sale
    // igual con lo demás. La alternativa —tumbar el parte entero porque una
    // de cinco casillas no contestó— dejaría a Javier sin la lista de atoros
    // que sí se pudo armar.
    const [tel, ob] = await Promise.all([
      ids.length === 0 ? Promise.resolve({} as Record<string, string>) : telefonosJefe(ids).catch((e) => {
        logger.warn('exito.onboarding.telefonos_ciegos', { err: e instanceof Error ? e.message : String(e) });
        return null;
      }),
      getOnboardingFlotas().catch((e) => {
        logger.warn('exito.onboarding.credenciales_ciegas', { err: e instanceof Error ? e.message : String(e) });
        return null;
      }),
    ]);

    const enOnboarding: FlotaEnOnboarding[] = [];
    for (const f of flotas) {
      // ── EL RELOJ, ANTES DE LA CONSULTA DE CADA FLOTA (c7-1) ───────────────
      // Este `for` hace UNA ida a la base POR FLOTA (`contarDeFlota`), así que
      // con el tope de 500 flotas son 500 consultas en serie dentro de una
      // función que Vercel mata a los 300 s. Es exactamente la forma del
      // incidente: el candado 0 del runner preguntó la hora UNA vez, antes de
      // despachar este agente, y aquí adentro ya nadie la volvió a preguntar.
      //
      // POR QUÉ EL CORTE ABANDONA EL PARTE EN VEZ DE PUBLICARLO A MEDIAS —
      // ésta es la parte importante y es la regla del #160 aplicada aquí. El
      // parte es idempotente POR TÍTULO (`Onboarding — 2026-08-27`, arbitrado
      // por el índice único de la 0218): encolar uno armado con 3 de 500 flotas
      // SELLA EL DÍA. La pasada de dentro de cuatro horas encontraría
      // «ya_existia» y no fabricaría nunca el parte completo — o sea que un
      // corte por reloj enterraría el parte del día entero, igual que una
      // reserva tomada y no usada enterraba el aviso de peaje del mes. Y sería
      // peor que no cortar: el parte diría «Flotas en seguimiento: 3» sin
      // mentir en ninguna línea y aun así sería falso de cabo a rabo.
      //
      // Así que el punto seguro de corte es AQUÍ, ANTES de gastar la consulta y
      // ANTES de sellar nada: se tira lo armado —que no cuesta nada, es
      // memoria— y se dice `sinTurno`. Lo que no se hizo se hace completo en la
      // próxima pasada, que es lo único que produce un parte honesto.
      if (relojAgotado(venceEnVuelta)) {
        const sinMirar = flotas.length - enOnboarding.length;
        logger.warn('exito.onboarding.corte_por_reloj', { sinMirar, miradas: enOnboarding.length });
        await anotar(agente, inicio, 'ok', disparo, { parte: 'sin_turno', sin_mirar: sinMirar, miradas: enOnboarding.length });
        return {
          resultado: 'corrio', piezas: 0, costoUsd: 0, sinTurno: true,
          motivo: `el reloj de la vuelta se agotó con ${numero(sinMirar)} flota(s) sin mirar — el parte de hoy NO se fabricó a medias (sellaría el día con una lista incompleta); le toca completo en la próxima pasada`,
        };
      }
      // El conteo de viajes SÍ es duro: es la casilla que define si el
      // arranque ocurrió, y un 0 inventado diría que la flota nunca trabajó.
      const viajes = await contarDeFlota('viaje', 'created_at', f.id, null, null, 'exito.onboarding.viajes');
      const obf: OnboardingFlota | null = ob === null
        ? null
        : ob.get(f.id) ?? {
            credenciales: { total: 0, probadas: 0 },
            avisosConfigurados: 0,
            avisoPrivacidad: { razonSocial: false, domicilio: false },
          };
      enOnboarding.push({
        flota: f,
        dias: Math.max(0, diasEntreIso(f.creadaEn, `${hoy}T12:00:00Z`)),
        casillas: {
          telefono: tel === null ? null : Boolean(tel[f.id]),
          conectoresProbados: obf === null ? null : obf.credenciales.probadas,
          avisos: obf === null ? null : obf.avisosConfigurados,
          politicaPropia: f.politicaPropia,
          viajes,
        },
      });
    }

    const { cuerpo, atoros, muertas } = armarParteOnboarding(enOnboarding, hoy, truncado);

    // El ROJO no espera a que alguien abra la bandeja. Sale ANTES de encolar
    // a propósito: si la pieza no pudiera entrar, el hallazgo ya salió.
    if (muertas.length > 0) {
      await alertarOperador('exito.onboarding_muerto', {
        error: `Onboarding sin arrancar (${numero(DIAS_ONBOARDING_MUERTO)} días o más sin un solo viaje): ${muertas.join(', ')}.`.slice(0, 900),
        codigo: 'exito_onboarding_sin_primer_viaje',
      });
    }

    const res = await encolarPiezaExito(agente, 'parte_onboarding', titulo, cuerpo, {
      flotas: enOnboarding.length, atoros: atoros.length, muertas: muertas.length, truncado,
      consultas: ['tenant', 'telefonosJefe', 'getOnboardingFlotas', 'viaje (conteo por flota)'],
    });
    await anotar(agente, inicio, 'ok', disparo, { parte: res, flotas: enOnboarding.length, atoros: atoros.length });
    return {
      resultado: 'corrio',
      piezas: res === 'encolada' ? 1 : 0,
      motivo: res === 'ya_existia' ? 'otra corrida ganó el periodo' : undefined,
      costoUsd: 0,
    };
  } catch (e) {
    await anotar(agente, inicio, 'fallo', disparo, { dia: hoy },
      `No se pudo armar el parte de onboarding: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500));
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2 · ÉXITO DEL CLIENTE — el silencio y el reporte mensual de valor
// (03-Atencion-al-Cliente/agente-exito-del-cliente.md)
//
// DOS productos, cada uno con su idempotencia:
//   · SILENCIO (diario): flotas sin UNA señal de vida en 14 días. Actividad =
//     viajes creados, gastos capturados o conversaciones de WhatsApp tocadas.
//     `wa_mensaje_procesado` NO participa: no tiene tenant_id y atribuirlo a
//     una flota sería inventarlo (lo documenta analytics.ts).
//   · VALOR (mensual, desde el día 3): un borrador POR FLOTA con las cifras
//     REALES de su mes — cada una con su consulta nombrada en la misma línea.
//     Va a la bandeja CON tenant para que Javier lo edite y lo mande: el
//     agente no le escribe al cliente.
// ═══════════════════════════════════════════════════════════════════════════

export interface ActividadFlota {
  flota: Flota;
  viajesVentana: number;
  gastosVentana: number;
  conversacionesVentana: number;
  /** Viajes de TODA su historia: una flota que nunca tuvo actividad no está
   *  «en silencio» — está en onboarding, y ese es otro agente. */
  viajesHistoricos: number;
}

export function enSilencio(a: ActividadFlota): boolean {
  return a.viajesHistoricos > 0
    && a.viajesVentana === 0 && a.gastosVentana === 0 && a.conversacionesVentana === 0;
}

export function armarParteSilencio(actividad: ActividadFlota[], hoy: string): string {
  const calladas = actividad.filter(enSilencio);
  const lineas = [
    `SILENCIO — ${hoy}`,
    '',
    `Ventana: ${numero(DIAS_SILENCIO)} días. Actividad = viajes creados, gastos capturados o conversaciones de WhatsApp tocadas (las tres tablas con tenant_id real).`,
    '',
  ];
  for (const a of calladas) {
    lineas.push(`[SILENCIO]  ${a.flota.nombre}: 0 viajes, 0 gastos y 0 conversaciones en ${numero(DIAS_SILENCIO)} días, con ${numero(a.viajesHistoricos)} viajes en su historia.`);
    lineas.push('            Una flota que trabajaba y dejó de aparecer no se recupera con un correo: la llamada la hace un humano.');
  }
  const arrancando = actividad.filter((a) => a.viajesHistoricos === 0);
  if (arrancando.length > 0) {
    lineas.push('');
    lineas.push(`No se cuentan como silencio ${numero(arrancando.length)} ${arrancando.length === 1 ? 'flota que nunca ha tenido' : 'flotas que nunca han tenido'} actividad: eso es onboarding sin arrancar, y lo vigila el agente de onboarding.`);
  }
  lineas.push('');
  lineas.push('Fuentes: conteos EN BASE de viaje.created_at, gasto.created_at y wa_conversacion.updated_at por tenant. wa_mensaje_procesado NO participa: no tiene tenant_id y atribuirlo sería inventar la atribución.');
  return lineas.join('\n');
}

// ARQ-A5 (auditoría 28): las liquidaciones que sostienen las cifras de dinero
// de este reporte son las FIRMADAS — mismo criterio que la RPC
// `acreditables_liquidacion_tenant` (mig. 0308) y que `ivaSostenible` en
// fiscal.ts: `revision in ('aprobada', 'ajustada')`. Antes de este arreglo el
// `select` de `leerValorDelMes` ni siquiera pedía `revision`, así que las
// sumas de dinero mezclaban firmadas con pendientes y rechazadas mientras el
// texto del reporte afirmaba «la misma columna que la RPC» — dos números
// distintos bajo un rótulo que juraba ser el mismo. La constante vive AQUÍ
// (no en `revision.ts`) porque este lote solo toca `exito.ts`/`comercial.ts`/
// `soporte.ts` — si otro archivo necesita el mismo predicado, se sube a
// `revision.ts` entonces, no antes.
const REVISIONES_FIRMADAS = ['aprobada', 'ajustada'] as const;
function esRevisionFirmada(revision: unknown): boolean {
  return (REVISIONES_FIRMADAS as readonly unknown[]).includes(revision);
}

/** Las cifras del mes de UNA flota. Todo lo que se afirma se contó o se sumó;
 *  `incompleto` marca que la ventana rebasó el tope y el total NO se afirma.
 *  Las SUMAS de dinero (`totalComprobado`, `diferencia`, `ivaAcreditable`,
 *  `peajeAcreditable`, `litrosDiesel`) SOLO cuentan liquidaciones FIRMADAS
 *  (`revision` aprobada|ajustada — ARQ-A5); `liquidaciones` y `porEstatus`
 *  siguen contando TODA la población del mes (no son cifras de dinero) y
 *  `porRevision` declara esa población para que el lector sepa qué falta. */
export interface ValorDelMes {
  mes: string;
  liquidaciones: number;
  porEstatus: Array<{ estatus: string; n: number }>;
  porRevision: Array<{ revision: string; n: number }>;
  totalComprobado: number;
  diferencia: number;
  ivaAcreditable: number;
  peajeAcreditable: number;
  litrosDiesel: number;
  gastosConCfdiValido: number;
  gastosDelMes: number;
  incompleto: boolean;
}

export function armarReporteValor(flota: Flota, v: ValorDelMes): string {
  const lineas = [
    `VALOR — ${flota.nombre} — ${v.mes}`,
    '',
    'BORRADOR para que Javier lo edite y lo mande. No sale solo: no hay canal de correo al cliente aprobado.',
    '',
  ];
  if (v.liquidaciones === 0) {
    lineas.push(`Liquidaciones cerradas en ${v.mes}: 0 (conteo EN BASE de liquidacion por tenant y mes).`);
    lineas.push('Un mes sin liquidaciones también es un reporte completo: no hay cifras de valor que presumir, y decirlo vale más que rellenarlo.');
  } else {
    const desglose = v.porEstatus.map((e) => `${e.estatus} ${numero(e.n)}`).join(' · ');
    const desgloseRevision = v.porRevision.map((r) => `${r.revision} ${numero(r.n)}`).join(' · ');
    lineas.push(`Viajes liquidados: ${numero(v.liquidaciones)}  (conteo EN BASE de liquidacion por tenant, created_at dentro de ${v.mes})`);
    lineas.push(`  Por estatus del cuadre: ${desglose}  (liquidacion.estatus)`);
    // ARQ-A5: esta línea es la que dice QUÉ POBLACIÓN sostiene las sumas de
    // dinero de abajo — sin ella, un lector no puede saber que "IVA
    // acreditable" no es la suma de las `liquidaciones` de la línea anterior.
    lineas.push(`  Por firma: ${desgloseRevision}  (liquidacion.revision — las cifras de dinero de abajo SOLO cuentan aprobada+ajustada)`);
    lineas.push(`Comprobado del mes (solo firmadas): ${mxn(v.totalComprobado)}  (suma de liquidacion.total_comprobado donde revision es aprobada o ajustada)`);
    lineas.push(`Diferencia que el cuadre observó (solo firmadas): ${mxn(v.diferencia)}  (suma de liquidacion.diferencia donde revision es aprobada o ajustada — es lo que el motor detectó, no lo que se recuperó)`);
    lineas.push(`IVA acreditable del mes (solo firmadas): ${mxn(v.ivaAcreditable)}  (suma de liquidacion.iva_acreditable donde revision es aprobada o ajustada — el mismo criterio que la RPC acreditables_liquidacion_tenant)`);
    lineas.push(`Peaje acreditable (50%, solo firmadas): ${mxn(v.peajeAcreditable)}  (suma de liquidacion.peaje_acreditable donde revision es aprobada o ajustada)`);
    lineas.push(`Diésel elegible (solo firmadas): ${litros(v.litrosDiesel)}  (suma de liquidacion.litros_diesel_acreditables donde revision es aprobada o ajustada — el estímulo en pesos lo calcula el contador: la cuota semanal del IEPS no vive aquí)`);
    lineas.push('');
    lineas.push(v.gastosDelMes === 0
      ? 'Comprobantes del mes: 0 (conteo EN BASE de gasto por tenant y mes).'
      : `Comprobantes validados ante el SAT: ${numero(v.gastosConCfdiValido)} de ${numero(v.gastosDelMes)}  (gasto.cfdi_valido = true; el resto NO es «inválido»: es «sin validar todavía»)`);
  }
  if (v.incompleto) {
    lineas.push('');
    lineas.push('[INCOMPLETO]  La lectura no pudo demostrar que trajo TODAS las liquidaciones del mes: los TOTALES de arriba no se afirman.');
  }
  lineas.push('');
  lineas.push('LO QUE ESTE REPORTE NO DICE: cuánto dinero se recuperó de verdad (Likida observa la diferencia, no cobra por ella), ni horas ahorradas sin declarar el supuesto. Ninguna cifra de aquí es una estimación.');
  return lineas.join('\n');
}

/** Suma el mes de UNA flota. AGB-8 (auditoría 24): antes esta lectura topaba
 *  a 2,000 filas y declaraba el mes INCOMPLETO al pasarlo — a 15,000
 *  viajes/mes eso corta el reporte de valor en el 13% del mes real. Ahora
 *  pagina de verdad con `traerTodo` (pg.ts): 100 páginas de 1,000 = 100,000
 *  filas/mes, un techo que ni Innovativos a escala completa alcanza, y LANZA
 *  si de plano no puede demostrar que trajo todo — en vez de devolver una
 *  suma parcial con cara de completa. El tope numérico desaparece: ya no hay
 *  un número que declarar rebasado. */
export async function leerValorDelMes(tenantId: string, mes: string): Promise<ValorDelMes> {
  const desde = new Date(`${mes}-01T00:00:00-06:00`).toISOString();
  const finMes = new Date(`${mes}-01T00:00:00Z`);
  finMes.setUTCMonth(finMes.getUTCMonth() + 1);
  const hasta = new Date(`${finMes.toISOString().slice(0, 7)}-01T00:00:00-06:00`).toISOString();

  const filas = await traerTodo<Record<string, unknown>>(
    (d, h) => acotada(supabaseAdmin()
      .from('liquidacion')
      // ARQ-A5: `revision` entra al select — sin ella no hay forma de aplicar
      // el mismo predicado que la 0308 y las sumas de dinero de abajo suman
      // TODA la población en vez de solo la firmada.
      .select('estatus, revision, total_comprobado, diferencia, iva_acreditable, peaje_acreditable, litros_diesel_acreditables', conteo(d))
      .eq('tenant_id', tenantId)
      .gte('created_at', desde)
      .lt('created_at', hasta)
      .order('id')
      .range(d, h), 'exito.valor.liquidaciones'),
    'exito.valor.liquidaciones',
  );

  const porEstatus = new Map<string, number>();
  const porRevision = new Map<string, number>();
  let totalComprobado = 0, diferencia = 0, iva = 0, peaje = 0, dieselL = 0;
  for (const f of filas) {
    const est = String(f.estatus);
    porEstatus.set(est, (porEstatus.get(est) ?? 0) + 1);
    const rev = String(f.revision);
    porRevision.set(rev, (porRevision.get(rev) ?? 0) + 1);
    // ARQ-A5: las SUMAS de dinero solo cuentan liquidaciones FIRMADAS — mismo
    // predicado que `acreditables_liquidacion_tenant` (0308). `liquidaciones`
    // y `porEstatus` (abajo) siguen contando TODA la población: no son cifras
    // de dinero y su rótulo no afirma "firmadas".
    if (esRevisionFirmada(f.revision)) {
      totalComprobado += Number(f.total_comprobado ?? 0);
      diferencia += Number(f.diferencia ?? 0);
      iva += Number(f.iva_acreditable ?? 0);
      peaje += Number(f.peaje_acreditable ?? 0);
      dieselL += Number(f.litros_diesel_acreditables ?? 0);
    }
  }
  // El CONTEO ya es exacto: `traerTodo` demostró que `filas` son TODAS las
  // del mes (count o página vacía) — no hace falta una consulta aparte
  // (antes divergía de las sumas: el conteo se leía SIN tope y las sumas SÍ
  // lo tenían, dos consultas que podían no acordar por una fila insertada
  // entre las dos).
  const liquidaciones = filas.length;

  // Las dos lecturas de `gasto` son independientes entre sí — en paralelo,
  // mismo criterio AGB-8 que el silencio y la retención.
  const [gastosDelMes, cfdi] = await Promise.all([
    contarDeFlota('gasto', 'created_at', tenantId, desde, hasta, 'exito.valor.gastos'),
    acotada(supabaseAdmin()
      .from('gasto').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('cfdi_valido', true)
      .gte('created_at', desde).lt('created_at', hasta), 'exito.valor.cfdi_valido'),
  ]);
  if (cfdi.error) throw new Error(`leerValorDelMes(cfdi): ${cfdi.error.message}`);
  if (typeof cfdi.count !== 'number') throw new Error('leerValorDelMes(cfdi): PostgREST no devolvió el conteo.');
  const conCfdi = cfdi.count;

  return {
    mes, liquidaciones,
    porEstatus: [...porEstatus.entries()].map(([estatus, n]) => ({ estatus, n })).sort((a, b) => b.n - a.n),
    porRevision: [...porRevision.entries()].map(([revision, n]) => ({ revision, n })).sort((a, b) => b.n - a.n),
    totalComprobado: round2(totalComprobado),
    diferencia: round2(diferencia),
    ivaAcreditable: round2(iva),
    peajeAcreditable: round2(peaje),
    litrosDiesel: round2(dieselL),
    gastosConCfdiValido: conCfdi,
    gastosDelMes,
    // AGB-8: `traerTodo` ya lanzó si no pudo demostrar que trajo TODO — de
    // haber llegado aquí, la lectura es completa. `false` no es un default
    // optimista: es la prueba de la línea de arriba.
    incompleto: false,
  };
}

/** El reporte mensual corre desde el día 3, misma aproximación declarada que
 *  el cierre financiero: antes de eso el mes todavía recibe filas. */
export function tocaReporteMensual(hoy: string): boolean {
  return Number(hoy.slice(8, 10)) >= 3;
}

async function correrExitoCliente(disparo: DisparoCorrida, hoy: string, venceEnVuelta?: number): Promise<ResultadoExito> {
  const inicio = new Date();
  const agente = 'exito_cliente';
  try {
    const { flotas, truncado } = await leerFlotas();
    let piezas = 0;
    let sinTurno = false;
    const motivos: string[] = [];

    // ── (a) El silencio, diario ────────────────────────────────────────────
    const tituloSilencio = `Silencio — ${hoy}`;
    if (await piezaExistente(agente, tituloSilencio)) {
      motivos.push('el parte de silencio de hoy ya está en la bandeja');
    } else {
      const corte = hace(DIAS_SILENCIO, hoy);
      const actividad: ActividadFlota[] = [];
      for (const f of flotas) {
        // EL RELOJ, ANTES DE LAS CUATRO CONSULTAS DE ESTA FLOTA (c7-1). Este
        // bucle es el MÁS CARO del archivo: son CUATRO `contarDeFlota` por
        // flota —viajes, gastos, conversaciones e histórico—, o sea hasta
        // 2,000 consultas en serie con el tope de 500 flotas.
        //
        // Se abandona el parte en vez de encolarlo a medias por lo mismo que
        // en onboarding: el título `Silencio — <día>` sella el día, y un parte
        // de silencio armado con media lista es peor que ninguno — la gracia
        // del agente es decir QUIÉN está callado, y una flota que no se miró
        // se lee igual que una flota que sí habló. Decir «no alcancé» es
        // honesto; publicar la lista corta sería inventar que las demás están
        // bien. Lo armado se tira (es memoria) y se dice `sinTurno`.
        if (relojAgotado(venceEnVuelta)) {
          sinTurno = true;
          logger.warn('exito.silencio.corte_por_reloj', { sinMirar: flotas.length - actividad.length, miradas: actividad.length });
          motivos.push(`el reloj de la vuelta se agotó con ${numero(flotas.length - actividad.length)} flota(s) sin mirar — el parte de silencio NO se fabricó a medias; le toca completo en la próxima pasada`);
          break;
        }
        // AGB-8 (auditoría 24): las CUATRO consultas de esta flota son
        // independientes entre sí (viajes/gastos/conversaciones/histórico no
        // se necesitan una a otra) — `await` en serie las sumaba: 4 × el
        // tiempo de red por flota. Medido en producción: `TimeoutError` en
        // `exito.silencio.gastos` con solo 119 filas en `gasto` — no era el
        // volumen de esa tabla, era la cola de 4 viajes redondos seguidos
        // dentro del `acotada` de 8 s de la ÚLTIMA consulta. `Promise.all`
        // las manda las cuatro a la vez: el costo de la flota pasa a ser el
        // de la consulta MÁS LENTA, no la SUMA de las cuatro.
        const [viajesVentana, gastosVentana, conversacionesVentana, viajesHistoricos] = await Promise.all([
          contarDeFlota('viaje', 'created_at', f.id, corte, null, 'exito.silencio.viajes'),
          contarDeFlota('gasto', 'created_at', f.id, corte, null, 'exito.silencio.gastos'),
          contarDeFlota('wa_conversacion', 'updated_at', f.id, corte, null, 'exito.silencio.wa'),
          contarDeFlota('viaje', 'created_at', f.id, null, null, 'exito.silencio.historico'),
        ]);
        actividad.push({ flota: f, viajesVentana, gastosVentana, conversacionesVentana, viajesHistoricos });
      }
      const calladas = actividad.filter(enSilencio);
      // El `break` de arriba ya dejó dicho el motivo; lo que NO puede pasar es
      // que la lista corta llegue a `encolarPiezaExito` y selle el día.
      if (sinTurno) {
        // nada que encolar: el parte de hoy se fabrica completo o no se fabrica.
      } else if (calladas.length === 0) {
        // Un parte diario que dice «nadie está callado» enseña a no leer el
        // parte. El dato queda en la corrida, no en la bandeja.
        motivos.push(flotas.length === 0
          ? '0 flotas dadas de alta — no hay silencio que reportar'
          : 'ninguna flota en silencio');
      } else {
        const res = await encolarPiezaExito(agente, 'parte_silencio', tituloSilencio,
          armarParteSilencio(actividad, hoy), {
            flotas: flotas.length, en_silencio: calladas.length, ventana_dias: DIAS_SILENCIO, truncado,
            consultas: ['tenant', 'viaje (conteo)', 'gasto (conteo)', 'wa_conversacion (conteo)'],
          });
        if (res === 'encolada') piezas += 1; else motivos.push('otra corrida ganó el parte de silencio');
      }
    }

    // ── (b) El reporte de valor, mensual y por flota ───────────────────────
    if (sinTurno) {
      // Si ya no hubo reloj para (a), tampoco lo hay para (b): entrar aquí
      // sería empezar una faena nueva con el presupuesto agotado, y lo que se
      // gasta de más se lo quita a la ruta para escribir el latido.
      motivos.push('el reloj de la vuelta ya estaba agotado — el reporte de valor ni se intentó');
    } else if (!tocaReporteMensual(hoy)) {
      motivos.push('antes del día 3 el mes todavía recibe filas — el reporte de valor no corre');
    } else {
      const mes = mesAnterior(hoy);
      let flotasSinMirar = 0;
      for (let i = 0; i < flotas.length; i++) {
        const f = flotas[i];
        // ── EL RELOJ, ANTES DE PREGUNTAR POR EL SELLO (c7-1 + criterio #160) ─
        // AQUÍ el corte SÍ es a mitad de lista y NO pasa nada, y la diferencia
        // con los partes de arriba es la que importa: este bucle fabrica UNA
        // PIEZA POR FLOTA, cada una con su propio título (`Valor — mes — id`).
        // Cortar deja las ya encoladas encoladas —cada una completa y correcta—
        // y a las que faltan sin sellar, así que la próxima pasada las fabrica
        // sin tropezar con nada. No hay un «parte del día» que se pueda enterrar.
        //
        // Se pregunta ANTES de `piezaExistente` —la sonda del sello— y no entre
        // ella y `encolarPiezaExito`: ése es el hueco que el fork del #160
        // señaló en el aviso de peaje, donde cortar entre reservar y actuar
        // enterraba el aviso del mes. Aquí el equivalente sería gastar la
        // lectura del valor del mes para tirarla.
        if (relojAgotado(venceEnVuelta)) {
          sinTurno = true;
          flotasSinMirar = flotas.length - i;
          logger.warn('exito.valor.corte_por_reloj', { sinMirar: flotasSinMirar, piezas });
          motivos.push(`el reloj de la vuelta cortó el reporte de valor con ${numero(flotasSinMirar)} flota(s) sin mirar — las que ya se encolaron quedan; el resto le toca en la próxima pasada`);
          break;
        }
        const titulo = `Valor — ${mes} — ${f.id.slice(0, 8)}`;
        if (await piezaExistente(agente, titulo)) continue;
        const v = await leerValorDelMes(f.id, mes);
        // Una flota sin NADA en el mes no recibe borrador: mandarle un
        // reporte de ceros a un cliente es peor que no mandarle nada. El
        // agente de silencio ya la está vigilando.
        if (v.liquidaciones === 0 && v.gastosDelMes === 0) continue;
        const res = await encolarPiezaExito(agente, 'reporte_valor', titulo,
          armarReporteValor(f, v), {
            mes, tenant: f.id, liquidaciones: v.liquidaciones, incompleto: v.incompleto,
            consultas: ['liquidacion (conteo y sumas por mes)', 'gasto (conteo y cfdi_valido)'],
          }, f.id);
        if (res === 'encolada') piezas += 1;
      }
    }

    await anotar(agente, inicio, 'ok', disparo, { piezas, flotas: flotas.length, motivos, sin_turno: sinTurno });
    return {
      resultado: 'corrio', piezas, costoUsd: 0,
      ...(sinTurno ? { sinTurno: true } : {}),
      // Con corte por reloj el motivo se dice AUNQUE se hayan fabricado piezas:
      // «encolé 3» a secas escondería que otras 40 flotas no se miraron, que es
      // justo el silencio que este arreglo existe para romper.
      motivo: (piezas === 0 || sinTurno) ? (motivos.join(' · ') || undefined) : undefined,
    };
  } catch (e) {
    await anotar(agente, inicio, 'fallo', disparo, { dia: hoy },
      `No se pudo armar el parte de éxito del cliente: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500));
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3 · RETENCIÓN — los gatillos de riesgo y de expansión, con evidencia
// (12-Agentes-del-Ciclo/agente-retencion.md)
//
// Semana contra semana, sobre conteos EN BASE. Los porcentajes solo se dicen
// cuando hay base para decirlos: `pctCambio` devuelve null con base 0, y el
// piso de tres viajes evita que caer de 2 a 1 se pinte como «−50% de uso».
// ═══════════════════════════════════════════════════════════════════════════

export interface UsoSemanal {
  flota: Flota;
  estaSemana: number;
  semanaPrevia: number;
  /** Corridas de agentes de ESTA flota que terminaron en 'fallo' en 7 días. */
  fallos7d: number;
}

export type TipoGatillo = 'RIESGO' | 'EXPANSION';
export interface Gatillo { tipo: TipoGatillo; flota: string; detalle: string }

/** Los gatillos de UNA flota, PUROS sobre cifras ya leídas. */
export function evaluarGatillos(u: UsoSemanal): Gatillo[] {
  const g: Gatillo[] = [];
  const pct = pctCambio(u.estaSemana, u.semanaPrevia);

  if (pct !== null && u.semanaPrevia >= PISO_VIAJES_SEMANA) {
    if (pct <= -CAIDA_RIESGO_PCT) {
      g.push({
        tipo: 'RIESGO', flota: u.flota.nombre,
        detalle: `el uso cayó ${numero(Math.abs(Math.round(pct)))}%: ${numero(u.semanaPrevia)} viajes la semana pasada contra ${numero(u.estaSemana)} esta (conteos en base sobre viaje.created_at).`,
      });
    } else if (pct >= SUBIDA_EXPANSION_PCT) {
      g.push({
        tipo: 'EXPANSION', flota: u.flota.nombre,
        detalle: `el uso subió ${numero(Math.round(pct))}%: ${numero(u.semanaPrevia)} viajes la semana pasada contra ${numero(u.estaSemana)} esta. Es el momento de preguntar por el resto de la flota, no de esperar.`,
      });
    }
  } else if (u.semanaPrevia > 0 && u.semanaPrevia < PISO_VIAJES_SEMANA) {
    g.push({
      tipo: 'RIESGO', flota: u.flota.nombre,
      detalle: `uso mínimo: ${numero(u.semanaPrevia)} viajes la semana pasada y ${numero(u.estaSemana)} esta. NO se calcula porcentaje sobre esa base — un −50% de 2 a 1 no dice nada.`,
    });
  }

  if (u.fallos7d >= FALLOS_RIESGO) {
    g.push({
      tipo: 'RIESGO', flota: u.flota.nombre,
      detalle: `${numero(u.fallos7d)} corridas de agentes terminaron en fallo para esta flota en 7 días (agente_corrida.estado = 'fallo'). El producto le está fallando de forma repetida y eso se ve antes en la base que en un correo de queja.`,
    });
  }
  return g;
}

export function armarParteRetencion(usos: UsoSemanal[], lunes: string, truncado: boolean): { cuerpo: string; gatillos: Gatillo[] } {
  const gatillos = usos.flatMap(evaluarGatillos);
  const lineas = [`RETENCIÓN — semana del ${lunes}`, ''];
  if (usos.length === 0) {
    lineas.push('0 flotas dadas de alta: no hay retención que vigilar. Es el estado real del sistema, no un fallo de lectura.');
  } else {
    lineas.push(`Flotas medidas: ${numero(usos.length)}${truncado ? ` (SOLO LAS PRIMERAS ${numero(TOPE_FLOTAS)})` : ''} · ventana: 7 días contra los 7 anteriores.`);
    lineas.push('');
    if (gatillos.length === 0) {
      lineas.push('Ningún gatillo se encendió esta semana.');
    }
    for (const g of gatillos) lineas.push(`[${g.tipo}]  ${g.flota} — ${g.detalle}`);
    lineas.push('');
    lineas.push('El detalle de cada flota (para poder discutir el gatillo, no solo leerlo):');
    for (const u of usos) {
      const pct = pctCambio(u.estaSemana, u.semanaPrevia);
      const cambio = pct === null
        ? 'sin base para el porcentaje (la semana previa fue 0 viajes)'
        : `${pct >= 0 ? '+' : ''}${numero(Math.round(pct))}%`;
      lineas.push(`  ${u.flota.nombre}: ${numero(u.semanaPrevia)} → ${numero(u.estaSemana)} viajes (${cambio}) · corridas en fallo 7d: ${numero(u.fallos7d)}`);
    }
  }
  lineas.push('');
  lineas.push('Fuentes: conteos EN BASE de viaje.created_at por tenant en las dos ventanas · agente_corrida (estado = fallo, por tenant). Los porcentajes usan pctCambio, que devuelve «sin base» en vez de un ∞% cuando la base es 0.');
  return { cuerpo: lineas.join('\n'), gatillos };
}

async function correrRetencion(disparo: DisparoCorrida, hoy: string, venceEnVuelta?: number): Promise<ResultadoExito> {
  const inicio = new Date();
  const agente = 'retencion';
  const lunes = lunesDeSemana(hoy);
  const titulo = `Retención — semana del ${lunes}`;
  try {
    if (await piezaExistente(agente, titulo)) {
      await anotar(agente, inicio, 'ok', disparo, { parte: 'ya_existia', titulo });
      return { resultado: 'corrio', piezas: 0, motivo: 'el parte de esta semana ya está en la bandeja', costoUsd: 0 };
    }

    const { flotas, truncado } = await leerFlotas();
    const corte7 = hace(7, hoy);
    const corte14 = hace(14, hoy);
    const usos: UsoSemanal[] = [];
    for (const f of flotas) {
      // EL RELOJ, ANTES DE LAS TRES CONSULTAS DE ESTA FLOTA (c7-1). Tres idas
      // a la base por flota (semana, semana previa y fallos), en serie.
      //
      // Y aquí abandonar el parte importa MÁS que en los diarios, porque éste
      // es SEMANAL: el título `Retención — semana del <lunes>` sella los siete
      // días. Un parte armado con media lista no lo corrige la pasada de las
      // cuatro horas siguientes ni la de mañana — se queda así hasta el lunes
      // que viene, con los gatillos de riesgo de las flotas que no se miraron
      // apagados durante una semana entera. Un cliente a punto de irse es
      // exactamente lo que este agente existe para ver a tiempo.
      if (relojAgotado(venceEnVuelta)) {
        const sinMirar = flotas.length - usos.length;
        logger.warn('exito.retencion.corte_por_reloj', { sinMirar, miradas: usos.length, semana: lunes });
        await anotar(agente, inicio, 'ok', disparo, { parte: 'sin_turno', sin_mirar: sinMirar, miradas: usos.length, semana: lunes });
        return {
          resultado: 'corrio', piezas: 0, costoUsd: 0, sinTurno: true,
          motivo: `el reloj de la vuelta se agotó con ${numero(sinMirar)} flota(s) sin mirar — el parte SEMANAL no se fabricó a medias (sellaría la semana y apagaría los gatillos de las flotas no miradas hasta el lunes que viene); le toca completo en la próxima pasada`,
        };
      }
      // AGB-8: las dos ventanas de la misma flota no dependen una de otra —
      // en paralelo, no en serie (mismo criterio que el silencio diario).
      const [estaSemana, semanaPrevia] = await Promise.all([
        contarDeFlota('viaje', 'created_at', f.id, corte7, null, 'exito.retencion.semana'),
        contarDeFlota('viaje', 'created_at', f.id, corte14, corte7, 'exito.retencion.previa'),
      ]);
      usos.push({
        flota: f,
        estaSemana,
        semanaPrevia,
        fallos7d: await contarFallosDeFlota(f.id, corte7),
      });
    }

    const { cuerpo, gatillos } = armarParteRetencion(usos, lunes, truncado);
    const res = await encolarPiezaExito(agente, 'parte_retencion', titulo, cuerpo, {
      flotas: usos.length, truncado,
      riesgo: gatillos.filter((g) => g.tipo === 'RIESGO').length,
      expansion: gatillos.filter((g) => g.tipo === 'EXPANSION').length,
      consultas: ['tenant', 'viaje (dos ventanas, conteo en base)', 'agente_corrida (fallos por flota)'],
    });
    await anotar(agente, inicio, 'ok', disparo, { parte: res, flotas: usos.length, gatillos: gatillos.length });
    return {
      resultado: 'corrio',
      piezas: res === 'encolada' ? 1 : 0,
      motivo: res === 'ya_existia' ? 'otra corrida ganó el periodo' : undefined,
      costoUsd: 0,
    };
  } catch (e) {
    await anotar(agente, inicio, 'fallo', disparo, { semana: lunes },
      `No se pudo armar el parte de retención: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500));
    throw e;
  }
}

/** Corridas en 'fallo' de UNA flota desde `desdeIso`. Conteo exacto; LANZA si
 *  la base no lo devuelve — un 0 inventado diría «el producto no le falló». */
async function contarFallosDeFlota(tenantId: string, desdeIso: string): Promise<number> {
  const { count, error } = await acotada(supabaseAdmin()
    .from('agente_corrida')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('estado', 'fallo')
    .gte('inicio', desdeIso), 'exito.retencion.fallos');
  if (error) throw new Error(`contarFallosDeFlota: ${error.message}`);
  if (typeof count !== 'number') throw new Error('contarFallosDeFlota: PostgREST no devolvió el conteo.');
  return count;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4 · COBRANZA SAAS — el dunning de las mensualidades DE LIKIDA
// (04-Cobranza/agente-cobranza-saas.md)
//
// No confundir con el agente `cobranza` (0102), que le cobra a los CLIENTES de
// una flota. Este cobra lo que la flota le debe a Likida: `factura_saas`.
//
// LA CADENCIA −3/0/+3/+7/+15 PRODUCE PROPUESTAS, NO ENVÍOS. Cada toque es una
// pieza a la bandeja con el texto listo; no hay canal de correo al cliente
// aprobado, así que nada sale solo — y el cuerpo de cada propuesta lo dice.
//
// CON CATCH-UP (c6-14): un hito se considera alcanzado con `>=`, no con
// igualdad. La igualdad ataba la cadencia al calendario del cron y perdía en
// silencio el toque de cualquier día que no hubiera corrida. El árbitro
// contra la duplicación no es la fecha: es el sello por (factura, hito) que
// el índice único de la 0218 ya impone.
//
// EL VENCIMIENTO: `factura_saas` no declara una fecha de vencimiento propia.
// Se toma `periodo_inicio` porque la mensualidad se cobra por adelantado (la
// referencia `LK…AAAAMM` se arma con `periodo_inicio`, transferencia.ts). Es
// una interpretación DECLARADA, no un dato: el parte la dice en cada corrida
// para que Javier la corrija si el criterio es otro [DECISIÓN DE JAVIER].
// ═══════════════════════════════════════════════════════════════════════════

export interface ToqueCobranza {
  factura: FacturaPorCobrar;
  /** Días entre el vencimiento y hoy. Negativo = todavía no vence. */
  diasVsVencimiento: number;
  hito: number;
}

/**
 * Los toques que TOCAN hoy — con CATCH-UP (c6-14).
 *
 * Antes se pedía igualdad exacta (`dias === hito`) y eso ataba la cadencia al
 * calendario del cron: una corrida que no pasó ese día —cron caído, palanca
 * apagada, despliegue, la factura dada de alta con retraso— perdía el toque
 * PARA SIEMPRE, en silencio. Una factura registrada con 9 días de vencida no
 * recibía −3, ni 0, ni +3, ni +7: su primera propuesta llegaba el día 15.
 *
 * Ahora se devuelven todos los hitos ALCANZADOS (`dias >= hito`). No duplica
 * nada porque el árbitro ya existe y es una constraint: el título es
 * determinista por (factura, hito) y `piezaExistente` + el índice único de la
 * 0218 dejan pasar exactamente una propuesta por par, para siempre.
 *
 * `diasVsVencimiento` viaja aparte del `hito` a propósito: el hito es la
 * llave del sello, y los días son la verdad de HOY — el texto se escribe con
 * los días, nunca con el hito (ver `textoDelToque`).
 */
export function toquesDeHoy(facturas: FacturaPorCobrar[], hoy: string): ToqueCobranza[] {
  const toques: ToqueCobranza[] = [];
  for (const f of facturas) {
    const dias = diasEntreDias(f.periodoInicio, hoy);
    for (const hito of HITOS_COBRANZA) {
      if (dias >= hito) toques.push({ factura: f, diasVsVencimiento: dias, hito });
    }
  }
  return toques;
}

/** ¿Este toque llega TARDE a su propio hito? (c6-14) */
export function esToqueAtrasado(t: ToqueCobranza): boolean {
  return t.diasVsVencimiento !== t.hito;
}

/** La clave del toque: una propuesta por (factura, hito), para siempre. La
 *  referencia bancaria es el identificador humano; sin ella (una factura de
 *  Stripe) se cae al id corto — nunca a un texto ambiguo. */
export function tituloToque(t: ToqueCobranza): string {
  const ref = t.factura.referencia?.trim() || t.factura.id.slice(0, 8);
  return `Cobranza SaaS — ${ref} — D${t.hito >= 0 ? `+${t.hito}` : t.hito}`;
}

export function armarPropuestaCobranza(t: ToqueCobranza, hoy: string): string {
  const f = t.factura;
  // El estado se escribe con los DÍAS REALES, no con el hito: un toque de
  // catch-up (c6-14) que dijera "faltan 3 días para el corte" sobre una
  // factura de 20 días vencida sería una mentira con firma de agente.
  const d = t.diasVsVencimiento;
  const cuando = d < 0
    ? `faltan ${numero(-d)} días para el corte`
    : d === 0
      ? 'hoy es el día del corte'
      : `lleva ${numero(d)} días vencida`;
  const desglose = f.subtotal === null || f.iva === null
    ? 'SIN desglose de IVA guardado — esta factura no se puede timbrar y el recordatorio no debe prometer factura'
    : `${mxn(f.subtotal)} + IVA ${mxn(f.iva)}`;
  return [
    `COBRANZA SAAS — ${f.tenantNombre} — día ${t.hito >= 0 ? `+${t.hito}` : t.hito}`,
    '',
    `Estado: ${cuando} (vencimiento tomado como periodo_inicio ${f.periodoInicio}; factura_saas no declara fecha de vencimiento propia).`,
    ...(esToqueAtrasado(t)
      ? [`TOQUE ATRASADO: es el D${t.hito >= 0 ? `+${t.hito}` : t.hito} de la cadencia y no salió el día que le tocaba (hoy la factura lleva ${numero(t.diasVsVencimiento)} días desde el corte). Sale ahora para no perderlo; el borrador de abajo habla del hoy real, no del día del hito.`]
      : []),
    `Periodo: ${f.periodoInicio} a ${f.periodoFin} · estado de la factura: ${f.estado}`,
    `A transferir: ${mxn(f.monto)}  (${desglose})`,
    `Referencia del concepto: ${f.referencia ?? 'SIN REFERENCIA — el cliente no tiene qué escribir en el concepto; revísalo antes de mandar nada'}`,
    f.cfdiUuid ? `CFDI timbrado: ${f.cfdiUuid}` : 'CFDI: sin timbrar todavía.',
    '',
    'BORRADOR DEL RECORDATORIO (Javier lo edita y lo manda — no sale solo):',
    `  ${textoDelToque(t)}`,
    '',
    `Preparado el ${hoy}. Este agente NO envía: no hay canal de correo al cliente aprobado, y la cadencia −3/0/+3/+7/+15 del diseño produce PROPUESTAS, una por factura y por hito.`,
    'Fuentes: getPorCobrar (factura_saas en pendiente/fallida, con su tenant) · la cadencia del diseño agente-cobranza-saas.md.',
  ].join('\n');
}

/** El texto que se le propondría al cliente. Sin cifras que no vengan de la
 *  factura y sin promesas de corte de servicio: apagarle el producto a una
 *  flota por una fecha es una decisión de Javier, no de un agente. */
export function textoDelToque(t: ToqueCobranza): string {
  const f = t.factura;
  // CATCH-UP (c6-14): el hito manda para el SELLO —una propuesta por (factura,
  // hito)— pero no para lo que se le dice al cliente. Los textos de la
  // cadencia están escritos para su día exacto; usarlos tarde produciría un
  // "el 3 de agosto vence" sobre algo vencido hace tres semanas.
  if (esToqueAtrasado(t)) {
    const d = t.diasVsVencimiento;
    return d < 0
      ? `Recordatorio: el ${f.periodoInicio} vence la mensualidad de Likida por ${mxn(f.monto)} (faltan ${numero(-d)} días). La referencia del concepto es ${f.referencia ?? '(pendiente de asignar)'}.`
      : `La mensualidad de Likida por ${mxn(f.monto)} del periodo ${f.periodoInicio} a ${f.periodoFin} lleva ${numero(d)} días desde el corte y sigue pendiente. ¿Hay algo que necesiten de mi lado para poder pagarla?`;
  }
  switch (t.hito) {
    case -3: return `Recordatorio: el ${f.periodoInicio} vence la mensualidad de Likida por ${mxn(f.monto)}. La referencia del concepto es ${f.referencia ?? '(pendiente de asignar)'}.`;
    case 0: return `Hoy vence la mensualidad de Likida por ${mxn(f.monto)}. Si ya la transfirieron, mándame la referencia del banco y la concilio.`;
    case 3: return `La mensualidad de ${mxn(f.monto)} sigue pendiente desde el ${f.periodoInicio}. ¿Hay algo que necesiten de mi lado para poder pagarla?`;
    case 7: return `Una semana de la mensualidad de ${mxn(f.monto)}. Prefiero preguntar antes de insistir: ¿está el proceso de pago atorado en algo?`;
    case 15: return `Quince días de la mensualidad de ${mxn(f.monto)}. Quiero platicarlo por teléfono en vez de seguir escribiendo.`;
    default: return `Mensualidad de ${mxn(f.monto)} del periodo ${f.periodoInicio} a ${f.periodoFin}.`;
  }
}

export function armarParteCobranzaSaas(
  facturas: FacturaPorCobrar[], toques: ToqueCobranza[], propuestas: number, hoy: string,
): string {
  const total = round2(facturas.reduce((s, f) => s + f.monto, 0));
  const lineas = [`COBRANZA SAAS — ${hoy}`, ''];
  if (facturas.length === 0) {
    lineas.push('0 mensualidades por cobrar. Likida no tiene hoy ninguna factura en pendiente ni en fallida (getPorCobrar sobre factura_saas).');
    lineas.push('No es un fallo de lectura ni una bandeja vacía por error: es el estado real del negocio, y decirlo es el trabajo del parte.');
  } else {
    lineas.push(`Por cobrar: ${numero(facturas.length)} ${facturas.length === 1 ? 'factura' : 'facturas'} · ${mxn(total)} (getPorCobrar — factura_saas en pendiente/fallida)`);
    lineas.push('');
    for (const f of facturas) {
      const dias = diasEntreDias(f.periodoInicio, hoy);
      lineas.push(`  ${f.tenantNombre}: ${mxn(f.monto)} · periodo ${f.periodoInicio} a ${f.periodoFin} · ${dias >= 0 ? `${numero(dias)} días desde el corte` : `faltan ${numero(-dias)} días`} · ${f.estado}`);
    }
    lineas.push('');
    const atrasados = toques.filter(esToqueAtrasado).length;
    lineas.push(toques.length === 0
      ? 'Ninguna factura ha alcanzado todavía un hito de la cadencia −3/0/+3/+7/+15: no se propuso ningún recordatorio.'
      : `Hitos ya alcanzados: ${numero(toques.length)}${atrasados > 0 ? ` (${numero(atrasados)} de recuperación — hitos que no salieron el día que tocaban)` : ''} · propuestas NUEVAS a la bandeja: ${numero(propuestas)} (el resto ya estaban propuestas — una por factura y por hito, y el índice único es el árbitro).`);
  }
  lineas.push('');
  lineas.push('El vencimiento se toma como periodo_inicio: factura_saas no declara una fecha propia y la mensualidad se cobra por adelantado (la referencia LK…AAAAMM se arma con periodo_inicio). Es una interpretación DECLARADA [DECISIÓN DE JAVIER].');
  lineas.push('Nada de esto sale solo: no hay canal de correo al cliente aprobado. El agente propone; Javier edita y manda.');
  return lineas.join('\n');
}

async function correrCobranzaSaas(disparo: DisparoCorrida, hoy: string, venceEnVuelta?: number): Promise<ResultadoExito> {
  const inicio = new Date();
  const agente = 'cobranza_saas';
  const titulo = `Cobranza SaaS — ${hoy}`;
  try {
    const facturas = await getPorCobrar();
    const toques = toquesDeHoy(facturas, hoy);

    let propuestas = 0;
    let sinTurno = false;
    let toquesSinMirar = 0;
    for (let i = 0; i < toques.length; i++) {
      const t = toques[i];
      // ── EL RELOJ, ANTES DE PREGUNTAR POR EL SELLO (c7-1 + criterio #160) ───
      // Dos idas a la base por toque (la sonda del título y el encolado). Se
      // pregunta ANTES de `piezaExistente` y NUNCA entre la sonda y
      // `encolarPiezaExito`: cortar en ese hueco gastaría la lectura para
      // tirarla, y es el mismo hueco que en el aviso de peaje dejaba el sello
      // puesto sobre una acción que no ocurrió.
      //
      // Cortar aquí es seguro porque cada toque es su propia pieza, con título
      // propio (`tituloToque`) arbitrado por el índice único: las ya encoladas
      // quedan, las que faltan no quedaron sembradas de nada y salen íntegras
      // en la próxima pasada. Lo que NO se puede hacer es sellar el parte del
      // día con las cuentas a medias — de eso se encarga el `if` de abajo.
      if (relojAgotado(venceEnVuelta)) {
        sinTurno = true;
        toquesSinMirar = toques.length - i;
        logger.warn('exito.cobranza_saas.corte_por_reloj', { sinMirar: toquesSinMirar, propuestas });
        break;
      }
      const tituloToqueHoy = tituloToque(t);
      if (await piezaExistente(agente, tituloToqueHoy)) continue;
      const res = await encolarPiezaExito(agente, 'recordatorio_cobranza', tituloToqueHoy,
        armarPropuestaCobranza(t, hoy), {
          factura: t.factura.id, hito: t.hito, monto: t.factura.monto,
          consultas: ['getPorCobrar (factura_saas)'],
        }, t.factura.tenantId);
      if (res === 'encolada') propuestas += 1;
    }

    // EL PARTE DEL DÍA NO SE SELLA CON LAS CUENTAS A MEDIAS. `armarParteCobranzaSaas`
    // escribe «de N toques de hoy se prepararon M propuestas», y con el bucle
    // cortado esa M es una fracción que el texto presentaría como el total. Peor:
    // el título `Cobranza SaaS — <día>` es idempotente, así que ese parte falso
    // sellaría el día y la pasada de dentro de cuatro horas —la que SÍ va a
    // terminar los toques— encontraría «ya_existia» y no lo corregiría nunca.
    // Las propuestas ya encoladas no se pierden (cada una tiene su propio
    // título); lo único que se pospone es el resumen, que es justo lo que puede
    // esperar cuatro horas.
    let parte: 'encolada' | 'ya_existia' | 'ya_estaba' = 'ya_estaba';
    if (!sinTurno && !(await piezaExistente(agente, titulo))) {
      parte = await encolarPiezaExito(agente, 'parte_cobranza_saas', titulo,
        armarParteCobranzaSaas(facturas, toques, propuestas, hoy), {
          por_cobrar: facturas.length, toques: toques.length, propuestas,
          consultas: ['getPorCobrar (factura_saas)'],
        });
    }

    const piezas = propuestas + (parte === 'encolada' ? 1 : 0);
    await anotar(agente, inicio, 'ok', disparo, {
      por_cobrar: facturas.length, toques: toques.length, propuestas, parte,
      ...(sinTurno ? { sin_turno: toquesSinMirar } : {}),
    });
    return {
      resultado: 'corrio', piezas, costoUsd: 0,
      ...(sinTurno ? { sinTurno: true } : {}),
      motivo: sinTurno
        ? `el reloj de la vuelta cortó la cobranza con ${numero(toquesSinMirar)} toque(s) sin mirar — las propuestas ya encoladas quedan; el parte del día NO se selló con cuentas a medias y sale completo en la próxima pasada`
        : (piezas === 0
          ? (facturas.length === 0 ? '0 mensualidades por cobrar y el parte de hoy ya está' : 'todo lo de hoy ya estaba en la bandeja')
          : undefined),
    };
  } catch (e) {
    await anotar(agente, inicio, 'fallo', disparo, { dia: hoy },
      `No se pudo armar la cobranza SaaS: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500));
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5 · SOPORTE — el reloj de los tickets y la escalación al operador
// (03-Atencion-al-Cliente/agente-soporte.md)
//
// El SLA no se guarda, se DERIVA (0051): `vence_en` se escribió al abrir el
// ticket y el «cuánto falta» se resta contra ahora. Un ticket SIN `vence_en`
// es «sin SLA pactado» — jamás «vencido», que es la forma más silenciosa de
// inventar un incumplimiento.
// ═══════════════════════════════════════════════════════════════════════════

export interface TicketVigilado {
  id: string;
  tenantId: string;
  asunto: string;
  categoria: string;
  prioridad: string;
  estado: string;
  abiertoEn: string;
  venceEn: string | null;
  /**
   * RESPUESTAS de verdad: mensajes del hilo que NO son internos y que NO
   * escribió el propio solicitante (c6-5). 0 = nadie le ha contestado.
   *
   * Contar el hilo entero —lo que se hacía antes— apagaba la alarma sola: el
   * cliente que insiste ("¿alguna novedad?") y la nota interna que un agente
   * se deja a sí mismo subían el contador y el ticket dejaba de salir en «sin
   * una sola respuesta» sin que nadie hubiera contestado nada.
   */
  respuestas: number;
}

/**
 * ¿Este mensaje CUENTA como respuesta al solicitante? PURA (c6-5).
 *
 * Fail-closed hacia el lado que hace ruido: un mensaje de autor DESCONOCIDO
 * (la cuenta se borró y el `on delete set null` dejó `autor_id` en NULL) no
 * cuenta como respuesta. El error de más deja un ticket en la lista de «sin
 * respuesta» y alguien lo mira; el error de menos deja a un cliente esperando
 * sin que nadie se entere, que es el fallo que este agente existe para evitar.
 */
export function cuentaComoRespuesta(
  m: { autorId: string | null; interna: boolean },
  solicitanteId: string | null,
): boolean {
  if (m.interna) return false;
  if (m.autorId === null) return false;
  return m.autorId !== solicitanteId;
}

export type SemaforoTicket = 'VENCIDO' | 'POR_VENCER' | 'SIN_SLA' | 'EN_TIEMPO';

/** El semáforo de UN ticket contra el instante `ahoraIso`. PURO. */
export function semaforoTicket(t: TicketVigilado, ahoraIso: string): SemaforoTicket {
  if (t.venceEn === null) return 'SIN_SLA';
  const horas = (Date.parse(t.venceEn) - Date.parse(ahoraIso)) / 3_600_000;
  if (horas < 0) return 'VENCIDO';
  if (horas <= 4) return 'POR_VENCER';
  return 'EN_TIEMPO';
}

export function armarParteSoporte(tickets: TicketVigilado[], ahoraIso: string, hoy: string, truncado: boolean): {
  cuerpo: string; vencidos: TicketVigilado[]; sinRespuesta: TicketVigilado[];
} {
  const vencidos = tickets.filter((t) => semaforoTicket(t, ahoraIso) === 'VENCIDO');
  const porVencer = tickets.filter((t) => semaforoTicket(t, ahoraIso) === 'POR_VENCER');
  const sinSla = tickets.filter((t) => semaforoTicket(t, ahoraIso) === 'SIN_SLA');
  const sinRespuesta = tickets.filter((t) => t.respuestas === 0);

  const lineas = [`SOPORTE — ${hoy}`, ''];
  if (tickets.length === 0) {
    lineas.push('0 tickets abiertos. Nadie ha pedido ayuda y nada se está venciendo (ticket_soporte en abierto/en_proceso/esperando).');
  } else {
    lineas.push(`Tickets vivos: ${numero(tickets.length)}${truncado ? ` (SOLO LOS PRIMEROS ${numero(TOPE_TICKETS)})` : ''} · vencidos ${numero(vencidos.length)} · por vencer (≤4 h) ${numero(porVencer.length)} · sin SLA pactado ${numero(sinSla.length)} · sin una sola respuesta ${numero(sinRespuesta.length)}`);
    lineas.push('');
    for (const t of tickets) {
      const s = semaforoTicket(t, ahoraIso);
      const reloj = t.venceEn === null
        ? 'sin SLA pactado (no es «vencido»: es que nadie pactó un plazo)'
        : `vence ${fechaMx(t.venceEn)}`;
      lineas.push(`[${s}]  ${t.asunto.slice(0, 90)} · ${t.categoria}/${t.prioridad} · abierto ${fechaMx(t.abiertoEn)} · ${reloj} · ${t.respuestas === 0 ? 'SIN RESPUESTA' : `${numero(t.respuestas)} respuesta(s)`}`);
    }
    if (vencidos.length > 0) {
      lineas.push('');
      lineas.push('Los vencidos ya salieron por el canal del operador: la alerta no espera a que alguien abra la bandeja.');
    }
  }
  lineas.push('');
  lineas.push('Fuentes: ticket_soporte (estados vivos, vence_en escrito al abrir) · ticket_mensaje (respuestas por ticket). «Sin respuesta» cuenta SOLO mensajes públicos (interna=false) de un autor distinto del solicitante: ni la nota interna del equipo ni el «¿alguna novedad?» del propio cliente apagan la alarma. El reloj se DERIVA contra ahora, no se guarda (0051).');
  lineas.push('Este agente no contesta tickets: los vigila y los pone enfrente. El borrador de respuesta lo prepara el agente de Atención y FAQ, y aprobarlo es humano.');
  return { cuerpo: lineas.join('\n'), vencidos, sinRespuesta };
}

/** Los tickets vivos con el conteo de su hilo. LANZA ante error de lectura.
 *
 *  `venceEnVuelta` es EL RELOJ DE LA INVOCACIÓN (epoch ms) — no confundir con
 *  `TicketVigilado.venceEn`, que es el SLA del ticket y es un ISO de calendario.
 *  Ver la nota grande de `relojAgotado` arriba: en este archivo conviven los dos
 *  plazos y por eso el de la vuelta lleva apellido.
 *
 *  `sinTurno` dice que el reloj cortó la lectura y la lista devuelta está
 *  INCOMPLETA — el llamador NO puede tratarla como el censo de tickets vivos. */
export async function leerTicketsVivos(venceEnVuelta?: number): Promise<{ tickets: TicketVigilado[]; truncado: boolean; sinTurno: boolean }> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('ticket_soporte')
    // `abierto_por` es el SOLICITANTE: sin él no se puede decir si el hilo
    // tiene respuesta o solo tiene al cliente insistiendo (c6-5).
    .select('id, tenant_id, asunto, categoria, prioridad, estado, abierto_en, vence_en, abierto_por')
    .in('estado', ['abierto', 'en_proceso', 'esperando'])
    .order('abierto_en', { ascending: true })
    .limit(TOPE_TICKETS + 1), 'exito.soporte.tickets');
  if (error) throw new Error(`leerTicketsVivos: ${error.message}`);
  const filas = (data ?? []) as Array<Record<string, unknown>>;
  const truncado = filas.length > TOPE_TICKETS;

  const tickets: TicketVigilado[] = [];
  const aMirar = filas.slice(0, TOPE_TICKETS);
  for (const f of aMirar) {
    // EL RELOJ, ANTES DE LEER EL HILO DE ESTE TICKET (c7-1). Una consulta por
    // ticket —el hilo completo, hasta 500 mensajes— por hasta 200 tickets: 200
    // idas a la base en serie que nadie estaba cronometrando.
    //
    // Aquí no se corta y se sigue: se corta y se DEVUELVE la lista marcada como
    // incompleta, porque lo que el llamador hace con ella no admite medias
    // tintas — arma un censo («N tickets vivos, M vencidos») y escala al
    // operador. Un censo corto presentado como completo diría que hay 3 tickets
    // vencidos cuando hay 12. Quien decide qué hacer con la duda es
    // `correrSoporte`, no esta lectura.
    if (relojAgotado(venceEnVuelta)) {
      logger.warn('exito.soporte.corte_por_reloj', { sinMirar: aMirar.length - tickets.length, miradas: tickets.length });
      return { tickets, truncado, sinTurno: true };
    }
    const id = String(f.id);
    // Ya no es un `count` de cabecera: hace falta MIRAR cada mensaje para
    // saber si es interno y de quién es. Se acota igual y el hilo de un
    // ticket es de decenas de filas, no de miles.
    const { data: msj, error: errMsj } = await acotada(supabaseAdmin()
      .from('ticket_mensaje')
      .select('autor_id, interna')
      .eq('ticket_id', id)
      .limit(TOPE_MENSAJES_POR_TICKET), 'exito.soporte.mensajes');
    if (errMsj) throw new Error(`leerTicketsVivos(mensajes): ${errMsj.message}`);
    if (!Array.isArray(msj)) throw new Error('leerTicketsVivos(mensajes): PostgREST no devolvió el hilo.');
    const solicitante = (f.abierto_por as string | null) ?? null;
    const respuestas = (msj as Array<Record<string, unknown>>).filter((m) => cuentaComoRespuesta(
      { autorId: (m.autor_id as string | null) ?? null, interna: m.interna === true },
      solicitante,
    )).length;
    tickets.push({
      id,
      tenantId: String(f.tenant_id),
      asunto: String(f.asunto),
      categoria: String(f.categoria),
      prioridad: String(f.prioridad),
      estado: String(f.estado),
      abiertoEn: String(f.abierto_en),
      venceEn: (f.vence_en as string | null) ?? null,
      respuestas,
    });
  }
  return { tickets, truncado, sinTurno: false };
}

async function correrSoporte(disparo: DisparoCorrida, hoy: string, ahora: Date, venceEnVuelta?: number): Promise<ResultadoExito> {
  const inicio = new Date();
  const agente = 'soporte';
  const titulo = `Soporte — ${hoy}`;
  try {
    const { tickets, truncado, sinTurno } = await leerTicketsVivos(venceEnVuelta);

    // ── EL CENSO INCOMPLETO NO ESCALA NI SE ENCOLA ─────────────────────────
    // Se sale ANTES de `armarParteSoporte`, y las dos razones son de las que
    // hacen daño de verdad:
    //
    //   1. LA ESCALACIÓN. `alertarOperador` lleva un piso de reserva en Redis
    //      para no repetir el mismo aviso; disparar «3 tickets vencidos» sobre
    //      una lista truncada consumiría ese piso y podría CALLAR la alerta
    //      correcta —«12 vencidos»— cuando la próxima pasada sí termine de
    //      leer. Una alerta a la baja es peor que ninguna: deja al operador
    //      tranquilo con un dato falso.
    //   2. EL PARTE. El título `Soporte — <día>` es idempotente y sellaría el
    //      día con un censo corto que el texto presenta como el total.
    //
    // Se pospone a la próxima pasada, que es en cuatro horas: el SLA de los
    // tickets se mide en horas o días, así que esperar una pasada no pierde
    // nada, y afirmar un censo que no se terminó de leer sí.
    if (sinTurno) {
      await anotar(agente, inicio, 'ok', disparo, { parte: 'sin_turno', leidos: tickets.length });
      return {
        resultado: 'corrio', piezas: 0, costoUsd: 0, sinTurno: true,
        motivo: `el reloj de la vuelta cortó la lectura de tickets (${numero(tickets.length)} leído(s)) — ni se escaló ni se encoló sobre un censo incompleto: una alerta a la baja tranquiliza con un dato falso. Sale completo en la próxima pasada`,
      };
    }

    const { cuerpo, vencidos, sinRespuesta } = armarParteSoporte(tickets, ahora.toISOString(), hoy, truncado);

    // El SLA vencido va al operador YA. Antes de encolar: si la pieza no
    // pudiera entrar, la escalación ya salió.
    if (vencidos.length > 0) {
      await alertarOperador('exito.soporte_sla', {
        error: `${numero(vencidos.length)} ${vencidos.length === 1 ? 'ticket vencido' : 'tickets vencidos'}: ${vencidos.map((t) => t.asunto.slice(0, 60)).join(' | ')}`.slice(0, 900),
        codigo: 'exito_soporte_sla_vencido',
      });
    }

    if (tickets.length === 0) {
      await anotar(agente, inicio, 'ok', disparo, { tickets: 0 });
      return { resultado: 'corrio', piezas: 0, motivo: '0 tickets vivos — no hay nada que vigilar hoy', costoUsd: 0 };
    }
    if (await piezaExistente(agente, titulo)) {
      await anotar(agente, inicio, 'ok', disparo, { parte: 'ya_existia', tickets: tickets.length, vencidos: vencidos.length });
      return { resultado: 'corrio', piezas: 0, motivo: 'el parte de hoy ya está en la bandeja', costoUsd: 0 };
    }

    const res = await encolarPiezaExito(agente, 'parte_soporte', titulo, cuerpo, {
      tickets: tickets.length, vencidos: vencidos.length, sin_respuesta: sinRespuesta.length, truncado,
      consultas: ['ticket_soporte', 'ticket_mensaje (conteo por ticket)'],
    });
    await anotar(agente, inicio, 'ok', disparo, { parte: res, tickets: tickets.length, vencidos: vencidos.length });
    return {
      resultado: 'corrio',
      piezas: res === 'encolada' ? 1 : 0,
      motivo: res === 'ya_existia' ? 'otra corrida ganó el parte de hoy' : undefined,
      costoUsd: 0,
    };
  } catch (e) {
    await anotar(agente, inicio, 'fallo', disparo, { dia: hoy },
      `No se pudo armar el parte de soporte: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500));
    throw e;
  }
}

// ── El despacho que el runner llama ────────────────────────────────────────

/**
 * UNA corrida de un agente de éxito del cliente. Los cinco deterministas
 * viven aquí; `atencion_faq` se importa dinámicamente porque arrastra el
 * corpus de normas y el cliente del modelo, y eso no se paga en cada pasada
 * del runner que despacha a otro.
 */
export async function correrAgenteExito(
  id: AgenteExito,
  disparo: DisparoCorrida = 'cron',
  hoy: string = hoyMx(),
  ahora: Date = new Date(),
  /** EL RELOJ DE LA VUELTA del runner (epoch ms), no el SLA de ningún ticket
   *  —ver la nota de `relojAgotado`—. Opcional: sin él los seis se comportan
   *  igual que siempre, que es lo que quieren el copiloto y las pruebas que
   *  llaman a un agente suelto. Lo pasa el cron, que es el único que corre
   *  contra un `maxDuration`. */
  venceEnVuelta?: number,
): Promise<ResultadoExito> {
  logger.info('exito.corrida', { agente: id, disparo });
  switch (id) {
    case 'onboarding_cliente': return correrOnboarding(disparo, hoy, venceEnVuelta);
    case 'exito_cliente': return correrExitoCliente(disparo, hoy, venceEnVuelta);
    case 'retencion': return correrRetencion(disparo, hoy, venceEnVuelta);
    case 'cobranza_saas': return correrCobranzaSaas(disparo, hoy, venceEnVuelta);
    case 'soporte': return correrSoporte(disparo, hoy, ahora, venceEnVuelta);
    case 'atencion_faq': {
      const { correrAtencionFaq } = await import('./faq');
      return correrAtencionFaq(disparo, hoy, venceEnVuelta);
    }
  }
}
