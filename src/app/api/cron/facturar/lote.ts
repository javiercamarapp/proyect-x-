// ═══════════════════════════════════════════════════════════════════════════
// EL MOTOR DEL LOTE DE AUTOFACTURA — compartido entre el cron síncrono
// (`route.ts`, GET) y el callback de QStash (`cola/route.ts`, POST).
//
// AUDITORÍA 24 (integración): vivía dentro de `route.ts` (extraído del GET en
// la ronda 16, ver el comentario que sigue de pie en `procesarLoteEnCola`).
// `cola/route.ts` lo importaba de ahí (`import { procesarLoteEnCola, type
// FilaCola } from '../route'`) — cross-import válido en tiempo de ejecución,
// pero un `route.ts` de App Router solo puede exportar handlers HTTP y la
// config reconocida por Next (`runtime`, `dynamic`, `maxDuration`, etc.):
// cualquier otro export ahí revienta el chequeo de tipos de `next build`
// (`.next/types` valida el módulo contra ese contrato). Aquí el motor puede
// exportar lo que necesite; `route.ts` y `cola/route.ts` importan de este
// archivo, no uno del otro.
// ═══════════════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { facturarAlVuelo, facturarLoteAlVuelo, type ResultadoAutofactura } from '@/lib/likida/facturacion/al_vuelo';
import { armar } from '@/lib/likida/facturacion/pendientes';
import { getFiscalDeFlota } from '@/lib/likida/facturacion/flota_fiscal';
import { avisarPorFacturar } from '@/lib/likida/facturacion/avisar';
import { telefonoJefeDe } from '@/lib/likida/contactos';
import { conPortales, PORTALES_CONOCIDOS, portalesOperables } from '@/lib/likida/facturacion/adaptadores/registro';
import { anotarVinculo, invalidarVinculo, refrescarSesiones, sesionesVigentes, type ClaseDeFallo } from '@/lib/likida/facturacion/vinculo_portal';
import { comercio as fichaComercio } from '@/lib/likida/facturacion/comercios';
import { reconectarPortal } from '@/lib/likida/facturacion/relogin';
import { conNavegador } from '@/lib/likida/facturacion/adaptadores/pagina_playwright';
import type { PaginaConInventario, PaginaPortal } from '@/lib/likida/facturacion/adaptadores/playwright_base';
import { logger } from '@/lib/logger';
import { codigoDeError } from '@/lib/observability/sentry';
import { alertarOperador } from '@/lib/observability/alerta';
import { registrarLatido } from '@/lib/admin/salud';
import { avisar, avisarCorridasPorFlota, FalloDePlataforma } from '@/lib/likida/agentes/notificaciones';
import { avisoColaAtorada } from '@/lib/correo/avisos';
import { registrarCorrida, ultimasCorridas } from '@/lib/likida/agentes/corridas';
import { modoEfectivo } from '@/lib/likida/facturacion/modo';

/**
 * El `maxDuration` de `route.ts`, copiado aquí — NO importado de ahí: Next
 * exige que `export const maxDuration` sea un LITERAL estático en el propio
 * `route.ts` (léelo ahí para el porqué), así que no puede derivarse de una
 * constante de otro módulo. Este archivo necesita el mismo número para
 * `PRESUPUESTO_LOTE_MS`, y lo declara aparte. `cola/route.ts` hace lo mismo
 * con su propio literal — los tres tienen que moverse juntos (ver M2/B12 en
 * el comentario de `cola/route.ts`, y la prueba que compara los literales de
 * `route.ts` y `cola/route.ts` por regex en `cola/route.test.ts`).
 */
export const TOPE_DURACION_S = 300;

/** El tope de duración de arriba, en milisegundos — la MISMA constante, no una copia. */
const PRESUPUESTO_LOTE_MS = TOPE_DURACION_S * 1000;

/**
 * Colchón sobre el presupuesto de la invocación antes de abrir la SIGUIENTE
 * sesión de navegador.
 *
 * Antes de este arreglo, el comentario de `TOPE_POR_CORRIDA` decía "a 60 s el
 * peor caso, ocho llenan 300 s con margen" — 8 × 60 s = 480 s, 180 s de MÁS. El
 * auditor de rendimiento lo encontró (`docs/auditoria-10/rendimiento.md`,
 * hallazgo ALTO): el peor caso medido de UNA sola sesión de portal —un ticket,
 * sumando cada tope de `pagina_playwright.ts` y `capufe.ts`— es ~147 s. Con
 * solo DOS flotas en ese escenario ya se rebasan los 300 s, y el `for` de
 * flotas no consultaba el reloj antes de abrir el siguiente navegador.
 *
 * Ahora sí lo consulta: antes de cada `conNavegador` nuevo, si ya pasaron
 * `PRESUPUESTO_LOTE_MS - MARGEN_LOTE_MS` = 150 s desde que arrancó la
 * invocación, el lote se corta AHÍ —no se abre la sesión— y lo que falta queda
 * SIN marcar como intentado, para la corrida siguiente (mismo principio que
 * `falloDeArranque` usa para un Chromium que no arranca).
 *
 * AUDITORÍA 12, ALTO (rendimiento): el margen anterior (60 s) era menos de la
 * mitad del peor caso de UNA sesión (~147 s sumando cada tope de
 * `pagina_playwright.ts`/`capufe.ts`), así que una sesión podía arrancar a
 * t=239.9 s y ser matada por Vercel a los 300 s, a media sesión — en modo
 * `emitir`, con el CFDI ya timbrado sin que `cfdi_uuid` se alcance a escribir.
 * El margen ahora cubre el peor caso de la sesión que YA está abierta: la
 * nueva no se abre si quedan menos de 150 s, y la que corre tiene espacio
 * para terminar y responder.
 */
const MARGEN_LOTE_MS = 150_000;

/** Una fila de `gasto` como la trae la consulta de la cola. */
export interface FilaCola {
  id: string;
  tenant_id: string;
  concepto: string;
  monto: number;
  fecha: string | null;
  folio: string | null;
  rfc_emisor: string | null;
  cfdi_uuid: string | null;
  ocr_extra: Record<string, unknown> | null;
}

interface Renglon extends ResultadoAutofactura {
  gastoId: string;
  tenantId: string;
  comercio: string | null;
}

/**
 * El aviso al encargado por lo que la máquina ya no va a intentar sola.
 *
 * Reusa `avisarPorFacturar` —el mismo mensaje, la misma plantilla, la misma
 * bitácora— en vez de escribir un segundo canal de avisos: lo que hace que un
 * ticket bloqueado entre en ese mensaje es `enrutar()`, que ahora lo manda por
 * 'mensaje' con el motivo. Aquí solo se decide A QUIÉN y CUÁNDO.
 *
 * NUNCA tumba la corrida: para cuando esto se llama, todo lo que había que
 * facturar ya se facturó y se guardó. Un WhatsApp que no salió es un aviso
 * perdido —y se dice en la respuesta—, no una corrida perdida.
 */
async function avisarALasPersonas(
  bloqueadosPorFlota: Map<string, Array<{ gastoId: string; motivo: string }>>,
  hoy: string,
): Promise<Array<{ tenantId: string; enviado: boolean; tickets?: number; motivo?: string }>> {
  const avisos: Array<{ tenantId: string; enviado: boolean; tickets?: number; motivo?: string }> = [];

  for (const [tenantId] of bloqueadosPorFlota) {
    try {
      const telefono = await telefonoJefeDe(tenantId);
      if (!telefono) {
        // No es un fallo del envío: es una flota sin encargado ni dueño con
        // teléfono. Se dice con esas palabras porque el arreglo es capturarlo,
        // no reintentar.
        logger.warn('cron.facturar.sin_a_quien_avisar', { tenant: tenantId });
        avisos.push({ tenantId, enviado: false, motivo: 'esa flota no tiene encargado ni dueño con teléfono registrado, así que no hay a quién avisarle' });
        continue;
      }
      const r = await avisarPorFacturar({ tenantId, telefono, hoy });
      avisos.push({ tenantId, enviado: r.enviado, tickets: r.tickets, motivo: r.motivo });
    } catch (e) {
      const motivo = e instanceof Error ? e.message : String(e);
      logger.error('cron.facturar.aviso_fallo', { tenant: tenantId, error: motivo });
      avisos.push({ tenantId, enviado: false, motivo });
    }
  }
  return avisos;
}

/**
 * LA CAPTURA VIAJA SOLO SI SE PIDE, Y SIEMPRE SE DICE QUE EXISTE.
 *
 * En `ensayo` —el modo por defecto— la captura es la ÚNICA evidencia de qué se
 * habría enviado: un ensayo sin ella solo dice que ningún selector reventó, no
 * que el RFC haya quedado en el campo del RFC. Así que no se tira.
 *
 * Pero es un data-uri de ~120 KB por sesión, y ocho en un JSON de respuesta son
 * ~1 MB que además acaba en los logs de Vercel. Regla:
 *
 *   · es una RUTA en disco (`LIKIDA_CAPTURAS_DIR` puesto, que es lo que uno
 *     quiere en la Mac para poder mirar el .jpg) → viaja siempre, pesa nada.
 *   · es un data-uri → viaja solo con `?captura=1`, y si no, se dice su tamaño
 *     y cómo pedirla. Una evidencia que existe y no se anuncia es una evidencia
 *     que nadie va a buscar.
 */
function sinCapturas(renglones: Renglon[], req: Request): unknown[] {
  const pedidas = new URL(req.url).searchParams.get('captura') === '1';
  return renglones.map((r) => {
    if (!r.captura || pedidas || !r.captura.startsWith('data:')) return r;
    const { captura, ...resto } = r;
    return {
      ...resto,
      capturaKb: Math.round(captura.length / 1024),
      capturaComoVerla: 'vuelve a llamar con ?captura=1 para que venga el JPEG, o pon LIKIDA_CAPTURAS_DIR para que se escriba en disco',
    };
  });
}

/** ¿Esta página sabe describirse? Sin inventario no hay re-login posible. */
function tieneInventario(p: PaginaPortal): p is PaginaConInventario {
  return typeof (p as PaginaConInventario).inventario === 'function';
}

/**
 * VOLVER A ENTRAR SOLA, si la flota lo autorizó (0233).
 *
 * Todo lo que decide vive en `relogin.ts` y `relogin_portal.ts` —el
 * consentimiento, el candado de intentos, los cinco cortes que solo un humano
 * pasa—; aquí solo se le da una pestaña del MISMO contexto del lote, que es lo
 * que hace que las cookies nuevas caigan donde sirven.
 *
 * NUNCA TUMBA LA CORRIDA. Los tickets de este portal ya se despacharon y su
 * estado ya se anotó: un fallo reconectando es una molestia (alguien entra a
 * mano, como hasta ayer), no una razón para perder el resto del lote de la
 * flota. Y no toma una sola captura — ver la higiene del secreto en
 * `relogin.ts`.
 */
async function reconectar(
  tenantId: string,
  comercio: string,
  /** Con qué clase llegó aquí. Decide qué estado se re-anota si tampoco pudo. */
  clase: ClaseDeFallo,
  abrirPagina: () => Promise<PaginaPortal>,
  navegador: { estadoDeSesion(): Promise<string | null> },
): Promise<void> {
  let pagina: PaginaPortal | undefined;
  try {
    pagina = await abrirPagina();
    if (!tieneInventario(pagina)) {
      // Hueco de plataforma, no del portal: se dice y se sigue.
      logger.warn('cron.facturar.relogin_sin_inventario', { tenant: tenantId, comercio });
      return;
    }

    const r = await reconectarPortal({
      tenantId, comercio,
      entorno: { pagina, estadoDeSesion: () => navegador.estadoDeSesion() },
    });

    if (r.ok) {
      logger.info('cron.facturar.relogin_ok', { tenant: tenantId, comercio, cookies: r.cookies });
      return;
    }

    // `sin_consentimiento` es el camino de siempre y no se grita: la flota no
    // pidió esto, y llenarle el log de avisos por no haberlo pedido sería
    // ruido. Todo lo demás SÍ se cuenta.
    if (r.clase === 'sin_consentimiento') return;

    logger.warn('cron.facturar.relogin_corte', { tenant: tenantId, comercio, clase: r.clase });

    // EL AVISO AL CONTRALOR, donde ya está mirando: el motivo exacto se escribe
    // en `portal_estado`, que es lo que pinta la pantalla de portales junto al
    // botón que lleva a la vinculación. El estado sigue siendo `caducada` —lo
    // dejó `invalidarVinculo` hace un momento— y lo que se agrega es POR QUÉ
    // la máquina tampoco pudo. Sin esto, el contralor vería «caducada» sin
    // saber que ya se intentó y que hay un CAPTCHA esperándolo.
    if (r.pideHumano) {
      // El estado se re-anota como llegó, no como «caducada» siempre: un
      // portal que nadie ha vinculado nunca sigue siendo `sin_vincular`, y
      // decirle «se te cayó la sesión» al contralor lo mandaría a buscar algo
      // que nunca existió. Es el mismo mapeo que hace `invalidarVinculo`.
      await anotarVinculo({
        tenantId, comercio,
        estado: clase === 'sesion_caducada' ? 'caducada' : 'sin_vincular',
        motivo: `Likida intentó volver a entrar sola y no pudo: ${r.motivo}`,
        ahora: new Date().toISOString(),
      });
    }
  } catch (e) {
    logger.warn('cron.facturar.relogin_fallo', {
      tenant: tenantId, comercio, err: e instanceof Error ? e.message : String(e),
    });
  } finally {
    await pagina?.cerrar?.().catch(() => undefined);
  }
}

// ── El procesamiento del lote (compartido: cron síncrono y callback QStash) ──
// Extraído del GET (ronda 16); movido a este módulo aparte en la integración de
// la auditoría 24 (ver la cabecera del archivo). La MISMA lógica; el callback de
// QStash corre con su propio presupuesto (10 min) sin el techo de 300s de una
// invocación directa.
/**
 * Cuántos tickets intentó y cuántos facturó CADA flota, con el desglose de
 * por qué no procedieron (RES-21).
 *
 * El desglose es de motivos, no de tickets: "requiere_cuenta ×7" dice qué
 * hacer; siete líneas de `info` iguales, no.
 */
function medirPorFlota(renglones: Renglon[]): Map<string, { intentados: number; facturados: number; motivos: Record<string, number> }> {
  const m = new Map<string, { intentados: number; facturados: number; motivos: Record<string, number> }>();
  for (const r of renglones) {
    const f = m.get(r.tenantId) ?? { intentados: 0, facturados: 0, motivos: {} };
    if (r.intentado) f.intentados += 1;
    if (r.facturado) f.facturados += 1;
    if (r.motivo) f.motivos[r.motivo] = (f.motivos[r.motivo] ?? 0) + 1;
    m.set(r.tenantId, f);
  }
  return m;
}

export async function procesarLoteEnCola(
  lote: FilaCola[],
  req: Request,
  hoy: string,
  inicioLote: number,
  quedaron: number,
  /** BE-6 (c): el cron cayó al camino síncrono por una causa que el latido
   *  tiene que decir (`parcial`, no `ok`): la cola encolada no se procesa. */
  opts: { parcialPor?: string } = {},
): Promise<NextResponse> {
  // D7 (auditoría 4): el modo que se REPORTA pasa por `modoEfectivo`, no por
  // process.env a secas. Con FACTURACION_MODO=emitir y el mandato sin aceptar,
  // el cron corría en ensayo (bien) y su JSON y su log decían "emitir"
  // (mintiendo sobre su propio estado). Ahora dice el modo con el que de
  // verdad va a correr — el mismo que decide `conNavegador`.
  const modo = modoEfectivo(process.env.FACTURACION_MODO === 'emitir' ? 'emitir' : 'ensayo');

  // Cómo le fue a CADA flota que alcanzó turno. El éxito SÍ se registra: es lo
  // que rearma el filo del anti-ruido (`avisarCorridasPorFlota`). Las que se
  // quedaron sin presupuesto de tiempo NO entran — no fallaron, no les tocó;
  // la corrida de la siguiente hora las levanta enteras.
  //
  // FUERA del `try` a propósito: el cierre se manda desde el `finally`, y ahí
  // esta variable tiene que estar viva incluso cuando el lote reventó — que es
  // justo el caso en que el aviso importa.
  const corridas = new Map<string, unknown>();
  const inicioCorrida = new Date();
  /** Flota → los gastos que ESTA corrida sacó de la cola automática. FUERA del
   *  `try` por la misma razón que `corridas`: el aviso de cola atorada (B2) se
   *  manda desde el `finally`, y un lote que reventó a la mitad ya pudo haber
   *  bloqueado tickets — esos siguen esperando a una persona aunque la corrida
   *  muera. Cada entrada nace con al menos un gasto (`anotarBloqueo`). */
  const bloqueadosPorFlota = new Map<string, Array<{ gastoId: string; motivo: string }>>();
  /** RES-21: cómo le fue a cada ticket. FUERA del `try` por lo mismo que
   *  `corridas`: la medición por flota se cierra desde el `finally`, y una
   *  corrida que revienta a la mitad ya intentó tickets que hay que contar. */
  const resultados: Renglon[] = [];
  /** BE-9: la flota (y sus tickets con portal) cuyo navegador está abierto.
   *  Si la sesión revienta a media escritura, el `throw` sale del bucle y el
   *  catch de abajo ya no sabe de quién era: esto es lo que lo nombra. */
  let flotaEnVuelo: { tenantId: string; gastoIds: string[] } | null = null;

  try {
    // ── Agrupar: flota → portal → tickets. El portal sale de `armar()`, que es
    // la MISMA función con la que `al_vuelo.ts` reconoce el comercio; derivarlo
    // aquí por otro camino sería tener dos opiniones sobre a qué portal va un
    // ticket, y la del cron mandaría el lote al navegador equivocado.
    const porFlota = new Map<string, Map<string, FilaCola[]>>();
    const sinPortal: FilaCola[] = [];
    const comercioDe = new Map<string, string | null>();
    // Escritos + pilotables (si la palanca del piloto está puesta). Mirar solo
    // los escritos con el piloto encendido despacharía "sin navegador" tickets
    // que la máquina sí va a intentar.
    const operables = portalesOperables();

    for (const g of lote) {
      const clave = armar(g, hoy).comercio?.clave ?? null;
      comercioDe.set(g.id, clave);
      if (!clave || !operables.includes(clave)) {
        sinPortal.push(g);
        continue;
      }
      const porPortal = porFlota.get(g.tenant_id) ?? new Map<string, FilaCola[]>();
      porPortal.set(clave, [...(porPortal.get(clave) ?? []), g]);
      porFlota.set(g.tenant_id, porPortal);
    }

    const flotas: Array<{
      tenantId: string;
      tickets: number;
      registrados?: string[];
      problemas?: string[];
      falta?: string[];
      /** Cuántas SESIONES de portal se abrieron, contra cuántos tickets. */
      sesiones?: number;
    }> = [];
    const correr = async (g: FilaCola) => {
      // Se vuelve a leer el gasto dentro de `facturarAlVuelo` a propósito: es el
      // único sitio que decide si se emite y el único que escribe el UUID. Entre
      // esta consulta y el intento pudo facturarlo otro camino (la pantalla de
      // "por facturar", el cierre del viaje), y la segunda lectura es lo que
      // impide emitir un segundo CFDI por el mismo ticket.
      const r = await facturarAlVuelo({ gastoId: g.id, tenantId: g.tenant_id, modo, hoy });
      resultados.push({ gastoId: g.id, tenantId: g.tenant_id, comercio: comercioDe.get(g.id) ?? null, ...r });
      if (r.bloqueado) anotarBloqueo(g.tenant_id, g.id, r.bloqueado);
    };

    const anotarBloqueo = (tenantId: string, gastoId: string, motivo: string) => {
      bloqueadosPorFlota.set(tenantId, [...(bloqueadosPorFlota.get(tenantId) ?? []), { gastoId, motivo }]);
    };

    /**
     * TODOS los tickets de un portal, en UNA sesión.
     *
     * Es el cambio de esta ronda y la razón por la que existe `facturarLoteAlVuelo`:
     * antes esto era `for (const g of tickets) await correr(g)`, o sea una sesión
     * de portal por ticket. En CAPUFE eso son ocho veces los datos fiscales, ocho
     * veces los dos catálogos por AJAX (~1.2 s cada vez) y —lo que de verdad
     * importa— ocho sesiones idénticas seguidas contra el mismo portal, que es el
     * patrón que hace que un portal empiece a pedir CAPTCHA.
     *
     * El adaptador que no sepa hacer lotes NO se queda atrás: `facturarLoteConAgente`
     * lo llama ticket por ticket y devuelve la misma forma. El cron no pregunta.
     */
    const correrLote = async (tenantId: string, comercio: string, tickets: FilaCola[]) => {
      const r = await facturarLoteAlVuelo({
        tenantId, comercio, gastoIds: tickets.map((g) => g.id), modo, hoy,
      });
      for (const p of r.porGasto) {
        resultados.push({ tenantId, comercio, ...p });
      }
      for (const b of r.bloqueados) anotarBloqueo(tenantId, b.gastoId, b.motivo);

      // EL VÍNCULO. Si el portal nos sacó, la sesión guardada se apaga AQUÍ y
      // no en la corrida siguiente: dejarla viva es garantizar que la próxima
      // se estrelle con la misma cookie muerta y vuelva a gastar el navegador.
      // `invalidarVinculo` ya sabe que `portal_cambio` NO toca la sesión.
      if (r.vinculo) {
        await invalidarVinculo({
          tenantId, comercio, clase: r.vinculo.clase, motivo: r.vinculo.motivo,
          ahora: new Date().toISOString(),
        });
      }
      return r;
    };

    // ── 1. Lo que no necesita navegador. Se despacha primero: si Chromium no
    // arranca, este trabajo YA quedó hecho y su sello puesto, así que la cola
    // avanza aunque la parte de portales no se pueda correr todavía.
    for (const g of sinPortal) await correr(g);

    // ── 2. Una flota, un navegador, su registro de portales.
    let falloDeArranque: string | null = null;
    let sinIntentar = 0;
    /** Tickets con flota y portal listos, que no se intentaron porque ya no
     *  quedaba tiempo para otra sesión de navegador completa. */
    let sinTiempo = 0;

    for (const [tenantId, porPortal] of porFlota) {
      const tickets = [...porPortal.values()].flat();

      if (falloDeArranque) {
        // Ya se sabe que no hay navegador. No se vuelve a intentar arrancarlo ni
        // se marcan estos tickets: quedan enteros para la corrida en que se pueda.
        // SÍ cuenta como corrida fallida para ESTA flota, aunque el error se
        // haya descubierto en otra: su agente no pudo trabajar, y ése es
        // exactamente el hecho que el aviso existe para contar. El anti-ruido
        // lo topa en 3 correos por incidente, no uno por flota por hora.
        // Va MARCADO como fallo de plataforma (B8): Chromium es infraestructura
        // de Likida, y el correo de la flota tiene que decir «el problema es
        // nuestro, tu información está bien», no mandarla a revisar sus datos.
        corridas.set(tenantId, new FalloDePlataforma(falloDeArranque));
        sinIntentar += tickets.length;
        flotas.push({ tenantId, tickets: tickets.length, falta: ['no se intentó: el navegador no arrancó'] });
        continue;
      }

      const { flota, falta } = await getFiscalDeFlota(tenantId);
      if (!flota) {
        // Sin datos fiscales no se abre navegador: el portal los pide antes que
        // nada y el intento terminaría igual, con un Chromium gastado de más.
        // Los tickets SÍ se despachan —`facturarAlVuelo` los sella y reporta— para
        // que no vuelvan a acaparar el lote de la próxima corrida.
        logger.warn('cron.facturar.flota_sin_datos_fiscales', { tenant: tenantId, falta: falta.join('; ') });
        flotas.push({ tenantId, tickets: tickets.length, falta });
        for (const g of tickets) await correr(g);
        // La corrida SÍ terminó: lo que falta son los datos fiscales de la
        // flota, que es un hueco de captura y no un agente caído. Llamarlo
        // «corrida fallida» mandaría a alguien a revisar logs de un agente
        // que funciona.
        corridas.set(tenantId, null);
        continue;
      }

      // EL PRESUPUESTO DE TIEMPO: no abrir una sesión que no le va a dar tiempo.
      // Se comprueba AQUÍ, ya con datos fiscales confirmados, para no cortar una
      // flota que de todos modos no iba a abrir navegador. Mismo principio que
      // `falloDeArranque`: lo que no alcanza a intentarse NO se marca, y se
      // recoge entero en la corrida siguiente.
      if (Date.now() - inicioLote >= PRESUPUESTO_LOTE_MS - MARGEN_LOTE_MS) {
        sinTiempo += tickets.length;
        logger.warn('cron.facturar.sin_tiempo', { tenant: tenantId, tickets: tickets.length });
        flotas.push({ tenantId, tickets: tickets.length, falta: ['no se intentó: no quedaba presupuesto de tiempo en esta corrida'] });
        continue;
      }

      // POR FLOTA, no global: si el navegador de la primera abrió y el de la
      // segunda no, lo de la segunda sigue siendo un fallo de arranque. Con una
      // bandera compartida ese caso se reportaría como 500 y los tickets de la
      // segunda quedarían marcados como intentados sin haberlo sido.
      //
      // LAS SESIONES YA INICIADAS de los portales de esta flota. Se leen ANTES
      // de arrancar Chromium porque el `storageState` se le pasa al CONTEXTO al
      // crearlo: después ya no hay dónde meterlo.
      //
      // Hasta el 27-ago-2026 aquí se leían las CREDENCIALES descifradas
      // (`credencialesDePortales`) para que el piloto tecleara la contraseña en
      // el formulario de login. Ese camino se retiró entero (ver la regla 3 de
      // `piloto_vision.ts`): lo que abre la puerta es la sesión que inició una
      // persona, y ninguna contraseña se descifra para facturar.
      // NO va detrás de `pilotoHabilitado()`, a diferencia de lo que iba antes:
      // una sesión guardada sirve para CUALQUIER adaptador —escrito o piloto—,
      // y atarla a la palanca del piloto haría que un portal vinculado dejara
      // de entrar solo el día que se escriba su adaptador. Es UNA consulta por
      // flota, y una flota sin nada vinculado devuelve un mapa vacío.
      const vigentes = await sesionesVigentes(tenantId, Date.now());
      const conSesion = new Set(vigentes.porComercio.keys());

      // LO QUE EL PRE-CHEQUE DE EDAD DESCARTÓ **NO SE APAGA**. Se dice en el
      // log y ahí se queda.
      //
      // AUDITORÍA CICLO 7, c7-9 (alto). Hasta el 27-ago-2026 esto recorría
      // `vigentes.vencidasPorEdad` llamando a `invalidarVinculo({ clase:
      // 'sesion_caducada' })`, que apaga la fila del cofre (`activo = false`)
      // y deja `portal_estado = 'caducada'`. O sea que usaba el pre-cheque
      // como VEREDICTO, justo lo que el encabezado de `sesion_portal.ts`
      // prohíbe con todas sus letras: «se usa como PRE-cheque, no como
      // veredicto; la única prueba REAL de que una sesión sigue viva es
      // intentar usarla».
      //
      // El daño concreto: `porPortal` se construye desde la COLA DE GASTOS, y
      // `refrescarSesiones` solo toca los portales que tuvieron tickets. Una
      // flota con G500, CAPUFE y La Gas vinculados que esta vuelta solo recibe
      // tickets de CAPUFE nunca refresca los otros dos; a los 31 minutos
      // entraban en `vencidasPorEdad` y SE DESTRUÍAN LAS DOS SESIONES — cada
      // media hora, para siempre, con su «tu portal caducó, vuelve a entrar»
      // al contralor. La sesión de portal la vincula UNA PERSONA pasando un
      // captcha: es lo más caro que tiene este circuito, y se tiraba sola por
      // no haber tenido trabajo ese rato. La promesa del PR («un toque humano
      // cuando la sesión caduca») se volvía «un toque humano cada 30 minutos
      // por portal ocioso».
      //
      // LA DISTINCIÓN QUE FALTABA: «esta sesión caducó» ≠ «esta vuelta no
      // había trabajo». La primera solo la puede afirmar el portal, y ya
      // tiene su camino — `correrLote` devuelve `r.vinculo` con la clase real
      // y ESE sí invalida (y dispara el re-login de la 0233). La segunda no es
      // un hecho sobre la sesión: es un hecho sobre la cola de gastos.
      //
      // Qué se conserva del pre-cheque, que sigue siendo útil: la sesión vieja
      // NO entra al `storageState` del contexto (eso lo decide `porComercio`,
      // arriba), así que no se gasta un intento contra una cookie que
      // probablemente ya no sirve. Lo único que se quita es el poder de
      // MATARLA sin haberlo intentado.
      //
      // Y `portal_estado` se queda en 'vinculado', que es la verdad: una
      // persona vinculó ese portal y nadie ha demostrado lo contrario. Pintar
      // 'caducada' sobre una sesión que jamás se intentó es la afirmación
      // falsa, no la honesta.
      if (vigentes.vencidasPorEdad.length > 0) {
        logger.info('cron.facturar.sesion_vieja_no_restaurada', {
          tenant: tenantId,
          portales: vigentes.vencidasPorEdad.join(','),
          conTicketsEstaVuelta: vigentes.vencidasPorEdad.filter((c) => porPortal.has(c)).join(','),
        });
      }

      let arranco = false;
      flotaEnVuelo = { tenantId, gastoIds: tickets.map((g) => g.id) };
      try {
        await conNavegador(async (abrirPagina, navegador) => {
          arranco = true;
          // ── EL RELOJ, HASTA DENTRO DEL LOTE (PR #152) ──────────────────
          //
          // Los dos cortes de arriba —por flota y por portal— miran el reloj
          // ANTES de empezar algo, y eso deja un hueco: dentro del lote de UN
          // portal puede haber ocho tickets en serie de 10-60 s cada uno, y
          // nadie vuelve a mirar el reloj entre uno y otro. El octavo arranca
          // sin presupuesto y muere a media emisión — una muerte AMBIGUA (¿se
          // fue el formulario antes de reventar?), que es exactamente como se
          // acaba con dos CFDI por el mismo consumo.
          //
          // Se pasa el MISMO instante de corte que usan los dos cortes de
          // arriba, no uno propio: dos relojes distintos para la misma corrida
          // se desincronizan el día que alguien ajuste uno.
          const venceEn = inicioLote + PRESUPUESTO_LOTE_MS - MARGEN_LOTE_MS;
          await conPortales({ flota, abrirPagina, sesiones: conSesion, venceEn }, async (registro) => {
            flotas.push({
              tenantId,
              tickets: tickets.length,
              registrados: registro.registrados,
              problemas: registro.problemas,
              // Un portal, una sesión. Es el número que dice si el lote sirvió
              // de algo: ocho tickets de CAPUFE tienen que salir con `sesiones: 1`.
              sesiones: porPortal.size,
            });
            // EN SERIE, no en paralelo. Varias pestañas a la vez contra el mismo
            // portal agotan la memoria de la función y, peor, se parecen a un
            // ataque desde el lado del portal — que responde bloqueando la IP.
            //
            // AUDITORÍA 12, ALTO: el corte de :406 era POR FLOTA, no por
            // sesión de portal — una flota con 2+ portales distintos podía
            // consumir ~294 s en UN solo `conNavegador` sin ningún corte
            // interno y morir en la tercera sesión. Aquí se consulta el reloj
            // ANTES de cada portal nuevo (excepto el primero: el navegador ya
            // está abierto y su sesión ya se pagó — procesar el portal
            // principal de la flota es siempre mejor que no procesar nada). Lo
            // que no alcanza a intentarse NO se marca, y se recoge entero en
            // la corrida siguiente.
            let primerPortal = true;
            /** Los que entraron con sesión Y siguieron dentro: clave → URL. */
            const siguenDentro = new Map<string, string>();
            for (const [comercio, delPortal] of porPortal) {
              if (!primerPortal && Date.now() - inicioLote >= PRESUPUESTO_LOTE_MS - MARGEN_LOTE_MS) {
                sinTiempo += delPortal.length;
                logger.warn('cron.facturar.sin_tiempo_portal', { tenant: tenantId, comercio, tickets: delPortal.length });
                break;
              }
              primerPortal = false;
              const r = await correrLote(tenantId, comercio, delPortal);
              // Solo se refresca lo que ENTRÓ con sesión y NO la perdió. Un
              // portal sin sesión no tiene nada que guardar, y uno que acaba de
              // caducar ya se apagó en `correrLote` — volver a guardarlo aquí
              // resucitaría la cookie muerta que se acaba de invalidar.
              const ficha = fichaComercio(comercio);
              if (conSesion.has(comercio) && !r.vinculo && ficha) {
                siguenDentro.set(comercio, ficha.portal);
              }

              // ── EL RE-LOGIN AUTOMÁTICO (0233). Se intenta AQUÍ y en ningún
              // otro sitio: es el único punto del sistema donde ya consta que
              // el portal pide entrar y todavía hay un navegador abierto en el
              // que hacerlo.
              //
              // LAS DOS CLASES CUENTAN, y hace falta decir por qué: la sesión
              // que el portal RECHAZA llega como `sesion_caducada`, pero la
              // que el pre-cheque de EDAD descartó antes de arrancar Chromium
              // deja al lote sin sesión, y entonces el login se ve como
              // `requiere_vinculacion` —«nadie ha entrado nunca»— aunque sea
              // la misma caducidad. Mirar solo la primera dejaría fuera el
              // caso más común. `portal_cambio` NO entra: ahí la sesión está
              // viva y lo que falla es nuestro mapeo; volver a entrar no
              // arregla nada y le gastaría un intento a la cuenta del cliente.
              //
              // UNA VEZ POR CADUCIDAD, no una por ticket: esto corre después
              // del lote entero de ese portal, y el candado de
              // `relogin_portal.ts` (tope diario + backoff) lo hace verdad
              // aunque alguien lo llame de más.
              //
              // Y NO SE REPITE EL LOTE en esta corrida aunque la reconexión
              // salga bien. Los tickets ya se despacharon y se sellaron; volver
              // a pasarlos por `facturarLoteAlVuelo` con la sesión nueva sería
              // meterle un segundo intento de emisión a un ticket que ya tiene
              // su marca, y esa es exactamente la clase de duda que
              // `emisionSinConfirmar` existe para no crear. La sesión queda
              // guardada y la corrida siguiente —minutos después— los factura
              // sin que nadie haya tenido que entrar.
              if (r.vinculo && r.vinculo.clase !== 'portal_cambio') {
                await reconectar(tenantId, comercio, r.vinculo.clase, abrirPagina, navegador);
              }
            }

            // LAS COOKIES ROTADAS. Estos portales usan TTL deslizante: la
            // sesión que sale del lote vale más que la que entró, y sin volver
            // a guardarla el pre-cheque de edad la tiraría a los 30 min aunque
            // el portal la siguiera aceptando — o sea, re-vincular para
            // siempre. Va DENTRO de `conNavegador`: cerrar el contexto es lo
            // que borra el perfil, y después ya no hay cookies que exportar.
            const refrescados = await refrescarSesiones({
              tenantId, navegador, portales: siguenDentro, ahora: new Date().toISOString(),
            });
            if (refrescados.length > 0) {
              logger.info('cron.facturar.sesiones_refrescadas', { tenant: tenantId, portales: refrescados.join(',') });
            }
          });
        }, {
          // La sesión que una persona inició, restaurada en el contexto. Es lo
          // que convierte "un captcha por ticket" en "un toque humano cuando la
          // sesión caduca" (ver el encabezado de `sesion_portal.ts`).
          ...(vigentes.storageState ? { storageState: vigentes.storageState } : {}),
          // En la Mac se escriben los JPEG y `captura()` devuelve la RUTA, que
          // es lo que hace falta para MIRAR qué se habría enviado. En Vercel no
          // se pone: `/tmp` no sobrevive a la invocación, así que ahí la captura
          // vuelve a ser el data-uri y viaja con `?captura=1`.
          pagina: process.env.LIKIDA_CAPTURAS_DIR
            ? { directorioCapturas: process.env.LIKIDA_CAPTURAS_DIR }
            : undefined,
        });
        corridas.set(tenantId, null);
        flotaEnVuelo = null;
      } catch (e) {
        const detalle = e instanceof Error ? e.message : String(e);
        if (arranco) {
          // ── AUDITORÍA 24, BE-9 (ALTO): LA FLOTA CUYO PORTAL REVENTÓ NO
          // DESAPARECE DE LOS REPORTES ───────────────────────────────────
          //
          // El navegador sí abrió y la sesión del portal reventó a media
          // escritura. Este `throw` salta al catch del lote, y hasta hoy
          // saltaba también el `corridas.set`: como TODO el circuito del
          // cierre (`avisarCorridasPorFlota`, `medirPorFlota`,
          // `registrarCorrida`, `avisoColaAtorada`) itera `corridas` y
          // `bloqueadosPorFlota`, la flota T no aparecía en ningún correo,
          // renglón de bitácora ni WhatsApp — con sus tickets ya marcados
          // «emisión en curso» por `marcarEmisionEnCurso` (fuera de la cola
          // automática, `reclamarIntentos` exige la columna en NULL) y quizá
          // un CFDI vivo en el SAT sin `cfdi_uuid`. Se anota la corrida como
          // fallida (no de plataforma: el navegador abrió) y los tickets de
          // esta flota que NO alcanzaron a reportarse quedan como bloqueados
          // «emisión interrumpida»: su suerte la tiene que mirar una persona,
          // que es exactamente lo que `avisoColaAtorada` existe para pedir.
          corridas.set(tenantId, e instanceof Error ? e : new Error(detalle));
          const reportados = new Set(resultados.filter((r) => r.tenantId === tenantId).map((r) => r.gastoId));
          for (const g of tickets) {
            if (!reportados.has(g.id)) anotarBloqueo(tenantId, g.id, 'emision_interrumpida');
          }
          flotas.push({ tenantId, tickets: tickets.length, problemas: [`la sesión del portal reventó a media escritura: ${detalle}`] });
          throw e; // el navegador sí abrió: es otro fallo, sube
        }

        // `conNavegador` arranca Chromium ANTES de correr el cuerpo, así que si
        // el cuerpo nunca se ejecutó, lo que falló fue el arranque — o sea la
        // PLATAFORMA de Likida, no los datos de la flota. La marca (B8) es lo
        // que hace que el correo diga la verdad sobre de quién es el problema.
        falloDeArranque = detalle;
        corridas.set(tenantId, new FalloDePlataforma(detalle));
        sinIntentar += tickets.length;
        flotas.push({ tenantId, tickets: tickets.length, falta: ['no se intentó: el navegador no arrancó'] });
        flotaEnVuelo = null;
      }
    }


    const facturados = resultados.filter((r) => r.facturado).length;

    if (falloDeArranque) {
      logger.error('cron.facturar.sin_navegador', { error: falloDeArranque, sinIntentar });
      await registrarLatido('facturar', 'fallo', {
        codigo: 'chromium_sin_arrancar', intentados: resultados.length, facturados, sinIntentar,
      });
      return NextResponse.json({
        corrio: false,
        modo,
        // (El latido 'fallo' de este camino se registró justo arriba: un 503
        // devuelto sin `throw` no pasa por el catch, y sin latido propio este
        // camino dejaba en pie el último estado que hubiera escrito otro.)
        motivo:
          'No se pudo arrancar Chromium, así que los tickets de portal NO se intentaron y quedan sin marcar para la próxima corrida. ' +
          'El campo `error` trae los TRES caminos que se probaron para conseguir el binario, en orden: la ruta explícita ' +
          '(`LIKIDA_CHROMIUM_PATH`), el paquete serverless (`@sparticuz/chromium`, que descomprime el suyo en /tmp) y la caché ' +
          'local de Playwright. Si el que falla es el serverless, lo primero que hay que mirar es si sus `bin/*.br` viajaron en ' +
          'el bundle de esta función (`outputFileTracingIncludes` en `next.config.ts`). La otra salida es un navegador remoto por CDP.',
        error: falloDeArranque,
        portalesConocidos: PORTALES_CONOCIDOS,
        // Lo que sí se alcanzó a hacer sin navegador, para que el 503 no se lea
        // como "no pasó nada".
        intentados: resultados.length,
        facturados,
        sinIntentar,
        sinTiempo,
        quedaron,
        flotas,
        detalle: sinCapturas(resultados, req),
      }, { status: 503 });
    }

    // ── 3. LO QUE YA NO LO HACE LA MÁQUINA, LO HACE UNA PERSONA.
    //
    // Aquí se cierra la señal de CAPTCHA. `pideCaptcha()` existía desde el
    // adaptador y no la consumía nadie: un portal que pide CAPTCHA se veía como
    // un fallo más en el detalle del cron, y la hora siguiente se volvía a
    // intentar contra el mismo muro. Ahora esos gastos salieron de la cola
    // (`autofactura_bloqueada_en`), `enrutar()` los manda con el encargado y
    // esto es lo que lo despierta.
    //
    // SOLO CUANDO ALGO SE BLOQUEÓ EN ESTA CORRIDA, no cada hora mientras siga
    // bloqueado: el cron corre 24 veces al día y un aviso repetido de lo mismo
    // enseña a ignorar el canal — que es justo lo que no puede pasar con el
    // canal por el que también llegan los tickets que vencen.
    const avisos = await avisarALasPersonas(bloqueadosPorFlota, hoy);

    // RES-21: el desglose de motivos va en el log de cierre. Sin él, la única
    // huella de por qué no se facturó nada eran N líneas de `info` sueltas.
    const motivos: Record<string, number> = {};
    for (const r of resultados) if (r.motivo) motivos[r.motivo] = (motivos[r.motivo] ?? 0) + 1;
    logger.info('cron.facturar.ok', { modo, intentados: resultados.length, facturados, quedaron, sinTiempo, flotas: flotas.length, motivos });

    // El latido del cierre REAL (tableros al día, 28-ago-2026): la corrida
    // terminó y así le fue. `parcial` si el reloj cortó flotas — mismo
    // criterio que asistencia/runner con sus cortes.
    await registrarLatido('facturar', sinTiempo > 0 || opts.parcialPor ? 'parcial' : 'ok', {
      modo, intentados: resultados.length, facturados, sinTiempo, quedaron,
      ...(opts.parcialPor ? { parcialPor: opts.parcialPor } : {}),
    });

    return NextResponse.json({
      corrio: true,
      modo,
      // BE-6 (c): por qué esta corrida es `parcial` aunque el lote saliera bien.
      ...(opts.parcialPor ? { parcialPor: opts.parcialPor } : {}),
      portalesConocidos: PORTALES_CONOCIDOS,
      intentados: resultados.length,
      facturados,
      quedaron,
      // Flotas con portal listo que no se intentaron porque ya no quedaba
      // presupuesto de tiempo en esta corrida. Se recogen enteras la próxima —
      // ver MARGEN_LOTE_MS.
      sinTiempo,
      // Por flota: qué portales quedaron operables y qué le falta a la que no.
      // Es lo que dice si el problema se arregla configurando al cliente o
      // tocando código.
      flotas,
      // Los que salieron de la cola automática, y si el aviso a la persona salió.
      bloqueados: [...bloqueadosPorFlota].map(([tenantId, b]) => ({ tenantId, cuantos: b.length, detalle: b })),
      avisos,
      // El detalle va en la respuesta: "requiere_cuenta" o "confianza_baja" por
      // ticket es lo que dice si el problema se arregla configurando o mirando.
      detalle: sinCapturas(resultados, req),
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // Mismo criterio que el catch del GET: código estable para el fingerprint
    // y alerta al operador. El fallo duro típico aquí cruza flotas (`if
    // (arranco) throw e` propaga fuera del bucle), así que tampoco hay UN
    // tenant que emitir sin mentir sobre el alcance.
    const codigo = codigoDeError(e);
    // BE-9: con la flota y los tickets en vuelo, que es el único rastro que
    // dice QUÉ mirar en el portal (¿quedó un CFDI timbrado sin uuid?).
    logger.error('cron.facturar.falló', {
      error, codigo, tenant: flotaEnVuelo?.tenantId ?? null, gastos: flotaEnVuelo?.gastoIds ?? null,
    });
    await alertarOperador('cron.facturar', { error, codigo });
    await registrarLatido('facturar', 'fallo', { codigo, tenant: flotaEnVuelo?.tenantId ?? null });
    return NextResponse.json({ error, tenant: flotaEnVuelo?.tenantId ?? null, gastos: flotaEnVuelo?.gastoIds ?? null }, { status: 500 });
  } finally {
    // ── EN `finally`, Y ÉSA ES LA CORRECCIÓN ────────────────────────────────
    //
    // Estaba después del bucle de flotas, que es donde parece que va y no va.
    // El camino de fallo duro de este cron —`if (arranco) throw e`, cuando el
    // navegador SÍ abrió y la sesión del portal revienta a media escritura—
    // propaga fuera del bucle y salta al catch de arriba: el aviso nunca
    // corría. O sea que el ÚNICO fallo que de verdad merecía el correo «el
    // agente no pudo trabajar» era exactamente el que lo silenciaba.
    //
    // Peor que no avisar: también se perdían los cierres de las flotas que SÍ
    // terminaron bien en ese lote, así que sus rachas quedaban sin re-armar.
    // Y QStash reintenta 2 veces sobre 5xx, de modo que el silencio se repetía
    // tres veces.
    //
    // `avisarCorridasPorFlota` nunca propaga, así que ponerlo en el `finally`
    // no puede convertir una corrida buena en un 500 — que es la única razón
    // por la que un `finally` daría miedo aquí.
    await avisarCorridasPorFlota('facturas', corridas);

    // ── RES-21: LA SEÑAL DE "INTENTA Y NO FACTURA NADA" ────────────────────
    //
    // `autofactura.no_procede` se queda en `info` a propósito: es de alto
    // volumen y por ticket, y subirlo a warn convertiría el canal de alertas
    // en el log de una cosa normal. Lo que faltaba era la señal AGREGADA — el
    // hecho de que una flota lleve corridas enteras intentando sin timbrar
    // una sola factura, que es como se ve desde fuera un adaptador roto.
    //
    // TRES CORRIDAS SEGUIDAS, no una: una corrida sin facturar es rutina
    // (tickets que no proceden, un portal caído un rato). Tres seguidas ya no.
    //
    // SOLO EN `emitir`: en `ensayo` —el modo por defecto— facturados=0 con
    // intentados>0 es EXACTAMENTE lo que tiene que pasar, y avisarlo sería
    // gritar por el funcionamiento correcto.
    const medido = medirPorFlota(resultados);
    for (const [tenantId, m] of medido) {
      if (modo !== 'emitir' || m.facturados > 0 || m.intentados === 0) continue;
      try {
        // Las DOS anteriores; la tercera es ésta, que todavía no se registra.
        const previas = await ultimasCorridas(tenantId, 'facturas', 2);
        const secas = previas.filter((c) => {
          const r = (c.resumen ?? {}) as { intentados?: number; facturados?: number };
          return typeof r.intentados === 'number' && r.intentados > 0 && r.facturados === 0;
        });
        if (previas.length >= 2 && secas.length === 2) {
          logger.warn('cron.facturar.sin_facturar_3_corridas', {
            tenant: tenantId, intentados: m.intentados, motivos: m.motivos,
          });
        }
      } catch (e) {
        // Una lectura del historial no puede tumbar el cierre de la corrida.
        logger.warn('cron.facturar.historial_ilegible', { tenant: tenantId, err: e instanceof Error ? e.message : String(e) });
      }
    }
    // La bitácora de corridas (B3), en el MISMO finally y por la misma razón:
    // el fallo duro es exactamente la corrida que más merece quedar anotada.
    // Sin conteo de tareas por flota aquí (los renglones son por portal, no
    // por flota): tareas null, y la ficha pinta «—», no un 0/0 inventado.
    await Promise.allSettled([...corridas.entries()].map(([tenant, err]) =>
      registrarCorrida(tenant, 'facturas', {
        inicio: inicioCorrida,
        fin: new Date(),
        estado: err ? 'fallo' : 'ok',
        disparo: 'cron',
        // RES-21: el resumen deja de ir vacío. Intentados/facturados y el
        // desglose de motivos son lo que hace legible un `no_procede` que
        // vive en `info`, y lo que la corrida siguiente lee para saber si
        // ésta es la tercera seca seguida.
        resumen: medido.get(tenant) as Record<string, unknown> | undefined,
        // La ficha también distingue el origen (B8): un fallo de plataforma no
        // manda a nadie a revisar la información de la flota.
        error: err
          ? (err instanceof FalloDePlataforma
            ? 'La plataforma de Likida tuvo un problema y esta corrida no se pudo completar. La información de la flota está bien; se reintenta solo.'
            : 'La corrida de facturación de esta flota no se pudo completar. El detalle quedó en los registros del sistema.')
          : undefined,
      })));

    // ── LA COLA ATORADA DE FACTURAS (B2, auditoría 4; re-armada AG-A5) ──────
    //
    // `avisoColaAtorada` existía desde el 14-ago sin un solo llamador; éste es
    // su primer emisor real, y SOLO para Facturas: los tickets que ESTA
    // corrida bloqueó (`requiere_cuenta`, CAPTCHA, emisión sin confirmar)
    // salieron de la cola automática y esperan a una persona — exactamente lo
    // que el evento existe para contar. La magnitud es MEDIDA (cuántos bloqueó
    // esta corrida) y `diasSinBajar` va en `null` porque es la verdad: no hay
    // serie histórica de esta cola, y la plantilla lo maneja sin inventar días.
    //
    // POR CADA FLOTA QUE ESTA CORRIDA PROCESÓ —las de `corridas`, el mismo
    // mapa que arma `avisarCorridasPorFlota` arriba—, NO solo las que
    // bloquearon algo. AG-A5 (auditoría 28): hasta esta auditoría el bucle
    // era `for (const [tenantId, bloqueados] of bloqueadosPorFlota)`, así que
    // una flota SOLO podía mandar `hayProblema: true` — nunca `false` — y el
    // filo de este aviso no se re-armaba jamás: tras la tercera marca de
    // insistencia quedaba mudo DE POR VIDA mientras la pantalla de
    // Notificaciones prometía que "la cuenta vuelve a cero en cuanto el
    // problema se resuelve".
    //
    // LA ELECCIÓN QUE SE DOCUMENTA (el comentario que pedía este hallazgo):
    // "bloqueados" aquí es SOLO lo que ESTA corrida bloqueó de nuevo, no la
    // cola VIVA de tickets que siguen esperando de corridas anteriores —medir
    // esa cola viva exigiría un COUNT por flota contra `gasto` en cada pasada
    // del cron (cada ~15 min) y, peor, no hay manera barata de distinguir "ya
    // lo resolvió una persona" de "sigue bloqueado": la captura manual del
    // panel (`dashboard/agentes/facturas/page.tsx`) solo escribe `cfdi_uuid`
    // y NUNCA limpia `autofactura_bloqueada_en`/`autofactura_bloqueo`, así que
    // un simple `is not null` sobrecontaría tickets que una persona ya
    // facturó a mano. Se opta por el mismo criterio que `escalado`
    // (`escalar_viaje.ts`): una corrida sin bloqueos NUEVOS es "no hay nada
    // que avisar ahora mismo" y re-arma el filo, igual que una corrida sin
    // fallos re-arma `corrida_fallida`. Una cola vieja que de verdad sigue
    // atorada sin que nadie la toque va a volver a bloquear tickets en la
    // corrida siguiente (los que no se resolvieron manualmente sencillamente
    // se re-intentan y re-bloquean), así que no se vuelve invisible — solo
    // deja de sumar magnitud en los ratos en que nadie generó un bloqueo
    // nuevo.
    //
    // `avisar` promete no lanzar, pero la corrida no cuelga de esa promesa:
    // una invariante que solo aguanta fallos por valor no es una invariante
    // (el mismo criterio del emisor de `escalado` en escalar_viaje.ts).
    for (const tenantId of corridas.keys()) {
      const bloqueados = bloqueadosPorFlota.get(tenantId) ?? [];
      try {
        await avisar(
          tenantId, 'facturas', 'cola_atorada',
          { hayProblema: bloqueados.length > 0, magnitud: bloqueados.length },
          // El nombre y la ruta salen del catálogo vía `avisar` (d.agente,
          // d.ruta) — el mismo patrón que `avisarCorridaFallida`.
          (d) => avisoColaAtorada({
            flota: d.flota,
            agente: d.agente,
            href: d.ruta,
            cuantos: bloqueados.length,
            diasSinBajar: null,
          }),
        );
      } catch (e) {
        logger.error('cron.facturar.aviso_cola_roto', {
          tenant: tenantId, err: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
}
