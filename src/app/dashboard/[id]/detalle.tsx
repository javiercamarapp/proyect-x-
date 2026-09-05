import Link from 'next/link';
import { ChevronRight, Download, MessageCircle, RotateCcw, Truck } from 'lucide-react';
import type { LiquidacionDetalle } from '@/lib/likida/analytics';
import type { ResumenLaboral } from '@/lib/likida/laboral/pagadero';
import { filasDeducibilidad } from '@/lib/likida/liquidacion/deducibilidad';
import { LEYENDA_CORTA } from '@/lib/likida/cuadre/leyendas';
import { mxn, litros, fechaMx, fechaCorta } from '@/lib/formato';
import { StatusPill, type Estado } from '@/app/admin/ui/kit';
import { FormaConAviso, type ResultadoAccion } from '@/app/admin/ui/forma';
import { BarraPagina } from '../resumen-visual';
import type { BuscarCatalogo } from '../combo-catalogo';
import { PanelRevision, type GastoAjustable } from './revision-panel';
import { FormaReasignar } from './reasignar-forma';
import type { RevisionDetalle } from '@/lib/likida/revision';
import {
  BTN_PRIMARIO, BTN_SECUNDARIO, ESTILO_PRIMARIO, ESTILO_SECUNDARIO,
  Kpi, Dato, Rotulo, LineaDeTiempo, Diferencia, PillRenglon, TH,
  estadoRenglon, etiquetaFormaPago, TIPOS_TOPE, type Hito,
} from './vista';

// ═══════════════════════════════════════════════════════════════════════════
// EL DETALLE DE LIQUIDACIÓN, EN PANTALLA (v2, 22-ago-2026).
//
// Pura props: la sesión, el tenant, los permisos y las acciones las decide
// `page.tsx`; aquí se pinta. Así se puede mirar con fixtures bajo un preview
// temporal (CLAUDE.md §Cómo se verifica) sin montar un login — y lo que se
// mira es el componente REAL, no una copia.
// ═══════════════════════════════════════════════════════════════════════════

export interface PropsDetalle {
  d: LiquidacionDetalle;
  /** `?tenant=`/`?vista=`/`?rol=` para los links de vuelta (sufijo.ts). */
  sufijo: string;
  /** Estatus de la liquidación ya resuelto por `dashboard/estatus.ts`. */
  estatus: { label: string; estado: Estado };
  /** La etiqueta del renglón (la del motor, igual que el PDF) — vive en la
   *  página porque `etiquetas_panel.test.ts` la vigila ahí. */
  etiqueta: (g: { concepto: string; ocrExtra?: Record<string, unknown> }) => string;
  /** `/api/export/pdf/<id>` si hay PDF y el rol puede exportar; si no, null. */
  pdfHref: string | null;
  reintentarPdf?: ((previo: ResultadoAccion, fd: FormData) => Promise<ResultadoAccion>) | null;
  /** `https://wa.me/…` del operador, o null si no hay teléfono. */
  wa: string | null;
  /** El formulario de reasignar, solo si el rol puede asignar. FE-2: ya no
   *  trae el catálogo de choferes (a 7,500, PostgREST lo recortaba a 1,000 en
   *  silencio) sino el buscador del servidor y el conteo real. */
  reasignar: {
    buscar: BuscarCatalogo;
    /** Cuántos choferes activos hay; `null` = no se pudo contar. */
    total: number | null;
    actual: string;
    /** El nombre del chofer ACTUAL — viene con el detalle, así que el control
     *  arranca lleno sin pedirle nada al catálogo. */
    actualNombre: string;
    /** FE-11: devuelve el rechazo en vez de lanzarlo — un chofer dado de baja
     *  no puede tumbar la pantalla entera por `error.tsx`. */
    accion: (previo: ResultadoAccion, fd: FormData) => Promise<ResultadoAccion>;
  } | null;
  /** La acción de reabrir, solo si el rol administra. */
  reabrir: ((previo: ResultadoAccion, fd: FormData) => Promise<ResultadoAccion>) | null;
  /** La firma humana (BLOQ-6, mig. 0299). `null` = no se pudo leer el estado
   *  de la revisión; entonces NO se pinta el panel, porque unos botones sin
   *  saber si la liquidación ya está firmada invitan a firmarla dos veces. */
  revision: {
    estado: RevisionDetalle;
    gastos: GastoAjustable[];
    /** `null` = el rol ve la firma pero no la pone. */
    accion: ((previo: ResultadoAccion, fd: FormData) => Promise<ResultadoAccion>) | null;
  } | null;
}

export function DetalleLiquidacion({ d, sufijo, estatus, etiqueta, pdfHref, reintentarPdf, wa, reasignar, reabrir, revision }: PropsDetalle) {
  // LA FOTO DEL TICKET SE GUARDA (CFF art. 30, conservación 5 años) PERO NO SE
  // ENSEÑA AQUÍ. El aviso de privacidad (privacidad.ts:498) le promete al
  // operador que un dato sensible que aparezca por accidente en su ticket "no
  // se usa para nada" — pero ni `subirComprobante` ni nada en este flujo filtra
  // contenido sensible de la IMAGEN (solo del texto que el OCR extrae de ella,
  // ver sanitizar.ts). Enseñarla en un clic desde el panel del contralor sí es
  // "usarla": convertía la promesa en falsa. AUDITORÍA 9, CRÍTICO legal. Por
  // eso la tabla de abajo dice "Foto archivada" y NO pinta miniatura ni link.
  const hayAcred = d.litrosDiesel > 0 || d.ieps > 0 || d.iva > 0 || d.peaje > 0;
  // Las tres cubetas SIEMPRE suman totalComprobado (types/likida.ts). Se le
  // pasa el total PERSISTIDO junto a las cubetas RECONSTRUIDAS a propósito: si
  // los dos no cuadran, `filasDeducibilidad` devuelve null y no se pinta nada.
  // Un desglose que contradice al total que tiene tres centímetros arriba es
  // peor que no tener desglose.
  const deducibilidad = d.deducibilidad
    ? filasDeducibilidad({ ...d.deducibilidad, totalComprobado: d.totalComprobado, diferencias: d.diferencias })
    : null;

  // ── Las diferencias, por comprobante ──
  // El motor cuelga cada diferencia de su `gastoId`; de ahí salen el estado
  // de cada renglón y los dos KPIs "Sin CFDI" / "Sobre tope". Un KPI se
  // calcula SOLO con lo que se puede cruzar: si una diferencia vieja no trae
  // `gastoId`, su monto no se conoce y la cifra se deja en guion con la nota.
  const tiposPorGasto = new Map<string, string[]>();
  for (const df of d.diferencias) {
    if (!df.gastoId) continue;
    tiposPorGasto.set(df.gastoId, [...(tiposPorGasto.get(df.gastoId) ?? []), df.tipo]);
  }
  const montoPorGasto = new Map(d.gastos.filter((g) => g.id).map((g) => [g.id as string, g.monto]));
  const difsSinCfdi = d.diferencias.filter((df) => df.tipo === 'sin_cfdi');
  const idsSinCfdi = new Set(difsSinCfdi.map((df) => df.gastoId).filter((x): x is string => !!x));
  const sinCfdiCruzable = difsSinCfdi.every((df) => df.gastoId && montoPorGasto.has(df.gastoId));
  const montoSinCfdi = [...idsSinCfdi].reduce((s, gid) => s + (montoPorGasto.get(gid) ?? 0), 0);
  const difsTope = d.diferencias.filter((df) => TIPOS_TOPE.has(df.tipo));
  const excedenteTope = difsTope.reduce((s, df) => s + (df.monto > 0 ? df.monto : 0), 0);
  const comprobantes = (n: number) => (n === 1 ? '1 comprobante' : `${n} comprobantes`);

  const hitos: Hito[] = [
    { etiqueta: 'Viaje avisado al chofer', cuando: d.viaje.avisadoEn, pendiente: 'Sin aviso registrado' },
    { etiqueta: 'Chofer aceptó', cuando: d.viaje.aceptadoEn, pendiente: 'Sin confirmación registrada' },
    ...(d.viaje.llegadaEn ? [{ etiqueta: 'Llegó a destino', cuando: d.viaje.llegadaEn }] : []),
    ...(d.viaje.descargaEn ? [{ etiqueta: 'Descargando', cuando: d.viaje.descargaEn }] : []),
    ...(d.viaje.regresoEn ? [{ etiqueta: 'De regreso', cuando: d.viaje.regresoEn }] : []),
    {
      etiqueta: 'Comprobantes por WhatsApp',
      cuando: d.comprobantesEntre.ultimo,
      pendiente: 'Ninguno recibido',
      nota: d.comprobantesEntre.n > 0
        ? `${comprobantes(d.comprobantesEntre.n)}${d.comprobantesEntre.n > 1 && d.comprobantesEntre.primero ? `, el primero ${fechaCorta(d.comprobantesEntre.primero)}` : ''}`
        : undefined,
    },
    { etiqueta: 'Cuadre del motor', cuando: d.creadoEn },
    d.pdfPath
      ? { etiqueta: 'PDF de liquidación', cuando: null, textoSinHora: 'Disponible para descargar' }
      : { etiqueta: 'PDF de liquidación', cuando: null, pendiente: 'Sin generar' },
  ];

  const ruta = d.viaje.origen && d.viaje.destino
    ? `${d.viaje.origen} → ${d.viaje.destino}`
    : d.viaje.origen ?? d.viaje.destino ?? null;
  const sumaRenglones = d.gastos.reduce((s, g) => s + g.monto, 0);

  return (
    <main className="h-full">
      <div className="rounded-2xl min-h-full hairline flex flex-col" style={{ background: 'var(--g1)' }}>
        <BarraPagina
          icono={<Truck width={15} height={15} strokeWidth={1.75} style={{ color: 'var(--muted)' }} />}
          titulo={
            <nav aria-label="Ruta de navegación" className="flex items-center gap-1.5 min-w-0">
              <Link href={`/dashboard/viajes${sufijo}`} className="hover:opacity-70 transition-opacity" style={{ color: 'var(--muted)' }}>Viajes</Link>
              <ChevronRight width={13} height={13} strokeWidth={1.75} style={{ color: 'var(--faint)' }} aria-hidden />
              <span className="truncate">{d.folio}</span>
            </nav>
          }
          derecha={
            <div className="flex items-center gap-2 flex-wrap justify-end">
              {wa && (
                <a href={wa} target="_blank" rel="noopener noreferrer" className={BTN_SECUNDARIO} style={ESTILO_SECUNDARIO}>
                  <MessageCircle width={13} height={13} strokeWidth={1.75} aria-hidden /> Ver WhatsApp
                </a>
              )}
              {/* El PDF existía, estaba autenticado y no había forma de llegar a
                  él: `pdf_url` ni se seleccionaba (auditoría 5, frontend, MEDIO 5). */}
              {pdfHref && (
                <a href={pdfHref} className={BTN_PRIMARIO} style={ESTILO_PRIMARIO}>
                  <Download width={13} height={13} strokeWidth={1.75} aria-hidden /> Descargar PDF
                </a>
              )}
            </div>
          }
        />

        <div className="px-5 py-5 flex-1 space-y-4">
          {reintentarPdf && (
            <section className="card p-4" aria-label="PDF pendiente">
              <p>El ajuste y la firma están guardados. Falta generar los dos ejemplares del PDF.</p>
              <FormaConAviso accion={reintentarPdf} boton="Reintentar PDF" columnas="md:grid-cols-1"><span>Reintentar no cambia tu firma ni las cifras.</span></FormaConAviso>
            </section>
          )}
          {/* ── Cabecera: folio, estatus y la ficha del viaje ── */}
          <section className="card p-4">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h1 className="font-display text-[24px] font-semibold leading-tight tabular">{d.folio}</h1>
                  <StatusPill estado={estatus.estado}>{estatus.label}</StatusPill>
                </div>
                {/* Hora de México, no UTC: `.slice(0,10)` fechaba en agosto una
                    liquidación cerrada el 31 de julio a las 20:00 (ver formato.ts). */}
                <p className="text-[12.5px] mt-1" style={{ color: 'var(--muted)' }}>
                  Liquidación cerrada el {fechaMx(d.creadoEn)}
                </p>
              </div>

              {/* ── Chofer asignado / reasignar ──
                  Solo dueño/encargado (permisos.ts: puedeAsignar) — un contador o un
                  superadmin de paso por el tenant demo no mueve viajes de chofer. */}
              {reasignar && (
                <FormaReasignar accion={reasignar.accion} buscar={reasignar.buscar}
                  actual={reasignar.actual} actualNombre={reasignar.actualNombre} total={reasignar.total} />
              )}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-7 gap-x-4 gap-y-3 mt-4 pt-3.5" style={{ borderTop: '1px dashed var(--line2)' }}>
              <Dato titulo="Inicio del viaje">{d.viaje.fechaInicio ? fechaMx(d.viaje.fechaInicio) : '—'}</Dato>
              <Dato titulo="Ruta" ancho>{ruta ?? <span style={{ color: 'var(--faint)' }}>Sin ruta capturada</span>}</Dato>
              <Dato titulo="Operador">{d.operadorNombre}</Dato>
              <Dato titulo="Unidad">
                {d.viaje.unidadEco
                  ? <>{d.viaje.unidadEco}{d.viaje.unidadPlacas && <span style={{ color: 'var(--muted)' }}> · {d.viaje.unidadPlacas}</span>}</>
                  : <span style={{ color: 'var(--faint)' }}>Sin unidad</span>}
              </Dato>
              <Dato titulo="Cliente">{d.viaje.clienteNombre ?? <span style={{ color: 'var(--faint)' }}>Sin cliente</span>}</Dato>
              <Dato titulo="Comprobantes">{d.comprobantesEntre.n > 0 ? comprobantes(d.comprobantesEntre.n) : '—'}</Dato>
            </div>
          </section>

          {/* ── KPIs ── */}
          <div className="grid grid-cols-2 min-[1100px]:grid-cols-5 gap-3">
            <Kpi titulo="Anticipo" valor={mxn(d.totalAnticipo)} nota="entregado al operador" />
            <Kpi titulo="Comprobado" valor={mxn(d.totalComprobado)}
              nota={d.comprobantesCuadran ? `${comprobantes(d.gastos.length)} válidos` : 'total persistido al cierre'} />
            <Kpi
              titulo="Diferencia"
              valor={d.diferencia === 0 ? 'Cuadra exacto' : mxn(Math.abs(d.diferencia))}
              tono={d.diferencia === 0 ? 'ok' : d.diferencia > 0 ? 'warn' : 'bad'}
              nota={d.diferencia === 0 ? 'anticipo = comprobado' : d.diferencia > 0 ? 'sobrante · a favor de la empresa' : 'faltante · a favor del operador'}
            />
            <Kpi
              titulo="Sin CFDI"
              valor={difsSinCfdi.length === 0 ? mxn(0) : sinCfdiCruzable ? mxn(montoSinCfdi) : '—'}
              tono={difsSinCfdi.length > 0 ? 'warn' : undefined}
              nota={difsSinCfdi.length === 0 ? 'todo lo que lo requería trae factura' : sinCfdiCruzable ? `${comprobantes(idsSinCfdi.size)} sin factura` : `${comprobantes(difsSinCfdi.length)} — monto no cruzable`}
            />
            <Kpi
              titulo="Sobre tope"
              valor={mxn(excedenteTope)}
              tono={difsTope.length > 0 ? 'warn' : undefined}
              nota={difsTope.length === 0 ? 'nada excede política ni tope fiscal' : `excedente en ${comprobantes(difsTope.length)}`}
            />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <div className="xl:col-span-2 space-y-4">
              {/* ── Acreditable / recuperable ──
                  Litros, no pesos: el estímulo del LIF 20-A es cuota semanal del DOF
                  × litros y esa cuota no la tenemos. `ieps` solo puede venir de filas
                  viejas escritas antes del cambio; se conserva para no ocultarlas. */}
              <section className="card p-4">
                <h2 className="font-display text-[15px] font-semibold mb-2">Acreditable / recuperable</h2>
                <div className="overflow-x-auto -mx-1">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr style={{ background: 'var(--canvas)' }}>
                        <th className={`${TH} rounded-l-lg`} style={{ color: 'var(--muted)' }}>Diésel elegible</th>
                        <th className={TH} style={{ color: 'var(--muted)' }}>IEPS de diésel</th>
                        <th className={TH} style={{ color: 'var(--muted)' }}>IVA acreditable</th>
                        <th className={`${TH} rounded-r-lg`} style={{ color: 'var(--muted)' }}>Peaje 50 %</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <Celda vacio={d.litrosDiesel <= 0}>{d.litrosDiesel > 0 ? litros(d.litrosDiesel) : '—'}</Celda>
                        <Celda vacio={d.ieps <= 0}>{d.ieps > 0 ? mxn(d.ieps) : '—'}</Celda>
                        <Celda vacio={d.iva <= 0}>{d.iva > 0 ? mxn(d.iva) : '—'}</Celda>
                        <Celda vacio={d.peaje <= 0}>{d.peaje > 0 ? mxn(d.peaje) : '—'}</Celda>
                      </tr>
                    </tbody>
                  </table>
                </div>
                {/* AUDITORÍA 12, ALTO (fiscal): el peaje acreditable no es automático —
                    el motor no verifica ninguna de las condiciones de la ficha (ingresos
                    < $300M, autopistas de cuota). El PDF ya lo decía; el panel no. */}
                <p className="text-[11px] mt-2" style={{ color: 'var(--faint)' }}>
                  {hayAcred
                    ? 'Diésel en litros (LIF 20-A fr. IV, estímulo por cuota semanal del DOF). El peaje al 50 % está sujeto a elegibilidad: ingresos menores a $300 M y autopistas de cuota, que el motor no verifica. IVA e IEPS sólo de CFDI con desglose.'
                    : 'El motor no encontró conceptos acreditables en esta liquidación: sin CFDI de diésel con IEPS desglosado ni peaje con factura, no hay nada que recuperar.'}
                </p>

                {/* ── De lo comprobado, cuánto sobrevive al SAT ──
                    Este reparto es la razón por la que el contralor compra, y hasta hoy
                    solo existía en el PDF (auditoría 5, frontend, ALTO 2). */}
                {deducibilidad && (
                  <div className="mt-3 pt-3" style={{ borderTop: '1px dashed var(--line2)' }}>
                    <Rotulo>De lo comprobado, cuánto es deducible</Rotulo>
                    <ul className="mt-1.5">
                      {deducibilidad.map((f, i) => (
                        <li key={f.label} className="flex items-start justify-between gap-4 py-2"
                          style={i < deducibilidad.length - 1 ? { borderBottom: '1px dashed var(--line2)' } : undefined}>
                          <div className="min-w-0">
                            <div className="text-[13px] font-medium">{f.label}</div>
                            {f.pie && <div className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>{f.pie}</div>}
                          </div>
                          <span className="cifra-mono text-[13px] font-medium whitespace-nowrap"
                            style={{ color: f.tono === 'malo' ? 'var(--bad)' : 'var(--ink)' }}>{mxn(f.monto)}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="text-[11px] mt-2" style={{ color: 'var(--faint)' }}>
                      Estimación con la información capturada; la determinación final es de su contador.
                    </p>
                  </div>
                )}

                {/* ── DEDUCIBLE ≠ PAGADERO (tableros al día, 28-ago-2026) ──
                    El mismo resumen que el PDF imprime desde el 1-ago, con las
                    MISMAS funciones (analytics lo calcula junto a las cubetas).
                    Hasta hoy el contralor decidía el neto EN ESTA PANTALLA
                    viendo solo la deducibilidad — y la advertencia de que «no
                    deducible» NO autoriza descontárselo al operador (LFT
                    110/111/263) solo aparecía en el PDF ya generado. La
                    decisión se toma aquí; la advertencia va aquí. */}
                {d.laboral && <SeccionLaboral laboral={d.laboral} />}
              </section>

              {/* ── Diferencias en lenguaje humano ── */}
              {d.diferencias.length > 0 && (
                <section className="card p-4">
                  <h2 className="font-display text-[15px] font-semibold mb-1">
                    Diferencias detectadas
                    <span className="cifra-mono text-[12px] font-normal ml-2" style={{ color: 'var(--muted)' }}>{d.diferencias.length}</span>
                  </h2>
                  <ul>
                    {d.diferencias.map((df, i) => <Diferencia key={i} nota={df.nota} monto={df.monto} />)}
                  </ul>
                </section>
              )}
            </div>

            {/* ── Línea de tiempo ── */}
            <section className="card p-4 xl:self-start">
              <h2 className="font-display text-[15px] font-semibold mb-3">Línea de tiempo</h2>
              <LineaDeTiempo hitos={hitos} />
              <p className="text-[11px] mt-3 pt-3" style={{ color: 'var(--faint)', borderTop: '1px dashed var(--line2)' }}>
                Horas de recepción por WhatsApp, en hora de México. Un hito sin sello no se estima.
              </p>
            </section>
          </div>

          {/* ── Comprobantes ──
              Los renglones son los mismos que imprime el PDF (duplicados y
              montos inválidos fuera) y el total va al pie, para que el
              contralor no tenga que sumar la columna con el dedo. */}
          <section className="card p-4">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
              <h2 className="font-display text-[15px] font-semibold">Comprobantes</h2>
              {d.comprobantesExcluidos > 0 && (
                <span className="text-[11.5px]" style={{ color: 'var(--muted)' }}>
                  {d.comprobantesExcluidos === 1
                    ? '1 comprobante excluido del total (duplicado o monto inválido); está explicado en las diferencias.'
                    : `${d.comprobantesExcluidos} comprobantes excluidos del total (duplicados o montos inválidos); están explicados en las diferencias.`}
                </span>
              )}
            </div>
            {d.gastos.length === 0 ? (
              // Pasa de verdad: en el tenant del demo hay liquidaciones con total
              // guardado y cero filas en `gasto`. Una tabla con encabezados y nada
              // debajo se lee como "se perdieron los comprobantes"; esto dice qué
              // pasó y a dónde ir.
              <p className="text-[13px] py-6 text-center" style={{ color: 'var(--muted)' }}>
                Esta liquidación se cerró con un total de {mxn(d.totalComprobado)}, pero no hay comprobantes
                individuales registrados — los renglones viven en el PDF.
              </p>
            ) : (
              <div className="overflow-x-auto -mx-1">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr style={{ background: 'var(--canvas)' }}>
                      <th scope="col" className={`${TH} rounded-l-lg`} style={{ color: 'var(--muted)' }}>Concepto</th>
                      <th scope="col" className={TH} style={{ color: 'var(--muted)' }}>Folio / CFDI</th>
                      <th scope="col" className={TH} style={{ color: 'var(--muted)' }}>Fecha</th>
                      <th scope="col" className={TH} style={{ color: 'var(--muted)' }}>Forma de pago</th>
                      <th scope="col" className={`${TH} text-right`} style={{ color: 'var(--muted)' }}>Monto</th>
                      <th scope="col" className={`${TH} rounded-r-lg`} style={{ color: 'var(--muted)' }}>Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.gastos.map((g, i) => {
                      const er = estadoRenglon(g, g.id ? (tiposPorGasto.get(g.id) ?? []) : []);
                      return (
                        <tr key={g.id ?? i} className="border-b transition-colors hover:bg-[var(--canvas)]" style={{ borderColor: 'var(--line2)' }}>
                          <td className="px-3 py-2.5 font-medium whitespace-nowrap">
                            {etiqueta(g)}
                            {g.imagenUrl && (
                              <span className="block text-[10.5px] font-normal" style={{ color: 'var(--faint)' }}>Foto archivada</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 min-w-0">
                            <span className="cifra-mono block" style={{ color: g.folio ? 'var(--ink)' : 'var(--faint)' }}>{g.folio ?? '—'}</span>
                            {g.cfdiUuid && (
                              <span className="cifra-mono block text-[10.5px] truncate max-w-[260px]" style={{ color: 'var(--faint)' }} title={g.cfdiUuid}>
                                {g.cfdiUuid}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: 'var(--muted)' }}>{g.fecha ? fechaMx(g.fecha) : '—'}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: g.formaPago ? 'var(--ink)' : 'var(--faint)' }}>{etiquetaFormaPago(g.formaPago)}</td>
                          <td className="px-3 py-2.5 text-right cifra-mono whitespace-nowrap">{mxn(g.monto)}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap"><PillRenglon e={er} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" colSpan={4} className="px-3 pt-3 pb-1 text-left text-[12.5px] font-medium">
                        {d.comprobantesCuadran ? 'Total comprobado' : 'Suma de los renglones'}
                        <span className="font-normal ml-2" style={{ color: 'var(--muted)' }}>{comprobantes(d.gastos.length)}</span>
                      </th>
                      <td className="px-3 pt-3 pb-1 text-right cifra-mono font-semibold whitespace-nowrap">
                        {mxn(d.comprobantesCuadran ? d.totalComprobado : sumaRenglones)}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
            {!d.comprobantesCuadran && d.gastos.length > 0 && (
              <p className="text-[11px] mt-2" style={{ color: 'var(--muted)' }}>
                Renglones tal como se capturaron: no se pudo reconstruir la liquidación, así que
                esta suma puede no coincidir con el comprobado de arriba ({mxn(d.totalComprobado)}).
              </p>
            )}
          </section>

          {/* La firma va ANTES de «reabrir»: es lo que se hace todos los
              días; reabrir es lo excepcional y destructivo. */}
          {revision && (
            <PanelRevision estado={revision.estado} gastos={revision.gastos}
              accion={revision.accion} folio={d.folio} />
          )}

          {reabrir && (
            <section className="card p-4">
              <div className="flex items-center gap-2 mb-1">
                <RotateCcw width={14} height={14} strokeWidth={1.75} aria-hidden />
                <h2 className="font-display text-[15px] font-semibold m-0">Reabrir este viaje</h2>
              </div>
              <p className="text-[12px] mb-3" style={{ color: 'var(--muted)' }}>
                Vuelve a aceptar comprobantes por WhatsApp. <strong>Borra la liquidación actual y su PDF</strong> — si
                ya se lo entregaste al operador o a tu contador, ese papel dejará de cuadrar con lo que el sistema diga
                después. Se genera una nueva al cerrar otra vez.
              </p>
              <FormaConAviso accion={reabrir} boton="Reabrir viaje" columnas="md:grid-cols-1">
                <label className="flex items-start gap-2 text-[13px]">
                  <input type="checkbox" name="confirmar" className="w-4 h-4 mt-0.5" />
                  <span>Entiendo que se borra la liquidación {d.folio} y su PDF.</span>
                </label>
              </FormaConAviso>
            </section>
          )}

          <p className="text-[11px] pt-2" style={{ color: 'var(--faint)' }}>
            {LEYENDA_CORTA}
          </p>
        </div>
      </div>
    </main>
  );
}


/** DEDUCIBLE ≠ PAGADERO en pantalla — exportada para probarla sin montar el
 *  detalle entero. El texto es EL MISMO que imprime el PDF (`resumenLaboral`):
 *  dos redacciones de la misma obligación laboral serían dos opiniones
 *  legales, y este producto emite una. */
export function SeccionLaboral({ laboral }: { laboral: ResumenLaboral }) {
  return (
    <div className="mt-3 pt-3" style={{ borderTop: '1px dashed var(--line2)' }}>
      <Rotulo>Lo que se le reembolsa al operador</Rotulo>
      <div className="flex items-start justify-between gap-4 mt-1.5">
        <p className="text-[12.5px] min-w-0">{laboral.texto}</p>
        {laboral.montoPagadero > 0 && (
          <span className="cifra-mono text-[13px] font-medium whitespace-nowrap">{mxn(laboral.montoPagadero)}</span>
        )}
      </div>
      <p className="text-[11px] mt-2" style={{ color: 'var(--faint)' }}>
        Deducible y pagadero son veredictos distintos: que un gasto no sea deducible (ISR) no
        autoriza descontárselo al operador (LFT 110 y 111; hospedaje y alimentación por demora
        ajena, LFT 263-I). Es el mismo texto que imprime el PDF.
      </p>
    </div>
  );
}

function Celda({ children, vacio }: { children: React.ReactNode; vacio: boolean }) {
  return (
    <td className="px-3 py-2.5 cifra-mono text-[15px] font-medium whitespace-nowrap" style={vacio ? { color: 'var(--faint)' } : undefined}>
      {children}
    </td>
  );
}
