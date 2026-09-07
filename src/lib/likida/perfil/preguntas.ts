// ═══════════════════════════════════════════════════════════════════════════
// EL PUNTO ÚNICO DEL PERFIL — FASE 3 (docs/perfil/PERFIL-OPERATIVO.md).
//
// Este módulo EXPONE DECISIONES, NO CAMPOS. Nada de `Perfil`, `CampoPerfil`
// ni `Procedencia` se exporta: quien necesita saber algo del cliente llama
// una función con nombre de decisión (`calificaEstimuloPeaje`) y le pasa el
// jsonb crudo de `tenant.perfil` — nunca importa el tipo ni construye un
// `Perfil` a mano. Eso es lo que hace el candado un MECANISMO: un agente que
// quisiera leer `perfil.ingresosAnualesMxn` directamente no puede, porque el
// campo no existe fuera de este archivo.
//
// EL CANDADO REAL vive en `decidir()`: nunca acepta un campo con procedencia
// `'inferido'`. Lo inferido (Mitad A de PERFIL-OPERATIVO.md — modalidad de
// compra de diésel, doble captura…) se recalcula cada mes y se MUESTRA al
// cliente; nunca se persiste como hecho, así que nunca llega aquí con esa
// procedencia salvo que alguien se salte el mecanismo de escritura. Un
// agente que quiera actuar sobre una inferencia tiene que llamar una
// función que no existe.
//
// PRIMER CAMPO REAL: ingresos anuales + parte relacionada, para el hueco
// fiscal MÁS CARO de los tres que cierra esta fase (docs/asistencia/PLAN-
// FASES.md, Fase 3): `estimulos.peajeFactor = 0.5` (config.ts:127) se aplica
// HOY sin condición, pero LIF 2026 art. 20-A (normas/lif-2026-20-A.yaml,
// hallazgo H6, verificado_fuente_primaria) exige ingresos < $300M y NO ser
// parte relacionada (LISR art. 179). Una flota grande está recibiendo un
// estímulo que no le toca.
// ═══════════════════════════════════════════════════════════════════════════

type Procedencia = 'declarado' | 'detectado' | 'inferido' | 'default' | 'ausente';

interface CampoPerfil<T> {
  valor: T;
  procedencia: Procedencia;
}

interface Perfil {
  ingresosAnualesMxn?: CampoPerfil<number>;
  /** La pregunta del plan es binaria ("¿bajo o sobre $300M?"), no un peso
   *  exacto. Capturar un número inventado para representar el umbral sería
   *  una cifra fabricada. El monto exacto (`ingresosAnualesMxn`) gana si
   *  alguien lo declara después. */
  ingresosMenoresA300M?: CampoPerfil<boolean>;
  parteRelacionada?: CampoPerfil<boolean>;
  dedicacionExclusivaCarga?: CampoPerfil<boolean>;
  regimenElegible?: CampoPerfil<boolean>;
  transporteDedicado?: CampoPerfil<boolean>;
  hombreCamion?: CampoPerfil<boolean>;
  /** ids del catálogo de conectores, o `ninguno` / `otro`. */
  gps?: CampoPerfil<string>;
  erp?: CampoPerfil<string>;
  tag?: CampoPerfil<string>;
  monedero?: CampoPerfil<string>;
  stackOtro?: CampoPerfil<string>;
  pagoOperador?: CampoPerfil<'viaje' | 'km' | 'sueldo'>;
  tanquePropio?: CampoPerfil<boolean>;
  politicaDocumento?: CampoPerfil<{ path: string; nombre: string; contentType: string }>;
  /** Paso 6: ventana del agente de cobranza. Fuente: este campo. La tabla
   *  `agente_cobranza_config` queda como legado / dual-write. */
  cobranzaVentana?: CampoPerfil<{ horaInicio: number; horaFin: number; diasSemana: number[] }>;
  /** Paso 6: a quién se avisa en operación, en orden. Default del código
   *  (encargado → flota_admin) solo aplica si esto no está declarado. */
  ordenAviso?: CampoPerfil<Array<'encargado' | 'flota_admin' | 'contador'>>;
  rfcEmpresa?: CampoPerfil<string>;
  razonSocial?: CampoPerfil<string>;
  regimenSat?: CampoPerfil<string>;
  codigoPostalFiscal?: CampoPerfil<string>;
  usoCfdi?: CampoPerfil<string>;
  emailFacturacion?: CampoPerfil<string>;
  tarjetasANombreEmpresa?: CampoPerfil<boolean>;
  pagoEnBomba?: CampoPerfil<'empresa' | 'chofer_reembolso' | 'mixto'>;
  creditoEstacion?: CampoPerfil<boolean>;
  casetasRedNacional?: CampoPerfil<boolean>;
  tms?: CampoPerfil<string>;
  portalFacturacion?: CampoPerfil<string>;
  topesPolitica?: CampoPerfil<{ diesel?: number; caseta?: number; alimentacion?: number; hospedaje?: number }>;
  operadoresAlta?: CampoPerfil<Array<{ nombre: string; telefono: string }>>;
  unidadesAlta?: CampoPerfil<Array<{ economico: string; placas?: string }>>;
  telefonoJefe?: CampoPerfil<string>;
  hazmat?: CampoPerfil<boolean>;
  poliza?: CampoPerfil<{ aseguradora: string; numero?: string; telefono800?: string }>;}

/** El candado: NUNCA decide sobre un campo inferido NI sobre un default de
 *  Likida. `getConfig()` fusiona relleno de la demo; el perfil existe justo
 *  para no tratar ese relleno como hecho del cliente. Ausente, inferido y
 *  default dan lo mismo hacia afuera — `undefined`. */
function decidir<T>(campo: CampoPerfil<T> | undefined): T | undefined {
  if (!campo || campo.procedencia === 'inferido' || campo.procedencia === 'ausente' || campo.procedencia === 'default') {
    return undefined;
  }
  return campo.valor;
}

/** Para una UI de cuestionario: el valor si ya se sabe, o la pregunta que
 *  habría que hacer si no. A diferencia de `decidir()`, SÍ deja ver un valor
 *  inferido — como sugerencia a confirmar, nunca como hecho para actuar. */
function sugerir<T>(campo: CampoPerfil<T> | undefined, pregunta: string): { valor: T | undefined; pregunta: string | undefined } {
  const decidido = decidir(campo);
  if (decidido !== undefined) return { valor: decidido, pregunta: undefined };
  return { valor: campo?.valor, pregunta };
}

/** Lee `tenant.perfil` (jsonb crudo de la base) como `Perfil`, tolerante a
 *  cualquier forma inesperada — un perfil ausente o corrupto se trata como
 *  vacío, nunca lanza. Fail-closed en el CONTENIDO (decidir() igual no va a
 *  afirmar nada sin procedencia buena), no en la lectura. */
function leerPerfil(perfilCrudo: unknown): Perfil {
  if (!perfilCrudo || typeof perfilCrudo !== 'object') return {};
  return perfilCrudo as Perfil;
}

export const PREGUNTA_ESTIMULO_PEAJE =
  '¿Los ingresos totales anuales de la flota en el último ejercicio fueron menores a $300 millones, y es parte relacionada de otra empresa (LISR art. 179)? De eso depende el estímulo de peaje del 50% (LIF 2026 art. 20-A). Likida no verifica la dedicación exclusiva ni que las casetas sean de la Red Nacional.';

export interface ElegibilidadEstimuloPeaje {
  /** `null` = el perfil todavía no lo declara. El motor lo trata como no
   *  elegible para acreditar: falta una declaración no es una autorización
   *  para aplicar un estímulo fiscal. */
  elegible: boolean | null;
}

/**
 * ¿Esta flota califica para el estímulo de peaje? Ver el encabezado del
 * archivo. `perfilCrudo` es `tenant.perfil` tal cual sale de la base —
 * quien llama nunca necesita saber su forma interna.
 */
export function calificaEstimuloPeaje(perfilCrudo: unknown): ElegibilidadEstimuloPeaje {
  const perfil = leerPerfil(perfilCrudo);
  const ingresos = decidir(perfil.ingresosAnualesMxn);
  const menoresA300M = ingresos !== undefined ? ingresos < 300_000_000 : decidir(perfil.ingresosMenoresA300M);
  const parteRelacionada = decidir(perfil.parteRelacionada);
  if (menoresA300M === undefined || parteRelacionada === undefined) return { elegible: null };
  return { elegible: menoresA300M && !parteRelacionada };
}

/** Para una futura UI de cuestionario: la pregunta pendiente, o `null` si ya
 *  se sabe. Usa `sugerir()` (no `decidir()`) a propósito: aquí SÍ importa
 *  distinguir "ya se preguntó y no se sabe" (sigue pendiente) de "hay un
 *  valor inferido que convendría confirmar" — un cuestionario que ignore la
 *  pista inferida le hace repetir al cliente un dato que el sistema ya
 *  detectó con evidencia razonable. */
export function preguntaPendienteEstimuloPeaje(perfilCrudo: unknown): string | null {
  const perfil = leerPerfil(perfilCrudo);
  const umbralCampo = perfil.ingresosMenoresA300M ?? (
    perfil.ingresosAnualesMxn
      ? { valor: perfil.ingresosAnualesMxn.valor < 300_000_000, procedencia: perfil.ingresosAnualesMxn.procedencia }
      : undefined
  );
  const umbral = sugerir(umbralCampo, PREGUNTA_ESTIMULO_PEAJE);
  const parteRelacionada = sugerir(perfil.parteRelacionada, PREGUNTA_ESTIMULO_PEAJE);
  return umbral.pregunta ?? parteRelacionada.pregunta ?? null;
}

/**
 * El patch de `tenant.perfil` para declarar la respuesta — quien llama
 * hace `{...perfilActual, ...declararIngresosYParteRelacionada(...)}` y
 * guarda el resultado. Puro: no toca la base (eso lo hace quien la llame,
 * junto con `perfil_actualizado_por` en el mismo UPDATE — ver migración
 * 0169, el trigger que sella el historial).
 */
export function declararIngresosYParteRelacionada(ingresosAnualesMxn: number, parteRelacionada: boolean): Record<string, unknown> {
  const campo = <T,>(valor: T): CampoPerfil<T> => ({ valor, procedencia: 'declarado' });
  return {
    ingresosAnualesMxn: campo(ingresosAnualesMxn),
    parteRelacionada: campo(parteRelacionada),
  };
}

/**
 * La pregunta que el plan pide (binaria). No inventa un monto en pesos para
 * representar el umbral: guarda el sí/no que el cliente declaró.
 */
/** Lo ya decidido, para prellenar el formulario. `null` = todavía no se
 *  puede afirmar (ausente, inferido o default). Nunca expone el campo crudo. */
export function umbralPeajeDeclarado(perfilCrudo: unknown): {
  ingresosMenoresA300M: boolean | null;
  parteRelacionada: boolean | null;
} {
  const perfil = leerPerfil(perfilCrudo);
  const ingresos = decidir(perfil.ingresosAnualesMxn);
  const menores = ingresos !== undefined ? ingresos < 300_000_000 : decidir(perfil.ingresosMenoresA300M);
  return {
    ingresosMenoresA300M: menores ?? null,
    parteRelacionada: decidir(perfil.parteRelacionada) ?? null,
  };
}

function campo<T>(valor: T): CampoPerfil<T> {
  return { valor, procedencia: 'declarado' };
}

export function declararUmbralPeaje(ingresosMenoresA300M: boolean, parteRelacionada: boolean): Record<string, unknown> {
  return {
    ingresosMenoresA300M: campo(ingresosMenoresA300M),
    parteRelacionada: campo(parteRelacionada),
  };
}

/** Lo que el dueño declara en el onboarding. Los opcionales se omiten si
 *  no contestó: no se inventa un "no" por un select vacío. */
export interface DatosOnboarding {
  ingresosMenoresA300M: boolean;
  parteRelacionada: boolean;
  dedicacionExclusivaCarga?: boolean;
  regimenElegible?: boolean;
  transporteDedicado?: boolean;
  hombreCamion?: boolean;
  gps?: string;
  erp?: string;
  tag?: string;
  monedero?: string;
  stackOtro?: string;
  pagoOperador?: 'viaje' | 'km' | 'sueldo';
  tanquePropio?: boolean;
  politicaDocumento?: { path: string; nombre: string; contentType: string };
  cobranzaVentana?: { horaInicio: number; horaFin: number; diasSemana: number[] };
  ordenAviso?: Array<'encargado' | 'flota_admin' | 'contador'>;
  rfcEmpresa?: string;
  razonSocial?: string;
  regimenSat?: string;
  codigoPostalFiscal?: string;
  usoCfdi?: string;
  emailFacturacion?: string;
  tarjetasANombreEmpresa?: boolean;
  pagoEnBomba?: 'empresa' | 'chofer_reembolso' | 'mixto';
  creditoEstacion?: boolean;
  casetasRedNacional?: boolean;
  tms?: string;
  portalFacturacion?: string;
  topesPolitica?: { diesel?: number; caseta?: number; alimentacion?: number; hospedaje?: number };
  operadoresAlta?: Array<{ nombre: string; telefono: string }>;
  unidadesAlta?: Array<{ economico: string; placas?: string }>;
  telefonoJefe?: string;
  hazmat?: boolean;
  poliza?: { aseguradora: string; numero?: string; telefono800?: string };}

export function declararOnboarding(d: DatosOnboarding): Record<string, unknown> {
  const patch: Record<string, unknown> = { ...declararUmbralPeaje(d.ingresosMenoresA300M, d.parteRelacionada) };
  if (d.dedicacionExclusivaCarga !== undefined) patch.dedicacionExclusivaCarga = campo(d.dedicacionExclusivaCarga);
  if (d.regimenElegible !== undefined) patch.regimenElegible = campo(d.regimenElegible);
  if (d.transporteDedicado !== undefined) patch.transporteDedicado = campo(d.transporteDedicado);
  if (d.hombreCamion !== undefined) patch.hombreCamion = campo(d.hombreCamion);
  if (d.gps) patch.gps = campo(d.gps);
  if (d.erp) patch.erp = campo(d.erp);
  if (d.tag) patch.tag = campo(d.tag);
  if (d.monedero) patch.monedero = campo(d.monedero);
  if (d.stackOtro) patch.stackOtro = campo(d.stackOtro);
  if (d.pagoOperador) patch.pagoOperador = campo(d.pagoOperador);
  if (d.tanquePropio !== undefined) patch.tanquePropio = campo(d.tanquePropio);
  if (d.politicaDocumento) patch.politicaDocumento = campo(d.politicaDocumento);
  if (d.cobranzaVentana) patch.cobranzaVentana = campo(d.cobranzaVentana);
  if (d.ordenAviso && d.ordenAviso.length > 0) patch.ordenAviso = campo(d.ordenAviso);
  Object.assign(patch, parcheHechosExtra(d));
  return patch;
}

function parcheHechosExtra(d: Partial<DatosOnboarding>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (d.rfcEmpresa) patch.rfcEmpresa = campo(d.rfcEmpresa);
  if (d.razonSocial) patch.razonSocial = campo(d.razonSocial);
  if (d.regimenSat) patch.regimenSat = campo(d.regimenSat);
  if (d.codigoPostalFiscal) patch.codigoPostalFiscal = campo(d.codigoPostalFiscal);
  if (d.usoCfdi) patch.usoCfdi = campo(d.usoCfdi);
  if (d.emailFacturacion) patch.emailFacturacion = campo(d.emailFacturacion);
  if (d.tarjetasANombreEmpresa !== undefined) patch.tarjetasANombreEmpresa = campo(d.tarjetasANombreEmpresa);
  if (d.pagoEnBomba) patch.pagoEnBomba = campo(d.pagoEnBomba);
  if (d.creditoEstacion !== undefined) patch.creditoEstacion = campo(d.creditoEstacion);
  if (d.casetasRedNacional !== undefined) patch.casetasRedNacional = campo(d.casetasRedNacional);
  if (d.tms) patch.tms = campo(d.tms);
  if (d.portalFacturacion) patch.portalFacturacion = campo(d.portalFacturacion);
  if (d.topesPolitica) patch.topesPolitica = campo(d.topesPolitica);
  if (d.operadoresAlta && d.operadoresAlta.length > 0) patch.operadoresAlta = campo(d.operadoresAlta);
  if (d.unidadesAlta && d.unidadesAlta.length > 0) patch.unidadesAlta = campo(d.unidadesAlta);
  if (d.telefonoJefe) patch.telefonoJefe = campo(d.telefonoJefe);
  if (d.hazmat !== undefined) patch.hazmat = campo(d.hazmat);
  if (d.poliza) patch.poliza = campo(d.poliza);
  return patch;
}

/** Un hecho suelto — el chat declara campo a campo. No inventa el umbral
 *  de peaje: si faltan ingresos o parte relacionada, no se escriben. */
export function declararHechos(d: Partial<DatosOnboarding>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (d.ingresosMenoresA300M !== undefined && d.parteRelacionada !== undefined) {
    Object.assign(patch, declararUmbralPeaje(d.ingresosMenoresA300M, d.parteRelacionada));
  } else {
    if (d.ingresosMenoresA300M !== undefined) patch.ingresosMenoresA300M = campo(d.ingresosMenoresA300M);
    if (d.parteRelacionada !== undefined) patch.parteRelacionada = campo(d.parteRelacionada);
  }
  if (d.dedicacionExclusivaCarga !== undefined) patch.dedicacionExclusivaCarga = campo(d.dedicacionExclusivaCarga);
  if (d.regimenElegible !== undefined) patch.regimenElegible = campo(d.regimenElegible);
  if (d.transporteDedicado !== undefined) patch.transporteDedicado = campo(d.transporteDedicado);
  if (d.hombreCamion !== undefined) patch.hombreCamion = campo(d.hombreCamion);
  if (d.gps) patch.gps = campo(d.gps);
  if (d.erp) patch.erp = campo(d.erp);
  if (d.tag) patch.tag = campo(d.tag);
  if (d.monedero) patch.monedero = campo(d.monedero);
  if (d.stackOtro) patch.stackOtro = campo(d.stackOtro);
  if (d.pagoOperador) patch.pagoOperador = campo(d.pagoOperador);
  if (d.tanquePropio !== undefined) patch.tanquePropio = campo(d.tanquePropio);
  if (d.politicaDocumento) patch.politicaDocumento = campo(d.politicaDocumento);
  if (d.cobranzaVentana) patch.cobranzaVentana = campo(d.cobranzaVentana);
  if (d.ordenAviso && d.ordenAviso.length > 0) patch.ordenAviso = campo(d.ordenAviso);
  Object.assign(patch, parcheHechosExtra(d));  return patch;
}

/** El umbral de peaje ya está declarado (las dos preguntas). Es el corte
 *  que desbloquea el panel del dueño: lo demás del onboarding es opcional. */
export function onboardingFiscalListo(perfilCrudo: unknown): boolean {
  return calificaEstimuloPeaje(perfilCrudo).elegible !== null;
}

export function stackDeclarado(perfilCrudo: unknown): {
  gps: string | null;
  erp: string | null;
  tag: string | null;
  monedero: string | null;
  pagoOperador: 'viaje' | 'km' | 'sueldo' | null;
} {
  const p = leerPerfil(perfilCrudo);
  return {
    gps: decidir(p.gps) ?? null,
    erp: decidir(p.erp) ?? null,
    tag: decidir(p.tag) ?? null,
    monedero: decidir(p.monedero) ?? null,
    pagoOperador: decidir(p.pagoOperador) ?? null,
  };
}

/** El dueño dijo "no sé" en un campo opcional. `decidir()` lo trata como
 *  no declarado (no actúa). La entrevista no lo vuelve a preguntar. */
export function declararAusente(campos: string[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const c of campos) patch[c] = { valor: null, procedencia: 'ausente' };
  return patch;
}
export function facilidad15Declarada(perfilCrudo: unknown): { dedicacionExclusivaCarga: boolean; regimenElegible: boolean } | null {
  const p = leerPerfil(perfilCrudo);
  const ded = decidir(p.dedicacionExclusivaCarga);
  const reg = decidir(p.regimenElegible);
  if (ded === undefined || reg === undefined) return null;
  return { dedicacionExclusivaCarga: ded, regimenElegible: reg };
}

/**
 * AUDITORÍA 28, FIS-A3 (fuente única) — RFA 2026 regla 2.9: la pareja
 * VIGENTE de la facilidad del 15%, con la MISMA precedencia que antes vivía
 * reimplementada por separado en `cuadre/desde_db.ts`, `fiscal.ts`, `tools.ts`
 * y `admin/negocio.ts`: el perfil manda SI declara las DOS condiciones a la
 * vez (`facilidad15Declarada`, arriba); si no, se usa
 * `tenant.config.facilidadCombustibleEfectivo` (el alta vieja, o el
 * dual-write de `actualizarFacilidad15` en `repo.ts`) SOLO si también trae
 * las DOS explícitas; si ninguna fuente decide las dos juntas, no hay
 * declaración vigente (`undefined`) — una declaración A MEDIAS nunca se
 * guarda ni se lee como si fuera un "no" (mismo candado que arriba).
 *
 * Devuelve la PAREJA (no un booleano ya combinado) para que el mismo helper
 * sirva tanto a quien solo necesita "¿aplica la facilidad?"
 * (`dedicacionExclusivaCarga && regimenElegible`) como a quien necesita
 * mostrar/editar cada condición por separado (el panel de superadmin en
 * `/admin/flotas`).
 */
export function facilidad15Vigente(
  perfilCrudo: unknown,
  config: { facilidadCombustibleEfectivo?: { dedicacionExclusivaCarga?: boolean; regimenElegible?: boolean } } | null | undefined,
): { dedicacionExclusivaCarga: boolean; regimenElegible: boolean } | undefined {
  const f15Perfil = facilidad15Declarada(perfilCrudo);
  if (f15Perfil) return f15Perfil;
  const f15 = config?.facilidadCombustibleEfectivo;
  if (f15 && f15.dedicacionExclusivaCarga !== undefined && f15.regimenElegible !== undefined) {
    return { dedicacionExclusivaCarga: f15.dedicacionExclusivaCarga === true, regimenElegible: f15.regimenElegible === true };
  }
  return undefined;
}

/**
 * El patch de `tenant.perfil` que declara la facilidad del 15% con
 * `procedencia: 'declarado'` — lo usa `repo.ts` (`actualizarFacilidad15`)
 * para que CUALQUIER corrección de la facilidad (onboarding, entrevista del
 * chat, o el panel de superadmin en `/admin/flotas`) quede también en la
 * fuente única, no solo en el `tenant.config` legado. `undefined` en ambos
 * argumentos = "sin declarar": se marca AUSENTE (no se inventa un `false`)
 * para que `facilidad15Declarada` dependa de una declaración de verdad.
 */
export function declararFacilidad15(
  dedicacionExclusivaCarga: boolean | undefined,
  regimenElegible: boolean | undefined,
): Record<string, unknown> {
  if (dedicacionExclusivaCarga === undefined || regimenElegible === undefined) {
    return declararAusente(['dedicacionExclusivaCarga', 'regimenElegible']);
  }
  return {
    dedicacionExclusivaCarga: campo(dedicacionExclusivaCarga),
    regimenElegible: campo(regimenElegible),
  };
}

export function ventanaCobranzaDeclarada(perfilCrudo: unknown): { horaInicio: number; horaFin: number; diasSemana: number[] } | null {
  return decidir(leerPerfil(perfilCrudo).cobranzaVentana) ?? null;
}

/** ¿La flota DECLARÓ mover materiales peligrosos? `null` = no declarado —
 *  que para los relojes matpel (Fase 6) significa NO disparar plazos de
 *  SICT/ASEA que quizá no aplican: un reloj legal inventado entrena a
 *  ignorar los reales. Solo una declaración (o detección) enciende el reloj.
 *  También lo lee el clasificador de Carta Porte: hazmat declarado = materia
 *  excluida = complemento SIEMPRE (2.7.7.2.1, cuarto párrafo). */
export function hazmatDeclarado(perfilCrudo: unknown): boolean | null {
  return decidir(leerPerfil(perfilCrudo).hazmat) ?? null;
}

/** RMF 2.7.7.1.3: en transporte DEDICADO se invierten los roles del
 *  complemento (el cliente emite el traslado). El aviso ADVIERTE, sin
 *  veredicto duro — la P40 del fiscalista sigue abierta. */
export function transporteDedicadoDeclarado(perfilCrudo: unknown): boolean | null {
  return decidir(leerPerfil(perfilCrudo).transporteDedicado) ?? null;
}

const ROLES_AVISO = ['encargado', 'flota_admin', 'contador'] as const;
export type RolAviso = typeof ROLES_AVISO[number];

export function ordenAvisoDeclarado(perfilCrudo: unknown): RolAviso[] | null {
  const v = decidir(leerPerfil(perfilCrudo).ordenAviso);
  if (!v || v.length === 0) return null;
  const limpios = v.filter((r): r is RolAviso => (ROLES_AVISO as readonly string[]).includes(r));
  return limpios.length > 0 ? limpios : null;
}
