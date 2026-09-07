import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { acotada } from './presupuesto';
import { traerTodo, conteo } from './pg';
import { anotarEventoIncidencia, TIPOS_ASISTENCIA } from './asistencia_wa';
import { telefonoJefeDe } from './contactos';
import { polizaVigenteDe, contactoSiLesionadosDe } from './emergencias';
import { leerConfigCobranza } from './agentes/cobranza';
import { dentroDeVentana } from './agentes/cobranza_pura';
import { sendButtons } from '@/lib/meta/client';
import { alertarOperador } from '@/lib/observability/alerta';

// ═══════════════════════════════════════════════════════════════════════════
// EL ESCALAMIENTO DE ASISTENCIA (Fase 5, paso 4 del plano).
//
// El reloj muerto: quien reporta una emergencia y nadie la RECONOCE no puede
// quedarse esperando a que alguien entre al panel. Cinco niveles:
//
//   0 chofer (el aviso síncrono de la Fase 4 ya salió al jefe)
//   1 jefe — se le INSISTE
//   2 dueño — o INMEDIATO si hay lesionados
//   3 seguros — el 800 de la póliza EN LA MANO de quien sí puede marcar
//   4 emergencia — "si hay riesgo de vida, 911" + alerta al operador de Likida
//
// LIKIDA NO MARCA 911 NI A LA ASEGURADORA, JAMÁS: una llamada automática abre
// un siniestro (dinero y acto jurídico) y un despacho falso de 911 es delito.
// Cada nivel pone el dato y la urgencia en manos humanas — nunca marca.
//
// ── EL CLAIM ES MONÓTONO Y TIENE QUE VOLVER A DISPARAR ─────────────────────
// A diferencia del sello de `escalar_viaje` (que no expira: un viaje escalado
// una vez no se re-escala), aquí QUE EL NIVEL 1 NO CONTESTE ES EL CASO DE
// USO. El claim es un UPDATE condicional sobre `nivel_escalado` exacto: dos
// crons solapados escalan EXACTAMENTE una vez (el perdedor no manda nada), y
// la incidencia RECONOCIDA (`asi_ok:` del jefe) detiene la escalada — ese es
// el punto del botón.
//
// ── LA VENTANA HORARIA ES DE LA SEVERIDAD, NO DEL CANAL ────────────────────
// ROJO (prioridad crítica) la ignora SIEMPRE: a un dueño se le despierta por
// un choque. ÁMBAR (varado) la respeta reusando `dentroDeVentana` de cobranza
// (UNA implementación, no dos) y fuera de ventana el aviso se DIFIERE con
// `notificar_desde` — no se tira: el cron de la mañana lo entrega. Nunca se
// le pregunta a un modelo si despierta a alguien.
// ═══════════════════════════════════════════════════════════════════════════

export const NIVEL_MAXIMO = 4;

/** Un reloj por nivel: rojo escala cada 5 min sin reconocimiento; ámbar cada
 *  15. Con el cron cada 5 min, un ROJO desatendido llega al nivel 4 en ~20
 *  minutos — que es el punto: nadie lo atendió en 20 minutos. */
export const RELOJ_ROJO_MS = 5 * 60_000;
export const RELOJ_AMBAR_MS = 15 * 60_000;

export interface IncidenciaEscalable {
  id: string;
  tenantId: string;
  tipo: string;
  prioridad: string;
  nivelEscalado: number;
  abiertaEn: string;
  hayLesionados: boolean | null;
  viajeId: string | null;
  operadorId: string | null;
  notificarDesde: string | null;
  descripcion: string | null;
}

/**
 * ¿A qué nivel debe estar esta incidencia AHORA, según su reloj? Puro, sin
 * IO. El nivel objetivo crece un peldaño por periodo transcurrido desde
 * cuándo empezó a esperar REALMENTE — el más tardío entre `abiertaEn` (se
 * reportó) y `notificarDesde` (el cron la refrescó al diferirla la última
 * vez que estuvo fuera de ventana). Con lesionados el primer salto aterriza
 * directo en el 2 (dueño).
 *
 * AUDITORÍA 28 (AG-A3): contar SIEMPRE desde `abiertaEn` inflaba el nivel de
 * un caso ámbar que llevaba horas DIFERIDO (fuera de ventana, sin que nadie
 * pudiera avisar todavía): al reabrir la ventana, el primer aviso real
 * saltaba directo a nivel 4 ("911, riesgo de vida") aunque nadie hubiera
 * dejado de responder — nunca se le había avisado. `escalarUna` refresca
 * `notificar_desde` en CADA corrida que sigue diferida (no solo la primera),
 * así que al reabrir la ventana el ancla queda a lo más un ciclo de cron
 * atrás, y el nivel vuelve a ser el que corresponde a la espera real.
 */
export function nivelObjetivo(
  i: Pick<IncidenciaEscalable, 'prioridad' | 'nivelEscalado' | 'abiertaEn' | 'hayLesionados'> & { notificarDesde?: string | null },
  ahora: Date,
): number {
  const reloj = i.prioridad === 'critica' ? RELOJ_ROJO_MS : RELOJ_AMBAR_MS;
  const abiertaEnMs = Date.parse(i.abiertaEn);
  const notificarDesdeMs = i.notificarDesde ? Date.parse(i.notificarDesde) : NaN;
  const desde = Number.isFinite(notificarDesdeMs) ? Math.max(abiertaEnMs, notificarDesdeMs) : abiertaEnMs;
  const transcurrido = ahora.getTime() - desde;
  if (!Number.isFinite(transcurrido) || transcurrido < 0) return i.nivelEscalado;
  const porReloj = Math.min(NIVEL_MAXIMO, Math.floor(transcurrido / reloj));
  // Lesionados: el dueño se entera de inmediato — el primer periodo vencido
  // ya apunta al nivel 2, no al 1.
  if (i.hayLesionados === true && porReloj >= 1) return Math.max(porReloj, 2);
  return porReloj;
}

/**
 * El claim atómico. Gana exactamente un proceso: `where nivel_escalado =
 * <esperado>` hace que dos crons solapados no dupliquen el aviso, y
 * `reconocida_en is null` + `estado <> 'resuelta'` hacen que el botón del
 * jefe (o el cierre en el panel) detengan la escalada para siempre.
 */
export async function reclamarEscalacionAsistencia(
  tenantId: string, incidenciaId: string, nivelEsperado: number, nivelNuevo: number,
): Promise<boolean> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('incidencia')
    .update({ nivel_escalado: nivelNuevo })
    .eq('id', incidenciaId)
    .eq('tenant_id', tenantId)
    .eq('nivel_escalado', nivelEsperado)
    .is('reconocida_en', null)
    .neq('estado', 'resuelta')
    .select('id'), 'asistencia.reclamarEscalacion');
  if (error) throw new Error(`reclamarEscalacionAsistencia: ${error.message}`);
  return (data ?? []).length > 0;
}

/** Teléfono de un rol concreto de la flota (el dueño para el nivel 2+).
 *  `null` = ese rol no tiene teléfono capturado — se dice, no se inventa. */
async function telefonoDeRol(tenantId: string, rol: string): Promise<string | null> {
  // AUDITORÍA 25, CRÍTICO (AGEN-C1): `activo`. Es la tercera salida que el
  // hallazgo de la 24 nombraba y el arreglo `70dd5c6` no tocó. Por aquí sale el
  // 🚨 de la escalada, que lleva la UBICACIÓN del chofer: mandárselo a alguien
  // a quien la flota ya le quitó el acceso es el peor de los tres casos.
  // El `.limit(1)` cuenta filas del SERVIDOR, así que el filtro tiene que ir en
  // la base o una fila de baja se lleva el cupo y esconde a la viva; y otra vez
  // en TS, porque una regla en dos capas no es una regla repetida.
  //
  // CORRECCIÓN (reauditoría de la 25): la rama `activo.is.null` no es una red
  // para la base vieja. La 0294 crea la columna `not null default true`
  // (`0294:47`): aplicada, NULL es imposible; sin aplicar, la columna no existe
  // y este `select` da 42703 — esta función LANZA. El caso sí queda cubierto,
  // pero por otro lado: la compuerta de despliegue no construye si la base va
  // atrás, y aquí el `catch` de arriba alerta al operador igual.
  const { data, error } = await acotada(supabaseAdmin()
    .from('app_user').select('telefono, activo')
    .eq('tenant_id', tenantId).eq('rol', rol)
    .or('activo.is.null,activo.eq.true')
    .not('telefono', 'is', null)
    .limit(1), 'asistencia.telefonoRol');
  if (error) throw new Error(`telefonoDeRol: ${error.message}`);
  const vivo = (data ?? []).find((f) => (f as { activo?: boolean }).activo !== false);
  return (vivo?.telefono as string) ?? null;
}

const ADVERTENCIA_ROBO =
  '\n⚠️ Puede ser violencia EN CURSO: no le marques al chofer hasta saber que está seguro.';

/**
 * El texto de cada nivel. El botón `asi_ok:` viaja en todos: reconocer en
 * cualquier nivel detiene el reloj. La descripción del chofer viaja citada y
 * recortada — es SU reporte.
 */
function textoEscalada(args: {
  nivel: number;
  tipo: string;
  descripcion: string;
  poliza: { aseguradora: string; numeroPoliza: string; telefonoSiniestros: string } | null;
  contactoLesionados: { nombre: string; telefono: string; parentesco: string | null } | null;
}): string {
  const desc = args.descripcion.replace(/\s+/g, ' ').trim().slice(0, 180);
  const robo = args.tipo === 'robo' ? ADVERTENCIA_ROBO : '';
  const lesionados = args.contactoLesionados
    ? `\n⛑️ Contacto de emergencia del operador (autorizado por tu flota): ${args.contactoLesionados.nombre}${args.contactoLesionados.parentesco ? ` (${args.contactoLesionados.parentesco})` : ''} · ${args.contactoLesionados.telefono}. Tú decides si avisarle — Likida no le marca a nadie.`
    : '';
  if (args.nivel === 1) {
    return `🚨 SIGUE SIN ATENDERSE la emergencia reportada:\n«${desc}»${robo}\n\nAprieta el botón si ya la estás atendiendo — si no, en unos minutos se escala al dueño.`;
  }
  if (args.nivel === 2) {
    return `🚨 EMERGENCIA SIN ATENDER — nadie la ha tomado:\n«${desc}»${robo}${lesionados}\n\nAprieta el botón si ya la estás atendiendo.`;
  }
  if (args.nivel === 3) {
    const seguro = args.poliza
      ? `Marca a tu aseguradora YA: ${args.poliza.aseguradora}, siniestros ${args.poliza.telefonoSiniestros}, póliza ${args.poliza.numeroPoliza}. Likida no puede marcar por ti — una llamada abre el siniestro.`
      : 'Tu flota NO tiene póliza capturada en Likida — el 800 de siniestros de tu aseguradora es el dato que ahora mismo falta. Captúralo en el panel (Emergencias) para la próxima.';
    return `🚨 EMERGENCIA SIN ATENDER (tercer aviso):\n«${desc}»${robo}${lesionados}\n\n${seguro}`;
  }
  return `🚨 NADIE HA ATENDIDO ESTA EMERGENCIA en ~20 minutos:\n«${desc}»${robo}${lesionados}\n\nSi hay riesgo de vida, marca 911 AHORA. Este es el último aviso automático — el equipo de Likida también fue alertado.`;
}

export interface ResultadoEscalamiento {
  revisadas: number;
  escaladas: number;
  diferidas: number;
  fallosAviso: number;
  cortadosPorReloj: number;
}

/**
 * La corrida del cron: barre TODAS las flotas (el índice parcial
 * `incidencia_sin_reconocer_idx` de la 0198 la hace corta) y escala lo
 * vencido. `venceEn` corta la corrida a tiempo — lo que no alcanzó turno lo
 * toma la siguiente (cada 5 min), y el conteo lo dice.
 */
export async function escalarAsistenciasPendientes(
  ahora: Date = new Date(),
  opts: { venceEn?: number } = {},
): Promise<ResultadoEscalamiento> {
  const venceEn = opts.venceEn ?? Number.POSITIVE_INFINITY;
  const r: ResultadoEscalamiento = { revisadas: 0, escaladas: 0, diferidas: 0, fallosAviso: 0, cortadosPorReloj: 0 };

  // AUDITORÍA 28 (AG-A4): el orden por `abierta_en` sin desempate permite
  // empates (dos incidencias abiertas en el mismo milisegundo) — con eso el
  // `range` por posición de `traerTodo` puede repetir o saltarse una fila en
  // el borde de una página. `conteo(desde)` además le da a `traerTodo` la
  // prueba barata (el `count` de la primera página) en vez de depender SOLO
  // de la página vacía.
  const filas = await traerTodo<Record<string, unknown>>(
    (desde, hasta) => supabaseAdmin()
      .from('incidencia')
      .select('id, tenant_id, tipo, prioridad, nivel_escalado, abierta_en, hay_lesionados, viaje_id, operador_id, notificar_desde, descripcion', conteo(desde))
      .in('tipo', [...TIPOS_ASISTENCIA])
      .neq('estado', 'resuelta')
      .is('reconocida_en', null)
      .lt('nivel_escalado', NIVEL_MAXIMO)
      .order('abierta_en', { ascending: true })
      .order('id', { ascending: true })
      .range(desde, hasta),
    'asistencia.pendientes',
  );

  for (const f of filas) {
    if (Date.now() > venceEn) {
      r.cortadosPorReloj = filas.length - r.revisadas;
      break;
    }
    r.revisadas++;
    const inc: IncidenciaEscalable = {
      id: f.id as string,
      tenantId: f.tenant_id as string,
      tipo: f.tipo as string,
      prioridad: f.prioridad as string,
      nivelEscalado: Number(f.nivel_escalado ?? 0),
      abiertaEn: f.abierta_en as string,
      hayLesionados: (f.hay_lesionados as boolean | null) ?? null,
      viajeId: (f.viaje_id as string) ?? null,
      operadorId: (f.operador_id as string) ?? null,
      notificarDesde: (f.notificar_desde as string) ?? null,
      descripcion: (f.descripcion as string) ?? null,
    };

    try {
      const escalo = await escalarUna(inc, ahora);
      if (escalo === 'escalada') r.escaladas++;
      else if (escalo === 'diferida') r.diferidas++;
      else if (escalo === 'fallo_aviso') { r.escaladas++; r.fallosAviso++; }
    } catch (e) {
      r.fallosAviso++;
      logger.error('asistencia.escalar_fallo', { incidencia: inc.id, err: e instanceof Error ? e.message : String(e) });
    }
  }
  return r;
}

async function escalarUna(inc: IncidenciaEscalable, ahora: Date): Promise<'sin_cambio' | 'diferida' | 'escalada' | 'fallo_aviso'> {
  const objetivo = nivelObjetivo(inc, ahora);
  if (objetivo <= inc.nivelEscalado) return 'sin_cambio';

  // ÁMBAR respeta la ventana de la flota (la misma de cobranza — una
  // implementación). Fuera de ventana: se DIFIERE con `notificar_desde` como
  // marca visible, nunca se tira. ROJO (crítica) ni la consulta.
  //
  // AUDITORÍA 28 (AG-A3): `notificar_desde` se REFRESCA en cada corrida que
  // sigue diferida, no solo la primera vez. Si se quedara fijo en el primer
  // diferimiento, un caso ámbar que pasa horas fuera de ventana llegaría al
  // reabrirla con `nivelObjetivo` calculando desde esa marca vieja — el mismo
  // salto directo a nivel 4 que el bug original, solo que un poco más tarde.
  // Refrescarlo hace que el ancla quede a lo más un ciclo de cron atrás
  // cuando la ventana reabre. La fila de bitácora `aviso_diferido` sí se
  // manda UNA sola vez (la primera): no hay nada nuevo que contar en las
  // siguientes, y diez filas idénticas no sirven al expediente.
  if (inc.prioridad !== 'critica') {
    const config = await leerConfigCobranza(inc.tenantId);
    if (!dentroDeVentana(config, ahora)) {
      const primeraVezDiferida = !inc.notificarDesde;
      const { error } = await acotada(supabaseAdmin()
        .from('incidencia')
        .update({ notificar_desde: ahora.toISOString() })
        .eq('id', inc.id).eq('tenant_id', inc.tenantId), 'asistencia.diferir');
      if (!error && primeraVezDiferida) await anotarEventoIncidencia(inc.tenantId, inc.id, 'aviso_diferido', { desde: ahora.toISOString() });
      return 'diferida';
    }
  }

  // El claim: gana exactamente uno. Saltos de más de un nivel (lesionados)
  // van en UN claim al objetivo — no un aviso por peldaño intermedio: el
  // dueño con lesionados necesita UN mensaje claro, no dos.
  const gano = await reclamarEscalacionAsistencia(inc.tenantId, inc.id, inc.nivelEscalado, objetivo);
  if (!gano) return 'sin_cambio';

  // Los datos del texto — best-effort declarado: sin póliza el nivel 3 lo
  // DICE; sin contacto, la línea no aparece.
  let poliza = null, contacto = null;
  try { poliza = await polizaVigenteDe(inc.tenantId); } catch { /* el texto lo dice */ }
  if (inc.hayLesionados === true) {
    try {
      let operadorId = inc.operadorId;
      if (!operadorId && inc.viajeId) {
        const { data: v } = await supabaseAdmin().from('viaje').select('operador_id')
          .eq('id', inc.viajeId).eq('tenant_id', inc.tenantId).maybeSingle();
        operadorId = (v?.operador_id as string) ?? null;
      }
      if (operadorId) contacto = await contactoSiLesionadosDe(inc.tenantId, operadorId);
    } catch { /* sin contacto la línea no aparece */ }
  }

  const texto = textoEscalada({
    nivel: objetivo,
    tipo: inc.tipo,
    descripcion: inc.descripcion ?? '(sin descripción)',
    poliza,
    contactoLesionados: contacto,
  });

  // A quién: nivel 1 al jefe; 2+ al dueño (y si el dueño no tiene teléfono,
  // al jefe — el aviso no se queda sin destinatario por un dato faltante).
  let telefono: string | null = null;
  let destinatario = 'jefe';
  try {
    if (objetivo >= 2) {
      telefono = await telefonoDeRol(inc.tenantId, 'flota_admin');
      destinatario = 'dueño';
      if (!telefono) { telefono = await telefonoJefeDe(inc.tenantId); destinatario = 'jefe (dueño sin teléfono)'; }
    } else {
      telefono = await telefonoJefeDe(inc.tenantId);
    }
  } catch (e) {
    logger.error('asistencia.telefono_ilegible', { incidencia: inc.id, err: e instanceof Error ? e.message : String(e) });
  }

  let avisado = false;
  if (telefono) {
    avisado = Boolean(await sendButtons(telefono, texto, [{ id: `asi_ok:${inc.id}`, titulo: 'Ya lo atiendo' }]));
  }

  // Nivel 4, o CUALQUIER aviso que no salió: el operador de Likida se entera.
  // La cascada plantilla→correo del plano llega cuando existan las plantillas
  // de Meta (acto de Javier) — HOY el fallback honesto es la alerta directa,
  // y la bitácora dice cuál de los dos caminos corrió.
  if (objetivo >= NIVEL_MAXIMO || !avisado) {
    await alertarOperador('asistencia.escalamiento', {
      error: !avisado
        ? `Emergencia ${inc.tipo} escalada a nivel ${objetivo} y el WhatsApp a ${destinatario} NO salió (tenant ${inc.tenantId}, incidencia ${inc.id}).`
        : `Emergencia ${inc.tipo} llegó al nivel ${NIVEL_MAXIMO} sin que nadie la reconozca (tenant ${inc.tenantId}, incidencia ${inc.id}).`,
      codigo: !avisado ? 'aviso_escalada_fallido' : 'escalada_nivel_maximo',
    });
  }

  await anotarEventoIncidencia(inc.tenantId, inc.id, avisado ? 'escalada' : 'aviso_escalada_fallido', {
    nivel: objetivo, destinatario, avisado,
  });
  logger.info('asistencia.escalada', { incidencia: inc.id, nivel: objetivo, destinatario, avisado });
  return avisado ? 'escalada' : 'fallo_aviso';
}

/** Expuestos SOLO para pruebas: el texto por nivel se fija con casos, no se
 *  re-deriva en el test. */
export const _soloParaTests = { textoEscalada, telefonoDeRol };
