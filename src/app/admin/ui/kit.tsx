'use client';

import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowRight, Info } from 'lucide-react';
import { Sparkline, Tendencia } from '../charts';
import { useCountUp } from './use-count-up';
import { usePrefersReducedMotion } from './prefers-reduced-motion';
import { resolverFormato, type FormatoPreset } from './formato-preset';

/**
 * Librería compartida de /admin (design system v2, complemento del
 * mockup aprobado) — "construir UNA vez y reusar en todas las páginas"
 * (§B). Todo monocromo: blanco/glass/negro + la rampa --g1..--g5, color
 * solo en los semáforos de salud (--ok/--warn/--bad) y nunca como
 * identidad de una serie de datos.
 */

// ── KpiTile ──────────────────────────────────────────────────────────────

export function KpiTile({
  icono, etiqueta, valor, formato = 'numero', tendencia, sparkline, vacio, destacar, nota,
}: {
  /** Elemento YA renderizado (`icono={<DollarSign width={15} .../>}`), no
   *  la referencia al componente — una referencia a función/componente no
   *  es serializable cruzando el límite Server→Client Component; un
   *  elemento (el resultado de `<Icono .../>`) sí lo es (mismo patrón que
   *  `asistente-expandible.tsx` ya usa para `main`/`asideTop`). */
  icono: React.ReactNode;
  etiqueta: string;
  /** `null` = NO MEDIBLE (auditoría 1): pinta "—" en el encabezado en vez de un
   *  0/0% con cara de medición. El pie lo explica con `vacio`. */
  valor: number | null;
  formato?: FormatoPreset;
  tendencia?: number | null;
  sparkline?: number[];
  /** Mensaje honesto ("sin historia suficiente") cuando no hay serie real
   *  que graficar — nunca se inventa un sparkline plano de relleno. */
  vacio?: string;
  /** Borde en --accent para LA cifra encabezado de una sección (p.ej. el
   *  litraje elegible del estímulo en /dashboard) — nunca dos destacadas en
   *  la misma grilla, o deja de leerse como jerarquía. */
  destacar?: boolean;
  /** Cita/base legal u otra nota fija de una línea (p.ej. "LIF 2026, Art.
   *  20-A") — a diferencia de `vacio`, no es un mensaje de "sin datos": se
   *  pinta SIEMPRE que se pasa, sin importar sparkline/vacio. Cada tile de
   *  /dashboard cita un artículo distinto; fusionarlas en una sola nota de
   *  sección se leería como que las tres comparten un mismo fundamento. */
  nota?: string;
}) {
  const reducido = usePrefersReducedMotion();
  const mostrado = useCountUp(valor ?? 0, !reducido);
  const fmt = resolverFormato(formato);
  const noMedible = valor === null;

  return (
    <div className="card p-3.5" style={destacar ? { borderColor: 'var(--accent)' } : undefined}>
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--canvas)', border: '1px solid var(--line)' }}>
          {icono}
        </div>
        <div className="min-w-0">
          {/* No medible → guion, nunca un 0/0% con cara de medición (auditoría 1). */}
          {/* ESCALA 50k (22-ago-2026): una cifra de 12+ dígitos ($999,999,999.00
              y más) ya no se desborda del tile — se recorta con "…" y el
              `title` lleva la cifra COMPLETA (hover / lector de pantalla). El
              recorte es de ANCHO, no de valor: el número real sigue ahí. */}
          <div className="text-xl font-semibold tracking-tight tabular leading-tight min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
            title={noMedible ? undefined : fmt(valor ?? 0)}
            style={noMedible ? { color: 'var(--faint)' } : undefined}>{noMedible ? '—' : fmt(mostrado)}</div>
          {/* AUDITORÍA 10, MEDIO — `truncate` (una sola línea + "…") cortaba
              la palabra que carga el significado fiscal: "IVA acreditable
              document…" perdía justo "documentado". `line-clamp-2` deja
              envolver a una segunda línea antes de recortar — a los anchos
              medidos (~1100 px de contenido real, sidebar + rail
              descontados) dos líneas alcanzan para las etiquetas más largas
              del producto; solo un rótulo patológicamente largo llegaría a
              perder algo, y ahí sigue habiendo un tope. */}
          <div className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--muted)' }}>{etiqueta}</div>
        </div>
      </div>
      {vacio ? (
        <p className="text-xs mt-2" style={{ color: 'var(--faint)' }}>{vacio}</p>
      ) : sparkline && sparkline.length > 1 ? (
        // Divisor PUNTEADO (dirección 16-ago-2026, ref. shadcn-dashboard): la
        // textura que separa la cifra de su contexto secundario.
        <div className="mt-2 pt-2 flex items-center gap-2" style={{ borderTop: '1px dashed var(--line2)' }}>
          <div className="flex-1 min-w-0"><Sparkline valores={sparkline} alto={20} /></div>
          {tendencia !== undefined && <Tendencia valor={tendencia} />}
        </div>
      ) : null}
      {nota && <p className="text-xs mt-2" style={{ color: 'var(--faint)' }}>{nota}</p>}
    </div>
  );
}

/**
 * Blanco de toque de las flechas ‹ › de periodo (auditoría 28, FE-M5): un
 * SOLO literal para que `kpi-periodo.tsx` y `motor-fiscal-periodo.tsx` no
 * vuelvan a divergir (venían con la MISMA clase copiada en los dos
 * archivos, `w-4 h-4` = 16×16 CSS px, por debajo del mínimo 24×24 de WCAG
 * 2.5.8 — en una tablet el dedo cae en la flecha vecina). El ícono sigue
 * chico (12-13px, se centra solo con `items-center justify-center`); la
 * caja real crece a `w-6 h-6` (24px) y `-m-1` le resta 4px por lado al
 * espacio que reserva en el flujo, dejando el layout EXACTO de antes
 * (16px netos) para que las tarjetas de `MotorFiscalPeriodo` no crezcan de
 * alto — la fila padre las estira parejas a la más alta de las tres
 * ("Diésel elegible" incluida), así que un pixel de más aquí se contagia a
 * las otras dos. Usa `gap-3` (12px) entre las dos flechas, no menos: con el
 * margen negativo, un gap menor deja las dos cajas de 24px pisándose.
 */
export const BOTON_PERIODO =
  'w-6 h-6 -m-1 rounded flex items-center justify-center transition-colors disabled:opacity-30 hover:bg-[color-mix(in_srgb,var(--muted)_14%,transparent)] disabled:hover:bg-transparent';

// ── StatCard (12-ago-2026) ────────────────────────────

/** La stat card: chip de ícono neutro + etiqueta
 *  arriba, la CIFRA grande en tinta, y el delta como TEXTO verde/rojo bajo
 *  un hairline ("+12% vs periodo anterior"), no como pill.
 *  Reemplaza a `KpiDegradado` (7-ago) en todo el producto.
 *
 *  `delta.bueno` lo decide el LLAMADOR — gastar más no es buena noticia
 *  aunque el número suba. Sin dato comparable el llamador OMITE el delta:
 *  un "0.0%" inventado afirmaría "sin cambio", que no es lo mismo que "no
 *  se pudo comparar". La diferencia con `KpiTile` (que sigue viva en
 *  /admin): jerarquía cifra-primero y el slot `flechas` para los ‹ › de
 *  periodo de /dashboard. */
export function StatCard({
  icono, etiqueta, valor, formato = 'numero', delta, deltaNota = 'vs periodo anterior', flechas, nota,
  sinDato = 'sin dato en este periodo',
}: {
  icono: React.ReactNode;
  etiqueta: string;
  /** `null` = NO MEDIBLE (auditoría 1, CRÍTICO frontend): la tarjeta pinta "—"
   *  y lo dice, en vez de colapsar a `0` un valor que el backend dejó `null` a
   *  propósito (p. ej. costo por viaje con 0 viajes). Un $0.00 fabricado rompe
   *  la regla #1 del producto. `0` sigue siendo un cero REAL, medido. */
  valor: number | null;
  formato?: FormatoPreset;
  /** El pie cuando `valor` es `null`: por qué no hay cifra. */
  sinDato?: string;
  /** `{ pct, bueno }` — misma forma que tenía `KpiDegradado.tendencia`. */
  delta?: { pct: number; bueno: boolean } | null;
  deltaNota?: string;
  /** Los ‹ › de `KpiPeriodo` — viven aquí para que el layout no se duplique
   *  en cada llamador que necesite paginar el periodo. */
  flechas?: React.ReactNode;
  /** Nota fija de una línea (cita legal, aclaración del supuesto). */
  nota?: string;
}) {
  const reducido = usePrefersReducedMotion();
  // `useCountUp` es un hook: corre SIEMPRE, aunque el valor sea no-medible.
  const mostrado = useCountUp(valor ?? 0, !reducido);
  const fmt = resolverFormato(formato);
  const noMedible = valor === null;
  return (
    // La anatomía EXACTA de la referencia: tarjeta blanca con una CAJA
    // INTERNA tenue (ícono + etiqueta + cifra) y el delta como línea de
    // texto DEBAJO de la caja, dentro de la tarjeta. El chip del ícono es
    // oscuro (--marca) con el glifo claro, como en la foto.
    <div className="card p-2 h-full flex flex-col min-w-0">
      <div className="rounded-xl px-3 py-2 min-w-0" style={{ background: 'var(--canvas)', border: '1px solid var(--line2)' }}>
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--marca)', color: 'var(--marca-fg)' }}>
            {icono}
          </div>
          <div className="text-[13px] min-w-0 flex-1 line-clamp-2" style={{ color: 'var(--muted)' }}>{etiqueta}</div>
          {flechas}
        </div>
        {/* No medible → un guion en gris, NUNCA un 0 con cara de medición. */}
        {/* Misma regla de ancho que KpiTile (escala 50k): recorte con "…" y
            la cifra completa en `title`; nunca se desborda de la tarjeta. */}
        <div className="font-display text-[20px] leading-tight font-semibold tabular mt-0.5 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
          title={noMedible ? undefined : fmt(valor ?? 0)}
          style={noMedible ? { color: 'var(--faint)' } : undefined}>
          {noMedible ? '—' : fmt(mostrado)}
        </div>
      </div>
      {/* El espaciador alinea los pies en una fila de tarjetas parejas
          (`h-full`) aunque una etiqueta envuelva a dos líneas. */}
      <div className="grow" />
      {/* El PIE va tras un divisor PUNTEADO (dirección 16-ago-2026, ref.
          shadcn-dashboard): la textura distintiva que separa la cifra de su
          lectura secundaria. Solo existe cuando hay pie que separar. */}
      {noMedible ? (
        // No hay cifra, así que tampoco hay tendencia que enseñar: se DICE por
        // qué (auditoría 1), en vez del "0% · sin movimiento" que leía como
        // "medí y no cambió".
        <p className="text-xs mx-1.5 mt-1.5 pt-1.5 pb-0" style={{ borderTop: '1px dashed var(--line2)', color: 'var(--faint)' }}>{sinDato}</p>
      ) : delta ? (
        <div className="mx-1.5 mt-1.5 pt-1.5 pb-0 text-xs flex items-baseline gap-1.5 min-w-0" style={{ borderTop: '1px dashed var(--line2)' }}>
          {/* Un 0% real (comparó y no cambió) va en gris neutro, no en verde
              ni rojo: "no se movió" no es buena ni mala noticia. */}
          <span className="font-medium tabular shrink-0"
            style={{ color: delta.pct === 0 ? 'var(--faint)' : delta.bueno ? 'var(--ok)' : 'var(--bad)' }}>
            {delta.pct === 0 ? '' : delta.pct > 0 ? '↑ ' : '↓ '}{Math.abs(delta.pct)}%
          </span>
          <span className="truncate" style={{ color: 'var(--faint)' }}>{delta.pct === 0 ? 'sin cambio vs periodo anterior' : deltaNota}</span>
        </div>
      ) : nota ? (
        <p className="text-xs mx-1.5 mt-1.5 pt-1.5 pb-0" style={{ borderTop: '1px dashed var(--line2)', color: 'var(--faint)' }}>{nota}</p>
      ) : delta === null ? (
        // Se intentó comparar y no hay contra qué (`pctCambio` con base 0, o
        // el bucket único de "histórico"): el pie no se queda vacío (pedido
        // del 12-ago), pero DICE que no hubo comparación. AUDITORÍA 18 (A12):
        // aquí se imprimía "0% · sin movimiento", que afirma "medí y no
        // cambió" — justo lo que el contrato de arriba prohíbe. Con `delta`
        // OMITIDO (undefined) no se pinta nada — métricas sin concepto de
        // comparativo (Diésel) van limpias, pedido del mismo día.
        <p className="text-xs mx-1.5 mt-1.5 pt-1.5 pb-0" style={{ borderTop: '1px dashed var(--line2)', color: 'var(--faint)' }}>sin periodo comparable</p>
      ) : null}
    </div>
  );
}

// ── WidgetUso (ref. shadcn-dashboard "plan usage", 16-ago-2026) ──────────

/** La tarjeta de uso al pie del sidebar — el patrón "Basic Plan · 68/100"
 *  de la referencia, con la regla de la casa: SIEMPRE dato medido. El
 *  llamador que no pudo leer pasa `valor: null` y la tarjeta lo DICE —
 *  jamás un $0 o un 0% con cara de medición. En /admin mide el costo de IA
 *  del mes; en /dashboard, el presupuesto diario de análisis del tenant.
 *  El widget de PLAN real llega cuando exista suscripción real (DESIGN §3). */
export function WidgetUso({ etiqueta, valor, detalle, tope, href, hrefTexto = 'Ver' }: {
  /** Micro-rótulo mono uppercase: "COSTO DE IA · AGOSTO". */
  etiqueta: string;
  /** La cifra YA formateada por el llamador (lib/formato) — `null` = no se
   *  pudo leer, y se dice. */
  valor: string | null;
  detalle?: string;
  /** Barra de progreso usado/límite (misma unidad). Omitida, no hay barra. */
  tope?: { usado: number; limite: number } | null;
  href?: string;
  hrefTexto?: string;
}) {
  const pct = tope && tope.limite > 0 ? Math.min(100, Math.round((tope.usado / tope.limite) * 100)) : null;
  return (
    <div className="hairline rounded-xl p-2.5 mb-1 sb-texto" style={{ background: 'var(--surface)' }}>
      <div className="etiqueta-mono text-[9.5px] uppercase" style={{ color: 'var(--faint)' }}>{etiqueta}</div>
      {valor === null ? (
        <p className="text-[11.5px] mt-1" style={{ color: 'var(--muted)' }}>No se pudo leer ahora mismo.</p>
      ) : (
        <>
          {/* El sidebar mide ~200 px: un USD de 7 cifras cabe, uno de 10 no.
              Recorte de ancho con la cifra completa en `title` (escala 50k). */}
          <div className="font-display text-[17px] font-semibold tabular leading-tight mt-0.5 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" title={valor}>{valor}</div>
          {pct !== null && (
            <div className="mt-1.5 h-1 rounded-full overflow-hidden" style={{ background: 'var(--line2)' }}>
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: 'var(--marca)' }} />
            </div>
          )}
          {detalle && <p className="text-[10.5px] mt-1" style={{ color: 'var(--faint)' }}>{detalle}</p>}
        </>
      )}
      {href && (
        <a href={href} className="inline-block text-[10.5px] font-medium mt-1 hover:opacity-70 transition-opacity">{hrefTexto} →</a>
      )}
    </div>
  );
}

// ── VerMas (botón fantasma, ref. shadcn-dashboard 16-ago-2026) ───────────

/** El "Ver estadísticas →" fantasma que vive BAJO un grupo de métricas y
 *  lleva a la pantalla (o ancla) donde se profundiza — el pariente chico del
 *  link del `BannerInsight`. Es `<a>` y no `Link` a propósito: la mitad de
 *  sus destinos son anclas (`#estadisticas`) en la misma página. */
export function VerMas({ href, children = 'Ver estadísticas' }: { href: string; children?: React.ReactNode }) {
  return (
    <a href={href}
      className="hairline inline-flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-full transition-colors hover:bg-[var(--canvas)]"
      style={{ background: 'var(--surface)', color: 'var(--ink2)' }}>
      {children} <ArrowRight width={12} height={12} strokeWidth={1.75} style={{ color: 'var(--muted)' }} />
    </a>
  );
}

// ── StatusPill / Semaphore ───────────────────────────────────────────────

export type Estado = 'ok' | 'warn' | 'bad' | 'neutral';

const ESTILO_ESTADO: Record<Estado, { bg: string; fg: string; label: string }> = {
  ok: { bg: 'var(--okbg)', fg: 'var(--ok)', label: 'OK' },
  warn: { bg: 'var(--warnbg)', fg: 'var(--warn)', label: 'Atención' },
  bad: { bg: 'var(--badbg)', fg: 'var(--bad)', label: 'Error' },
  neutral: { bg: 'var(--canvas)', fg: 'var(--muted)', label: '—' },
};

/** Nunca color solo — siempre trae texto (label o children), para no
 *  depender de percibir el matiz (regla del skill de dataviz). */
export function StatusPill({ estado, children }: { estado: Estado; children?: React.ReactNode }) {
  const e = ESTILO_ESTADO[estado];
  return (
    <span className="text-xs font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1.5 shrink-0"
      style={{ background: e.bg, color: e.fg }}>
      {children ?? e.label}
    </span>
  );
}

export function Semaphore({ estado, etiqueta }: { estado: Estado; etiqueta?: string }) {
  const e = ESTILO_ESTADO[estado];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: e.fg }}>
      <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: e.fg }} />
      {etiqueta}
    </span>
  );
}

// ── ChartCard ────────────────────────────────────────────────────────────

const ALTURA_TAMANO = { S: 120, M: 200, L: 280, XL: 380 } as const;

export function ChartCard({
  titulo, subtitulo, tamano = 'M', soft = false, accion, children,
}: {
  titulo: string;
  subtitulo?: string;
  tamano?: keyof typeof ALTURA_TAMANO;
  /** Variante "soft": fondo --canvas2 en vez de blanco puro, sin sombra —
   *  para piezas secundarias que no deben competir con la dominante. */
  soft?: boolean;
  accion?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl p-4"
      style={soft
        ? { background: 'var(--canvas2)', border: '1px solid var(--line2)' }
        : { background: 'var(--panel)', border: '1px solid var(--line)', boxShadow: 'var(--shadow-card)' }}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          {/* Mismo criterio que `KpiTile.etiqueta`: "El gasto del periodo, por
              su suerte fiscal" se cortaba a media palabra con `truncate` —
              `line-clamp-2` lo deja envolver antes de recortar. */}
          <h3 className="text-xs font-semibold uppercase tracking-wide line-clamp-2" style={{ color: 'var(--muted)' }}>{titulo}</h3>
          {subtitulo && <p className="text-xs mt-0.5" style={{ color: 'var(--faint)' }}>{subtitulo}</p>}
        </div>
        {accion}
      </div>
      <div style={{ minHeight: ALTURA_TAMANO[tamano] }}>{children}</div>
    </div>
  );
}

// ── Estados: vacío / error / carga ───────────────────────────────────────

/** El mismo bloque "sin datos suficientes" que ya se repetía a mano en
 *  cada página — consolidado aquí (§H: "no gráficas/widgets ad-hoc por
 *  página"). Nunca rellena con datos de ejemplo. */
export function EstadoVacio({ icono, children }: { icono?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="card p-4">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--canvas)', border: '1px solid var(--line)' }}>
          {icono ?? <Info width={17} height={17} strokeWidth={1.75} style={{ color: 'var(--marca)' }} />}
        </div>
        <p className="text-sm pt-1">{children}</p>
      </div>
    </div>
  );
}

/**
 * `onReintentar` es OPCIONAL y con default interno (`router.refresh()`) a
 * propósito: así una página Server Component puede escribir
 * `<EstadoError mensaje="..." />` sin pasar ninguna función — pasar un
 * callback de un Server Component a este Client Component revienta en
 * build ("Event handlers cannot be passed to Client Component props").
 * Un caller que YA es cliente sí puede pasar su propio reintento si
 * "refrescar la página" no es lo que quiere.
 */
export function EstadoError({ mensaje, onReintentar }: { mensaje: string; onReintentar?: () => void }) {
  const router = useRouter();
  const reintentar = onReintentar ?? (() => router.refresh());
  return (
    <div className="card p-4">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--badbg)' }}>
          <AlertTriangle width={17} height={17} strokeWidth={1.75} style={{ color: 'var(--bad)' }} />
        </div>
        <div className="flex-1 pt-0.5">
          <p className="text-sm">{mensaje}</p>
          <button type="button" onClick={reintentar}
            className="mt-2 text-xs font-medium px-3 py-1.5 rounded-full hairline hover:opacity-70 transition-opacity">
            Reintentar
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * El banner de insight (patrón "Update" de shadcn,
 * 16-ago-2026): UNA noticia del periodo con cifra REAL y un link a donde
 * se profundiza. La regla que lo gobierna es la del producto entero: el
 * LLAMADOR solo lo monta cuando tiene un dato real que contar — este
 * componente no tiene estado vacío a propósito, porque un insight de
 * relleno ("$0 esta semana") es exactamente el ruido que no se pinta.
 * `deltaPct` viene de `pctCambio` y llega `null` sin comparable: el chip
 * se omite, nunca un "0%" con cara de medición.
 */
export function BannerInsight({ etiqueta, deltaPct, href, hrefTexto = 'Ver estadísticas', children }: {
  /** Micro-rótulo mono uppercase: "ESTA SEMANA", "ESTE MES". */
  etiqueta: string;
  /** % de cambio real vs el periodo anterior, o `null` si no hay comparable. */
  deltaPct: number | null;
  /** A dónde se profundiza (ancla o ruta). */
  href: string;
  hrefTexto?: string;
  /** La frase con la cifra ya formateada por el llamador (lib/formato). */
  children: React.ReactNode;
}) {
  return (
    <div className="card p-3 flex items-center gap-2.5">
      <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--ok)' }} />
      <span className="etiqueta-mono shrink-0" style={{ color: 'var(--muted)' }}>{etiqueta}</span>
      {/* ESCALA 50k (22-ago-2026): aquí había `truncate`, y la frase trae un
          MONTO ("Tu flota liquidó $12,345,678.90…"): a un ancho justo se
          mutilaba justo la cifra. Ahora envuelve a una segunda línea; lo que
          no se parte es el monto en sí, que el llamador manda en un <b> y
          aquí se protege con `[&_b]:whitespace-nowrap`. */}
      <span className="text-[13px] min-w-0 flex-1 break-words [&_b]:whitespace-nowrap">{children}</span>
      {deltaPct !== null && (
        <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-full shrink-0 tabular"
          style={deltaPct >= 0
            ? { color: 'var(--ok)', background: 'var(--okbg)' }
            : { color: 'var(--bad)', background: 'var(--badbg)' }}>
          {/* Sin toLocaleString: el formato vive SOLO en lib/formato (la
              prueba de formato.test.ts caza cualquier copia) — y un % a un
              decimal se pinta igual que el delta de StatCard, directo. */}
          {deltaPct >= 0 ? '↑' : '↓'} {Math.abs(Math.round(deltaPct * 10) / 10)}% vs periodo anterior
        </span>
      )}
      <a href={href} className="ml-auto text-[11px] font-medium shrink-0 hover:opacity-70 transition-opacity">
        {hrefTexto} →
      </a>
    </div>
  );
}

/** Shimmer, no spinner (§E). `filas`/`alto` cubren tanto una lista de KPI
 *  (pocas filas cortas) como el cuerpo de una gráfica (una sola fila alta). */
export function EstadoCargando({ filas = 3, alto = 14 }: { filas?: number; alto?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: filas }).map((_, i) => (
        <div key={i} className="skeleton rounded-md" style={{ height: alto, width: i === filas - 1 ? '60%' : '100%' }} />
      ))}
    </div>
  );
}
