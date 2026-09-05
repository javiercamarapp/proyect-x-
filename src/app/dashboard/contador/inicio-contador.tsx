import Link from 'next/link';
import {
  Calculator, CalendarDays, Plus, MessageCircle, Landmark, Route as RouteIcon,
  ReceiptText, Fuel, Wallet, FileX2, FileSearch, Download,
} from 'lucide-react';
import {
  getAcreditables, getKpis, detectarAnomalias,
  type Acreditables, type DashboardKpis, type Anomalia,
} from '@/lib/likida/analytics';
import { contarHuerfanosPendientes } from '@/lib/likida/repo';
import { getConfig, type LikidaConfig } from '@/lib/likida/config';
import {
  resolverPeriodo, getGastosFiscales, getGastosFiscalesSeries,
  resumirPerdidas, resumirFiscal, opcionesDe, opcionesFiscalesDelPeriodo, ventanaLitrosElegibles,
  type GastoFiscal, type ResumenPerdidas, type ResumenFiscal, type GastosFiscalesSeries,
  type Periodo,
} from '@/lib/likida/fiscal';
import { getFacturacionClientes, type FacturacionClientes } from '@/lib/likida/facturacion_clientes';
import { saludo, ahoraMs } from '@/lib/saludo';
import { fechaMx, mxn, hoyMx } from '@/lib/formato';
import { LEYENDA_CORTA } from '@/lib/likida/cuadre/leyendas';
import { areaDeRuta } from '@/lib/auth/visibilidad';
import { AUTOMATIZACIONES, DINERO_FISCAL, SISTEMA, type Item } from '../rutas';
import { BarraPagina, ChipFecha, HeroSaludo, MotorFiscal, TituloSeccion } from '../resumen-visual';
import { StatCard, EstadoVacio } from '../../admin/ui/kit';
import { MotorFiscalPeriodo } from '../motor-fiscal-periodo';
import { AvisoSinFlota } from '../sin-flota';
import { Bloque, Barra, EsqCifras } from '../bloque';
import { EstimuloPeaje } from './estimulo-peaje';
import { PerfilErp } from './perfil-erp';
import { Timbrado } from './timbrado';

/** Resiliencia por sección: si una consulta falla, devuelve null y la
 *  tarjeta muestra un fallback en vez de tirar toda la pantalla. */
async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}

/**
 * Inicio del PANEL DEL CONTADOR — el Resumen de quien vive del dinero y del
 * papel, y no despacha. Misma anatomía de página que el Resumen del dueño
 * (`inicio-contenido.tsx`): barra de página, saludo con chip de fecha sobre
 * el lienzo tenue, y tarjetas blancas encima. Lo que cambia es el contenido:
 * aquí no hay despacho, ni viajes recientes, ni carga por operador — hay
 * acreditables, deducibilidad y el papel que falta perseguir.
 *
 * VIVE EN SU PROPIO ARCHIVO, EXPORTADO, y no dentro de `page.tsx`, por las
 * dos razones que `InicioContenido` ya documenta (y que ya cobraron una vez
 * cada una): Next rechaza exports extra en una Page, y sin export el preview
 * headless no puede montar el componente REAL sin sesión.
 */
export async function InicioContador({
  tenantId, tenantNombre, nombre, tenantExiste = true, sufijo = '', searchParams = {},
}: {
  tenantId: string;
  tenantNombre: string | null;
  nombre: string | null;
  /** `false` cuando el uuid al que apunta la página no tiene fila en `tenant`
   *  — ver `sin-flota.tsx`. Aquí la mentira sería fiscal: "$0.00 de IVA
   *  acreditable" de una flota que no existe se lee como una medición. */
  tenantExiste?: boolean;
  /** Query string que los links internos deben cargar (`?tenant=`/`?vista=`/
   *  `?rol=` del superadmin) — mismo contrato que el sidebar; vacío para
   *  roles reales. Lo arma `page.tsx`, que es quien tiene los searchParams. */
  sufijo?: string;
  /** Lo necesita el formulario del estímulo de peaje (server action) para
   *  re-resolver el tenant igual que Políticas: el rol del render no es el
   *  de la acción. */
  searchParams?: { vista?: string; tenant?: string; rol?: string };
}) {
  // El MISMO "cuándo" que el Resumen del dueño (auditoría de diseño,
  // 8-ago-2026): todo lo fiscal de esta pantalla se corta al ejercicio en
  // curso, y `getKpis`/`detectarAnomalias` van sin ventana — un pendiente no
  // deja de ser pendiente por ser viejo.
  // DAT-08/FE-20 (auditoría prod): era `toISOString().slice(0,10)`, el día
  // UTC. De 18:00 a 24:00 hora de México el panel ya estaba en el día
  // siguiente, y el 31 de diciembre el `resolverPeriodo` de abajo abría el
  // ejercicio EQUIVOCADO: todo lo fiscal salía en ceros a las 6 de la tarde.
  const hoy = hoyMx(new Date(ahoraMs()));
  const periodoFiscal = resolverPeriodo(undefined, hoy);
  // FE-8 (auditoría 24): misma ventana que `ventanaLitrosElegibles` usa en
  // combustible-casetas/page.tsx y chat/page.tsx — antes cada pantalla
  // calculaba "días del ejercicio" a mano, con la misma cita legal (LIF
  // 2026, Art. 20-A) llegando a cifras distintas entre pantallas.
  const diasEjercicio = ventanaLitrosElegibles(hoy).dias;

  // ── LAS OCHO CONSULTAS, LANZADAS DE UNA (FE-14) ─────────────────────────
  // Sin `await`: salen todas en el mismo tick, igual que en el `Promise.all`
  // que había aquí, pero cada una se espera DENTRO del bloque que la usa. La
  // cáscara (barra, saludo, el botón de exportar, "Tus pantallas") no
  // depende de ninguna lectura y sale con el primer flush del stream, en vez
  // de esperar a que `getFacturacionClientes` recorra la cartera entera.
  // Todas pasan por `safe`, así que ninguna rechaza: resuelven a `null` y su
  // tarjeta pinta la leyenda honesta (null ≠ 0).
  const pAcred = safe<Acreditables>(() => getAcreditables(tenantId, diasEjercicio));
  const pKpis = safe<DashboardKpis>(() => getKpis(tenantId));
  const pAnomalias = safe<Anomalia[]>(() => detectarAnomalias(tenantId));
  // Devuelve `null` ante error (≠ 0) y la alerta simplemente no se pinta —
  // una alerta no puede afirmar en falso. Igual que en el Resumen del dueño,
  // no entra al conteo de secciones caídas: es solo una alerta.
  const pHuerfanos = safe<number | null>(() => contarHuerfanosPendientes(tenantId));
  const pCfgFiscal = safe<LikidaConfig>(() => getConfig(tenantId));
  const pGastosFiscales = safe<GastoFiscal[]>(() => getGastosFiscales(tenantId, periodoFiscal));
  // "En riesgo/perdido" y "Recuperable" ciclan semanal/mensual/histórico
  // (`MotorFiscalPeriodo`) — serie aparte de `gastosFiscales`, que sigue
  // fija al ejercicio para el top de causas y el desglose.
  const pGastosFiscalesSeries = safe<GastosFiscalesSeries>(() => getGastosFiscalesSeries(tenantId, hoy));
  // La cartera: facturas emitidas y qué les falta de pago. El helper NO
  // atrapa por dentro (una base caída se leería como "no te debe nadie"),
  // así que aquí el `safe` la marca como sección caída, no como cero.
  const pFacturacion = safe<FacturacionClientes>(() => getFacturacionClientes(tenantId));

  // `resumirPerdidas`/`resumirFiscal` son puras: se calculan UNA vez aquí en
  // el servidor. `fiscal.ts` importa `supabaseAdmin` a nivel de módulo — un
  // Client Component no puede importarlo sin arrastrar el service-role al
  // bundle del navegador, por eso `MotorFiscalPeriodo` recibe datos planos.
  // `.then` sobre promesas YA lanzadas: no añade espera, solo dice qué hacer
  // cuando lleguen.
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
  // AUDITORÍA 25, FIS-C1/FIS-C2 (CRÍTICO): `resumirFiscal` necesita el
  // acumulado REAL del ejercicio (`combustibleEjercicio`) para partir el IVA
  // del diésel en efectivo igual que el motor — `opcionesDe(cfg)` solo trae
  // la config, no ese acumulado.
  const pResumenFiscal: Promise<ResumenFiscal | null> =
    Promise.all([pCfgFiscal, pGastosFiscales]).then(async ([cfg, gastos]) =>
      cfg && gastos ? resumirFiscal(gastos, await opcionesFiscalesDelPeriodo(tenantId, periodoFiscal, cfg)) : null);

  // Los accesos del final salen del MISMO mapa que gatea las páginas
  // (`areaDeRuta`), no de una lista escrita a mano: una pantalla de dinero
  // nueva aparece aquí sola, y una que cambie de área desaparece sola. El
  // chat se excluye porque ya tiene su botón fijo en la barra de arriba.
  // No consulta nada: se pinta con el primer flush.
  const pantallas: Item[] = [...AUTOMATIZACIONES, ...DINERO_FISCAL, ...SISTEMA]
    .filter((it) => areaDeRuta(it.href) === 'dinero' && it.href !== '/dashboard/chat');

  const ICONO_BARRA = { width: 15, height: 15, strokeWidth: 1.75, style: { color: 'var(--muted)' } } as const;

  return (
    // El scroll vive DENTRO del panel (patrón FASE 1.5). Lienzo tenue
    // (`--g1`) con tarjetas blancas encima — la misma anatomía que el
    // Resumen del dueño, porque es la misma casa con otro contenido.
    <main className="h-full">
      <div className="rounded-2xl overflow-hidden min-h-full flex flex-col hairline" style={{ background: 'var(--g1)' }}>
        <BarraPagina
          icono={<Calculator {...ICONO_BARRA} />}
          titulo="Panel del contador"
          derecha={
            <div className="flex items-center gap-2 min-w-0">
              {tenantNombre && (
                <span className="hidden lg:inline-block text-[11px] px-2 py-0.5 rounded-full font-medium shrink-0" style={{ color: 'var(--accent-fg)', background: 'var(--accent)' }}>
                  viendo como superadmin · {tenantNombre}
                </span>
              )}
              {/* Un link directo, no `BarraAcciones`: su buscador indexa los
                  VIAJES (registro operativo, área `operacion`) y esta
                  pantalla no debe cargar datos de un área que su lector
                  principal no ve. El asistente sí es suyo (chat es dinero). */}
              <Link href={`/dashboard/chat${sufijo}`}
                className="hairline h-8 px-3 rounded-lg inline-flex items-center gap-1.5 text-[13px] font-medium transition-colors hover:bg-[var(--canvas)] shrink-0"
                style={{ background: 'var(--surface)' }}>
                <MessageCircle width={14} height={14} strokeWidth={1.75} /> Chatea con tus datos
              </Link>
            </div>
          }
        />
        <HeroSaludo
          saludo={saludo()} nombre={nombre ?? 'contador'}
          tagline="El dinero comprobado y el papel que lo sostiene, con su fundamento citado"
          derecha={
            <div className="flex items-center gap-2.5 shrink-0 pt-1">
              {/* El DÍA DE MÉXICO, no el UTC — mismo arreglo que el Resumen
                  del dueño (capturado el 12-ago). */}
              <ChipFecha icono={<CalendarDays {...ICONO_BARRA} />}>{fechaMx(hoyMx(new Date(ahoraMs())))}</ChipFecha>
              {/* La acción primaria del contador no es despachar: es meter el
                  papel. Facturación es lectura Y captura desde la auditoría
                  4 (A1), y este botón es su puerta. */}
              {/* AUDITORÍA 2, ALTO (proceso faltante): el CSV de liquidaciones
                  para el ERP/Excel ya existía en /api/export/liquidaciones —bien
                  protegido por sesión, rol (`puedeExportar`) y tenant— pero NO
                  tenía puerta en ninguna pantalla, así que el contador no podía
                  sacar sus datos. Un `<a download>` a esa ruta, con el `?tenant=`
                  del sufijo del superadmin (vacío para roles reales, que usan su
                  sesión). Es la puerta que faltaba, no un endpoint nuevo. */}
              {/* ESCALA 50k (22-ago-2026, ESC-8): la ruta ahora EXIGE ventana
                  (máx. 3 meses) porque el CSV completo de un cliente grande no
                  cabe en la respuesta de la plataforma. La puerta del contador
                  se lleva el MES EN CURSO, que es su unidad de trabajo, y lo
                  dice en el rótulo: un botón que promete "todo" y entrega un
                  mes sería el recorte silencioso de siempre. */}
              <a href={`/api/export/liquidaciones${sufijo}${sufijo ? '&' : '?'}desde=${hoy.slice(0, 8)}01&hasta=${hoy}`} download
                className="h-8 px-3 rounded-lg text-[13px] font-medium inline-flex items-center gap-1.5 shrink-0 transition-opacity hover:opacity-85 border"
                style={{ borderColor: 'var(--line)', color: 'var(--ink)' }}>
                <Download width={15} height={15} strokeWidth={2} /> Exportar CSV del mes
              </a>
              <Link href={`/dashboard/facturacion${sufijo}`}
                className="h-8 px-3 rounded-lg text-[13px] font-medium inline-flex items-center gap-1.5 shrink-0 transition-opacity hover:opacity-85"
                style={{ background: 'var(--marca)', color: 'var(--marca-fg)' }}>
                <Plus width={15} height={15} strokeWidth={2} /> Registrar factura
              </Link>
            </div>
          }
        />

        <div className="px-5 pb-5 flex-1">
          {/* ANTES QUE NINGUNA CIFRA: los ceros de una flota que no existe no
              son una medición, y menos una fiscal. Sin consulta de por medio,
              o sea que llega con el primer flush — que es exactamente lo que
              "antes que ninguna cifra" pide. */}
          {!tenantExiste && (
            <div className="mt-3"><AvisoSinFlota tenantId={tenantId} /></div>
          )}

          {/* FASE 3: la pregunta del 50% de peaje va ANTES que las cifras.
              Sin declaración el motor fail-open y pinta un estímulo que
              quizá no toca — esa cifra no puede ser lo primero que se ve. */}
          <EstimuloPeaje searchParams={searchParams} tenantExiste={tenantExiste} />

          {/* PLAN MAESTRO 26-ago, sección B: la plantilla que desbloquea el
              export a SAP B1/CONTPAQi. Sin ella el export responde 409 para
              cualquier flota — el lector existía desde la 0178, el escritor
              es este formulario. */}
          <PerfilErp searchParams={searchParams} tenantExiste={tenantExiste} />

          <Timbrado searchParams={searchParams} tenantExiste={tenantExiste} sufijo={sufijo} />

          {/* Condicional de verdad (solo si hay fuego): sin esqueleto, para no
              reservar un hueco que casi siempre queda vacío. */}
          <Bloque mensaje="No se pudieron leer las alertas." esqueleto={null}>
            <BloqueAlertas pKpis={pKpis} pAnomalias={pAnomalias} pHuerfanos={pHuerfanos}
              pFacturacion={pFacturacion} sufijo={sufijo} />
          </Bloque>

          {/* El aviso de pantalla incompleta necesita saber de las SIETE
              secciones, o sea que es por definición el bloque más lento. Con
              el streaming ya no gobierna el render —cada tarjeta de abajo
              degrada sola y dice lo suyo—: queda como lo que en el fondo
              siempre fue, un aviso, y llega cuando puede. */}
          <Bloque mensaje="No se pudo evaluar el estado de la pantalla." esqueleto={null}>
            <AvisoEstado pAcred={pAcred} pKpis={pKpis} pAnomalias={pAnomalias} pCfgFiscal={pCfgFiscal}
              pGastosFiscales={pGastosFiscales} pGastosFiscalesSeries={pGastosFiscalesSeries}
              pFacturacion={pFacturacion} />
          </Bloque>

          {/* ── Lo acreditable que tus liquidaciones ya certificaron ──
              Sale de `liquidacion.*_acreditable` (getAcreditables): son
              las MISMAS cifras que cada PDF imprimió al cerrar, sumadas
              al ejercicio — no un recálculo. El desglose de más abajo sí
              recalcula sobre comprobantes, y por eso cada bloque dice de
              dónde sale: dos números parecidos sin su fuente se leen
              como dos cálculos. */}
          <div className="mt-2">
            <Bloque mensaje="No se pudo cargar lo acreditable de tus liquidaciones."
              esqueleto={<EsqCifras n={4} rejilla="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2" />}>
              <BloqueAcreditables pAcred={pAcred} pResumenPerdidas={pResumenPerdidas} periodoFiscal={periodoFiscal} />
            </Bloque>
          </div>

          {/* ── Motor fiscal — las mismas piezas que el Resumen del
              dueño, porque el motor ES la pantalla del contador. */}
          <div className="mt-2">
            <Bloque mensaje="No se pudo cargar el motor fiscal." esqueleto={<EsqMotorFiscal />}>
              <BloqueFiscal pResumenPerdidas={pResumenPerdidas} pResumenPerdidasSeries={pResumenPerdidasSeries}
                periodoFiscal={periodoFiscal} />
            </Bloque>
          </div>

          {/* ── El gasto del ejercicio, por su suerte fiscal
              (`resumirFiscal`). Las cubetas deducible/no deducible/por
              confirmar del motor son POR LIQUIDACIÓN y no se persisten
              agregadas (recalcularlas aquí sería otra copia de la lógica
              del dinero — ver `reconstruir` en analytics.ts), así que lo
              que se afirma es lo que las columnas sí sostienen: el IVA
              documentado, en sus dos cubetas que SUMAN todo el IVA
              desglosado, y el estado de cada CFDI ante el SAT. */}
          <div className="mt-2">
            <Bloque mensaje="No se pudo leer el desglose fiscal." esqueleto={<EsqDesgloseFiscal />}>
              <BloqueDesglose pResumenFiscal={pResumenFiscal} periodoFiscal={periodoFiscal} />
            </Bloque>
          </div>

          {/* ── Sus pantallas: solo rutas de área `dinero`, del mismo
              mapa que las gatea. Todos los links cargan el sufijo. Cero
              consultas: entra con el primer flush. */}
          <div className="card p-3 mt-2">
            <TituloSeccion>Tus pantallas</TituloSeccion>
            <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-1.5">
              {pantallas.map((it) => (
                <Link key={it.href} href={`${it.href}${sufijo}`}
                  className="hairline rounded-lg px-3 py-2 flex items-center gap-2 text-[13px] transition-colors hover:bg-[var(--canvas)]"
                  style={{ background: 'var(--surface)' }}>
                  <it.Icono width={15} height={15} strokeWidth={1.75} style={{ color: 'var(--muted)' }} />
                  <span className="truncate">{it.nombre}</span>
                </Link>
              ))}
            </div>
          </div>

          <p className="text-[11px] pt-3" style={{ color: 'var(--faint)' }}>{LEYENDA_CORTA}</p>
        </div>
      </div>
    </main>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LOS BLOQUES (FE-14). Cada uno espera SOLO sus promesas: por eso el de al
// lado no lo espera.
// ═══════════════════════════════════════════════════════════════════════════

async function BloqueAlertas({ pKpis, pAnomalias, pHuerfanos, pFacturacion, sufijo }: {
  pKpis: Promise<DashboardKpis | null>;
  pAnomalias: Promise<Anomalia[] | null>;
  pHuerfanos: Promise<number | null>;
  pFacturacion: Promise<FacturacionClientes | null>;
  sufijo: string;
}) {
  const [kpis, anomalias, huerfanosPendientes, facturacion] =
    await Promise.all([pKpis, pAnomalias, pHuerfanos, pFacturacion]);

  // Las alertas accionables: cada una lleva a LA pantalla donde se resuelve,
  // con el sufijo del superadmin a cuestas, y SOLO si la cifra es mayor a
  // cero — una banda que siempre dice algo entrena a ignorarla.
  const alertas: Array<{ texto: string; href: string }> = [];
  if (kpis && kpis.porRevisar > 0) {
    alertas.push({
      texto: `${kpis.porRevisar} liquidación${kpis.porRevisar === 1 ? ' espera' : 'es esperan'} tu revisión`,
      href: `/dashboard/agentes/liquidacion${sufijo}`,
    });
  }
  if (anomalias && anomalias.length > 0) {
    alertas.push({
      texto: `${anomalias.length} comprobante${anomalias.length === 1 ? '' : 's'} repetido${anomalias.length === 1 ? '' : 's'} entre viajes distintos`,
      href: `/dashboard/agentes/liquidacion${sufijo}`,
    });
  }
  if (huerfanosPendientes !== null && huerfanosPendientes !== undefined && huerfanosPendientes > 0) {
    alertas.push({
      texto: `${huerfanosPendientes} comprobante${huerfanosPendientes === 1 ? ' sin viaje espera que alguien lo acomode' : 's sin viaje esperan que alguien los acomode'}`,
      href: `/dashboard/huerfanos${sufijo}`,
    });
  }
  if (facturacion) {
    // "Emitida sin pago" = viva Y con saldo arriba del centavo de tolerancia
    // — el MISMO criterio que la vista `factura_saldo` (0049) y que la
    // pantalla de Facturación, para que el clic aterrice en la misma cuenta.
    const sinPago = facturacion.cartera.facturas.filter((f) => f.viva && f.conSaldo).length;
    if (sinPago > 0) {
      alertas.push({
        texto: `${sinPago} factura${sinPago === 1 ? '' : 's'} emitida${sinPago === 1 ? '' : 's'} sin cobrar por completo — ${mxn(facturacion.cartera.porCobrar)} por cobrar${facturacion.cartera.vencido > 0 ? ` (${mxn(facturacion.cartera.vencido)} ya vencido)` : ''}`,
        href: `/dashboard/facturacion${sufijo}`,
      });
    }
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

async function AvisoEstado({
  pAcred, pKpis, pAnomalias, pCfgFiscal, pGastosFiscales, pGastosFiscalesSeries, pFacturacion,
}: {
  pAcred: Promise<Acreditables | null>;
  pKpis: Promise<DashboardKpis | null>;
  pAnomalias: Promise<Anomalia[] | null>;
  pCfgFiscal: Promise<LikidaConfig | null>;
  pGastosFiscales: Promise<GastoFiscal[] | null>;
  pGastosFiscalesSeries: Promise<GastosFiscalesSeries | null>;
  pFacturacion: Promise<FacturacionClientes | null>;
}) {
  // La MISMA regla que `estadoPanel` (estado.ts), sobre las secciones de ESTA
  // pantalla: "no hay nada" es una afirmación sobre el negocio y solo se hace
  // cuando TODO cargó. No se reusa la función porque su forma pide viajes y
  // liquidaciones, que aquí no se consultan — la regla sí se copia entera:
  // todo caído es error, algo caído se enseña CON aviso.
  const secciones = await Promise.all([
    pAcred, pKpis, pAnomalias, pCfgFiscal, pGastosFiscales, pGastosFiscalesSeries, pFacturacion,
  ]);
  const caidas = secciones.filter((s) => s === null).length;
  if (caidas === 0) return null;

  if (caidas === secciones.length) {
    return (
      <div className="card p-6 mt-3" style={{ borderColor: 'var(--bad)' }}>
        <p className="text-sm font-semibold tracking-tight m-0">No se pudieron cargar los datos</p>
        <p className="mt-1.5 text-sm m-0" style={{ color: 'var(--muted)' }}>
          Hubo un problema al leer del sistema. Recarga la página en un momento — esto NO significa
          que no haya nada acreditable, significa que no se pudo leer.
        </p>
      </div>
    );
  }
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

async function BloqueAcreditables({ pAcred, pResumenPerdidas, periodoFiscal }: {
  pAcred: Promise<Acreditables | null>;
  pResumenPerdidas: Promise<ResumenPerdidas | null>;
  periodoFiscal: Periodo;
}) {
  const [acred, resumenPerdidas] = await Promise.all([pAcred, pResumenPerdidas]);
  if (acred === null) {
    return (
      <p className="text-sm" style={{ color: 'var(--muted)' }}>
        No se pudo cargar lo acreditable de tus liquidaciones.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2">
      <StatCard icono={<Landmark width={15} height={15} strokeWidth={1.75} />}
        etiqueta={`IVA acreditable de tus liquidaciones — ${periodoFiscal.etiqueta}`}
        valor={acred.iva} formato="mxn"
        nota="LIVA art. 5 — lo que el motor certificó al cerrar cada liquidación" />
      {/* La condición va en el rótulo, no solo en la nota — el
          criterio de `liquidacion/acreditable.ts`: "Estímulo de
          peaje 50%" a secas se lee como un derecho ya ganado. */}
      <StatCard icono={<RouteIcon width={15} height={15} strokeWidth={1.75} />}
        etiqueta={`Estímulo de peaje 50% — ${periodoFiscal.etiqueta} · sujeto a elegibilidad`}
        valor={acred.peaje} formato="mxn"
        nota="LIF 2026 art. 20, ap. A — base: subtotal SIN IVA de casetas con CFDI" />
      {resumenPerdidas ? (
        <StatCard icono={<ReceiptText width={15} height={15} strokeWidth={1.75} />}
          etiqueta={`Recuperable pidiendo factura — ${periodoFiscal.etiqueta}`}
          valor={resumenPerdidas.montoRecuperable} formato="mxn"
          nota="Gasto cuya factura aún se puede pedir — el motor dice a quién, abajo" />
      ) : (
        <div className="card p-3 h-full flex items-center text-sm" style={{ color: 'var(--muted)' }}>
          No se pudo calcular lo recuperable en este momento.
        </div>
      )}
      {/* En LITROS, nunca en pesos — regla de producto: el
          estímulo es cuota DOF (semanal) × litros, y la cuota no
          vive aquí (decisión D2; `guion_demo.test.ts` la ata). */}
      <StatCard icono={<Fuel width={15} height={15} strokeWidth={1.75} />}
        etiqueta="Diésel elegible para el estímulo"
        valor={acred.litrosDiesel} formato="litros"
        nota="LIF 2026, art. 20-A: cuota semanal del DOF × litros — tu contador aplica la cuota fechada" />
    </div>
  );
}

/** El mismo bulto que el motor fiscal: rótulo, la fila de tarjetas del
 *  periodo y el cuerpo del desglose de causas. */
function EsqMotorFiscal() {
  return (
    <div className="card p-3" role="status" aria-label="Cargando">
      <Barra alto={13} ancho="38%" />
      <div className="mt-2 flex flex-wrap gap-2 items-stretch">
        <div className="flex-1 min-w-[200px]"><Barra alto={100} className="rounded-xl" /></div>
        <div className="flex-1 min-w-[200px]"><Barra alto={100} className="rounded-xl" /></div>
      </div>
      <div className="mt-2"><Barra alto={150} className="rounded-xl" /></div>
    </div>
  );
}

async function BloqueFiscal({ pResumenPerdidas, pResumenPerdidasSeries, periodoFiscal }: {
  pResumenPerdidas: Promise<ResumenPerdidas | null>;
  pResumenPerdidasSeries: Promise<Record<'semanal' | 'mensual' | 'historico', ResumenPerdidas> | null>;
  periodoFiscal: Periodo;
}) {
  const [resumenPerdidas, resumenPerdidasSeries] = await Promise.all([pResumenPerdidas, pResumenPerdidasSeries]);
  return (
    <div className="card p-3">
      <TituloSeccion>Tu motor fiscal — {periodoFiscal.etiqueta}</TituloSeccion>
      <div className="mt-2 flex flex-wrap gap-2 items-stretch">
        <MotorFiscalPeriodo series={resumenPerdidasSeries} />
      </div>
      <div className="mt-2">
        <MotorFiscal resumen={resumenPerdidas} />
      </div>
    </div>
  );
}

/** Rótulo + las tres cifras del desglose + la línea del estado ante el SAT. */
function EsqDesgloseFiscal() {
  return (
    <div className="card p-3" role="status" aria-label="Cargando">
      <Barra alto={13} ancho="55%" />
      <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Barra key={i} alto={100} className="rounded-xl" />
        ))}
      </div>
      <div className="mt-2"><Barra alto={12} ancho="80%" /></div>
    </div>
  );
}

async function BloqueDesglose({ pResumenFiscal, periodoFiscal }: {
  pResumenFiscal: Promise<ResumenFiscal | null>;
  periodoFiscal: Periodo;
}) {
  const resumenFiscal = await pResumenFiscal;
  return (
    <div className="card p-3">
      <TituloSeccion>El gasto del periodo, por su suerte fiscal — {periodoFiscal.etiqueta}</TituloSeccion>
      {resumenFiscal === null ? (
        <p className="text-sm mt-2" style={{ color: 'var(--muted)' }}>
          No se pudo leer el desglose fiscal en este momento.
        </p>
      ) : resumenFiscal.n === 0 ? (
        <div className="mt-2">
          <EstadoVacio icono={<FileSearch width={17} height={17} strokeWidth={1.75} style={{ color: 'var(--marca)' }} />}>
            Todavía no hay comprobantes leídos en este ejercicio. En cuanto los operadores manden
            los primeros por WhatsApp, aquí se ve cuánto del gasto sostiene su IVA y cuánto no.
          </EstadoVacio>
        </div>
      ) : (
        <>
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
            <StatCard icono={<Wallet width={15} height={15} strokeWidth={1.75} />}
              etiqueta="Gasto comprobado leído" valor={resumenFiscal.gastoTotal} formato="mxn"
              nota={`${resumenFiscal.n} comprobante${resumenFiscal.n === 1 ? '' : 's'} · ${resumenFiscal.conCfdi} con CFDI, ${resumenFiscal.sinCfdi} sin CFDI`} />
            <StatCard icono={<Landmark width={15} height={15} strokeWidth={1.75} />}
              etiqueta="IVA acreditable documentado" valor={resumenFiscal.ivaAcreditable} formato="mxn"
              nota={resumenFiscal.combustible15SujetoADeriva
                // RE-AUDITORÍA 25, FIS-REAUD-3 (ALTO): incluye combustible en
                // efectivo prorrateado al 15% con el acumulado del ejercicio
                // A HOY — un PDF ya firmado fijó su reparto contra el
                // acumulado que tenía al cerrar, así que esta cifra puede no
                // coincidir con liquidaciones antiguas. La cifra que SÍ
                // coincide con cada PDF es "IVA acreditable de tus
                // liquidaciones", arriba.
                ? 'LIVA art. 5 — incluye combustible en efectivo al 15% del acumulado de HOY: puede diferir de lo firmado en PDFs viejos (ver "de tus liquidaciones", arriba)'
                : 'LIVA art. 5 — solo el IVA desglosado en CFDI que lo sostiene'} />
            <StatCard icono={<FileX2 width={15} height={15} strokeWidth={1.75} />}
              etiqueta="IVA desglosado que NO se acredita" valor={resumenFiscal.ivaNoAcreditable} formato="mxn"
              nota="Las dos cubetas suman todo el IVA desglosado del periodo — crúzalo con calculadora" />
          </div>
          <p className="text-xs mt-2" style={{ color: 'var(--muted)' }}>
            Estado ante el SAT de los {resumenFiscal.conCfdi} CFDI: {resumenFiscal.vigentes} vigente{resumenFiscal.vigentes === 1 ? '' : 's'} · {resumenFiscal.porValidar} por validar · {resumenFiscal.cancelados} cancelado{resumenFiscal.cancelados === 1 ? '' : 's'}.
            {/* "Por validar" no es "inválido": es "no comprobado" —
                la distinción viene del propio tipo ResumenFiscal. */}
            {resumenFiscal.conCfdiSinDesglose > 0 && (
              ` ${resumenFiscal.conCfdiSinDesglose} traen CFDI pero sin desglose de IVA leído — su IVA existe en el papel y aquí no se afirma.`
            )}
          </p>
        </>
      )}
    </div>
  );
}
