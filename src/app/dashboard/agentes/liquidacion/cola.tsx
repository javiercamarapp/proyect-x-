import Link from 'next/link';
import { Inbox, ArrowRight, Filter } from 'lucide-react';
import { mxn, numero, fechaCorta } from '@/lib/formato';
import { EstadoVacio } from '@/app/admin/ui/kit';
import { ESTILO_CONTROL } from '@/app/admin/ui/forma';
import { ComboCatalogo, type BuscarCatalogo } from '../../combo-catalogo';
import {
  ESTADOS_CUADRE, REVISIONES, hayFiltrosCola,
  type FiltrosCola, type PaginaCola, type FilaCola, type RevisionLiquidacion,
} from '@/lib/likida/revision';

// ═══════════════════════════════════════════════════════════════════════════
// «ESPERAN TU REVISIÓN» — LA COLA DE VERDAD (auditoría 24, FE-5 · BLOQ-6).
//
// Antes esta tabla era un FILTRO EN MEMORIA sobre las 50 liquidaciones más
// recientes (`getLiquidaciones`, `order created_at desc limit 50`). A ~500
// cierres/día, 50 filas son 2.4 horas: la liquidación que lleva desde la
// mañana esperando firma —justo la que hay que atender— no estaba en la única
// pantalla donde se firma, y el pie mandaba al Registro de Viajes, que no
// filtra por revisión.
//
// Ahora la cola es su propia consulta: `revision='pendiente'` ordenada por
// ANTIGÜEDAD (la que más lleva esperando, primero), por llave `(created_at,
// id)` y con `count` real de la base. El rótulo dice «N de M» con la M
// contada, no con el largo de una lista topada.
//
// Los filtros son los que un contralor usa de verdad: por terminal (la
// sucursal que le toca), por operador, por unidad, por el estado del cuadre y
// por fechas. Van en la URL —`<form method="get">`— para que un filtro se
// pueda compartir por chat y para que el botón de atrás funcione.
// ═══════════════════════════════════════════════════════════════════════════

const ROTULO_REVISION: Record<RevisionLiquidacion, string> = {
  pendiente: 'Esperan firma',
  aprobada: 'Aprobadas',
  ajustada: 'Ajustadas',
  rechazada: 'Rechazadas',
};

/** Cómo se dice el CERO MEDIDO de cada filtro. Cero contado por la base es un
 *  dato, y se pinta como tal. */
const ROTULO_VACIO: Record<RevisionLiquidacion, string> = {
  pendiente: 'Ninguna espera tu firma',
  aprobada: 'Ninguna aprobada',
  ajustada: 'Ninguna ajustada',
  rechazada: 'Ninguna rechazada',
};

const ROTULO_ESTADO: Record<string, { rotulo: string; fg: string; bg: string }> = {
  cuadrada: { rotulo: 'Cuadrada', fg: 'var(--ok)', bg: 'var(--okbg)' },
  con_diferencias: { rotulo: 'Con diferencias', fg: 'var(--bad)', bg: 'var(--badbg)' },
  revisar: { rotulo: 'Revisar', fg: 'var(--warn)', bg: 'var(--warnbg)' },
};

export interface ColaProps {
  cola: Promise<PaginaCola>;
  filtros: FiltrosCola;
  /** Las terminales de la flota para el selector. `null` = no se pudieron
   *  leer, y entonces el selector no se pinta (no se afirma «no hay»). */
  terminales: Promise<{ opciones: Array<{ id: string; nombre: string }>; recortadas: boolean } | null>;
  /** Buscador de catálogo (server action del host) para operador y unidad. */
  buscar: BuscarCatalogo;
  /** Los campos de la query que hay que conservar en cada link/submit
   *  (`tenant`, `vista`, `rol`): el mismo contrato de sufijo del panel. */
  contexto: Array<[string, string]>;
  sufijo: string;
}

/** El texto que explica QUÉ ventana se está viendo. Nunca «N liquidaciones» a
 *  secas: siempre cuántas de cuántas, y bajo qué filtro. */
export function rotuloCola(p: PaginaCola, f: FiltrosCola): string {
  // El `??` no es adorno: si un día se agrega un estado de revisión y falta su
  // rótulo, la cola tiene que seguir diciendo la verdad en crudo, no reventar
  // la pantalla donde se firma.
  const que = (ROTULO_REVISION[f.revision] ?? f.revision).toLowerCase();
  if (p.total === 0) return ROTULO_VACIO[f.revision] ?? `Ninguna en «${que}»`;
  if (p.filas.length >= p.total) {
    return `${numero(p.total)} ${p.total === 1 ? 'liquidación' : 'liquidaciones'} — ${que}`;
  }
  return `${numero(p.filas.length)} de ${numero(p.total)} — ${que}, las que más llevan esperando primero`;
}

export async function SeccionCola({ cola, filtros, terminales, buscar, contexto, sufijo }: ColaProps) {
  const [pagina, terms] = await Promise.all([cola, terminales]);
  const conFiltros = hayFiltrosCola(filtros);

  return (
    <section className="card p-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1">
        <h2 className="font-display text-[15px] font-semibold">Esperan tu revisión</h2>
        <p className="text-[11px]" style={{ color: 'var(--faint)' }}>{rotuloCola(pagina, filtros)}</p>
      </div>

      <FormaFiltros filtros={filtros} terminales={terms} buscar={buscar} contexto={contexto} conFiltros={conFiltros} />

      {pagina.filas.length === 0 ? (
        <EstadoVacio icono={<Inbox width={17} height={17} strokeWidth={1.75} style={{ color: 'var(--marca)' }} />}>
          {conFiltros
            ? 'Ninguna liquidación cae en ese filtro. Quita alguno para ver el resto de la cola.'
            : 'No hay liquidaciones esperando a un humano — cuando el agente no pueda cuadrar una solo, la vas a ver aquí.'}
        </EstadoVacio>
      ) : (
        <>
          <TablaCola filas={pagina.filas} sufijo={sufijo} />
          <div className="flex items-center justify-between gap-3 mt-2.5">
            <p className="text-[11px]" style={{ color: 'var(--faint)' }}>
              {/* La ventana, DECLARADA. No hay «se muestran las más recientes»
                  que esconda a las viejas: esta cola empieza por las viejas. */}
              Por antigüedad. La firma se pone en el detalle de cada una.
            </p>
            {pagina.siguiente && (
              <Link
                href={`?${new URLSearchParams([...contexto, ...paramsDeFiltros(filtros), ['cursor', pagina.siguiente]]).toString()}`}
                className="inline-flex items-center gap-1 text-[12px] font-medium hover:opacity-70 transition-opacity"
                style={{ color: 'var(--marca)' }}
              >
                Siguientes <ArrowRight width={12} height={12} strokeWidth={2} />
              </Link>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** Los filtros vigentes, en forma de query. Se usa para el link de «siguientes»
 *  (el cursor viaja aparte) y para «limpiar». */
export function paramsDeFiltros(f: FiltrosCola): Array<[string, string]> {
  const p: Array<[string, string]> = [];
  if (f.revision !== 'pendiente') p.push(['rev', f.revision]);
  if (f.estado) p.push(['estado', f.estado]);
  if (f.operadorId) p.push(['operador', f.operadorId]);
  if (f.unidadId) p.push(['unidad', f.unidadId]);
  if (f.terminalId) p.push(['terminal', f.terminalId]);
  if (f.desde) p.push(['desde', f.desde]);
  if (f.hasta) p.push(['hasta', f.hasta]);
  return p;
}

function FormaFiltros({ filtros, terminales, buscar, contexto, conFiltros }: {
  filtros: FiltrosCola;
  terminales: { opciones: Array<{ id: string; nombre: string }>; recortadas: boolean } | null;
  buscar: BuscarCatalogo;
  contexto: Array<[string, string]>;
  conFiltros: boolean;
}) {
  return (
    /* GET y no server action: un filtro tiene que poder compartirse por chat y
       sobrevivir al botón de atrás. `cursor` NO se conserva — cambiar el filtro
       empieza la cola desde arriba, o la página 3 de otro filtro no significa
       nada. */
    <form method="get" className="flex flex-wrap items-end gap-2 mb-3">
      {contexto.map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}

      <Campo etiqueta="Revisión">
        <select name="rev" defaultValue={filtros.revision} className={CLASE_CONTROL} style={ESTILO_CONTROL}>
          {REVISIONES.map((r) => <option key={r} value={r}>{ROTULO_REVISION[r]}</option>)}
        </select>
      </Campo>

      <Campo etiqueta="Cuadre">
        <select name="estado" defaultValue={filtros.estado ?? ''} className={CLASE_CONTROL} style={ESTILO_CONTROL}>
          <option value="">Cualquiera</option>
          {ESTADOS_CUADRE.map((e) => <option key={e} value={e}>{ROTULO_ESTADO[e]?.rotulo ?? e}</option>)}
        </select>
      </Campo>

      {/* El catálogo NO viaja: el combo pide 20 al escribir (FE-2). */}
      <Campo etiqueta="Operador">
        <ComboCatalogo tipo="operador" name="operador" buscar={buscar} etiquetaVacia="Cualquiera"
          valorInicial={filtros.operadorId} className={CLASE_CONTROL} estilo={ESTILO_CONTROL} aria-label="Filtrar por operador" />
      </Campo>
      <Campo etiqueta="Unidad">
        <ComboCatalogo tipo="unidad" name="unidad" buscar={buscar} etiquetaVacia="Cualquiera"
          valorInicial={filtros.unidadId} className={CLASE_CONTROL} estilo={ESTILO_CONTROL} aria-label="Filtrar por unidad" />
      </Campo>

      {/* Sin terminales legibles NO se pinta el selector: un `<select>` con
          solo «Cualquiera» afirmaría que la flota no tiene sucursales. */}
      {terminales && terminales.opciones.length > 0 && (
        <Campo etiqueta="Terminal" pista={terminales.recortadas ? `${numero(terminales.opciones.length)} de más` : undefined}>
          <select name="terminal" defaultValue={filtros.terminalId ?? ''} className={CLASE_CONTROL} style={ESTILO_CONTROL}>
            <option value="">Cualquiera</option>
            {terminales.opciones.map((t) => <option key={t.id} value={t.id}>{t.nombre}</option>)}
          </select>
        </Campo>
      )}

      <Campo etiqueta="Desde">
        <input type="date" name="desde" defaultValue={filtros.desde ?? ''} className={CLASE_CONTROL} style={ESTILO_CONTROL} />
      </Campo>
      <Campo etiqueta="Hasta">
        <input type="date" name="hasta" defaultValue={filtros.hasta ?? ''} className={CLASE_CONTROL} style={ESTILO_CONTROL} />
      </Campo>

      <button type="submit"
        className="inline-flex items-center gap-1.5 text-[12px] font-medium rounded-lg px-3 py-1.5"
        style={{ background: 'var(--marca)', color: 'var(--marca-fg)' }}>
        <Filter width={12} height={12} strokeWidth={2} /> Filtrar
      </button>
      {conFiltros && (
        <Link href={`?${new URLSearchParams(contexto).toString()}`}
          className="text-[12px] font-medium px-2 py-1.5 hover:opacity-70 transition-opacity"
          style={{ color: 'var(--muted)' }}>
          Limpiar
        </Link>
      )}
    </form>
  );
}

const CLASE_CONTROL = 'text-[12.5px] rounded-lg px-2 py-1.5 min-w-[9rem]';

function Campo({ etiqueta, pista, children }: { etiqueta: string; pista?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="etiqueta-mono text-[10px] uppercase" style={{ color: 'var(--faint)' }}>
        {etiqueta}{pista ? ` · ${pista}` : ''}
      </span>
      {children}
    </label>
  );
}

function TablaCola({ filas, sufijo }: { filas: FilaCola[]; sufijo: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left" style={{ color: 'var(--faint)' }}>
            <Th>Viaje</Th>
            <Th>Cerrada</Th>
            <Th>Operador</Th>
            <Th>Unidad</Th>
            <Th derecha>Comprobado</Th>
            <Th derecha>Diferencia</Th>
            <Th>Cuadre</Th>
            <th className="pb-2" />
          </tr>
        </thead>
        <tbody>
          {filas.map((l) => {
            const e = ROTULO_ESTADO[l.estatus] ?? { rotulo: l.estatus, fg: 'var(--muted)', bg: 'var(--canvas)' };
            return (
              <tr key={l.id} className="border-t" style={{ borderColor: 'var(--line2)' }}>
                <td className="py-2 font-medium">{l.folio}</td>
                <td className="py-2" style={{ color: 'var(--muted)' }}>{fechaCorta(l.creadoEn)}</td>
                {/* Sin nombre no se inventa uno: la ficha del chofer puede
                    estar incompleta y «—» es la verdad. */}
                <td className="py-2" style={{ color: 'var(--muted)' }}>{l.operadorNombre ?? '—'}</td>
                <td className="py-2" style={{ color: 'var(--muted)' }}>{l.unidadEco ?? '—'}</td>
                <td className="py-2 text-right cifra-mono">{mxn(l.comprobado)}</td>
                <td className="py-2 text-right cifra-mono" style={l.diferencia !== 0 ? { color: 'var(--bad)' } : undefined}>
                  {mxn(l.diferencia)}
                </td>
                <td className="py-2">
                  <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium"
                    style={{ color: e.fg, background: e.bg }}>{e.rotulo}</span>
                </td>
                <td className="py-2 text-right">
                  <Link href={`/dashboard/${l.id}${sufijo}`}
                    className="inline-flex items-center gap-1 text-[12px] font-medium hover:opacity-70 transition-opacity"
                    style={{ color: 'var(--marca)' }}>
                    Revisar <ArrowRight width={12} height={12} strokeWidth={2} />
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, derecha }: { children: React.ReactNode; derecha?: boolean }) {
  return (
    <th className={`etiqueta-mono text-[10px] uppercase font-normal pb-2${derecha ? ' text-right' : ''}`}>{children}</th>
  );
}
