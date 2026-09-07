// ═══════════════════════════════════════════════════════════════════════════
// EL AVISO DE CIERRE DE MES DE PEAJE (0231) — la contracara honesta de la
// descarga masiva.
//
// LO QUE CAE SOLO: todo comprobante que el comercio ya timbró al RFC de la
// flota. Monederos de combustible autorizados (el emisor timbra por periodo
// con complemento ECC), TeleVía tras un alta única de datos fiscales, y PASE
// pospago EN MODALIDAD MENSUAL. Eso lo recoge la descarga masiva y este
// archivo no tiene nada que hacer ahí.
//
// LO QUE NO CAE SOLO: PASE prepago (factura la RECARGA, en su portal), PASE
// pospago por cruce (portal, selección manual) y, muy probablemente,
// IAVE/CAPUFE (bajo demanda desde su portal). Ésos siguen exigiendo que
// alguien entre a un sitio — Y ESE DERECHO CADUCA.
//
// ─────────────────────────────────────────────────────────────────────────
// LA REGLA QUE HACE QUE ESTO EXISTA
//
// PASE extingue el derecho a facturar EL ÚLTIMO DÍA DEL MES EN CURSO (regla
// vigente desde diciembre de 2021, verificada en su propio sitio). O sea: un
// cruce del 3 de septiembre se factura hasta el 30 de septiembre, y el 1 de
// octubre ya no. Un panel que concilia a mes vencido —que es lo natural, y lo
// que hace un contador— LLEGA TARDE SIEMPRE, por diseño y no por descuido.
//
// Por eso esto no es un reporte: es un RELOJ, de la misma familia que los
// relojes legales (`relojes_legales.ts`) y los avisos de vigencia (0202).
// Avisa ANTES, con la lista de lo que falta, al teléfono del dinero. Y sella
// lo avisado para no convertirse en spam: una vez por (flota, mes, umbral), y
// un mes nuevo es un ciclo nuevo.
//
// LIKIDA NO FACTURA POR NADIE. Avisa con el plazo y el paso exacto; entrar al
// portal de PASE sigue siendo un acto de la flota — el mismo principio que
// gobierna los otros relojes ("Likida AVISA; jamás ejecuta el acto legal").
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase/admin';
import { acotada } from '@/lib/likida/presupuesto';
import { traerTodo, conteo } from '@/lib/likida/pg';
import { logger } from '@/lib/logger';
import { hoyMx, mxn } from '@/lib/formato';
import { sendText } from '@/lib/meta/client';
import { telefonoParaDineroDe } from '../contactos';

/** Con cuántos días de anticipación se avisa cuando la flota no declaró otra
 *  cosa. Siete días deja una semana hábil para entrar al portal — y el aviso
 *  del último día (umbral 0) sale siempre, porque es el que ya no admite
 *  postergarse. */
export const DIAS_AVISO_DEFECTO = 7;

/** Cuántos cruces se listan en el WhatsApp antes de mandar al panel. Mismo
 *  tope que el vigilante de reglas: un mensaje de 300 líneas no se lee. */
export const MAX_LINEAS = 10;

export interface GastoPorFacturar {
  id: string;
  monto: number;
  fecha: string;
}

/** El último día del mes al que pertenece `hoy`. */
export function ultimoDiaDelMes(hoy: string): string {
  const [a, m] = hoy.split('-').map(Number);
  // Día 0 del mes siguiente = último del actual, sin tabla de bisiestos.
  return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
}

/** El primer día del mes: el CICLO del sello. */
export function primerDiaDelMes(hoy: string): string {
  return `${hoy.slice(0, 7)}-01`;
}

export function diasHastaCierre(hoy: string): number {
  return Math.round(
    (Date.parse(`${ultimoDiaDelMes(hoy)}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / 86_400_000,
  );
}

/**
 * ¿Toca avisar hoy, y con qué umbral? PURO: la decisión de cuándo hablar es
 * exactamente lo que hay que poder probar sin reloj ni base.
 *
 * Dos umbrales, y solo dos, por la misma razón que `UMBRALES_VIGENCIA` tiene
 * tres: uno con margen para actuar (el que la flota configura) y uno el día
 * del cierre, que ya no admite postergarse. Un aviso diario durante el mes
 * entrena a ignorarlo, que es la forma más eficaz de no avisar.
 */
export function umbralDeHoy(hoy: string, diasAviso = DIAS_AVISO_DEFECTO): number | null {
  const faltan = diasHastaCierre(hoy);
  if (faltan === 0) return 0;
  if (faltan === diasAviso) return diasAviso;
  return null;
}

export function mensajeCierrePeaje(
  gastos: readonly GastoPorFacturar[],
  faltan: number,
  total: number,
): string {
  const cabeza = faltan === 0
    ? '⏰ HOY vence el derecho a facturar tus casetas de este mes.'
    : `⏰ Faltan ${faltan} días para que venza el derecho a facturar tus casetas de este mes.`;
  const cuerpo = gastos.slice(0, MAX_LINEAS).map((g) => `· ${g.fecha} — ${mxn(g.monto)}`);
  const resto = gastos.length - cuerpo.length;
  const cola = resto > 0 ? `\n…y ${resto} cruce${resto === 1 ? '' : 's'} más.` : '';
  return [
    cabeza,
    `Tienes ${gastos.length} cruce${gastos.length === 1 ? '' : 's'} de caseta sin CFDI por ${mxn(total)}:`,
    cuerpo.join('\n') + cola,
    'PASE extingue el derecho a facturar el último día del mes en curso: lo que no se facture hoy ya no se puede. Entra a tu portal de PASE/IAVE y factúralos — el detalle está en Combustible y casetas.',
  ].join('\n');
}

export interface ResumenCierrePeaje {
  corrio: boolean;
  flotas: number;
  avisadas: number;
  sinDestinatario: number;
  gastos: number;
  /** Flotas a las que NO se pudo reservar el sello (la base no contestó). No
   *  recibieron aviso, y se cuentan aparte de `sinDestinatario` porque la causa
   *  y el arreglo son otros. */
  sinReserva: number;
  /** Reservas que se tomaron, no acabaron en mensaje y TAMPOCO se pudieron
   *  soltar. Cada una es un aviso de ESTE umbral que ya no va a salir: el
   *  número que hay que mirar primero cuando algo huele mal. */
  reservasAtoradas: number;
  /** Flotas que quedaron sin mirar porque se acabó el reloj de la vuelta. NO
   *  es lo mismo que «no les tocaba»: es trabajo que el tiempo le quitó a este
   *  barrido, y por eso se cuenta aparte y sube al latido como 'parcial'. */
  sinTurno: number;
  /**
   * AUDITORÍA 28, MEDIO (REN-A4). Antes: `true` cuando la lectura de casetas
   * llegaba AL TOPE de un `.limit(5_000)` fijo — hay más cruces del mes de
   * los que se leyeron, y el barrido seguía con datos parciales sin que nada
   * más que un log lo dijera. Hoy la lectura usa `traerTodo` (paginación real,
   * hasta 100,000 filas) y LANZA `LecturaIncompleta` si no puede demostrar que
   * trajo todo — fail-closed, igual que `configIlegible` más abajo — así que
   * una lectura truncada nunca produce un resumen `corrio: true` a medias.
   * El campo se conserva SIEMPRE en `false` por compatibilidad con el latido
   * (`descarga-sat/route.ts` todavía lo lee) y con el panel.
   */
  truncado: boolean;
}

/** ¿El rebote es el de la llave primaria del sello? */
function esDuplicado(err: { code?: unknown; message?: unknown }): boolean {
  return String(err.code ?? '') === '23505'
    || String(err.message ?? '').includes('duplicate key');
}

/**
 * SUELTA una reserva de sello que no acabó en mensaje.
 *
 * Es la mitad que hace honesto al claim-then-act: sin ella, una reserva sobre
 * un WhatsApp que nunca salió enterraría el aviso del mes (el umbral es un día
 * exacto y no vuelve). Si el borrado tampoco se puede, se GRITA: ese es el
 * único caso en el que este archivo pierde un aviso, y tiene que ser ruidoso.
 * Devuelve `true` si la reserva quedó libre.
 */
async function soltarReserva(tenantId: string, periodo: string, umbral: number): Promise<boolean> {
  const { error } = await acotada(supabaseAdmin()
    .from('peaje_cierre_aviso')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('periodo', periodo)
    .eq('umbral', umbral), 'peaje_cierre.soltar');
  if (error) {
    logger.error('peaje_cierre.reserva_atorada', { tenantId, periodo, umbral, err: error.message });
    return false;
  }
  return true;
}

/**
 * El barrido: por cada flota, si hoy cruza un umbral y hay casetas sin CFDI,
 * avisa y sella.
 *
 * ── LA IDEMPOTENCIA ES LA LLAVE PRIMARIA, NO UN `if` (regla 6) ────────────
 *
 * AUDITORÍA CICLO 7, c7-17: hasta el 27-ago-2026 esto leía el sello, decidía,
 * MANDABA y sellaba al final. La PK `(tenant_id, periodo, umbral)` protegía la
 * FILA, no el ENVÍO: dos invocaciones solapadas del cron leían las dos
 * «todavía no se ha avisado», las dos llamaban a `sendText`, y la segunda
 * rebotaba con un 23505 cuando el WhatsApp duplicado YA estaba en el teléfono
 * de la flota. En el canal del dinero, que es justo el que el resto del repo
 * protege con pisos horarios para que nadie aprenda a ignorarlo.
 *
 * Ahora el orden es claim-then-act, el mismo patrón que la 0227 usa para el
 * timbre: se RESERVA el sello con un `insert` —la PK arbitra la carrera, no un
 * `if`—, se manda, y si el mensaje no sale se SUELTA la reserva para que la
 * corrida siguiente reintente. Una fila viva significa: este aviso SALIÓ.
 *
 * Lo que se pierde y por qué se acepta: el fallo de `soltarReserva` (un
 * borrado que tampoco se pudo) entierra ese aviso. Se cambió un riesgo por
 * otro a sabiendas — un aviso perdido cada tanto es recuperable con el aviso
 * del último día, y un WhatsApp duplicado en el canal del dinero enseña a
 * ignorarlo, que es lo que no tiene arreglo.
 *
 * ── EL RELOJ DE LA VUELTA (patrón del PR #152) ────────────────────────────
 *
 * Este barrido ITERA SOBRE UNA LISTA DE TRABAJO —una flota por vuelta, con un
 * WhatsApp de por medio— así que le toca la regla que el runner aprendió a la
 * mala: un motor que itera pregunta la hora. El runner murió mudo el
 * 25-ago-2026 y el 28-ago-2026 exactamente por bucles que no la preguntaban;
 * Vercel corta la función DENTRO del bucle y la ruta no alcanza a escribir su
 * latido, así que el fallo no se ve en ningún tablero. Aquí el riesgo es el
 * mismo: `telefonoParaDineroDe` + `sendText` son dos viajes de red EN SERIE
 * por flota, y este barrido comparte los 300 s de `maxDuration` con
 * `correrDescargaSat`, que corre ANTES y se lleva lo que quiera.
 *
 * DÓNDE SE PREGUNTA, Y POR QUÉ SOLO AHÍ: al principio de cada flota, ANTES de
 * reservar el sello. Nunca entre la reserva y el envío — cortar ahí dejaría el
 * sello puesto sobre un mensaje que no salió, que es justo el aviso enterrado
 * que `soltarReserva` existe para impedir. Una vez tomada la reserva, esa
 * flota se termina.
 */
export async function avisarCierrePeaje(
  ahora: Date = new Date(),
  /** EL RELOJ DE LA VUELTA (epoch ms), cuando el llamador impone uno. Sin él el
   *  barrido corre completo, como siempre. */
  opts: { venceEn?: number } = {},
): Promise<ResumenCierrePeaje> {
  const hoy = hoyMx(ahora);
  const periodo = primerDiaDelMes(hoy);
  const faltan = diasHastaCierre(hoy);

  // Las flotas que tienen casetas sin CFDI ESTE MES. Se parte de los gastos y
  // no del catálogo de flotas: una flota sin casetas no necesita el aviso, y
  // recorrer todos los tenants para descubrirlo sería trabajo por nada.
  //
  // AUDITORÍA 28, MEDIO (REN-A4). Esto era UNA página con `.limit(5_000)` y
  // se seguía trabajando con datos parciales si la tocaba (declarando
  // `truncado`, pero sin dejar de avisar a medias). El `.order()` tampoco
  // desempataba por `id`: sin PK en el orden, la rebanada que entra cuando se
  // agota el tope depende de cómo Postgres resuelva el empate entre filas con
  // el mismo `(tenant_id, fecha)` — no es determinista fila por fila, aunque
  // no cruce de flota (mismo patrón de riesgo que otros lotes de esta
  // auditoría: PostgREST recorta a N filas cualesquiera sin un orden que
  // desempate del todo). `traerTodo` pagina de verdad —hasta 100,000 filas— y
  // LANZA `LecturaIncompleta` si no puede demostrar que trajo todo, en vez de
  // continuar con un subconjunto: fail-closed, igual que `configIlegible` más
  // abajo. El desempate final por `id` hace el cursor de página determinista.
  let gastos: Array<{ id: string; tenant_id: string; monto: number; fecha: string }>;
  try {
    gastos = await traerTodo<{ id: string; tenant_id: string; monto: number; fecha: string }>(
      (desde, hasta) => acotada(supabaseAdmin()
        .from('gasto')
        .select('id, tenant_id, monto, fecha', conteo(desde))
        .eq('concepto', 'caseta')
        .is('cfdi_uuid', null)
        .gte('fecha', periodo)
        .lte('fecha', hoy)
        .order('tenant_id', { ascending: true })
        .order('fecha', { ascending: true })
        .order('id', { ascending: true })
        .range(desde, hasta), 'peaje_cierre.gastos'),
      'peaje_cierre.gastos',
    );
  } catch (e) {
    throw new Error(`avisarCierrePeaje: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (gastos.length === 0) {
    return {
      corrio: true, flotas: 0, avisadas: 0, sinDestinatario: 0, gastos: 0,
      sinReserva: 0, reservasAtoradas: 0, sinTurno: 0, truncado: false,
    };
  }

  const porFlota = new Map<string, GastoPorFacturar[]>();
  for (const g of gastos) {
    const t = g.tenant_id;
    const lista = porFlota.get(t) ?? [];
    lista.push({ id: g.id, monto: Number(g.monto), fecha: g.fecha });
    porFlota.set(t, lista);
  }

  // La anticipación declarada por cada flota. Sin fila de configuración se usa
  // el default: una flota SIN descarga masiva también recibe este aviso — el
  // derecho a facturar se le vence igual.
  //
  // AUDITORÍA CICLO 7, c7-8 (alto): aquí NO se leía `error` (regla 4), y
  // `acotada` lo empeoraba — al agotar su tope devuelve `{ data: null, error }`,
  // así que un timeout de 9.5 s entraba por esta puerta y se leía como «ninguna
  // flota tiene configuración». Una flota con `peaje_dias_aviso = 10` perdía su
  // aviso ENTERO: el día en que faltaban 10 días, `diasDe` venía vacío, el
  // `?? DIAS_AVISO_DEFECTO` inventaba un 7, y `umbralDeHoy` —que solo dispara
  // con `faltan === diasAviso` EXACTO— devolvía null. Mañana faltan 9, tampoco
  // es 7: NO HAY SEGUNDA OPORTUNIDAD para ese umbral. La flota solo recibía el
  // aviso de «HOY vence», demasiado tarde para entrar al portal de PASE, y el
  // derecho a facturar esos cruces se extinguía. Dinero perdido por un valor de
  // configuración inventado a partir de un error tragado.
  //
  // «No pude leer tu configuración» NO es «tu configuración es 7».
  const { data: cfgs, error: errCfg } = await acotada(supabaseAdmin()
    .from('sat_descarga_config')
    .select('tenant_id, peaje_dias_aviso')
    .in('tenant_id', [...porFlota.keys()]), 'peaje_cierre.config');
  const configIlegible = Boolean(errCfg);
  if (configIlegible) {
    logger.error('peaje_cierre.config_ilegible', { periodo, faltan, err: errCfg!.message });
  }
  const diasDe = new Map((cfgs ?? []).map((c) => [c.tenant_id as string, Number(c.peaje_dias_aviso)]));

  let avisadas = 0;
  let sinDestinatario = 0;
  let sinReserva = 0;
  let reservasAtoradas = 0;
  let flotas = 0;
  let saltadasPorConfig = 0;
  let sinTurno = 0;

  // Se materializa el Map a arreglo para poder decir CUÁNTAS flotas quedaron
  // sin mirar cuando el reloj corta — «se acabó el tiempo» sin el número es
  // media verdad, y el latido necesita el número.
  const entradas = [...porFlota.entries()];
  for (let i = 0; i < entradas.length; i++) {
    // ── EL RELOJ, ADENTRO DEL MOTOR (patrón #152) ──────────────────────────
    // ANTES de reservar el sello, nunca después: una reserva tomada y no
    // usada entierra el aviso del mes (el umbral es un día exacto y no
    // vuelve). Lo que no alcanzó turno se DICE en `sinTurno`; no desaparece.
    if (opts.venceEn !== undefined && Date.now() >= opts.venceEn) {
      sinTurno = entradas.length - i;
      logger.warn('peaje_cierre.corte_por_reloj', { sinTurno, avisadas, flotas, periodo, faltan });
      break;
    }
    const [tenantId, lista] = entradas[i];
    // EL ÚNICO UMBRAL QUE NO DEPENDE DE LA CONFIGURACIÓN es el del último día:
    // `faltan === 0` es el cierre para TODAS las flotas, lo hayan configurado o
    // no. Así que con la configuración ilegible ese aviso —el que ya no admite
    // postergarse— sigue saliendo, y solo se saltan los umbrales que de verdad
    // dependían del dato que no se pudo leer. Fail-closed no es «no hacer
    // nada»: es no afirmar lo que no se sabe.
    const umbral = configIlegible
      ? (faltan === 0 ? 0 : null)
      : umbralDeHoy(hoy, diasDe.get(tenantId) ?? DIAS_AVISO_DEFECTO);
    if (umbral === null) {
      if (configIlegible) saltadasPorConfig++;
      continue;
    }
    flotas++;

    // LA RESERVA DEL SELLO, ANTES DE MANDAR (claim-then-act, patrón 0227). La
    // PK `(tenant_id, periodo, umbral)` es el árbitro de la carrera entre dos
    // invocaciones solapadas del cron: la que pierde recibe 23505 y NO manda
    // nada. Antes esto era «consulto, mando y sello», y el WhatsApp duplicado
    // ya estaba en el teléfono cuando el 23505 llegaba (c7-17).
    //
    // Y el error se LEE: un `data: null` por timeout se leía como «todavía no
    // se ha avisado» y REENVIABA. Aquí un error que no sea el duplicado
    // significa «no sé si ya avisé», y con esa duda no se manda.
    const { error: errReserva } = await acotada(supabaseAdmin()
      .from('peaje_cierre_aviso')
      .insert({ tenant_id: tenantId, periodo, umbral, gastos: lista.length }), 'peaje_cierre.reservar');
    if (errReserva) {
      if (esDuplicado(errReserva)) continue; // ya se avisó este (flota, mes, umbral)
      logger.error('peaje_cierre.sin_reserva', { tenantId, periodo, umbral, err: errReserva.message });
      sinReserva++;
      continue;
    }

    // A partir de aquí el sello es NUESTRO: todo camino que no acabe en
    // mensaje entregado tiene que soltarlo.
    let entregado = false;
    try {
      const telefono = await telefonoParaDineroDe(tenantId);
      if (!telefono) {
        // Sin destinatario no queda sello: el día que la flota registre a su
        // contador, el aviso todavía puede salir. Dejarlo puesto lo enterraría.
        logger.warn('peaje_cierre.sin_destinatario', { tenantId, periodo, umbral });
        sinDestinatario++;
      } else {
        const total = lista.reduce((s, g) => s + g.monto, 0);
        const ordenados = [...lista].sort((a, b) => a.fecha.localeCompare(b.fecha));
        // `sendText` devuelve el id del mensaje o `null`; lo que importa aquí
        // es si salió, y `null` es exactamente «no salió».
        entregado = (await sendText(telefono, mensajeCierrePeaje(ordenados, faltan, total))) !== null;
        if (!entregado) logger.warn('peaje_cierre.no_enviado', { tenantId, periodo, umbral });
      }
    } catch (e) {
      // El canal de una flota que truena NO puede costarle el aviso a las
      // demás: se anota, se suelta la reserva en el `finally` y el barrido
      // sigue. Antes una excepción de `sendText` subía y mataba la pasada
      // entera con las flotas restantes sin mirar.
      logger.error('peaje_cierre.envio_lanzo', {
        tenantId, periodo, umbral, err: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (entregado) avisadas++;
      else if (!(await soltarReserva(tenantId, periodo, umbral))) reservasAtoradas++;
    }
  }

  const resumen: ResumenCierrePeaje = {
    corrio: true, flotas, avisadas, sinDestinatario,
    gastos: gastos.length, sinReserva, reservasAtoradas,
    // `truncado` siempre `false` aquí: una lectura incompleta ya LANZÓ arriba
    // (`traerTodo`) en vez de llegar a este punto con datos parciales.
    sinTurno, truncado: false,
  };

  // Si la configuración no se pudo leer, la pasada NO fue limpia y hay que
  // decirlo donde alguien lo vea: la ruta del cron atrapa esto, lo registra y
  // marca el latido 'parcial' (lo que ya se avisó, ya salió y quedó sellado).
  // Callarlo con un resumen verde sería exactamente el error que este hallazgo
  // describe, movido un piso más arriba.
  if (configIlegible) {
    throw new Error(
      `avisarCierrePeaje: no se pudo leer sat_descarga_config (${errCfg!.message}). `
      + `Se saltaron ${saltadasPorConfig} flota(s) cuyo umbral configurado no se pudo conocer — NO se asumió el default de ${DIAS_AVISO_DEFECTO} días. `
      + `El aviso del último día del mes no depende de esa configuración y sí salió: ${avisadas} enviado(s).`,
    );
  }

  return resumen;
}
