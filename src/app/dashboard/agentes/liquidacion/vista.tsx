import Link from 'next/link';
import { Route, ArrowRight, Bot, BellRing, Flag, Link2, Settings } from 'lucide-react';
import type { LiqRow, DashboardKpis, HechoSolo, DineroObservadoTipo } from '@/lib/likida/analytics';
import { etiquetaConcepto, type PoliticaGasto } from '@/lib/likida/cuadre/engine';
import { mxn, mxnCompacto, numero, fechaCorta } from '@/lib/formato';
import { EstadoVacio } from '@/app/admin/ui/kit';
import { CalendarHeatmap, HBars } from '@/app/admin/ui/graficas';
import { Dona } from '@/app/admin/charts';
import { BarraPagina } from '../../resumen-visual';
import { Bloque, Barra, EsqTabla } from '../../bloque';
import { SeccionCola, type ColaProps } from './cola';

// El rótulo de cada tipo de diferencia vive en `rotulo-diferencia.ts`, tipado
// contra `TipoDiferencia` completo (M10) — aquí había 3 renglones para ~35 tipos.
import { rotuloDiferencia as rotuloTipo } from './rotulo-diferencia';

/** Los conteos del ciclo. `porRevisar` sale de los KPIs; los otros tres, de
 *  `contarViajes`. Van juntos porque los pinta UNA sola tarjeta. */
export interface CicloLiquidacion {
  abiertos: number | null;
  enCuadre: number | null;
  porRevisar: number;
  liquidados: number | null;
}

/** Las cuatro fuentes de "Lo que hizo solo", en un solo paquete: la tarjeta
 *  aterriza completa y no a pedazos. */
export interface HizoSolo {
  hechos: HechoSolo[] | null;
  huerfanos: { resueltos: number; totales: number } | null;
  docsProcesados: number | null;
  /** Lecturas de IA del agente (sin chat). null = no se pudo leer. */
  actividadIa: number | null;
}

/**
 * FE-14: `extra` ya no es un paquete de VALORES sino de PROMESAS. La página
 * las lanza todas juntas y cada tarjeta espera SOLO la suya — pasar el valor
 * ya esperado volvería a serializar aquí lo que allá se paralelizó.
 */
export interface ExtraAgenteLiquidacion {
  /** ¿El rol puede abrir /dashboard/configuracion? (El contador no —
   *  esconder el link vale más que un clic que rebota.) No es una lectura:
   *  se resuelve con la sesión y viaja como valor. */
  puedeVerReglas: boolean;
  ciclo: Promise<CicloLiquidacion>;
  /** Cierres por día (últimas 12 semanas). null = no se pudo leer. */
  cierresPorDia: Promise<Array<{ fecha: string; valor: number }> | null>;
  hizoSolo: Promise<HizoSolo>;
  porTipo: Promise<DineroObservadoTipo[] | null>;
  /** Diferencias por operador, ya en forma de barras (top, solo >0). */
  operadores: Promise<Array<{ etiqueta: string; valor: number }> | null>;
  politica: Promise<PoliticaGasto[] | null>;
}

/**
 * El render del Agente de Liquidación de Ruta (v2, 13-ago-2026: "gráficas,
 * algo visual… estilo minimalista elegante premium como el dashboard
 * inicial"). Tres zonas: la firma del humano (cola), la evidencia de que el
 * agente trabaja (ciclo, calendario, lo-que-hizo-solo), y el criterio con el
 * que juzga (dinero observado, operadores, sus reglas).
 *
 * Cada sección degrada por su cuenta: un dato que no se pudo leer enseña su
 * leyenda honesta sin tumbar la página — y un cero MEDIDO sí se grafica. Y
 * desde FE-14 cada una además LLEGA por su cuenta: la barra de página sale
 * con el primer flush y las nueve tarjetas aterrizan conforme contestan sus
 * consultas, cada una con un esqueleto de su alto.
 */
export function VistaAgenteLiquidacion({
  kpis, liquidaciones, cola, extra, sufijo, notificaciones,
}: {
  /** Primario: falla CERRADO. Su bloque enseña `EstadoError` — nunca un
   *  "0 por revisar" que nadie midió. */
  kpis: Promise<DashboardKpis>;
  /** Las 50 liquidaciones más recientes — SOLO para «últimos cierres».
   *  La cola YA NO sale de aquí (FE-5): un recorte de 2.4 h escondía justo a
   *  las que más llevaban esperando firma. */
  liquidaciones: Promise<LiqRow[]>;
  /** La cola de revisión de verdad: su propia consulta, por antigüedad, por
   *  llave y con `count` real. Ver `cola.tsx`. */
  cola: ColaProps;
  extra: ExtraAgenteLiquidacion;
  sufijo: string;
  /** La sección de Notificaciones, ya renderizada en el servidor
   *  (`SeccionNotificaciones`). Entra como ReactNode y no como datos: esta
   *  vista no debe importar el motor de avisos, que trae `supabaseAdmin`. */
  notificaciones?: React.ReactNode;
}) {
  return (
    <main className="h-full">
      <div className="rounded-2xl min-h-full hairline flex flex-col" style={{ background: 'var(--g1)' }}>
        <BarraPagina
          icono={<Route width={15} height={15} strokeWidth={1.75} style={{ color: 'var(--muted)' }} />}
          titulo="Liquidación automática"
        />
        <div className="px-5 py-5 flex-1 space-y-4">

          <Bloque mensaje="No se pudieron leer los indicadores del agente."
            esqueleto={
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" role="status" aria-label="Cargando">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="card p-3.5">
                    <Barra alto={10} ancho="55%" />
                    <div className="mt-1.5"><Barra alto={20} ancho="70%" /></div>
                    <div className="mt-1"><Barra alto={11} ancho="40%" /></div>
                  </div>
                ))}
              </div>
            }>
            <BloqueKpis kpis={kpis} />
          </Bloque>

          <Bloque mensaje="No se pudo leer la cola de revisión." esqueleto={<EsqTabla filas={5} />}>
            <SeccionCola {...cola} />
          </Bloque>

          {/* ── La evidencia de que trabaja ── */}
          <div className="grid lg:grid-cols-3 gap-4">
            <Bloque mensaje="No se pudo contar el ciclo." esqueleto={<EsqSeccion alto={190} />}>
              <BloqueCiclo ciclo={extra.ciclo} />
            </Bloque>
            <Bloque mensaje="No se pudo leer la actividad." esqueleto={<EsqSeccion alto={190} />}>
              <BloqueCierres cierresPorDia={extra.cierresPorDia} />
            </Bloque>
            <Bloque mensaje="No se pudo leer el registro." esqueleto={<EsqSeccion alto={190} />}>
              <BloqueHizoSolo hizoSolo={extra.hizoSolo} />
            </Bloque>
          </div>

          {/* ── El criterio con el que juzga ── */}
          <div className="grid lg:grid-cols-3 gap-4">
            <Bloque mensaje="No se pudo leer el desglose." esqueleto={<EsqSeccion alto={230} />}>
              <BloqueDineroObservado porTipo={extra.porTipo} />
            </Bloque>
            <Bloque mensaje="No se pudo leer el desglose por operador." esqueleto={<EsqSeccion alto={230} />}>
              <BloqueOperadores operadores={extra.operadores} />
            </Bloque>
            <Bloque mensaje="No se pudo leer la política." esqueleto={<EsqSeccion alto={230} />}>
              <BloqueReglas politica={extra.politica} puedeVerReglas={extra.puedeVerReglas} sufijo={sufijo} />
            </Bloque>
          </div>

          <Bloque mensaje="No se pudieron leer los últimos cierres." esqueleto={<EsqTabla filas={5} />}>
            <BloqueUltimosCierres liquidaciones={liquidaciones} sufijo={sufijo} />
          </Bloque>

          {notificaciones}
        </div>
      </div>
    </main>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LOS BLOQUES. Cada uno espera SOLO su promesa.
// ═══════════════════════════════════════════════════════════════════════════

/** El hueco de una de las tarjetas de la rejilla de tres: rótulo, subrótulo
 *  y el cuerpo, del mismo alto que el contenido que va a caer ahí. */
function EsqSeccion({ alto }: { alto: number }) {
  return (
    <section className="card p-4" role="status" aria-label="Cargando">
      <Barra alto={15} ancho="45%" />
      <div className="mt-1.5"><Barra alto={11} ancho="60%" /></div>
      <div className="mt-3"><Barra alto={alto} className="rounded-xl" /></div>
    </section>
  );
}

async function BloqueKpis({ kpis: pKpis }: { kpis: Promise<DashboardKpis> }) {
  const kpis = await pKpis;
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {/* FE-17: es el acumulado HISTÓRICO — a escala 50k son miles de millones y
          `$9,000,000,000.00` no cabe en un cuarto de fila. `mxnCompacto`
          abrevia SOLO a partir del millón; debajo es `mxn()` exacto. */}
      <Kpi titulo="Monto comprobado" valor={mxnCompacto(kpis.montoComprobado)} nota="histórico" />
      <Kpi titulo="Tasa de cuadre" valor={`${numero(kpis.tasaCuadre)}%`} nota={`${numero(kpis.viajesLiquidados)} liquidaciones`} />
      {/* BLOQ-6: desde la 0299 hay DOS estados y este KPI es el del MOTOR
          («no pude cuadrarla»), no el de la firma. La cola de abajo cuenta lo
          que espera FIRMA —que incluye las de diferencias— y sale de su
          propia consulta: dos números distintos con su rótulo distinto, en vez
          de dos versiones del mismo. */}
      <Kpi titulo="Por revisar" valor={numero(kpis.porRevisar)} nota="el agente no pudo cuadrarlas"
        tono={kpis.porRevisar > 0 ? 'warn' : undefined} />
      <Kpi titulo="Con diferencias" valor={numero(kpis.conDiferencias)} tono={kpis.conDiferencias > 0 ? 'bad' : undefined} />
    </div>
  );
}

async function BloqueCiclo({ ciclo }: { ciclo: Promise<CicloLiquidacion> }) {
  const funnel = await ciclo;
  // Barras SOLO de lo VIVO (auditoría 13-ago): "Liquidados" es acumulado
  // histórico y en meses domina la escala — las etapas vivas se volverían
  // astillas invisibles. Lo vivo se grafica; el histórico es una línea.
  const cicloVivoLegible = funnel.abiertos !== null && funnel.enCuadre !== null;
  const pasosVivos = cicloVivoLegible
    ? [
        { etiqueta: 'Abiertos', valor: funnel.abiertos as number },
        { etiqueta: 'En cuadre', valor: funnel.enCuadre as number },
        { etiqueta: 'Por revisar', valor: funnel.porRevisar },
      ]
    : [];
  const hayCicloVivo = cicloVivoLegible && pasosVivos.some((p) => p.valor > 0);
  return (
    <section className="card p-4 flex flex-col">
      <h2 className="font-display text-[15px] font-semibold mb-1">Viajes en curso</h2>
      <p className="text-[11px] mb-3" style={{ color: 'var(--faint)' }}>La foto de ahora mismo, por etapa</p>
      {!cicloVivoLegible ? (
        <Leyenda>No se pudo contar el ciclo ahora mismo — antes que un cero sin medir, se queda pendiente.</Leyenda>
      ) : hayCicloVivo ? (
        /* HBars y no Funnel A PROPÓSITO: el Funnel imprime conversión
           paso-a-paso y este ciclo no es un embudo decreciente. */
        <HBars datos={pasosVivos} />
      ) : (
        <Leyenda>Nada vivo en el ciclo ahora mismo — el próximo viaje que despaches aparece aquí.</Leyenda>
      )}
      {funnel.liquidados !== null && (
        <p className="text-[12px] mt-3 pt-2.5 border-t" style={{ color: 'var(--faint)', borderColor: 'var(--line2)' }}>
          <span className="cifra-mono font-medium" style={{ color: 'var(--ink)' }}>{numero(funnel.liquidados)}</span>{' '}
          viajes liquidados en total, histórico.
        </p>
      )}
    </section>
  );
}

async function BloqueCierres({ cierresPorDia }: {
  cierresPorDia: Promise<Array<{ fecha: string; valor: number }> | null>;
}) {
  const dias = await cierresPorDia;
  const total = dias?.reduce((s, d) => s + d.valor, 0) ?? 0;
  return (
    <section className="card p-4 flex flex-col">
      <h2 className="font-display text-[15px] font-semibold mb-1">Cierres por día</h2>
      <p className="text-[11px] mb-3" style={{ color: 'var(--faint)' }}>Últimas 12 semanas</p>
      {dias === null ? (
        <Leyenda>No se pudo leer la actividad ahora mismo.</Leyenda>
      ) : total > 0 ? (
        <>
          <CalendarHeatmap dias={dias} />
          <p className="text-[12px] mt-3" style={{ color: 'var(--faint)' }}>
            {numero(total)} liquidaciones cerradas en la ventana.
          </p>
        </>
      ) : (
        <Leyenda>Aún sin cierres en las últimas 12 semanas — cada día con cierres pinta su cuadrito.</Leyenda>
      )}
    </section>
  );
}

async function BloqueHizoSolo({ hizoSolo }: { hizoSolo: Promise<HizoSolo> }) {
  const { hechos, huerfanos, docsProcesados, actividadIa } = await hizoSolo;
  return (
    <section className="card p-4 flex flex-col">
      <h2 className="font-display text-[15px] font-semibold mb-3">Lo que hizo solo</h2>
      {hechos === null ? (
        <Leyenda>No se pudo leer el registro ahora mismo.</Leyenda>
      ) : hechos.length === 0 && !(huerfanos && huerfanos.resueltos > 0) ? (
        <Leyenda>Aún nada que presumir: cuando el agente mande un recordatorio o escale un
          viaje sin que nadie se lo pida, queda escrito aquí.</Leyenda>
      ) : (
        <div className="space-y-2.5 text-[12.5px]">
          {hechos.map((h, i) => (
            <div key={i} className="flex items-start gap-2">
              {h.tipo === 'recordatorio'
                ? <BellRing width={13} height={13} strokeWidth={1.75} className="mt-0.5 shrink-0" style={{ color: 'var(--muted)' }} />
                : <Flag width={13} height={13} strokeWidth={1.75} className="mt-0.5 shrink-0" style={{ color: 'var(--warn)' }} />}
              <div className="min-w-0">
                {h.tipo === 'recordatorio'
                  ? <span>Le recordó a <span className="font-medium">{h.operador ?? 'el operador'}</span> comprobar el viaje {h.folio}</span>
                  : <span>Escaló el viaje <span className="font-medium">{h.folio}</span> para atención humana</span>}
                <span className="block text-[11px]" style={{ color: 'var(--faint)' }}>{fechaCorta(h.cuando)}</span>
              </div>
            </div>
          ))}
          {huerfanos && huerfanos.resueltos > 0 && (
            <div className="flex items-start gap-2 pt-1.5 border-t" style={{ borderColor: 'var(--line2)' }}>
              <Link2 width={13} height={13} strokeWidth={1.75} className="mt-0.5 shrink-0" style={{ color: 'var(--ok)' }} />
              <span>Amarró solo <span className="font-medium">{numero(huerfanos.resueltos)}</span> comprobantes
                que llegaron sin viaje asignado.</span>
            </div>
          )}
        </div>
      )}
      {(docsProcesados !== null || actividadIa !== null) && (
        <p className="text-[12px] mt-auto pt-2.5 border-t" style={{ color: 'var(--faint)', borderColor: 'var(--line2)' }}>
          {docsProcesados !== null && (
            <><span className="cifra-mono font-medium" style={{ color: 'var(--ink)' }}>{numero(docsProcesados)}</span> comprobantes leídos</>
          )}
          {docsProcesados !== null && actividadIa !== null && ' · '}
          {actividadIa !== null && (
            <><span className="cifra-mono font-medium" style={{ color: 'var(--ink)' }}>{numero(actividadIa)}</span> lecturas de IA</>
          )}
          {' '}— histórico.
        </p>
      )}
    </section>
  );
}

export async function BloqueDineroObservado({ porTipo: p }: { porTipo: Promise<DineroObservadoTipo[] | null> }) {
  const porTipo = await p;
  const totalObservado = porTipo?.reduce((s, t) => s + t.monto, 0) ?? 0;
  return (
    <section className="card p-4 flex flex-col">
      <h2 className="font-display text-[15px] font-semibold">Dinero observado</h2>
      <p className="text-[11px] mb-2" style={{ color: 'var(--faint)' }}>Todas las diferencias que el motor registró, por tipo — histórico completo, no solo fuera de política o duplicado</p>
      {porTipo === null ? (
        <Leyenda>No se pudo leer el desglose ahora mismo.</Leyenda>
      ) : porTipo.length === 0 ? (
        <Leyenda>Sin diferencias detectadas todavía — cuando el agente atrape un gasto fuera
          de política o un ticket duplicado, aquí se desglosa.</Leyenda>
      ) : (
        <>
          <div className="cifra-mono text-[22px] font-medium mb-2">{mxn(totalObservado)}</div>
          <Dona segmentos={porTipo.map((t) => ({ etiqueta: rotuloTipo(t.tipo), valor: t.monto }))} />
          <div className="mt-2 space-y-1">
            {porTipo.map((t) => (
              <div key={t.tipo} className="flex items-center justify-between text-[12px]">
                <span style={{ color: 'var(--muted)' }}>{rotuloTipo(t.tipo)} · {numero(t.n)}</span>
                <span className="cifra-mono">{mxn(t.monto)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

async function BloqueOperadores({ operadores: p }: {
  operadores: Promise<Array<{ etiqueta: string; valor: number }> | null>;
}) {
  const operadores = await p;
  return (
    <section className="card p-4 flex flex-col">
      <h2 className="font-display text-[15px] font-semibold">Diferencias por operador</h2>
      <p className="text-[11px] mb-3" style={{ color: 'var(--faint)' }}>Liquidaciones con diferencia, por operador</p>
      {operadores === null ? (
        <Leyenda>No se pudo leer el desglose ahora mismo.</Leyenda>
      ) : operadores.length === 0 ? (
        <Leyenda>Ningún operador acumula diferencias — la señal que quieres ver.</Leyenda>
      ) : (
        <HBars datos={operadores} />
      )}
    </section>
  );
}

async function BloqueReglas({ politica: p, puedeVerReglas, sufijo }: {
  politica: Promise<PoliticaGasto[] | null>; puedeVerReglas: boolean; sufijo: string;
}) {
  const politica = await p;
  return (
    <section className="card p-4 flex flex-col">
      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-display text-[15px] font-semibold">Sus reglas</h2>
          {puedeVerReglas && (
            /* "Ver", no "Editar": Configuración hoy es solo lectura —
               un botón que promete editar y no edita es un botón que
               miente. Cuando esa página edite, esto vuelve a ser
               "Editar". */
            <Link href={`/dashboard/configuracion${sufijo}`} title="Ver la configuración completa"
              className="inline-flex items-center gap-1 text-[12px] font-medium hover:opacity-70 transition-opacity"
              style={{ color: 'var(--marca)' }}>
              <Settings width={12} height={12} strokeWidth={1.75} /> Ver
            </Link>
          )}
        </div>
        {politica === null ? (
          <Leyenda>No se pudo leer la política ahora mismo.</Leyenda>
        ) : (
          <div className="space-y-1">
            {politica.map((pg) => (
              <div key={pg.concepto} className="flex items-center justify-between text-[12px]">
                <span style={{ color: 'var(--muted)' }}>{etiquetaConcepto(pg.concepto)}</span>
                <span className="cifra-mono">
                  {pg.topeMonto !== undefined ? mxn(pg.topeMonto) : pg.requiereCfdi ? 'Requiere CFDI' : 'Sin tope'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

async function BloqueUltimosCierres({ liquidaciones, sufijo }: {
  liquidaciones: Promise<LiqRow[]>; sufijo: string;
}) {
  const liqs = await liquidaciones;
  const cierres = liqs.filter((l) => l.estatus !== 'revisar').slice(0, 5);
  return (
    <section className="card p-4">
      <h2 className="font-display text-[15px] font-semibold mb-3">Últimos cierres</h2>
      {cierres.length === 0 ? (
        <EstadoVacio icono={<Bot width={17} height={17} strokeWidth={1.75} style={{ color: 'var(--marca)' }} />}>
          El agente todavía no cierra ninguna liquidación en esta flota.
        </EstadoVacio>
      ) : (
        <TablaLiqs filas={cierres} sufijo={sufijo} conVer />
      )}
    </section>
  );
}

/** Leyenda de vacío/pendiente — centrada por alto y ancho, como TODAS las
 *  leyendas del panel (regla del 12-ago). */
function Leyenda({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 min-h-[110px] flex items-center justify-center">
      <p className="text-[12.5px] text-center max-w-[30ch]" style={{ color: 'var(--muted)' }}>{children}</p>
    </div>
  );
}

function Kpi({ titulo, valor, nota, tono }: { titulo: string; valor: string; nota?: string; tono?: 'warn' | 'bad' }) {
  return (
    <div className="card p-3.5">
      <div className="etiqueta-mono text-[10px] uppercase" style={{ color: 'var(--faint)' }}>{titulo}</div>
      <div className="cifra-mono text-[20px] font-medium mt-1"
        style={tono ? { color: `var(--${tono})` } : undefined}>{valor}</div>
      {nota && <div className="text-[11px] mt-0.5" style={{ color: 'var(--faint)' }}>{nota}</div>}
    </div>
  );
}

const ESTATUS: Record<string, { rotulo: string; fg: string; bg: string }> = {
  cuadrada: { rotulo: 'Cuadrada', fg: 'var(--ok)', bg: 'var(--okbg)' },
  con_diferencias: { rotulo: 'Con diferencias', fg: 'var(--bad)', bg: 'var(--badbg)' },
  revisar: { rotulo: 'Por revisar', fg: 'var(--warn)', bg: 'var(--warnbg)' },
};

function TablaLiqs({ filas, sufijo, conVer }: { filas: LiqRow[]; sufijo: string; conVer?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left" style={{ color: 'var(--faint)' }}>
            <th className="etiqueta-mono text-[10px] uppercase font-normal pb-2">Viaje</th>
            <th className="etiqueta-mono text-[10px] uppercase font-normal pb-2">Fecha</th>
            <th className="etiqueta-mono text-[10px] uppercase font-normal pb-2 text-right">Comprobado</th>
            <th className="etiqueta-mono text-[10px] uppercase font-normal pb-2 pr-6 text-right">Diferencia</th>
            <th className="etiqueta-mono text-[10px] uppercase font-normal pb-2">Estatus</th>
            {conVer && <th className="pb-2" />}
          </tr>
        </thead>
        <tbody>
          {filas.map((l) => {
            const e = ESTATUS[l.estatus] ?? { rotulo: l.estatus, fg: 'var(--muted)', bg: 'var(--canvas)' };
            return (
              <tr key={l.id} className="border-t" style={{ borderColor: 'var(--line2)' }}>
                <td className="py-2 font-medium">{l.folio}</td>
                <td className="py-2" style={{ color: 'var(--muted)' }}>{fechaCorta(l.creadoEn)}</td>
                <td className="py-2 text-right cifra-mono">{mxn(l.comprobado)}</td>
                <td className="py-2 pr-6 text-right cifra-mono" style={l.diferencia !== 0 ? { color: 'var(--bad)' } : undefined}>
                  {mxn(l.diferencia)}
                </td>
                <td className="py-2">
                  <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium"
                    style={{ color: e.fg, background: e.bg }}>{e.rotulo}</span>
                </td>
                {conVer && (
                  <td className="py-2 text-right">
                    <Link href={`/dashboard/${l.id}${sufijo}`}
                      className="inline-flex items-center gap-1 text-[12px] font-medium hover:opacity-70 transition-opacity"
                      style={{ color: 'var(--marca)' }}>
                      Ver <ArrowRight width={12} height={12} strokeWidth={2} />
                    </Link>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
