'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Inbox } from 'lucide-react';
import { EstadoVacio, StatusPill, type Estado } from '../ui/kit';
import { numero } from '@/lib/formato';

// ═══════════════════════════════════════════════════════════════════════════
// EL TABLERO KANBAN DEL PIPELINE — compartido entre /admin/vendedores (todo
// el censo, con asignar) y /vendedor (solo SUS tarjetas, sin asignar).
//
// SIN drag&drop a propósito: una librería nueva es una dependencia que nadie
// pidió, y los botones de mover llegan igual de rápido con teclado y con
// dedo. Cada acción es un server action + revalidatePath; `useTransition`
// mantiene el tablero vivo mientras el servidor confirma, y el error se
// enseña EN la tarjeta que falló — no en un toast que desaparece.
//
// TODO LO QUE DECIDE VIVE EN EL SERVIDOR. Este componente recibe columnas ya
// filtradas y recortadas, el mapa de transiciones y los catálogos COMO
// PROPS (patrón `MODOS_TARIFA`): importar `vendedores.ts` aquí arrastraría
// `supabaseAdmin` al bundle del navegador. Y aunque los botones solo
// ofrecen transiciones válidas, el servidor las re-valida — un botón
// escondido no es una regla.
// ═══════════════════════════════════════════════════════════════════════════

export interface TarjetaProspecto {
  id: string;
  empresa: string;
  vacante: string | null;
  ciudad: string | null;
  notas: string | null;
  estado: string;
  vendedorId: string | null;
  /** Resuelto por el servidor; `null` = sin asignar. */
  vendedorNombre: string | null;
}

export interface ColumnaTablero {
  estado: string;
  rotulo: string;
  /** La cifra REAL de la columna (con filtros aplicados), aunque abajo solo
   *  se pinten `tarjetas.length` — el recorte se dice, nunca se esconde. */
  total: number;
  tarjetas: TarjetaProspecto[];
  /** FE-10: a dónde lleva "ver los que faltan" cuando la columna está
   *  recortada. El tablero decía "y N más — filtra para verlos" en una
   *  pantalla que NO TIENE filtro (/vendedor): mandaba a usar algo que no
   *  existe. Con `mas` se pinta un link real; sin él, el texto se limita a
   *  declarar el recorte. */
  mas?: { href: string; etiqueta: string } | null;
  /** El link de vuelta cuando la columna está EXPANDIDA (misma razón). */
  menos?: { href: string; etiqueta: string } | null;
}

export type ResultadoAccion = { ok: true; mensaje?: string } | { ok: false; error: string };

/** El tinte del pill por etapa — color + texto siempre, nunca color solo. */
const PILL_COLUMNA: Record<string, Estado> = {
  nuevo: 'neutral',
  contactado: 'neutral',
  appointment: 'warn',
  rescheduled: 'warn',
  cancelled: 'bad',
  'no-show': 'bad',
  demo: 'warn',
  proposal: 'warn',
  pilot: 'warn',
  won: 'ok',
  lost: 'bad',
  // Solo pueden llegar como estado de una tarjeta histórica; la columna ya
  // usa su nombre canónico.
  negociacion: 'warn',
  cerrado: 'ok',
  perdido: 'bad',
};

function Tarjeta({
  t, orden, transiciones, rotulos, vendedores, mover, asignar, guardarNota, redactar, conVendedor,
}: {
  t: TarjetaProspecto;
  orden: string[];
  transiciones: Record<string, readonly string[]>;
  rotulos: Record<string, string>;
  vendedores: Array<{ id: string; nombre: string }>;
  mover: (id: string, a: string) => Promise<ResultadoAccion>;
  asignar?: (id: string, vendedorId: string) => Promise<ResultadoAccion>;
  guardarNota?: (id: string, nota: string) => Promise<ResultadoAccion>;
  /** El Redactor (C5, Fase 2): arma el primer correo y lo deja EN LA COLA de
   *  aprobación — jamás lo envía. Solo /admin lo pasa. */
  redactar?: (id: string) => Promise<ResultadoAccion>;
  conVendedor: boolean;
}) {
  const [pendiente, empezar] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [hecho, setHecho] = useState<string | null>(null);
  const [nota, setNota] = useState(t.notas ?? '');

  const correr = (accion: () => Promise<ResultadoAccion>) => {
    setError(null);
    setHecho(null);
    empezar(async () => {
      const r = await accion();
      if (!r.ok) setError(r.error);
      else if (r.mensaje) setHecho(r.mensaje);
    });
  };

  const destinos = transiciones[t.estado] ?? [];
  const idx = orden.indexOf(t.estado);
  const etiquetaDe = (a: string): string => {
    if (a === 'lost' || a === 'perdido') return '✕ Perdido';
    if (a === 'won' || a === 'cerrado') return '✓ Ganado';
    const r = rotulos[a] ?? a;
    return orden.indexOf(a) < idx ? `← ${r}` : `${r} →`;
  };

  const BOTON = 'text-[11px] font-medium px-2 py-1 rounded-md hairline transition-colors hover:bg-[var(--canvas)] disabled:opacity-50';

  return (
    <div className="card p-2.5 space-y-1.5" style={pendiente ? { opacity: 0.6 } : undefined}>
      <div className="text-[13px] font-medium leading-tight">{t.empresa}</div>
      {/* La vacante es LA señal del censo — si existe, se enseña siempre. */}
      {t.vacante && (
        <div className="text-[11px] truncate" style={{ color: 'var(--muted)' }}>Vacante: {t.vacante}</div>
      )}
      {(t.ciudad || conVendedor) && (
        <div className="text-[11px] flex items-center gap-1.5 min-w-0" style={{ color: 'var(--faint)' }}>
          {t.ciudad && <span className="truncate">{t.ciudad}</span>}
          {t.ciudad && conVendedor && <span aria-hidden>·</span>}
          {conVendedor && <span className="truncate">{t.vendedorNombre ?? 'Sin asignar'}</span>}
        </div>
      )}
      {t.notas && (
        <div className="text-[11px] truncate" style={{ color: 'var(--faint)' }}>{t.notas}</div>
      )}

      {destinos.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {destinos.map((a) => (
            <button key={a} type="button" disabled={pendiente}
              onClick={() => correr(() => mover(t.id, a))}
              className={BOTON}
              style={a === 'lost' || a === 'perdido' ? { color: 'var(--bad)' } : a === 'won' || a === 'cerrado' ? { color: 'var(--ok)' } : undefined}>
              {etiquetaDe(a)}
            </button>
          ))}
        </div>
      )}

      {/* El Redactor solo para etapas vivas — el servidor lo re-valida (un
          botón escondido no es una regla, misma nota del encabezado). */}
      {redactar && !['won', 'lost', 'cerrado', 'perdido'].includes(t.estado) && (
        <button type="button" disabled={pendiente}
          onClick={() => correr(() => redactar(t.id))}
          className={`${BOTON} w-full`}>
          {pendiente ? 'Redactando…' : 'Redactar correo → cola de aprobación'}
        </button>
      )}

      {hecho && (
        <p className="text-[11px] m-0" style={{ color: 'var(--ok)' }}>{hecho}</p>
      )}

      {asignar && (
        <select
          aria-label={`Vendedor de ${t.empresa}`}
          value={t.vendedorId ?? ''}
          disabled={pendiente}
          onChange={(e) => correr(() => asignar(t.id, e.target.value))}
          className="w-full hairline rounded-md px-1.5 h-7 text-[11px] outline-none"
          style={{ background: 'var(--surface)' }}>
          <option value="">Sin asignar</option>
          {vendedores.map((v) => (
            <option key={v.id} value={v.id}>{v.nombre}</option>
          ))}
        </select>
      )}

      {guardarNota && (
        <details className="text-[11px]">
          <summary className="cursor-pointer select-none" style={{ color: 'var(--muted)' }}>Nota</summary>
          <textarea value={nota} onChange={(e) => setNota(e.target.value)} rows={2} maxLength={2000}
            className="w-full hairline rounded-md px-1.5 py-1 mt-1 text-[11px] outline-none"
            style={{ background: 'var(--surface)' }} />
          <button type="button" disabled={pendiente}
            onClick={() => correr(() => guardarNota(t.id, nota))}
            className={`${BOTON} mt-1`}>
            Guardar nota
          </button>
        </details>
      )}

      {error && (
        <p className="text-[11px] m-0" style={{ color: 'var(--bad)' }}>{error}</p>
      )}
    </div>
  );
}

export function TableroProspectos({
  columnas, orden, transiciones, rotulos, vendedores, mover, asignar, guardarNota, redactar, hayFiltro = false,
  conVendedor = true,
}: {
  columnas: ColumnaTablero[];
  /** El embudo en orden, para decidir qué botón es ← y cuál →. */
  orden: string[];
  transiciones: Record<string, readonly string[]>;
  rotulos: Record<string, string>;
  vendedores: Array<{ id: string; nombre: string }>;
  mover: (id: string, a: string) => Promise<ResultadoAccion>;
  /** Ausente en /vendedor: asignar es del admin. */
  asignar?: (id: string, vendedorId: string) => Promise<ResultadoAccion>;
  guardarNota?: (id: string, nota: string) => Promise<ResultadoAccion>;
  /** El Redactor (C5) — ausente en /vendedor por ahora: aprobar es de /admin. */
  redactar?: (id: string) => Promise<ResultadoAccion>;
  /** Con filtros activos, la columna vacía dice la verdad completa: vacía
   *  BAJO ESTE FILTRO, no vacía en el negocio. */
  hayFiltro?: boolean;
  /** `false` en el tablero PROPIO del vendedor: todas las tarjetas son
   *  suyas, y pintarle "Sin asignar" (el `null` de un nombre que no viaja)
   *  sería mentirle sobre su propia cartera. */
  conVendedor?: boolean;
}) {
  return (
    // El tablero scrollea DENTRO de su contenedor (regla de wide content):
    // seis columnas no caben en un portátil y la página no debe crecer a lo
    // ancho por ellas.
    <div className="overflow-x-auto pb-1">
      <div className="flex gap-2 items-start min-w-max">
        {columnas.map((col) => (
          <div key={col.estado} className="w-[248px] shrink-0 rounded-xl p-2"
            style={{ background: 'var(--canvas2)', border: '1px solid var(--line2)' }}>
            <div className="flex items-center justify-between gap-2 px-1 pb-2">
              <StatusPill estado={PILL_COLUMNA[col.estado] ?? 'neutral'}>{col.rotulo}</StatusPill>
              <span className="text-[11px] tabular font-medium" style={{ color: 'var(--muted)' }}>{numero(col.total)}</span>
            </div>
            <div className="space-y-1.5">
              {col.tarjetas.length === 0 ? (
                <EstadoVacio icono={<Inbox width={15} height={15} strokeWidth={1.75} style={{ color: 'var(--muted)' }} />}>
                  {hayFiltro
                    ? 'Ninguno en esta etapa con el filtro actual.'
                    : 'Sin prospectos en esta etapa.'}
                </EstadoVacio>
              ) : (
                col.tarjetas.map((t) => (
                  <Tarjeta key={t.id} t={t} orden={orden} transiciones={transiciones} rotulos={rotulos}
                    vendedores={vendedores} mover={mover} asignar={asignar} guardarNota={guardarNota}
                    redactar={redactar} conVendedor={conVendedor} />
                ))
              )}
              {col.mas ? (
                <Link href={col.mas.href} className="block text-[11px] px-1 underline hover:opacity-70 transition-opacity"
                  style={{ color: 'var(--muted)' }}>
                  {col.mas.etiqueta}
                </Link>
              ) : col.total > col.tarjetas.length ? (
                <p className="text-[11px] px-1 m-0" style={{ color: 'var(--muted)' }}>
                  {/* Sin link, se DECLARA el recorte y nada más. Antes decía
                      "filtra para verlos" también donde no hay filtro. */}
                  y {col.total - col.tarjetas.length} más
                  {hayFiltro ? ' — acota el filtro para verlos' : ''}
                </p>
              ) : null}
              {col.menos && (
                <Link href={col.menos.href} className="block text-[11px] px-1 underline hover:opacity-70 transition-opacity"
                  style={{ color: 'var(--muted)' }}>
                  {col.menos.etiqueta}
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
