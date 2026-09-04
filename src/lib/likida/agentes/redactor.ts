// ═══════════════════════════════════════════════════════════════════════════
// EL REDACTOR (C5) — el primer correo de un prospecto del censo, A LA COLA.
//
// La última pieza de código de la Fase 2 del plan hacia el 90%. Ejecuta el
// prompt operativo de `prompts/redactor.md` (13-Agentes-de-AI) con las tres
// prohibiciones cableadas en el system prompt: no citar la vacante, cero
// personalización alucinada (solo hechos de la FILA del prospecto), y
// ninguna cifra fuera de la guía canónica ($38/$35/$31, ciclo ≈$105).
//
// LO QUE ESTE MÓDULO NUNCA HACE: enviar. Su única salida es `encolarPieza`
// (0117) — el envío vive en `enviarPiezaPorCorreo`, detrás de la aprobación
// humana, el CHECK enviar-solo-aprobado, la guardia de cadencia 48h y el
// tope diario. La pieza lleva la variante A LISTA PARA SALIR TAL CUAL en el
// cuerpo (aprobar-tal-cual tiene que ser un correo enviable, no un menú);
// las variantes B/C y los datos usados viajan en `fuentes` — trazabilidad
// que la bandeja enseña.
//
// COSTO: al log (`redactor.costo`), NO a `llm_costo` — misma decisión que el
// copiloto: esa tabla exige tenant y el Redactor es gasto de LIKIDA.
// ═══════════════════════════════════════════════════════════════════════════
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { acotada } from '../presupuesto';
import { DatoInvalido } from '../errores';
import { estaApagado } from '../interruptores';
import { generateStructured, StructuredError } from '@/lib/llm/openrouter';
import { createLlmBudget, type LlmBudget } from '@/lib/llm/budget';
import { encolarPieza, verificarFormatoCampana } from './cola';
import { registrarCorrida, type DisparoCorrida } from './corridas';
import { notasSinPersona } from '@/lib/likida/prospectos/seudonimo';
import { logger } from '@/lib/logger';
import { normalizarEstadoProspecto } from '../vendedores';

// Las ÚNICAS cifras que el correo puede decir (prompts/redactor.md §3,
// guía canónica del 15-ago-2026). Cambiarlas aquí es cambiar el guion.
const CIFRAS_CANONICAS = `- $35 MXN por viaje liquidado, un tercio del costo del ciclo (tabulador: $38 hasta 500 viajes/mes · $35 de 500 a 5,000 · $31 arriba de 5,000; piso $9,500 MXN/mes)
- costo del ciclo completo ≈ $105 MXN por viaje (banda $94–115), porque lo tocan cinco puestos — tráfico, liquidación, facturación y cierre contable — no solo el liquidador
- estímulos: IEPS del diésel y 50% del peaje (sin porcentajes de ahorro inventados)
- validación de facturas ante el SAT`;

const SYSTEM = `Eres el redactor de primeros correos de Likida (liquidación de viajes de flotas de carga en México).

TU SALIDA NO SE ENVÍA. Va a una cola donde un humano la aprueba, la edita o la rechaza. Escribe como si supieras que un humano va a leer cada palabra antes de que salga, porque así es.

ESCRIBE 3 VARIANTES:
- Variante A — por el costo (la de default)
- Variante B — por el dinero fiscal (IEPS del diésel, 50% de peaje)
- Variante C — confirmación de demo (SOLO si el dossier trae un sí previo; si no, escribe exactamente: "No aplica: la variante C solo se usa después de un sí.")

REGLAS DE ESCRITURA:
- Máximo 5 líneas por correo. Asunto de máximo 6 palabras, sin signos de admiración. (El asunto de la variante A se sustituye después por el asunto fijo de la campaña — escríbelo igual: el de las variantes B/C sí sale.)
- PROHIBIDO el guion largo (—) en cualquier parte del correo.
- Si mencionas tracción, la ÚNICA frase permitida es "en pláticas con transportistas del centro y norte del país". PROHIBIDO nombrar a NINGÚN prospecto o cliente por su nombre, aunque exista una plática real (AGB-2: el nombre de un prospecto es un dato de terceros, no un argumento de venta). PROHIBIDO decir "clientes reales" o llamar cliente a cualquier empresa: ninguna ha firmado.
- Termina SIEMPRE con una pregunta de agenda concreta: "¿le vienen bien 15 minutos el jueves?" — no "¿le interesaría platicar?".
- Remitente: el vendedor humano indicado, una persona. Nunca "el equipo de Likida".
- Español mexicano directo. Prohibido "revolucionario", "innovador", "inteligente", "de vanguardia", "solución integral". Sin emojis, sin negritas de venta, sin postdata de urgencia falsa.
- Si el dossier trae un Contacto, para dirigirte a él por su nombre escribe EXACTAMENTE el token \`{{NOMBRE}}\` (con las llaves dobles, tal cual) donde iría su nombre de pila — nunca inventes ni copies un nombre distinto. Ese token se reemplaza fuera de este modelo. Si el dossier dice "no capturado", no uses el token: saluda sin nombre ("Hola,").

LAS TRES PROHIBICIONES (romper cualquiera invalida el correo entero):
1. NO CITES LA VACANTE ni menciones que la viste. El dolor se alude por OFICIO: "liquidar viajes a mano", "el cierre administrativo del viaje", "la comprobación de gastos del operador".
2. PROHIBIDA LA PERSONALIZACIÓN ALUCINADA. Si un hecho no está en el DOSSIER, no existe. El único contexto permitido es el que el dossier trae.
3. NINGUNA CIFRA fuera de esta lista:
${CIFRAS_CANONICAS}

FORMATO DE SALIDA: JSON que cumpla el schema, y NADA más. Los campos:
- variante_a: { asunto, cuerpo } — la del costo. OBLIGATORIA: sin ella no hay pieza.
- variante_b: { asunto, cuerpo } — la del dinero fiscal, o null si no aplica.
- variante_c: el cuerpo de la confirmación de demo, o null si el dossier no trae un sí previo.
- datos_usados: cada hecho concreto del dossier que aparece en los correos, o "ninguno específico de esta empresa" — un correo genérico honesto es mejor que uno personalizado con datos inventados.

Los cuerpos van en texto plano con saltos de línea reales: sin markdown, sin encabezados, sin viñetas.`;

// ═══════════════════════════════════════════════════════════════════════════
// EL CONTRATO DE SALIDA, EN SCHEMA (primera pasada real del runner, 18:03).
//
// Hasta aquí el Redactor pedía markdown (`## Variante A` + `**Asunto:**`) y lo
// desarmaba con regex. Las TRES corridas de la primera pasada real murieron
// con «El Redactor devolvió una salida sin variante A legible»: el rol
// `back_office` corre con un modelo de RAZONAMIENTO, que gasta cientos de
// tokens invisibles antes de la primera letra visible y se quedaba sin los 900
// de tope — el `content` llegaba vacío o cortado a media variante. Contra eso
// un regex no tiene nada que hacer, y además confundía el diagnóstico:
// "ilegible" cuando lo que pasaba era truncamiento.
//
// `generateStructured` sí lo distingue: ve `finish_reason: 'length'` ANTES de
// parsear, reintenta con el doble de tope, valida contra el schema y trae el
// texto CRUDO del modelo en el error para poder diagnosticar. Es el mismo
// camino que ya usa el investigador con este mismo rol.
// ═══════════════════════════════════════════════════════════════════════════
const ESQUEMA_VARIANTES = z.object({
  variante_a: z.object({
    asunto: z.string().describe('Asunto de máximo 6 palabras, sin signos de admiración'),
    cuerpo: z.string().describe('El correo completo listo para salir, máximo 5 líneas, texto plano'),
  }).describe('La variante por el costo — la de default. Obligatoria: sin ella no hay pieza.'),
  variante_b: z.object({
    asunto: z.string(),
    cuerpo: z.string(),
  }).nullable().describe('La variante por el dinero fiscal, o null'),
  variante_c: z.string().nullable()
    .describe('Cuerpo de la confirmación de demo SOLO si el dossier trae un sí previo; si no, null'),
  datos_usados: z.string().nullable()
    .describe('Los hechos del dossier que aparecen en los correos, o "ninguno específico de esta empresa"'),
});

export type SalidaRedactor = z.infer<typeof ESQUEMA_VARIANTES>;

export interface PiezaRedactada {
  piezaId: string;
  asunto: string;
  /** Gasto de modelo de esta pieza, USD — lo suma el runner contra el techo. */
  costoUsd: number;
  /** Aviso honesto del agente (p. ej. "el prospecto no tiene correo capturado
   *  — conseguir el contacto ANTES de aprobar"). */
  aviso: string | null;
}

interface Variante { asunto: string; cuerpo: string }

/** Contexto de cobro del Redactor. Nunca se obtiene de un env global: el
 * caller autenticado o el runner debe entregar explícitamente el tenant que
 * paga la corrida. `budget` permite compartir una única reserva/run entre
 * varias piezas del mismo lote, sin reiniciar la contabilidad por prospecto.
 */
export interface RedactorExecutionContext {
  tenantId?: string | null | undefined;
  budget?: LlmBudget;
  runId?: string;
  maxTenantDailyUsd?: number;
  /**
   * AUDITORÍA FABLE CICLO 5 (c5-10): el gasto es de LIKIDA (tenant null) —
   * el mismo contrato que investigador/SDR/enviador desde la 0217. El techo
   * NO desaparece: lo vigila el runner comparando el gasto MEDIDO del día
   * (agente_corrida.costo_usd, que cada corrida escribe) contra el
   * `presupuesto_dia_usd` declarado del agente. Sin este modo, la corrida
   * cron del runner no tenía ningún tenant que darle y el Redactor quedaba
   * "saltado — fail closed" en TODA pasada: la cadena cron→redactor→
   * enviador→SDR estaba muerta y la máquina solo trabajaba a mano.
   */
  plataforma?: boolean;
}

function presupuestoDelRedactor(contexto: RedactorExecutionContext | undefined): LlmBudget | undefined {
  // El modo plataforma no lleva ledger por-tenant: su techo es el gasto
  // medido contra el presupuesto declarado, en el runner (c5-10).
  if (contexto?.plataforma) return undefined;
  if (contexto?.budget) {
    if (contexto.tenantId !== undefined && contexto.tenantId !== null
      && contexto.tenantId !== contexto.budget.tenantId) {
      throw new DatoInvalido('El presupuesto del Redactor no coincide con el tenant autenticado.');
    }
    return contexto.budget;
  }
  return createLlmBudget(contexto?.tenantId, contexto?.runId ?? randomUUID(), 'fondo', {
    maxTenantDailyUsd: contexto?.maxTenantDailyUsd,
  });
}

const MARCADOR_NOMBRE = '{{NOMBRE}}';

/** El asunto ÚNICO de la campaña de frío (plantilla asentada en la campaña
 *  real y ratificada el 27-ago-2026). La variante A siempre sale con él —
 *  se impone en CÓDIGO tras el parseo, no se le confía al modelo. */
export const ASUNTO_CAMPANA = 'Automatizar la liquidación de viajes, antes de contratar para el puesto';

// El verificador ESTRUCTURAL del formato de campaña vive ahora en cola.ts
// (c5-14): la PUERTA de salida también lo aplica — una edición humana o una
// pieza retomada que lo viole tampoco sale. Se re-exporta para los
// llamadores y pruebas que lo importaban de aquí.
export { verificarFormatoCampana };

/** AGB-6 (auditoría 24, 1-sep-2026): fuentes ya vetadas a mano — no son el
 *  censo abierto (DENUE/Computrabajo, sin giro) que dejó pasar vacantes como
 *  "Gerente General de Restaurante" (Premium Restaurant Brands) o "Analista
 *  de finanzas" (Coca-Cola FEMSA) hacia el redactor. */
const FUENTES_ICP_VETADAS = ['canacar', 'aaag', 'manual', 'landing'] as const;
/** El piso de `similitud_icp_pct` (columna derivada, 0140/0143) para que la
 *  compuerta confíe en el scorer en vez de en el SCIAN o la fuente. */
const UMBRAL_SIMILITUD_ICP = 60;

/** AGB-6: la COMPUERTA DE ICP — sin ella, `estado = 'nuevo'` era el único
 *  filtro entre el censo (vacantes de Computrabajo, sin giro capturado en
 *  32,900 de 32,986 prospectos) y el redactor. Un prospecto pasa si CUALQUIERA
 *  de tres señales dice "es transportista": su SCIAN es del sector 48-49
 *  (Transportes, correos y almacenamiento, INEGI), su fuente ya fue vetada a
 *  mano (no es censo abierto), o el propio scorer (`similitud_icp_pct`,
 *  0140/0143) ya mide suficiente parecido con el ICP. PURA, para poder
 *  probarla sin base — y FAIL CLOSED: sin ninguna de las tres, no pasa. */
export function pasaCompuertaIcp(p: { scian: string | null; fuente: string; similitudIcpPct: number | null }): boolean {
  const scian = p.scian?.trim() ?? '';
  if (scian.startsWith('48') || scian.startsWith('49')) return true;
  if ((FUENTES_ICP_VETADAS as readonly string[]).includes(p.fuente)) return true;
  if (typeof p.similitudIcpPct === 'number' && p.similitudIcpPct >= UMBRAL_SIMILITUD_ICP) return true;
  return false;
}

/** El nombre de pila del contacto — lo único que se sustituye de vuelta, y
 *  SOLO fuera del modelo (ver la nota de AUDITORÍA 19 legal C2 en el
 *  dossier). `null` si no hay contacto capturado: sin nombre no hay nada
 *  que sustituir, y el SYSTEM le pide al modelo no usar el marcador en ese
 *  caso. Exportada para su prueba. */
export function primerNombreDelContacto(contactoNombre: string | null): string | null {
  const primero = contactoNombre?.trim().split(/\s+/)[0];
  return primero || null;
}

/**
 * Reemplaza el marcador por el nombre de pila real DESPUÉS de la completion
 * — el modelo nunca ve `nombre`. Si no hay nombre (el dossier decía "no
 * capturado" y aun así el modelo usó el marcador, o lo usó mal), se limpia
 * el saludo a secas en vez de dejar "Hola {{NOMBRE}}," visible en la pieza
 * que un humano va a aprobar.
 */
export function sustituirMarcador(texto: string, nombre: string | null): string {
  if (nombre) return texto.split(MARCADOR_NOMBRE).join(nombre);
  return texto
    .replace(new RegExp(`\\s*${MARCADOR_NOMBRE.replace(/[{}]/g, '\\$&')}\\s*,`, 'g'), ',')
    .split(MARCADOR_NOMBRE).join('');
}

/** Lo que el modelo devolvió, TAL CUAL, para meterlo en el error. Sin esto el
 *  diagnóstico de la primera pasada real fue imposible: la corrida solo decía
 *  "sin variante A legible" y nadie podía ver qué había contestado el modelo.
 *  `null`/vacío se dice con palabras, que también es información. */
export function textoDelModelo(raw: string | undefined | null): string {
  const t = (raw ?? '').trim();
  return t === '' ? '(vacío — el modelo no devolvió texto)' : t;
}

/** Valida la salida del schema y la deja lista para la cola. LANZA si la
 *  variante A no llega utilizable — una pieza malformada no entra a la cola, y
 *  el error lleva el texto EXACTO del modelo para poder diagnosticarlo.
 *  Exportada para su prueba: esta función es la frontera entre el modelo y la
 *  cola. */
export function variantesDeSalida(
  d: SalidaRedactor,
  raw: string,
): { a: Variante; b: Variante | null; c: string | null; datosUsados: string | null } {
  const limpiar = (v: { asunto: string; cuerpo: string } | null): Variante | null => {
    const asunto = v?.asunto?.trim();
    const cuerpo = v?.cuerpo?.trim();
    // El schema garantiza los TIPOS, no que el modelo haya escrito algo: una
    // cadena vacía cumple `z.string()` y encolaría un correo en blanco.
    if (!asunto || !cuerpo) return null;
    return { asunto: asunto.slice(0, 120), cuerpo };
  };
  const a = limpiar(d.variante_a);
  if (!a) {
    throw new DatoInvalido(
      'El Redactor devolvió una salida sin variante A legible — no se encoló nada. Reintenta. '
      + `Lo que contestó el modelo: ${textoDelModelo(raw)}`,
    );
  }
  return {
    a,
    b: limpiar(d.variante_b),
    c: d.variante_c?.trim().slice(0, 2_000) || null,
    datosUsados: d.datos_usados?.trim().slice(0, 1_000) || null,
  };
}

/**
 * Redacta el primer correo de UN prospecto y lo deja en la cola de
 * aprobación. LANZA con palabras de pantalla en todo rechazo — quien apretó
 * el botón debe enterarse, no creer que hay una pieza esperando.
 */
export async function redactarCorreoFrio(
  prospectoId: string,
  vendedorNombre: string,
  /** 'manual' = botón del tablero; 'cron' = el runner nivel 2 (0123) — la
   *  corrida dice la verdad de quién la disparó. */
  disparo: DisparoCorrida = 'manual',
  contexto?: RedactorExecutionContext,
): Promise<PiezaRedactada> {
  const inicio = new Date();

  // 1) El kill switch — fail closed, como todos (interruptores.ts).
  if (await estaApagado('agente:redactor')) {
    throw new DatoInvalido('El Redactor está apagado — se enciende desde /admin/observabilidad o ⌘K.');
  }

  // El presupuesto se resuelve ANTES de leer/gastar el modelo. Un Redactor
  // sin tenant explícito no puede caer a un tenant global ni a un env de
  // plataforma: en producción se detiene cerrado.
  const budget = presupuestoDelRedactor(contexto);

  // 2) El prospecto REAL — el dossier es su fila, nada más (prohibición #2).
  const { data: p, error } = await acotada(supabaseAdmin()
    .from('prospecto')
    .select('id, empresa, contacto_nombre, correo, ciudad, estado, fuente, notas, scian, similitud_icp_pct')
    .is('duplicado_de', null)
    .eq('id', prospectoId).maybeSingle(), 'redactor.prospecto');
  if (error) throw new Error(`redactarCorreoFrio: ${error.message}`);
  if (!p) throw new DatoInvalido('Ese prospecto no existe — recarga el tablero.');
  const prospecto = p as { id: string; empresa: string; contacto_nombre: string | null; correo: string | null; ciudad: string | null; estado: string; fuente: string; notas: string | null; scian: string | null; similitud_icp_pct: number | null };
  const estadoCanonico = normalizarEstadoProspecto(prospecto.estado);
  if (estadoCanonico === 'won' || estadoCanonico === 'lost') {
    throw new DatoInvalido(`Este prospecto está ${prospecto.estado} — a un ${prospecto.estado} no se le redacta correo frío.`);
  }
  // AGB-6: compuerta de ICP ANTES de gastar modelo — fail closed, como la
  // cadencia de abajo. Sin giro de autotransporte, fuente vetada o score
  // suficiente, este prospecto no es a quien se le escribe "liquidación de
  // viajes" (el caso real: vacantes de Computrabajo sin relación con carga).
  if (!pasaCompuertaIcp({ scian: prospecto.scian, fuente: prospecto.fuente, similitudIcpPct: prospecto.similitud_icp_pct })) {
    throw new DatoInvalido('Este prospecto no pasa la compuerta de ICP (sin SCIAN de autotransporte, sin fuente vetada y sin similitud ICP suficiente) — no se le redacta correo frío.');
  }

  // 3) La regla del censo finito: contactado hace <48h NO se vuelve a tocar
  //    — se lee el historial ANTES de gastar en el modelo, y si el historial
  //    no se puede leer, no se redacta (fail closed, misma regla que el
  //    envío). También frena la pieza duplicada: ya hay una pendiente de
  //    este prospecto en la cola → no se fabrica otra.
  const hace48h = new Date(Date.now() - 48 * 3_600_000).toISOString();
  const { data: recientes, error: errHist } = await supabaseAdmin()
    .from('prospecto_contacto').select('ocurrio_en')
    .eq('prospecto_id', prospectoId).eq('direccion', 'salida')
    .gte('ocurrio_en', hace48h).limit(1);
  if (errHist) throw new DatoInvalido('No se pudo leer el historial del prospecto — sin él no se redacta (la cadencia no se verifica a ciegas). Reintenta.');
  if ((recientes ?? []).length > 0) {
    throw new DatoInvalido('A este prospecto se le escribió hace menos de 48 horas — la cadencia lo protege. Reintenta cuando pase la ventana.');
  }
  const { data: pendientes, error: errPend } = await supabaseAdmin()
    .from('cola_aprobacion').select('id')
    .eq('prospecto_id', prospectoId).eq('estado', 'pendiente').limit(1);
  if (errPend) throw new DatoInvalido('No se pudo verificar la cola — reintenta.');
  if ((pendientes ?? []).length > 0) {
    throw new DatoInvalido('Este prospecto ya tiene una pieza esperando aprobación — resuélvela antes de redactar otra.');
  }

  // 4) El dossier: SOLO los hechos de la fila, declarados como tales.
  //
  // AUDITORÍA 19 (legal C2, CRÍTICO): el aviso de privacidad del Cerebro de
  // ventas promete «tu nombre no sale de Likida: la ficha que recibe el
  // modelo de lenguaje lleva un marcador en lugar de tu nombre... tu nombre
  // de pila se pone después, dentro de Likida» (privacidad.ts:757) — pero
  // este archivo mandaba `prospecto.contacto_nombre` COMPLETO, tal cual, a
  // un modelo externo (OpenRouter). El aviso describía un mecanismo que
  // nunca se construyó. `primerNombreDelContacto` se queda LOCAL: el modelo
  // solo ve el marcador `{{NOMBRE}}` (instrucción en SYSTEM); el nombre de
  // pila real se sustituye DESPUÉS de la completion, en `sustituirMarcador`.
  const primerNombre = primerNombreDelContacto(prospecto.contacto_nombre);

  // LA INVESTIGACIÓN (0217): si el investigador ya dejó dossier, sus hechos
  // — cada uno leído del sitio real de la empresa, con fuente — SON hechos
  // verificados y entran al contexto permitido. Es la única ampliación de la
  // prohibición #2: personalizar con lo investigado, jamás con lo imaginado.
  // Lectura best-effort deliberada: sin dossier (o con la lectura caída) el
  // correo sale genérico honesto, que siempre fue el piso del Redactor.
  const lineasInvestigadas: string[] = [];
  try {
    const { data: d, error: errD } = await supabaseAdmin()
      .from('prospecto_dossier')
      .select('historia, empleados, flotilla, datos')
      .eq('prospecto_id', prospectoId).maybeSingle();
    if (errD) {
      logger.info('redactor.dossier_ilegible', { prospecto: prospectoId, err: errD.message });
    } else if (d) {
      const dd = d as { historia: string | null; empleados: string | null; flotilla: string | null; datos: Array<{ dato?: string }> | null };
      if (dd.historia) lineasInvestigadas.push(`Historia (de su sitio): ${dd.historia.slice(0, 300)}`);
      if (dd.empleados) lineasInvestigadas.push(`Tamaño (de su sitio): ${dd.empleados.slice(0, 150)}`);
      if (dd.flotilla) lineasInvestigadas.push(`Flota (de su sitio): ${dd.flotilla.slice(0, 150)}`);
      for (const h of (dd.datos ?? []).slice(0, 4)) {
        if (h?.dato) lineasInvestigadas.push(`Hallazgo (de su sitio): ${h.dato.slice(0, 200)}`);
      }
    }
  } catch (e) {
    logger.info('redactor.dossier_ilegible', { prospecto: prospectoId, err: e instanceof Error ? e.message : String(e) });
  }

  // AUDITORÍA 19, CRÍTICO (legal C2 / C.18): las notas pasaban CRUDAS al
  // modelo — `prospecto.notas.slice(0, 500)` con lo que un vendedor hubiera
  // escrito adentro: nombres, correos, teléfonos, y desde /api/lead hasta el
  // teléfono de un tercero que un formulario público inyectó a `notas`. El
  // nombre ya se había cerrado con el marcador (ronda previa); las notas se
  // escapaban por la misma puerta. Ahora pasan por `notasSinPersona` — LA
  // PUERTA ÚNICA de lib/likida/prospectos/seudonimo.ts, la misma que usa el
  // Cerebro — con ESTE marcador, para que si el modelo copia un tramo de la
  // nota, `sustituirMarcador` lo resuelva de vuelta igual que el saludo.
  const notasLimpias = notasSinPersona(prospecto.notas, prospecto.contacto_nombre, MARCADOR_NOMBRE);
  const dossier = [
    `Empresa: ${prospecto.empresa}`,
    primerNombre ? 'Contacto: {{NOMBRE}}' : 'Contacto: no capturado',
    prospecto.ciudad ? `Ciudad: ${prospecto.ciudad}` : 'Ciudad: no capturada',
    `Etapa del pipeline: ${prospecto.estado}`,
    notasLimpias ? `Notas del vendedor: ${notasLimpias.slice(0, 500)}` : 'Notas: ninguna',
    ...lineasInvestigadas,
    '(No hay más hechos verificados. Lo que no esté aquí, NO existe.)',
  ].join('\n');

  // 5) El modelo — una sola llamada, con SCHEMA (ver la nota de arriba), sin
  //    tools.
  let salida: SalidaRedactor;
  let crudo = '';
  let costoUsd = 0;
  try {
    const r = await generateStructured({
      // El rol BARATO del back office (16-ago-2026) — por aquí pasan datos
      // de PROSPECTOS, nunca RFC/CFDI de un cliente (la frontera y el
      // proveedor viven en models.ts).
      role: 'back_office',
      system: SYSTEM,
      schema: ESQUEMA_VARIANTES,
      schemaName: 'variantes_correo_frio',
      messages: [{ role: 'user', content: `DOSSIER:\n${dossier}\n\nVENDEDOR (remitente): ${vendedorNombre}` }],
      // Tres variantes + los datos usados, y el rol corre con un modelo de
      // razonamiento cuyos tokens invisibles salen de este mismo tope: con 900
      // no alcanzaba ni para abrir la llave del JSON. `generateStructured`
      // reintenta solo al doble si aun así se corta.
      maxTokens: 1_800,
      temperature: 0.5,
      budget,
    });
    salida = r.data;
    crudo = r.raw;
    costoUsd = r.cost;
    logger.info('redactor.costo', {
      costoUsd: r.cost, tokensIn: r.tokensIn, tokensOut: r.tokensOut, modelo: r.model,
    });
  } catch (e) {
    // El texto CRUDO del modelo viaja en el StructuredError — es lo único que
    // permite saber por qué no se pudo leer una salida, y era exactamente lo
    // que faltó para diagnosticar los tres fallos de la primera pasada.
    const rawDelError = e instanceof StructuredError ? textoDelModelo(e.raw) : null;
    // La llamada se cobra aunque falle (`usage` viaja en el error): tirar ese
    // costo dejaría al techo diario ciego justo en el modo que más gasta.
    const gastado = e instanceof StructuredError ? e.usage?.cost ?? 0 : 0;
    await registrarCorrida(null, 'redactor', {
      inicio, fin: new Date(), estado: 'fallo', disparo, costoUsd: gastado,
      resumen: { prospecto: prospectoId },
      error: (rawDelError
        ? `El modelo no devolvió una salida legible. Lo que contestó: ${rawDelError}`
        : 'El modelo no respondió.').slice(0, 1_000),
    });
    logger.error('redactor.modelo_fallo', {
      prospecto: prospectoId,
      err: e instanceof Error ? e.message : String(e),
      ...(rawDelError ? { crudo: rawDelError } : {}),
    });
    throw new DatoInvalido('El Redactor no pudo escribir en este momento — inténtalo de nuevo.');
  }

  // 6) Parsear, SUSTITUIR el marcador por el nombre de pila real (nunca visto
  // por el modelo — AUDITORÍA 19 legal C2), y ENCOLAR. La pieza jamás sale de
  // aquí hacia ningún correo.
  let pieza: PiezaRedactada;
  try {
    const v = variantesDeSalida(salida, crudo);
    const con = (s: string) => sustituirMarcador(s, primerNombre);
    // El asunto de la campaña se IMPONE (no se le confía al modelo), y el
    // cuerpo pasa por el verificador estructural: "clientes reales" o un
    // guion largo descartan la pieza entera — mejor cero correo que uno que
    // rompa los guardarraíles cazados en vivo.
    const asuntoA = ASUNTO_CAMPANA;
    const cuerpoA = con(v.a.cuerpo);
    verificarFormatoCampana(cuerpoA);
    const varianteB = v.b ? { asunto: con(v.b.asunto), cuerpo: con(v.b.cuerpo) } : null;
    const varianteC = v.c ? con(v.c) : null;
    const aviso = prospecto.correo?.trim()
      ? null
      : 'El prospecto no tiene correo capturado — conseguir el contacto ANTES de aprobar.';
    const piezaId = await encolarPieza({
      tipo: 'correo_frio', prioridad: 'normal', agente: 'redactor',
      prospectoId, titulo: asuntoA,
      cuerpo: cuerpoA,
      fuentes: {
        variante_b: varianteB, variante_c: varianteC, datos_usados: v.datosUsados,
        dossier: { empresa: prospecto.empresa, ciudad: prospecto.ciudad, etapa: prospecto.estado, fuente: prospecto.fuente },
        ...(aviso ? { aviso } : {}),
      },
    });
    pieza = { piezaId, asunto: asuntoA, aviso, costoUsd };
  } catch (e) {
    // AUDITORÍA 21 (agéntico, MEDIO): la lectura previa de `pendientes`
    // (arriba, paso 3) basta contra un humano pero no contra dos disparadores
    // en carrera (el botón del tablero y el cron nivel 2, ambos llaman a
    // `redactarCorreoFrio` para el mismo prospecto). El árbitro real es el
    // índice único parcial `cola_correo_frio_por_prospecto` (0270): la
    // invocación que pierde la carrera rebota aquí con 23505, y se traduce al
    // MISMO mensaje de pantalla que ya daba el freno de lectura — el mismo
    // patrón que `encolarPiezaExito` usa contra `cola_parte_exito_por_periodo`
    // (exito.ts). El costo del modelo YA se gastó de todos modos: se registra
    // aunque la pieza no entrara — tirarlo dejaría al techo diario ciego al
    // modo de falla que más gasta.
    const msg = e instanceof Error ? e.message : String(e);
    const esCarreraDuplicada = msg.includes('cola_correo_frio_por_prospecto') || msg.includes('duplicate key');
    const error = esCarreraDuplicada
      ? new DatoInvalido('Este prospecto ya tiene una pieza esperando aprobación — resuélvela antes de redactar otra.')
      : e;
    await registrarCorrida(null, 'redactor', {
      inicio, fin: new Date(), estado: 'fallo', disparo, costoUsd,
      resumen: { prospecto: prospectoId },
      error: error instanceof DatoInvalido ? error.message : 'No se pudo encolar la pieza.',
    });
    throw error;
  }

  await registrarCorrida(null, 'redactor', {
    inicio, fin: new Date(), estado: 'ok', disparo, costoUsd,
    tareasHechas: 1, tareasTotal: 1,
    resumen: { prospecto: prospectoId, pieza: pieza.piezaId, con_correo: Boolean(prospecto.correo?.trim()) },
  });
  return pieza;
}
