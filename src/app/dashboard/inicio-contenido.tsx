import Link from 'next/link';
import { Wallet, Calculator, Fuel, PiggyBank, LayoutGrid, CalendarDays, Plus } from 'lucide-react';
import {
  getKpis, getAcreditables, detectarAnomalias, getViajes, getViajesPorMes,
  getGastoPorSemanaSeries, getLiquidadoPorSemanaSeries, getTopRutasPorGastoSeries,
  getSeriesKpiCards, getLiquidacionesDeViajes,
  type ViajeRow, type LiquidacionDeViaje,
  type DashboardKpis, type Acreditables, type Anomalia,
  type GastoSemanalSeries, type LiquidadoSemanalSeries, type TopRutasSeries, type SeriesKpiCards,
} from '@/lib/likida/analytics';
import { contarEscalados } from '@/lib/likida/analytics';
import { contarHuerfanosPendientes } from '@/lib/likida/repo';
import { getConfig, type LikidaConfig } from '@/lib/likida/config';
import {
  resolverPeriodo, getGastosFiscales, getGastosFiscalesSeries, resumirPerdidas, opcionesDe,
  type GastoFiscal, type ResumenPerdidas, type GastosFiscalesSeries, type Periodo,
} from '@/lib/likida/fiscal';
import { saludo, ahoraMs } from '@/lib/saludo';
import { fechaMx, mxn, pctCambio, hoyMx } from '@/lib/formato';
import { LEYENDA_CORTA } from '@/lib/likida/cuadre/leyendas';
import { estadoPanel, liquidacionesDeViajes } from './estado';
import type { DiaViajes } from './serie-diaria';
import { getViajesPorDia } from './serie-diaria-servidor';
import {
  BarraPagina, ChipFecha, HeroSaludo, MotorFiscal, TituloSeccion,
  type FilaViaje,
} from './resumen-visual';
import { ViajesRecientes } from './viajes-recientes';
import { StatCard, BannerInsight, VerMas } from '../admin/ui/kit';
import { BarraAcciones, type ItemBusqueda, type BuscarViajes } from './barra-acciones';
import { getViajesRegistro } from '@/lib/likida/viajes_registro';
import { requireSessionTenant } from '@/lib/auth/guard';
import { KpiPeriodo } from './kpi-periodo';
import { MotorFiscalPeriodo } from './motor-fiscal-periodo';
import { PanelPeriodo } from './panel-periodo';
import { AvisoSinFlota } from './sin-flota';
import { getPrimerosPasos, type PrimerosPasos } from '@/lib/likida/primeros-pasos';
import { PrimeraLiquidacion } from './primera-liquidacion';
import { OperaWhatsApp } from './opera-whatsapp';
import { Bloque, Barra, EsqCifras, EsqTabla, EsqGrafica } from './bloque';

/** Resiliencia por sección: si una consulta falla, devuelve null y la
 *  tarjeta muestra un fallback en vez de tirar toda la pantalla. */
async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}

/**
 * Inicio / Resumen del panel de la FLOTA — todo filtrado al `tenantId` que
 * le pasan. Anatomía de página (12-ago-2026): barra de
 * página, saludo con chip de fecha, KPIs con caja interna, la tabla de
 * viajes recientes como protagonista y los bloques de periodo como
 * tarjetas blancas sobre el lienzo tenue.
 *
 * VIVE EN SU PROPIO ARCHIVO, EXPORTADO, y no dentro de `page.tsx`, por dos
 * razones que ya cobraron una vez cada una:
 *  1. Next valida los exports de una Page: `export` de esto dentro de
 *     `page.tsx` rompía `npm run build` ("InicioContenido is not a valid
 *     Page export field", 12-ago-2026).
 *  2. Sin export no se puede montar en un preview headless sin sesión — y
 *     "verificar mirando" es regla del repo. Recibe el tenant YA resuelto
 *     por eso mismo: lo que se verifica es la pantalla real, no una copia.
 *
 * ── FE-14 (22-ago-2026): SE PINTA POR PARTES, YA NO DE GOLPE ──────────────
 *
 * Esta función abría con un `Promise.all` de DIECISÉIS consultas y no
 * devolvía nada hasta que la última terminaba: con `force-dynamic`, Next no
 * manda un byte de HTML hasta entonces, así que el saludo, la barra y las
 * cifras baratas esperaban a la serie de 12 semanas y el usuario miraba el
 * logo respirando (`loading.tsx`) todo ese rato.
 *
 * Ahora las promesas se LANZAN todas juntas aquí arriba —el mismo
 * paralelismo que daba `Promise.all`— pero se ESPERAN dentro de cada
 * `<Bloque>`, cada uno con un esqueleto de la forma y la altura de su
 * tarjeta. La cáscara (barra, saludo, chip, CTA) sale con el primer flush y
 * cada tarjeta aterriza cuando su consulta contesta.
 *
 * LA TRAMPA A NO PISAR: pasar la PROMESA, jamás el valor ya esperado. Un
 * `await` en esta función vuelve a serializar lo que se acaba de
 * paralelizar, y el bloque de abajo no empezaría hasta que el de arriba
 * terminara.
 */
export async function InicioContenido({
  tenantId, tenantNombre, nombre, tenantExiste = true, sufijo = '',
}: {
  tenantId: string;
  tenantNombre: string | null;
  nombre: string | null;
  /** `false` cuando el uuid al que apunta la página no tiene fila en `tenant`
   *  — ver `sin-flota.tsx`. Default `true` para no cambiar el render de
   *  ningún cliente real, cuyo tenant existe por llave foránea. */
  tenantExiste?: boolean;
  /** Query string que los links internos deben cargar (`?tenant=`/`?vista=`
   *  del superadmin) — mismo contrato que el sidebar; vacío para roles
   *  reales. Lo arma `page.tsx`, que es quien tiene los searchParams. */
  sufijo?: string;
}) {
  // AUDITORÍA DE DISEÑO, 8-AGO-2026 — sin filtro operativo global 7d/30d:
  //   - `getKpis` sin ventana: "por revisar" y "comprobantes duplicados"
  //     nunca esconden un pendiente real solo por ser viejo.
  //   - `getAcreditables` usa el MISMO periodo que el resto de "Tu motor
  //     fiscal" (el ejercicio fiscal en curso) — dos cifras en la misma
  //     tarjeta con dos "cuándo" distintos se leen como error de captura.
  // DAT-08/FE-20 (auditoría prod): era `toISOString().slice(0,10)`, el día
  // UTC. De 18:00 a 24:00 hora de México el panel ya estaba en el día
  // siguiente, y el 31 de diciembre el `resolverPeriodo` de abajo abría el
  // ejercicio EQUIVOCADO: todo lo fiscal salía en ceros a las 6 de la tarde.
  const hoy = hoyMx(new Date(ahoraMs()));
  const periodoFiscal = resolverPeriodo(undefined, hoy);
  const diasEjercicio = periodoFiscal.desde
    ? Math.floor((Date.parse(`${hoy}T00:00:00Z`) - Date.parse(`${periodoFiscal.desde}T00:00:00Z`)) / 86_400_000) + 1
    : undefined;

  // ── LAS DIECISÉIS CONSULTAS, LANZADAS DE UNA ────────────────────────────
  // Sin `await`: salen todas a la base en el mismo tick, igual que en el
  // `Promise.all` que había aquí. Cada una viaja hasta el bloque que la
  // consume. Todas pasan por `safe`, así que NINGUNA rechaza — resuelven a
  // `null` y la tarjeta pinta su leyenda honesta (null ≠ 0).
  const pAcred = safe<Acreditables>(() => getAcreditables(tenantId, diasEjercicio));
  const pKpis = safe<DashboardKpis>(() => getKpis(tenantId));
  const pAnomalias = safe<Anomalia[]>(() => detectarAnomalias(tenantId));
  // `estadoPanel`, `PanelPeriodo` (Actividad) y la tabla de viajes
  // recientes reusan este MISMO arreglo.
  const pViajes = safe<ViajeRow[]>(() => getViajes(tenantId));
  // Semanal/mensual/histórico — mismo selector único que las tarjetas de
  // KPI y el resto de `PanelPeriodo` (dirección del 8-ago-2026).
  const pGastoSemanal = safe<GastoSemanalSeries>(() => getGastoPorSemanaSeries(tenantId, hoy));
  const pLiquidadoSemanal = safe<LiquidadoSemanalSeries>(() => getLiquidadoPorSemanaSeries(tenantId, hoy));
  // Cada tarjeta de KPI cicla su PROPIA granularidad con ‹ ›
  // (dirección del 8-ago-2026). `PanelPeriodo` también lo reusa para la
  // dona "Viajes" (liquidados/pendientes DEL periodo).
  const pSeriesKpis = safe<SeriesKpiCards>(() => getSeriesKpiCards(tenantId, hoy));
  const pCfgFiscal = safe<LikidaConfig>(() => getConfig(tenantId));
  const pGastosFiscales = safe<GastoFiscal[]>(() => getGastosFiscales(tenantId, periodoFiscal));
  // "En riesgo/perdido" y "Recuperable pidiendo factura" ciclan
  // semanal/mensual/histórico (`MotorFiscalPeriodo`) — serie aparte de
  // `gastosFiscales` (que sigue fija al ejercicio, para el top-causas).
  const pGastosFiscalesSeries = safe<GastosFiscalesSeries>(() => getGastosFiscalesSeries(tenantId, hoy));
  // `Actividad` pestaña Histórico — agregado real por mes, SIN el tope de
  // 100 filas de `viajes` (ver nota en `getViajesPorMes`).
  const pViajesPorMes = safe<Array<{ dia: string; valor: number }>>(() => getViajesPorMes(tenantId));
  const pTopRutas = safe<TopRutasSeries>(() => getTopRutasPorGastoSeries(tenantId, 5, hoy));
  // FE-5: "Actividad — últimos 7/30 días" se bucketeaba EN EL CLIENTE sobre
  // las 100 filas de `viajes` (≈90 min de operación a 50k viajes/mes: seis
  // barras en cero bajo un rótulo que decía "7 días"). Ahora la base cuenta
  // por día, en una sola lectura para las dos ventanas.
  const pViajesPorDia = safe<DiaViajes[]>(() => getViajesPorDia(tenantId, hoy));
  // Las alertas de F2. Devuelven `null` ante error (≠ 0) y la alerta
  // simplemente no se pinta — una alerta no puede afirmar en falso.
  const pEscalados = safe<number | null>(() => contarEscalados(tenantId));
  const pHuerfanos = safe<number | null>(() => contarHuerfanosPendientes(tenantId));
  const pPasos = safe(() => getPrimerosPasos(tenantId));

  // Derivadas: `.then` sobre promesas YA lanzadas — no añade una espera, solo
  // dice qué hacer cuando lleguen. `resumirPerdidas` es pura y se calcula UNA
  // vez aquí en el servidor: `fiscal.ts` importa `supabaseAdmin` a nivel de
  // módulo, y un Client Component no puede importarlo sin arrastrar el
  // service-role al bundle del navegador.
  const pResumenPerdidas: Promise<ResumenPerdidas | null> =
    Promise.all([pCfgFiscal, pGastosFiscales]).then(([cfg, gastos]) =>
      cfg && gastos ? resumirPerdidas(gastos, opcionesDe(cfg)) : null);
  const pResumenPerdidasSeries: Promise<Record<'semanal' | 'mensual' | 'historico', ResumenPerdidas> | null> =
    Promise.all([pCfgFiscal, pGastosFiscalesSeries]).then(([cfg, series]) =>
      cfg && series
        ? {
          semanal: resumirPerdidas(series.semanal, opcionesDe(cfg)),
          mensual: resumirPerdidas(series.mensual, opcionesDe(cfg)),
          historico: resumirPerdidas(series.historico, opcionesDe(cfg)),
        }
        : null);

  // ── FE-6: EL LINK "Ver" SE CRUZA POR viaje_id, NO POR FOLIO ─────────────
  //
  // Aquí se pedían las 50 liquidaciones más recientes (`getLiquidaciones`) y
  // se cruzaban contra los 100 viajes POR FOLIO. Dos fallas a la vez:
  //   1. 50 < 100. El viaje liquidado número 51 hacia atrás nunca encontraba
  //      su liquidación y perdía el "Ver" — sin que nada lo dijera. A 50k
  //      viajes/mes eso son casi todas las filas de la tabla.
  //   2. El folio es TEXTO LIBRE del TMS y puede repetirse (por eso
  //      `getLiquidacionesDeViajes` existe y cruza por `viaje_id`): dos
  //      viajes con el mismo folio se llevaban el link del otro, que es peor
  //      que no tener link.
  //
  // Encadenado a `pViajes` a propósito: depende de los ids que esa consulta
  // trae, y son a lo más 100 — un `.in()` de una tanda. Va encadenado y no
  // esperado aquí para que la tabla sea el único bloque que aguante esos dos
  // saltos (FE-14): las demás tarjetas no tienen por qué esperarlos.
  const pFilasViajes: Promise<FilaViaje[] | null> = pViajes.then(async (viajes) => {
    if (viajes === null) return null;
    const liquidaciones = viajes.length > 0
      ? await safe<LiquidacionDeViaje[]>(() => getLiquidacionesDeViajes(tenantId, viajes.map((v) => v.id)))
      : [];
    const liqPorViaje = new Map((liquidaciones ?? []).map((l) => [l.viajeId, l.id]));
    // TODAS las filas cargadas (tope 100 de getViajes): la tarjeta enseña 6 y
    // su botón "Ver los N" despliega el resto (pedido del 12-ago). El link
    // "Ver" solo cuando la liquidación existe Y se pudo cruzar — un viaje sin
    // cruce se queda sin link, nunca con un link a un 404. Ya no se pregunta
    // por `estatus === 'liquidado'`: la existencia de la FILA es la condición
    // real (un viaje en cuadre con liquidación tiene detalle que abrir), y
    // preguntar por el estatus dejaba sin link a filas cuyo destino sí existe.
    return viajes.map((v) => ({
      id: v.id, folio: v.folio, origen: v.origen, destino: v.destino,
      estatus: v.estatus, anticipo: v.anticipo, operadorNombre: v.operadorNombre,
      fechaInicio: v.fechaInicio,
      liqId: liqPorViaje.get(v.id) ?? null,
    }));
  });

  const ICONO_BARRA = { width: 15, height: 15, strokeWidth: 1.75, style: { color: 'var(--muted)' } } as const;

  /**
   * FE-5 — LA BÚSQUEDA VA A LA BASE, NO A LAS 100 FILAS CARGADAS.
   *
   * La barra filtraba en memoria sobre `viajes` (las 100 más recientes). A
   * 50,000 viajes/mes eso son ~90 minutos de operación: teclear el folio de
   * ayer devolvía "Ningún viaje coincide con «F-0148»" — una afirmación sobre
   * toda la flota respaldada por hora y media de datos. `getViajesRegistro`
   * ya busca por folio/origen/destino contra el tenant COMPLETO, con los
   * índices de trigramas de la 0154.
   *
   * Server action: el tenant viaja por closure del render, nunca del cliente,
   * y la sesión se re-verifica adentro (alcanzable por POST directo). Lanza
   * ante rechazo o fallo — la barra lo pinta como "no se pudo buscar", que no
   * es lo mismo que "no existe".
   */
  async function buscarViajes(q: string): Promise<ItemBusqueda[]> {
    'use server';
    const sesion = await requireSessionTenant('/dashboard');
    if (sesion.rol !== 'superadmin' && sesion.tenantId !== tenantId) {
      throw new Error('Esa flota no es la tuya.');
    }
    const texto = typeof q === 'string' ? q.trim().slice(0, 80) : '';
    if (!texto) return [];

    const { filas } = await getViajesRegistro(tenantId, { q: texto, porPagina: 8 });
    // El link "Ver" se cruza por `viaje_id` — el folio es texto libre del TMS
    // y puede repetirse (el mismo motivo por el que existe esta función).
    const liqs = await getLiquidacionesDeViajes(tenantId, filas.map((v) => v.id));
    const porViaje = new Map(liqs.map((l) => [l.viajeId, l.id]));
    return filas.map((v) => {
      const liqId = porViaje.get(v.id) ?? null;
      const ruta = v.origen && v.destino ? `${v.origen} → ${v.destino}` : v.origen ?? v.destino ?? 'sin ruta capturada';
      return {
        etiqueta: v.folio,
        detalle: `${ruta}${v.operadorNombre ? ` · ${v.operadorNombre}` : ''}`,
        href: liqId ? `/dashboard/${liqId}${sufijo}` : null,
      };
    });
  }

  return (
    // El scroll vive DENTRO del panel (patrón FASE 1.5). El lienzo del
    // contenido es TENUE (`--g1`) y las piezas son tarjetas blancas encima —
    // la anatomía de la referencia; la barra y el saludo van sobre blanco.
    <main className="h-full">
      <div className="rounded-2xl overflow-hidden min-h-full flex flex-col hairline" style={{ background: 'var(--g1)' }}>
        <BarraPagina
          icono={<LayoutGrid {...ICONO_BARRA} />}
          titulo="Resumen"
          derecha={
            <div className="flex items-center gap-2 min-w-0">
              {tenantNombre && (
                <span className="hidden lg:inline-block text-[11px] px-2 py-0.5 rounded-full font-medium shrink-0" style={{ color: 'var(--accent-fg)', background: 'var(--accent)' }}>
                  viendo como superadmin · {tenantNombre}
                </span>
              )}
              {/* La campana enseña PENDIENTES reales, y para saberlos hay que
                  leer kpis + anomalías. Su hueco se reserva con un fantasma
                  del MISMO tamaño (h-8) para que la barra no dé el brinco al
                  aterrizar los tres controles. */}
              <Bloque mensaje="No se pudo cargar la barra de acciones." esqueleto={<FantasmaAcciones />}>
                <AccionesResumen buscar={buscarViajes} pKpis={pKpis} pAnomalias={pAnomalias} sufijo={sufijo} />
              </Bloque>
            </div>
          }
        />
        {/* La bienvenida vive DIRECTO sobre el lienzo tenue — corrección de
            Javier sobre la referencia: lo que lleva recuadro blanco es la
            BARRA de arriba, no el saludo. */}
        <HeroSaludo
            saludo={saludo()} nombre={nombre ?? 'flota'}
            tagline="Todo listo para que sigas moviendo tu flota"
            derecha={
              <div className="flex items-center gap-2.5 shrink-0 pt-1">
                {/* El DÍA DE MÉXICO, no el UTC: a las 6pm de CDMX el chip
                    decía mañana (capturado el 12-ago). */}
                <ChipFecha icono={<CalendarDays {...ICONO_BARRA} />}>{fechaMx(hoyMx(new Date(ahoraMs())))}</ChipFecha>
                {/* A DESPACHO (13-ago): ahí vive la forma de crear — junto
                    con asignar, avisar y el alta de operadores. La página
                    suelta /viajes/nuevo se retiró: era la misma forma con
                    menos contexto, y dos puertas se desincronizan. */}
                <Link href={`/dashboard/despacho${sufijo}`}
                  className="h-8 px-3 rounded-lg text-[13px] font-medium inline-flex items-center gap-1.5 shrink-0 transition-opacity hover:opacity-85"
                  style={{ background: 'var(--marca)', color: 'var(--marca-fg)' }}>
                  <Plus width={15} height={15} strokeWidth={2} /> Nuevo viaje
                </Link>
              </div>
            }
        />

        <div className="px-5 pb-5 flex-1">
          {/* ANTES QUE NINGUNA CIFRA. Lo de abajo son ceros de una flota que
              no existe, y esa frase tiene que llegar antes que los ceros. No
              necesita consulta: sale con el primer flush, que es justo lo que
              "antes que ninguna cifra" quiere decir. */}
          {!tenantExiste && (
            <div className="mt-3"><AvisoSinFlota tenantId={tenantId} /></div>
          )}

          {/* La guía del arranque y el canal (auditoría 5): condicionales de
              verdad —solo mientras no exista la primera liquidación—, así que
              su hueco NO se reserva: un esqueleto que casi siempre se resuelve
              en "nada" sería un salto de layout garantizado en vez de uno
              excepcional. */}
          {tenantExiste && (
            <Bloque mensaje="No se pudo leer el avance del arranque." esqueleto={null}>
              <BloqueArranque pPasos={pPasos} sufijo={sufijo} />
            </Bloque>
          )}

          {/* El insight ANTES que las alertas (patrón de la referencia): la
              noticia del negocio abre; los pendientes accionables siguen
              justo debajo, cada uno con su puerta. Los dos son condicionales
              (solo con dato real), por lo mismo van sin esqueleto. */}
          <Bloque mensaje="No se pudo calcular el insight de la semana." esqueleto={null}>
            <BloqueInsight pLiquidadoSemanal={pLiquidadoSemanal} />
          </Bloque>

          <Bloque mensaje="No se pudieron leer las alertas." esqueleto={null}>
            <BloqueAlertas pKpis={pKpis} pEscalados={pEscalados} pHuerfanos={pHuerfanos}
              pAnomalias={pAnomalias} sufijo={sufijo} />
          </Bloque>

          {/* El aviso de pantalla incompleta necesita saber de TODAS las
              secciones, así que es —por definición— el bloque más lento. Con
              el streaming ya no puede seguir gobernando el render: cada
              tarjeta de abajo degrada sola y dice lo suyo. Éste queda como lo
              que siempre fue en el fondo, un AVISO, y llega cuando puede. */}
          <Bloque mensaje="No se pudo evaluar el estado de la pantalla." esqueleto={null}>
            <AvisoEstado
              pAcred={pAcred} pKpis={pKpis} pAnomalias={pAnomalias} pViajes={pViajes}
              pSeriesKpis={pSeriesKpis} pGastoSemanal={pGastoSemanal}
              pLiquidadoSemanal={pLiquidadoSemanal} pTopRutas={pTopRutas}
              pViajesPorMes={pViajesPorMes} pCfgFiscal={pCfgFiscal} pGastosFiscales={pGastosFiscales}
              pEscalados={pEscalados} pHuerfanos={pHuerfanos} />
          </Bloque>

          {/* ── KPIs (caja interna + delta como texto, referencia) ──
              "Total viajes" y "Liquidado" no van aquí: ya se ven como
              GRÁFICA más abajo. "Ahorro generado" se queda (pedido
              explícito): mismo número que "Recuperable pidiendo
              factura", pero fijo al ejercicio fiscal completo. La
              dirección buena/mala no es igual para las tres: gastar
              más no es bueno aunque el número suba. */}
          <div className="mt-2">
            <Bloque mensaje="No se pudieron cargar las cifras del periodo."
              esqueleto={<EsqCifras n={3} rejilla="grid grid-cols-1 sm:grid-cols-3 gap-2" />}>
              <BloqueKpis pKpis={pKpis} pSeriesKpis={pSeriesKpis} pResumenPerdidas={pResumenPerdidas}
                periodoFiscal={periodoFiscal} />
            </Bloque>
          </div>

          {/* ── Motor fiscal — el diferenciador real, no un TMS
              genérico. Todo lo fiscal vive junto, en UNA tarjeta. */}
          <div className="mt-2">
            <Bloque mensaje="No se pudo cargar el motor fiscal." esqueleto={<EsqMotorFiscal />}>
              <BloqueFiscal pAcred={pAcred} pResumenPerdidas={pResumenPerdidas}
                pResumenPerdidasSeries={pResumenPerdidasSeries} periodoFiscal={periodoFiscal} />
            </Bloque>
          </div>

          {/* ── La tabla protagonista, con los viajes REALES y su botón
              de abrir (despliega los 100 cargados ahí mismo). */}
          <Bloque mensaje="No se pudieron cargar los viajes recientes." esqueleto={<div className="mt-2.5"><EsqTabla filas={6} /></div>}>
            <BloqueViajes pFilasViajes={pFilasViajes} sufijo={sufijo} />
          </Bloque>

          {/* ── Viajes / Actividad / Gasto por categoría / Liquidado /
              Top rutas — UN SOLO selector Semanal/Mensual/Histórico que
              mueve las 5 juntas (pedido explícito, 8-ago-2026). El id
              es el ancla del BannerInsight de arriba. */}
          <div className="mt-2.5" id="estadisticas">
            <Bloque mensaje="No se pudieron cargar las estadísticas del periodo." esqueleto={<EsqGrafica alto={260} />}>
              <BloqueEstadisticas
                pViajesPorDia={pViajesPorDia} pViajesPorMes={pViajesPorMes} pSeriesKpis={pSeriesKpis}
                pGastoSemanal={pGastoSemanal} pLiquidadoSemanal={pLiquidadoSemanal} pTopRutas={pTopRutas} />
            </Bloque>
          </div>

          <p className="text-[11px] pt-3" style={{ color: 'var(--faint)' }}>{LEYENDA_CORTA}</p>
        </div>
      </div>
    </main>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LOS BLOQUES. Cada uno espera SOLO sus promesas y nada más: eso es lo que
// hace que el de al lado no lo espere. Viven en ESTE archivo a propósito —
// `dinero_por_area.test.ts` escanea `page.tsx` + `inicio-contenido.tsx` +
// `inicio-operacion.tsx` en busca de pesos sin gatear, y una sección con
// `mxn(` mudada a un archivo nuevo se saldría de ese escaneo en silencio.
// ═══════════════════════════════════════════════════════════════════════════

/** El hueco de los tres controles de la barra, del mismo alto (h-8). */
function FantasmaAcciones() {
  return (
    <div className="flex items-center gap-2 shrink-0" role="status" aria-label="Cargando">
      <Barra alto={32} ancho={148} className="rounded-lg" />
      <Barra alto={32} ancho={32} className="rounded-lg" />
      <Barra alto={32} ancho={32} className="rounded-lg" />
    </div>
  );
}

async function AccionesResumen({ buscar, pKpis, pAnomalias, sufijo }: {
  buscar: BuscarViajes;
  pKpis: Promise<DashboardKpis | null>;
  pAnomalias: Promise<Anomalia[] | null>;
  sufijo: string;
}) {
  const [kpis, anomalias] = await Promise.all([pKpis, pAnomalias]);
  // La campana enseña PENDIENTES reales — los mismos que perdieron su
  // tarjeta cuando Cuadre se borró el 10-ago. Aquí son texto: el link
  // regresa cuando esa página exista.
  const pendientes: string[] = [];
  if (kpis && kpis.porRevisar > 0) {
    pendientes.push(`${kpis.porRevisar} liquidación${kpis.porRevisar === 1 ? '' : 'es'} por revisar`);
  }
  if (anomalias && anomalias.length > 0) {
    pendientes.push(`${anomalias.length} comprobante${anomalias.length === 1 ? '' : 's'} repetido${anomalias.length === 1 ? '' : 's'} entre viajes distintos`);
  }
  return <BarraAcciones buscar={buscar} pendientes={pendientes} hrefAsistente={`/dashboard/chat${sufijo}`} />;
}

async function BloqueArranque({ pPasos, sufijo }: {
  pPasos: Promise<PrimerosPasos | null>; sufijo: string;
}) {
  const pasos = await pPasos;
  // Si la consulta falla, no se pinta — jamás se palomea de cortesía.
  if (!pasos || pasos.completado) return null;
  return (
    <>
      <div className="mt-3"><PrimeraLiquidacion datos={pasos} sufijo={sufijo} /></div>
      {/* El canal, presentado con sus mensajes literales — solo mientras
          la flota arranca: ya operando, el guion lo tiene aprendido y la
          tarjeta cede el lugar a las cifras. */}
      <div className="mt-3"><OperaWhatsApp rol="jefe" /></div>
    </>
  );
}

async function BloqueInsight({ pLiquidadoSemanal }: {
  pLiquidadoSemanal: Promise<LiquidadoSemanalSeries | null>;
}) {
  // ── El insight de la semana (BannerInsight, 16-ago-2026) ────────────────
  // La noticia POSITIVA del periodo, con la regla de siempre: solo se monta
  // con dato real. La serie semanal ya está cargada para la gráfica
  // "Liquidado" de abajo — el último bucket es la semana en curso y el
  // penúltimo la anterior; `pctCambio` devuelve null sin comparable y el
  // chip se omite. Con $0 liquidado esta semana NO hay banner: un insight
  // de relleno es ruido, no noticia.
  const liquidadoSemanalSeries = await pLiquidadoSemanal;
  const buckets = liquidadoSemanalSeries?.semanal ?? [];
  const actual = buckets.length > 0 ? buckets[buckets.length - 1].valor : 0;
  const anterior = buckets.length > 1 ? buckets[buckets.length - 2].valor : null;
  if (actual <= 0) return null;
  return (
    <div className="mt-3">
      <BannerInsight etiqueta="Esta semana" deltaPct={pctCambio(actual, anterior)} href="#estadisticas">
        Tu flota liquidó <b className="tabular">{mxn(actual)}</b> en viajes cerrados
      </BannerInsight>
    </div>
  );
}

async function BloqueAlertas({ pKpis, pEscalados, pHuerfanos, pAnomalias, sufijo }: {
  pKpis: Promise<DashboardKpis | null>;
  pEscalados: Promise<number | null>;
  pHuerfanos: Promise<number | null>;
  pAnomalias: Promise<Anomalia[] | null>;
  sufijo: string;
}) {
  const [kpis, escalados, huerfanosPendientes, anomalias] =
    await Promise.all([pKpis, pEscalados, pHuerfanos, pAnomalias]);

  // Las alertas accionables (F2): cada una lleva a LA pantalla donde se
  // resuelve, con el sufijo del superadmin a cuestas. Se apagaron cuando
  // Cuadre se borró el 10-ago (un "Ver →" a un 404 es peor que nada);
  // regresan ahora que sus destinos existen.
  const alertas: Array<{ texto: string; href: string }> = [];
  if (kpis && kpis.porRevisar > 0) {
    alertas.push({
      texto: `${kpis.porRevisar} liquidación${kpis.porRevisar === 1 ? ' espera' : 'es esperan'} tu revisión`,
      href: `/dashboard/agentes/liquidacion${sufijo}`,
    });
  }
  if (escalados !== null && escalados !== undefined && escalados > 0) {
    alertas.push({
      texto: `${escalados} viaje${escalados === 1 ? '' : 's'} escalado${escalados === 1 ? '' : 's'} sin chofer que acepte — se resuelve en Despacho`,
      href: `/dashboard/despacho${sufijo}`,
    });
  }
  if (huerfanosPendientes !== null && huerfanosPendientes !== undefined && huerfanosPendientes > 0) {
    alertas.push({
      texto: `${huerfanosPendientes} comprobante${huerfanosPendientes === 1 ? ' sin viaje espera que alguien lo acomode' : 's sin viaje esperan que alguien los acomode'}`,
      href: `/dashboard/huerfanos${sufijo}`,
    });
  }
  if (anomalias && anomalias.length > 0) {
    alertas.push({
      texto: `${anomalias.length} comprobante${anomalias.length === 1 ? '' : 's'} repetido${anomalias.length === 1 ? '' : 's'} entre viajes distintos`,
      href: `/dashboard/agentes/liquidacion${sufijo}`,
    });
  }
  if (alertas.length === 0) return null;

  return (
    <div className="mt-3 space-y-1.5">
      {alertas.map((a) => (
        <Link key={a.texto} href={a.href}
          className="card p-3 flex items-center gap-2.5 hover:opacity-85 transition-opacity"
          style={{ borderColor: 'var(--warn)' }}>
          <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--warn)' }} />
          <span className="text-[13px]">{a.texto}</span>
          <span className="ml-auto text-[11px] shrink-0" style={{ color: 'var(--muted)' }}>Ver →</span>
        </Link>
      ))}
    </div>
  );
}

export async function AvisoEstado({
  pAcred, pKpis, pAnomalias, pViajes, pSeriesKpis, pGastoSemanal, pLiquidadoSemanal,
  pTopRutas, pViajesPorMes, pCfgFiscal, pGastosFiscales, pEscalados, pHuerfanos,
}: {
  pAcred: Promise<Acreditables | null>;
  pKpis: Promise<DashboardKpis | null>;
  pAnomalias: Promise<Anomalia[] | null>;
  pViajes: Promise<ViajeRow[] | null>;
  pSeriesKpis: Promise<SeriesKpiCards | null>;
  pGastoSemanal: Promise<GastoSemanalSeries | null>;
  pLiquidadoSemanal: Promise<LiquidadoSemanalSeries | null>;
  pTopRutas: Promise<TopRutasSeries | null>;
  pViajesPorMes: Promise<Array<{ dia: string; valor: number }> | null>;
  pCfgFiscal: Promise<LikidaConfig | null>;
  pGastosFiscales: Promise<GastoFiscal[] | null>;
  // AUDITORÍA 25, MEDIO: faltaban aquí — una caída de `contarEscalados` o
  // `contarHuerfanosPendientes` borraba el renglón de alerta (BloqueAlertas)
  // Y no encendía este aviso, así que el Resumen quedaba IDÉNTICO al de una
  // flota sin escalados ni huérfanos. Mismas promesas que ya recibe
  // `BloqueAlertas` — ninguna consulta nueva.
  pEscalados: Promise<number | null>;
  pHuerfanos: Promise<number | null>;
}) {
  const [
    acred, kpis, anomalias, viajes, seriesKpis, gastoSemanalSeries,
    liquidadoSemanalSeries, topRutasSeries, viajesPorMes, cfgFiscal, gastosFiscales,
    escalados, huerfanos,
  ] = await Promise.all([
    pAcred, pKpis, pAnomalias, pViajes, pSeriesKpis, pGastoSemanal,
    pLiquidadoSemanal, pTopRutas, pViajesPorMes, pCfgFiscal, pGastosFiscales,
    pEscalados, pHuerfanos,
  ]);

  // AUDITORÍA 10, ALTO: el estado se decide con VIAJES reales filtrados a
  // `liquidado` (un arreglo que sí puede quedar vacío), no con `porDia`
  // (siempre traía 7/30 elementos y la rama 'vacio' era inalcanzable).
  const estado = estadoPanel({
    acreditables: acred, kpis, liquidaciones: liquidacionesDeViajes(viajes), anomalias,
    // A13 + AUDITORÍA 25 MEDIO: las consultas del selector, las fiscales Y
    // las dos alertas (escalados/huérfanos) cuentan — una caída aquí enseña
    // el banner de "pantalla incompleta", no un vacío silencioso.
    secundarias: {
      seriesKpis, gastoSemanalSeries, liquidadoSemanalSeries, topRutasSeries, viajesPorMes,
      cfgFiscal, gastosFiscales, escalados, huerfanos,
    },
  });

  if (estado === 'error') {
    return (
      <div className="card p-6 mt-3" style={{ borderColor: 'var(--bad)' }}>
        <p className="text-sm font-semibold tracking-tight m-0">No se pudieron cargar los datos</p>
        <p className="mt-1.5 text-sm m-0" style={{ color: 'var(--muted)' }}>
          Hubo un problema al leer del sistema. Recarga la página en un momento — esto NO significa
          que no haya liquidaciones, significa que no se pudieron leer.
        </p>
      </div>
    );
  }
  if (estado !== 'parcial') return null;
  // `vacio` y `datos` son el MISMO layout — `estadoPanel` ya garantiza que
  // todo cargó bien en ambos casos: "vacío" son las mismas piezas con sus
  // propios ceros honestos.
  return (
    <div className="card p-4 flex items-start gap-3 mt-3" style={{ borderColor: 'var(--warn)' }}>
      <span className="inline-block w-2 h-2 rounded-full mt-1.5 shrink-0" style={{ background: 'var(--warn)' }} />
      <div>
        <p className="text-sm font-semibold m-0">Faltan datos por cargar — esta pantalla está incompleta</p>
        <p className="text-xs mt-1 m-0" style={{ color: 'var(--muted)' }}>
          Una o más secciones no respondieron. No tomes estas cifras como el corte del periodo.
        </p>
      </div>
    </div>
  );
}

async function BloqueKpis({ pKpis, pSeriesKpis, pResumenPerdidas, periodoFiscal }: {
  pKpis: Promise<DashboardKpis | null>;
  pSeriesKpis: Promise<SeriesKpiCards | null>;
  pResumenPerdidas: Promise<ResumenPerdidas | null>;
  periodoFiscal: Periodo;
}) {
  const [kpis, seriesKpis, resumenPerdidas] = await Promise.all([pKpis, pSeriesKpis, pResumenPerdidas]);
  if (!kpis) return null;
  return (
    <>
      {seriesKpis ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <KpiPeriodo icono={<Wallet width={15} height={15} strokeWidth={1.75} />}
            nombre="Gasto total" campo="gastoTotal" formato="mxn" subeEsBueno={false} series={seriesKpis} />
          <KpiPeriodo icono={<Calculator width={15} height={15} strokeWidth={1.75} />}
            nombre="Costo por viaje" campo="costoPorViaje" formato="mxn" subeEsBueno={false} series={seriesKpis} />
          <StatCard icono={<PiggyBank width={15} height={15} strokeWidth={1.75} />}
            etiqueta={`Ahorro generado — ${periodoFiscal.etiqueta}`}
            // AUDITORÍA 1, ALTO: si la lectura fiscal falló (o no hay
            // config), es `null` — se PRESERVA y la tarjeta dice "—",
            // en vez de afirmar "$0.00 de ahorro" que suena a medición.
            valor={resumenPerdidas ? resumenPerdidas.montoRecuperable : null}
            sinDato="no se pudo leer el dato fiscal"
            // Sin `delta`: esta cifra va fija al ejercicio completo,
            // no hay "periodo anterior" contra el que compararla (A12).
            formato="mxn" />
        </div>
      ) : (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>No se pudo cargar el comparativo de KPIs.</p>
      )}
      {/* El fantasma "Ver estadísticas →" (ref. shadcn): la puerta
          al bloque de gráficas — mismo ancla que el BannerInsight. */}
      <div className="mt-2 flex justify-end">
        <VerMas href="#estadisticas" />
      </div>
    </>
  );
}

/** El esqueleto del motor fiscal: título, la fila de tarjetas y el cuerpo del
 *  desglose — el mismo bulto que la tarjeta real, para que nada brinque. */
function EsqMotorFiscal() {
  return (
    <div className="card p-3" role="status" aria-label="Cargando">
      <Barra alto={13} ancho="38%" />
      <div className="mt-2 flex flex-wrap gap-2 items-stretch">
        <div className="flex-1 min-w-[200px]"><Barra alto={100} className="rounded-xl" /></div>
        <div className="flex-1 min-w-[200px]"><Barra alto={100} className="rounded-xl" /></div>
        <div className="flex-1 min-w-[200px]"><Barra alto={100} className="rounded-xl" /></div>
      </div>
      <div className="mt-2"><Barra alto={150} className="rounded-xl" /></div>
    </div>
  );
}

async function BloqueFiscal({ pAcred, pResumenPerdidas, pResumenPerdidasSeries, periodoFiscal }: {
  pAcred: Promise<Acreditables | null>;
  pResumenPerdidas: Promise<ResumenPerdidas | null>;
  pResumenPerdidasSeries: Promise<Record<'semanal' | 'mensual' | 'historico', ResumenPerdidas> | null>;
  periodoFiscal: Periodo;
}) {
  const [acred, resumenPerdidas, resumenPerdidasSeries] =
    await Promise.all([pAcred, pResumenPerdidas, pResumenPerdidasSeries]);
  return (
    <div className="card p-3">
      <TituloSeccion>Tu motor fiscal — {periodoFiscal.etiqueta}</TituloSeccion>
      {/* Las 3 tarjetas en la MISMA línea, todo el ancho (pedido
          explícito, 8-ago-2026), misma altura (`h-full`). El
          diésel elegible va en LITROS, no en pesos — el estímulo
          es cuota DOF (semanal) × litros, y esa cuota no vive
          aquí. `docs/conocimiento/guion-demo.md` +
          `guion_demo.test.ts` atan el guion de venta a esto. */}
      <div className="mt-2 flex flex-wrap gap-2 items-stretch">
        <MotorFiscalPeriodo series={resumenPerdidasSeries} />
        {acred && (
          <div className="flex-1 min-w-[200px]">
            <StatCard icono={<Fuel width={15} height={15} strokeWidth={1.75} />}
              etiqueta="Diésel elegible para el estímulo" valor={acred.litrosDiesel} formato="litros" />
          </div>
        )}
      </div>
      <div className="mt-2">
        <MotorFiscal resumen={resumenPerdidas} />
      </div>
    </div>
  );
}

async function BloqueViajes({ pFilasViajes, sufijo }: {
  pFilasViajes: Promise<FilaViaje[] | null>; sufijo: string;
}) {
  const filas = await pFilasViajes;
  if (filas === null) {
    return (
      <div className="card p-6 mt-2.5 text-sm" style={{ color: 'var(--muted)' }}>
        No se pudieron leer los viajes recientes — no significa que no haya viajes.
      </div>
    );
  }
  return <ViajesRecientes filas={filas} sufijo={sufijo} />;
}

async function BloqueEstadisticas({
  pViajesPorDia, pViajesPorMes, pSeriesKpis, pGastoSemanal, pLiquidadoSemanal, pTopRutas,
}: {
  pViajesPorDia: Promise<DiaViajes[] | null>;
  pViajesPorMes: Promise<Array<{ dia: string; valor: number }> | null>;
  pSeriesKpis: Promise<SeriesKpiCards | null>;
  pGastoSemanal: Promise<GastoSemanalSeries | null>;
  pLiquidadoSemanal: Promise<LiquidadoSemanalSeries | null>;
  pTopRutas: Promise<TopRutasSeries | null>;
}) {
  const [viajesPorDia, viajesPorMes, seriesKpis, gastoSemanalSeries, liquidadoSemanalSeries, topRutasSeries] =
    await Promise.all([pViajesPorDia, pViajesPorMes, pSeriesKpis, pGastoSemanal, pLiquidadoSemanal, pTopRutas]);
  return (
    <PanelPeriodo
      porDia={viajesPorDia}
      porMes={viajesPorMes}
      seriesKpis={seriesKpis}
      gastoSemanalSeries={gastoSemanalSeries}
      liquidadoSemanalSeries={liquidadoSemanalSeries}
      topRutasSeries={topRutasSeries}
    />
  );
}
