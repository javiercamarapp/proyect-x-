import Link from 'next/link';
import {
  MessagesSquare, Send, CheckCheck, Flag, MapPin, Package, Truck, Sparkles,
} from 'lucide-react';
import type { EventoConductor } from '@/lib/likida/analytics';
import { HORAS_PARA_ESCALAR } from '@/lib/likida/escalar_viaje';
import { numero, fechaCorta } from '@/lib/formato';
import { BarraPagina } from '../../resumen-visual';
import { Bloque, Barra, EsqTabla } from '../../bloque';

export interface EsperaAceptar {
  id: string;
  folio: string;
  operadorNombre: string | null;
  /** Horas COMPLETAS desde el aviso — medidas, se rotulan así. */
  horasDesdeAviso: number;
  avisos: number;
}

/** Cómo se lee cada sello en la bitácora. Un tipo nuevo cae al crudo. */
const EVENTO: Record<EventoConductor['tipo'], { Icono: typeof Send; texto: (e: EventoConductor) => string; color: string }> = {
  avisado: { Icono: Send, color: 'var(--muted)', texto: (e) => `Le avisó a ${e.operador ?? 'el operador'} de su viaje ${e.folio}` },
  acepto: { Icono: CheckCheck, color: 'var(--ok)', texto: (e) => `${e.operador ?? 'El operador'} aceptó el viaje ${e.folio}` },
  escalado: { Icono: Flag, color: 'var(--bad)', texto: (e) => `Escaló el viaje ${e.folio} al jefe — nadie aceptaba` },
  llegada: { Icono: MapPin, color: 'var(--ok)', texto: (e) => `${e.operador ?? 'El operador'} avisó que llegó (${e.folio})` },
  descarga: { Icono: Package, color: 'var(--warn)', texto: (e) => `${e.operador ?? 'El operador'} está descargando (${e.folio})` },
  regreso: { Icono: Truck, color: 'var(--muted)', texto: (e) => `${e.operador ?? 'El operador'} va de regreso (${e.folio})` },
};

/** Los cuatro conteos de arriba, ya medidos en la base. */
export interface ConteosConductores {
  vivos: number | null;
  aceptados: number | null;
  esperan: number | null;
  escalados: number | null;
}

/** La cola listada y lo que hace falta para rotularla honestamente. */
export interface ColaConductores {
  esperan: EsperaAceptar[];
  /** Cuántos hay en TODA la flota (`count` en la base). `null` = no se pudo
   *  contar; sin él no se puede declarar la diferencia con lo listado. */
  totalEsperan: number | null;
  /** Vivos SIN aviso — el fallo silencioso que se enseña. `null` = no se
   *  pudo contar, y entonces no se pinta la frase. */
  sinAvisar: number | null;
  /** FE-6: `viajesEsperandoAceptarPaginados` no lanza — un fallo viaja aquí,
   *  para que la sección lo diga en vez de pintar "nadie debe respuesta". */
  error: string | null;
  /** FE-B1 (auditoría 28): `Pagina.truncada` de `viajesEsperandoAceptarPaginados`
   *  — `true` cuando el total real rebasa lo que esta paginación alcanza a
   *  recorrer (`paginaMax * porPagina`, repo_paginado.ts). Esta pantalla no
   *  ofrece "Siguiente" (no hay navegación por página aquí), pero sin
   *  declarar esto el jefe de tráfico no sabe que la lectura misma tiene un
   *  techo — no solo lo que se lista de esta vuelta. `undefined`/`false` =
   *  no truncado (u origen que todavía no manda el campo). */
  truncada?: boolean;
}

/**
 * La ventana del Agente de Conductores (F4): la cola honesta de aceptación,
 * la bitácora de todo lo que selló, y la carta de lo que entiende por
 * WhatsApp — que es la verdad del código, no marketing. Sin pesos: es la
 * pantalla del jefe de tráfico.
 *
 * FE-14 (22-ago-2026): recibe PROMESAS y monta un boundary por sección. Lo
 * que más se nota es "Lo que entiende por WhatsApp": es texto fijo, no lee
 * nada, y hasta hoy esperaba detrás de los cuatro `count` de la flota.
 */
export function VistaAgenteConductores({
  kpis, cola, eventos, sufijo = '', notificaciones,
}: {
  /** FE-5: los cuatro salen de `count` en la base, no de filtrar las 100
   *  filas más recientes en memoria. `null` = no se pudo contar → "—". */
  kpis: Promise<ConteosConductores>;
  cola: Promise<ColaConductores>;
  eventos: Promise<EventoConductor[] | null>;
  sufijo?: string;
  /** La sección de Notificaciones, ya renderizada en el servidor
   *  (`SeccionNotificaciones`). Entra como ReactNode y no como datos: esta
   *  vista no debe importar el motor de avisos, que trae `supabaseAdmin`. */
  notificaciones?: React.ReactNode;
}) {
  return (
    <main className="h-full">
      <div className="rounded-2xl min-h-full hairline flex flex-col" style={{ background: 'var(--g1)' }}>
        <BarraPagina
          icono={<MessagesSquare width={15} height={15} strokeWidth={1.75} style={{ color: 'var(--muted)' }} />}
          titulo="Comunicación con operadores"
        />
        <div className="px-5 py-5 flex-1 space-y-4">

          <Bloque mensaje="No se pudieron leer los conteos de la flota." esqueleto={<EsqConteos />}>
            <BloqueConteos kpis={kpis} />
          </Bloque>

          <div className="grid lg:grid-cols-2 gap-4">
            <Bloque mensaje="No se pudo leer la cola de aceptación." esqueleto={<EsqTabla filas={4} />}>
              <BloqueCola cola={cola} sufijo={sufijo} />
            </Bloque>
            <Bloque mensaje="No se pudo leer la bitácora." esqueleto={<EsqTabla filas={4} />}>
              <BloqueBitacora eventos={eventos} />
            </Bloque>
          </div>

          {/* Lo que entiende — la verdad del código, como onboarding. Texto
              fijo: sale con el primer flush, sin esperar a una sola consulta. */}
          <section className="card p-4">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles width={14} height={14} strokeWidth={1.75} style={{ color: 'var(--marca)' }} />
              <h2 className="font-display text-[15px] font-semibold">Lo que entiende por WhatsApp</h2>
            </div>
            <div className="grid md:grid-cols-3 gap-4 text-[12.5px]">
              <div>
                <div className="etiqueta-mono text-[10px] uppercase mb-1.5" style={{ color: 'var(--faint)' }}>El chofer avisa</div>
                <p style={{ color: 'var(--muted)' }}>
                  «ya llegué» · «estoy descargando» · «voy de regreso» — cada uno queda
                  sellado con su hora. Y cada foto de recibo se anota sola en su viaje.
                </p>
              </div>
              <div>
                <div className="etiqueta-mono text-[10px] uppercase mb-1.5" style={{ color: 'var(--faint)' }}>El jefe despacha</div>
                <p style={{ color: 'var(--muted)' }}>
                  «nuevo viaje para Juan Pérez, Puebla a Monterrey, anticipo 8000» —
                  el agente confirma antes de crear, y al confirmar el chofer recibe su aviso.
                </p>
              </div>
              <div>
                <div className="etiqueta-mono text-[10px] uppercase mb-1.5" style={{ color: 'var(--faint)' }}>Solo, sin que nadie pida</div>
                <p style={{ color: 'var(--muted)' }}>
                  Persigue la aceptación del viaje y a las {HORAS_PARA_ESCALAR} horas sin respuesta
                  escala al jefe. Corre con las reglas de fábrica — aún no tiene estrategia editable.
                </p>
              </div>
            </div>
          </section>

          {notificaciones}
        </div>
      </div>
    </main>
  );
}

/** Cuatro tarjetas de cifra y su pie — el mismo bulto que las reales. */
function EsqConteos() {
  return (
    <div role="status" aria-label="Cargando">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card p-3.5">
            <Barra alto={10} ancho="55%" />
            <div className="mt-1.5"><Barra alto={20} ancho="60%" /></div>
            <div className="mt-1"><Barra alto={11} ancho="45%" /></div>
          </div>
        ))}
      </div>
      <div className="mt-2"><Barra alto={11} ancho="70%" /></div>
    </div>
  );
}

async function BloqueConteos({ kpis: p }: { kpis: Promise<ConteosConductores> }) {
  const kpis = await p;
  return (
    <div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi titulo="Viajes en curso" valor={kpis.vivos === null ? '—' : numero(kpis.vivos)}
          nota={kpis.vivos === null ? 'no se pudo contar' : 'abiertos o en cuadre'} />
        <Kpi titulo="Aceptados" valor={kpis.aceptados === null ? '—' : numero(kpis.aceptados)}
          nota={kpis.aceptados === null ? 'no se pudo contar' : 'el chofer dijo que sí'} />
        <Kpi titulo="Esperan aceptar" valor={kpis.esperan === null ? '—' : numero(kpis.esperan)}
          nota={kpis.esperan === null ? 'no se pudo contar' : undefined}
          tono={(kpis.esperan ?? 0) > 0 ? 'warn' : undefined} />
        <Kpi titulo="Escalados" valor={kpis.escalados === null ? '—' : numero(kpis.escalados)}
          nota={kpis.escalados === null ? 'no se pudo contar' : 'esperan cambio de chofer'}
          tono={(kpis.escalados ?? 0) > 0 ? 'bad' : undefined} />
      </div>
      {/* FE-5: aquí decía "se calculan sobre los 100 viajes más
          recientes" — un rótulo honesto sobre una cifra inútil (a 50k
          viajes/mes, 100 filas son ~90 minutos). Los cuatro conteos
          ahora salen de la base y cubren TODOS los viajes en curso de
          la flota; lo único acotado es la LISTA de abajo, que lo dice
          en su propio pie. */}
      <p className="text-[11px] mt-2" style={{ color: 'var(--faint)' }}>
        Los cuatro conteos son de toda la flota: los tres primeros sobre los viajes en curso
        (abiertos o en cuadre), Escalados sobre todo el histórico.
      </p>
    </div>
  );
}

/** Exportado para pruebas: `renderToStaticMarkup` no monta `<Bloque>`
 *  (Suspense de servidor), así que la prueba de FE-6 llama esta pieza
 *  directamente con la promesa ya resuelta. */
export async function BloqueCola({ cola, sufijo }: {
  cola: Promise<ColaConductores>; sufijo: string;
}) {
  const { esperan, totalEsperan, sinAvisar, error, truncada = false } = await cola;
  return (
    /* La cola honesta de aceptación */
    <section className="card p-4 flex flex-col">
      <h2 className="font-display text-[15px] font-semibold mb-1">Esperan aceptar</h2>
      <p className="text-[11px] mb-3" style={{ color: 'var(--faint)' }}>
        Avisados sin respuesta — a las {HORAS_PARA_ESCALAR} horas el agente escala al jefe solo
      </p>
      {error !== null ? (
        <Leyenda>No se pudo leer la cola de aceptación ahora mismo.</Leyenda>
      ) : esperan.length === 0 ? (
        <Leyenda>Nadie debe respuesta ahora mismo — cada viaje avisado
          está aceptado o ya se escaló.</Leyenda>
      ) : (
        <div className="space-y-2">
          {esperan.map((v) => (
            <div key={v.id} className="flex items-center gap-2.5 text-[12.5px]">
              <span className="font-medium">{v.folio}</span>
              <span className="truncate" style={{ color: 'var(--muted)' }}>{v.operadorNombre ?? 'Sin operador'}</span>
              <span className="ml-auto shrink-0 cifra-mono" style={{ color: v.horasDesdeAviso >= HORAS_PARA_ESCALAR ? 'var(--warn)' : 'var(--muted)' }}>
                {v.horasDesdeAviso === 0 ? 'hace menos de 1 h' : `hace ${numero(v.horasDesdeAviso)} h`}
              </span>
              {v.avisos > 1 && (
                <span className="shrink-0 inline-flex px-2 py-0.5 rounded-full text-[10.5px] font-medium"
                  style={{ color: 'var(--muted)', background: 'var(--canvas)' }}>×{v.avisos}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {/* Cuántas filas se listan de cuántas hay. La lista sale de los
          100 viajes recientes (para decir "hace N horas" hace falta la
          fila); el conteo de arriba es el de la flota. Callar la
          diferencia haría que la lista pareciera la cola completa. */}
      {/* FE-6: la lista ya viene ordenada por antigüedad del aviso (el más
          urgente primero) — lo que sobra del tope son los avisados hace MENOS
          tiempo, no viajes "más antiguos" que la lista no alcanzó a leer. */}
      {totalEsperan !== null && totalEsperan > esperan.length && (
        <p className="text-[11px] mt-2" style={{ color: 'var(--faint)' }}>
          Se listan {numero(esperan.length)} de {numero(totalEsperan)}, los más urgentes primero — el resto
          espera menos tiempo; están en el <Link href={`/dashboard/viajes${sufijo}`} className="underline">registro</Link>.
        </p>
      )}
      {sinAvisar !== null && sinAvisar > 0 && (
        <p className="text-[12px] mt-3 pt-2.5 border-t" style={{ color: 'var(--warn)', borderColor: 'var(--line2)' }}>
          {numero(sinAvisar)} viaje{sinAvisar === 1 ? '' : 's'} en curso SIN aviso —
          el botón Avisar vive en <Link href={`/dashboard/despacho${sufijo}`} className="underline">Despacho</Link>.
        </p>
      )}
      {/* FE-B1: aquí no hay "Siguiente" que quede muerto (esta pantalla no
          pagina por URL), pero sin esto la lectura tenía un techo que nunca
          se decía — mismo patrón que `despacho/vista.tsx` y
          `descarga-sat/bandeja/vista.tsx`. */}
      {truncada && (
        <p className="text-[12px] mt-3 pt-2.5 border-t" style={{ color: 'var(--warn)', borderColor: 'var(--line2)' }}>
          Esta lista no alcanza a traerlos a todos: hay más esperando aceptar de los que una sola
          lectura puede recorrer — revisa el{' '}
          <Link href={`/dashboard/viajes${sufijo}`} className="underline">registro</Link> para lo que
          sobra.
        </p>
      )}
    </section>
  );
}

async function BloqueBitacora({ eventos: p }: { eventos: Promise<EventoConductor[] | null> }) {
  const eventos = await p;
  return (
    /* Bitácora */
    <section className="card p-4 flex flex-col">
      <h2 className="font-display text-[15px] font-semibold mb-1">Bitácora</h2>
      <p className="text-[11px] mb-3" style={{ color: 'var(--faint)' }}>
        Los últimos sellos, sobre los 60 viajes más recientes
      </p>
      {eventos === null ? (
        <Leyenda>No se pudo leer la bitácora ahora mismo.</Leyenda>
      ) : eventos.length === 0 ? (
        <Leyenda>Aún sin actividad — cada aviso, aceptación, escalación
          o hito del chofer queda escrito aquí.</Leyenda>
      ) : (
        <div className="space-y-2.5 text-[12.5px]">
          {eventos.map((e, i) => {
            const cfg = EVENTO[e.tipo];
            return (
              <div key={i} className="flex items-start gap-2">
                <cfg.Icono width={13} height={13} strokeWidth={1.75} className="mt-0.5 shrink-0" style={{ color: cfg.color }} />
                <div className="min-w-0">
                  <span>{cfg.texto(e)}</span>
                  <span className="block text-[11px]" style={{ color: 'var(--faint)' }}>{fechaCorta(e.cuando)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Leyenda({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 min-h-[110px] flex items-center justify-center">
      <p className="text-[12.5px] text-center max-w-[34ch]" style={{ color: 'var(--muted)' }}>{children}</p>
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
