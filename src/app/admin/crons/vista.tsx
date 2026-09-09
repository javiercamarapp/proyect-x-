import { AlarmClock, Power, TriangleAlert } from 'lucide-react';
import { fechaHoraMx } from '@/lib/formato';
import { CRONS, TOLERANCIA_LATIDO_MS, type CronId, type LatidoDetallado } from '@/lib/admin/salud';
import { StatusPill, EstadoError, type Estado } from '../ui/kit';
import { BarraPagina, TituloSeccion } from '../../dashboard/resumen-visual';

/**
 * LOS RELOJES DEL SISTEMA — el render.
 *
 * Cuántos son NO se escribe aquí: sale de `CRONS`, la constante que
 * `salud.test.ts` cruza contra vercel.json y contra el CHECK de la base. Eran
 * siete, luego nueve, y con el registro de jornada (0241) son diez — un
 * número escrito a mano en esta pantalla habría envejecido tres veces.
 *
 * `cron_latido` (0155) lleva meses guardando el pulso de cada cron y hasta hoy
 * el único que lo leía era `/api/health`, que contesta un booleano agregado
 * (`checks.crons: 'ok'|'degraded'|'unknown'`) porque es un endpoint público: a
 * quien pregunta desde fuera no se le dice qué reloj se paró. El dato existía
 * y nadie podía verlo — para saber por qué no salió una liquidación había que
 * abrir los logs de Vercel.
 *
 * Esta pantalla es el otro lado de ese mismo dato: aquí sí se dice cuál, desde
 * cuándo y por qué.
 *
 * LO QUE NO HACE: no dispara un cron a mano. Un cron que se puede lanzar desde
 * el panel es un cron que corre dos veces —el reloj de Vercel no se entera de
 * que alguien le ganó— y varios de estos motores (`facturar`, `runner`)
 * reservan filas: dos pasadas simultáneas se pisan. Se OBSERVA aquí y se
 * APAGA en Observabilidad, que es donde vive la palanca.
 */

/** El id de `cron_latido` es el último segmento de la ruta en vercel.json. */
const RUTA: Record<CronId, string> = {
  'wa-pendientes': '/api/cron/wa-pendientes',
  'wa-outbox': '/api/cron/wa-outbox',
  escalar: '/api/cron/escalar',
  facturar: '/api/cron/facturar',
  purgar: '/api/cron/purgar',
  runner: '/api/cron/runner',
  gps: '/api/cron/gps',
  asistencia: '/api/cron/asistencia',
  'descarga-sat': '/api/cron/descarga-sat',
  jornada: '/api/cron/jornada',
  'portales-vivos': '/api/cron/portales-vivos',
};

/** Qué hace cada reloj, en una línea, para que el rojo se pueda priorizar. */
const OFICIO: Record<CronId, string> = {
  'wa-pendientes': 'recoge los mensajes de WhatsApp que llegaron',
  'wa-outbox': 'manda los mensajes de WhatsApp encolados',
  escalar: 'escala lo que lleva demasiado tiempo sin atender',
  facturar: 'pide las facturas de los tickets a los portales',
  purgar: 'borra lo que ya cumplió su retención',
  runner: 'despacha la compañía de agentes',
  gps: 'baja las posiciones de las unidades',
  asistencia: 'vigila las emergencias sin reconocer',
  'descarga-sat': 'recoge del SAT los CFDI que el comercio ya timbró',
  jornada: 'asienta el registro de jornada del día (LFT 132-XXXIV)',
  'portales-vivos': 'comprueba que los portales de facturación sigan en pie',
};

/**
 * El veredicto de `juzgarLatido` como pill.
 *
 * `sin_latido` es ÁMBAR y no rojo a propósito: significa «nunca escribió»,
 * que tanto puede ser un cron recién nacido como uno que no PUEDE escribir
 * (el drift de dominio que arregló la 0242). No es lo mismo que `vencido`,
 * donde sí consta que latía y dejó de hacerlo.
 */
const PILL_SALUD: Record<LatidoDetallado['estado'], { estado: Estado; etiqueta: string }> = {
  ok: { estado: 'ok', etiqueta: 'Latiendo' },
  vencido: { estado: 'bad', etiqueta: 'No late' },
  sin_latido: { estado: 'warn', etiqueta: 'Nunca latió' },
};

/** Lo que el propio cron dijo de su última pasada. */
const PILL_ULTIMO: Record<string, { estado: Estado; etiqueta: string }> = {
  ok: { estado: 'ok', etiqueta: 'OK' },
  parcial: { estado: 'warn', etiqueta: 'Parcial' },
  saltado: { estado: 'neutral', etiqueta: 'Saltado' },
  fallo: { estado: 'bad', etiqueta: 'Fallo' },
};

/** "cada 5 min" / "cada 4 h" / "una vez al día". */
export function cadaCuanto(ms: number): string {
  if (ms < 3_600_000) return `cada ${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return `cada ${Math.round(ms / 3_600_000)} h`;
  return 'una vez al día';
}

/** "hace 3 min" / "hace 2.5 h" / "hace 4 d". `null` = nunca latió. */
export function desdeHace(min: number | null): string {
  if (min === null) return 'nunca';
  if (min < 60) return `hace ${min} min`;
  if (min < 1440) return `hace ${Math.round(min / 6) / 10} h`;
  return `hace ${Math.round(min / 144) / 10} d`;
}

/**
 * El card de arriba promete "el detalle está abajo" para una corrida
 * `parcial` — y para un `fallo` sin `codigo` no hay nada más que decir salvo
 * lo que el propio cron dejó en `detalle`. Sin esto, el renglón caía siempre
 * al guion, contradiciendo la promesa del propio card y la premisa de este
 * archivo: "aquí sí se dice cuál, desde cuándo y por qué". No inventa una
 * interpretación: sólo enseña lo que el cron ya registró, tal cual, sin
 * `codigo` (que ya tiene su propio renglón) ni claves vacías.
 */
export function resumenDetalle(detalle: Record<string, unknown>): string | null {
  const partes = Object.entries(detalle)
    .filter(([clave, valor]) => clave !== 'codigo' && valor !== undefined && valor !== null)
    .map(([clave, valor]): string | null => {
      if (Array.isArray(valor)) return valor.length > 0 ? `${clave}: ${valor.length}` : null;
      if (typeof valor === 'number') return valor > 0 ? `${clave}: ${valor}` : null;
      if (typeof valor === 'string') return valor.trim() !== '' ? `${clave}: ${valor}` : null;
      if (typeof valor === 'boolean') return valor ? clave : null;
      return null;
    })
    .filter((x): x is string => x !== null);
  return partes.length > 0 ? partes.join(' · ') : null;
}

function Renglon({ cron, l }: { cron: CronId; l: LatidoDetallado }) {
  const salud = PILL_SALUD[l.estado];
  const ultimo = l.ultimoEstado === null ? null : PILL_ULTIMO[l.ultimoEstado];
  return (
    <tr className="hairline-t">
      <td className="py-2 pr-3 align-top">
        <div className="font-medium">{cron}</div>
        <div className="text-xs" style={{ color: 'var(--muted)' }}>{OFICIO[cron]}</div>
        <div className="text-xs mt-0.5" style={{ color: 'var(--faint)' }}>{RUTA[cron]}</div>
      </td>
      <td className="py-2 pr-3 align-top text-sm whitespace-nowrap">{cadaCuanto(l.cadenciaMs)}</td>
      <td className="py-2 pr-3 align-top"><StatusPill estado={salud.estado}>{salud.etiqueta}</StatusPill></td>
      <td className="py-2 pr-3 align-top text-sm whitespace-nowrap">
        {/* La fecha exacta ARRIBA y el «hace» debajo: el «hace» se lee de un
            golpe, la fecha es la que se pega en un reporte. */}
        <div>{l.ultimoLatido === null ? '—' : fechaHoraMx(l.ultimoLatido)}</div>
        <div className="text-xs" style={{ color: 'var(--muted)' }}>{desdeHace(l.haceMin)}</div>
      </td>
      <td className="py-2 pr-3 align-top">
        {ultimo === null
          ? <span className="text-sm" style={{ color: 'var(--faint)' }}>—</span>
          : <StatusPill estado={ultimo.estado}>{ultimo.etiqueta}</StatusPill>}
      </td>
      <td className="py-2 align-top text-sm">
        {l.motivoSalto !== null
          ? (
            <span className="inline-flex items-center gap-1.5">
              <Power width={14} height={14} strokeWidth={1.75} style={{ color: 'var(--muted)' }} />
              {l.motivoSalto}
            </span>
          )
          // El código del fallo, si el cron lo dejó (tableros al día,
          // 28-ago-2026): `interruptor_ilegible` y «base caída» son problemas
          // distintos, y hasta hoy el porqué solo vivía en los logs de Vercel.
          : l.ultimoEstado === 'fallo' && typeof l.detalle.codigo === 'string'
          ? (
            <span style={{ color: 'var(--muted)' }}>
              falló con código <code>{l.detalle.codigo}</code>
            </span>
          )
          : l.estado === 'sin_latido'
            ? <span style={{ color: 'var(--muted)' }}>no ha escrito su pulso ni una vez</span>
            : l.estado === 'vencido'
              ? (
                <span style={{ color: 'var(--muted)' }}>
                  debería haber latido {cadaCuanto(l.cadenciaMs)} (+{Math.round(TOLERANCIA_LATIDO_MS / 60_000)} min de tolerancia)
                </span>
              )
              : (l.ultimoEstado === 'parcial' || l.ultimoEstado === 'fallo') && resumenDetalle(l.detalle) !== null
                ? <span style={{ color: 'var(--muted)' }}>{resumenDetalle(l.detalle)}</span>
                : <span style={{ color: 'var(--faint)' }}>—</span>}
      </td>
    </tr>
  );
}

/**
 * El resumen del card superior, puro para poder probarlo. Dos ejes, los
 * MISMOS que /api/health (tableros al día, 28-ago-2026): antes este card solo
 * miraba la cadencia (`estado !== 'ok'`) y un cron que latía puntual
 * reportando `fallo` cada minuto salía en «los 10 relojes latieron» — el
 * panel del operador era más laxo que el endpoint público, que es exactamente
 * al revés de lo que promete esta pantalla.
 */
export function resumenRelojes(lista: Array<{ cron: CronId; l: LatidoDetallado }>): {
  sinLatir: CronId[]; conFallo: CronId[]; parciales: CronId[];
} {
  return {
    sinLatir: lista.filter((x) => x.l.estado !== 'ok').map((x) => x.cron),
    conFallo: lista.filter((x) => x.l.estado === 'ok' && x.l.ultimoEstado === 'fallo').map((x) => x.cron),
    parciales: lista.filter((x) => x.l.estado === 'ok' && x.l.ultimoEstado === 'parcial').map((x) => x.cron),
  };
}

export function VistaCrons({ latidos }: { latidos: Record<CronId, LatidoDetallado> | null }) {
  const lista = latidos === null ? [] : CRONS.map((c) => ({ cron: c, l: latidos[c] }));
  const { sinLatir, conFallo, parciales } = resumenRelojes(lista);
  const malos = [...sinLatir, ...conFallo];

  return (
    <main className="p-5 space-y-5">
      <BarraPagina
        icono={<AlarmClock width={17} height={17} strokeWidth={1.75} style={{ color: 'var(--marca)' }} />}
        titulo="Relojes"
      />

      {latidos === null ? (
        <EstadoError mensaje="No se pudo leer el pulso de los relojes — la base no respondió. Esto NO significa que estén corriendo: significa que ahora mismo no se sabe." />
      ) : (
        <>
          <div className="card p-4">
            {/* El rótulo cuenta lo MEDIDO, no una meta. `CRONS.length` sale de
                la misma constante que vercel.json cruza en `salud.test.ts`, así
                que "de 9" no se queda viejo al alta del décimo. */}
            {malos.length === 0 ? (
              <p className="text-sm">
                Los <strong>{CRONS.length}</strong> relojes latieron dentro de su cadencia
                y ninguno reportó fallo en su última corrida.
                {parciales.length > 0 && (
                  <span style={{ color: 'var(--muted)' }}>
                    {' '}({parciales.join(', ')} {parciales.length === 1 ? 'reportó' : 'reportaron'} corrida parcial — el detalle está abajo.)
                  </span>
                )}
              </p>
            ) : (
              <p className="text-sm inline-flex items-start gap-2">
                <TriangleAlert width={17} height={17} strokeWidth={1.75} style={{ color: 'var(--color-bad)', flexShrink: 0 }} />
                <span>
                  {sinLatir.length > 0 && (
                    <>
                      <strong>{sinLatir.length}</strong> de {CRONS.length} relojes no están latiendo como deberían:{' '}
                      {sinLatir.join(', ')}.{' '}
                    </>
                  )}
                  {conFallo.length > 0 && (
                    <>
                      {conFallo.length === 1 ? 'Un reloj late' : `${conFallo.length} relojes laten`} a tiempo
                      pero su última corrida reportó <strong>fallo</strong>: {conFallo.join(', ')}.
                    </>
                  )}
                </span>
              </p>
            )}
            <p className="text-xs mt-2" style={{ color: 'var(--muted)' }}>
              El pulso lo escribe cada cron al terminar (cron_latido, 0155). Aquí no se
              dispara ninguno a mano: el reloj de Vercel no se entera y varios reservan
              filas — dos pasadas a la vez se pisan. Para apagar uno, su palanca está en
              Observabilidad.
            </p>
          </div>

          <section className="card p-4">
            <TituloSeccion>Uno por uno</TituloSeccion>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr style={{ color: 'var(--muted)' }}>
                    <th className="py-2 pr-3 font-medium">Reloj</th>
                    <th className="py-2 pr-3 font-medium">Cadencia</th>
                    <th className="py-2 pr-3 font-medium">Pulso</th>
                    <th className="py-2 pr-3 font-medium">Último latido</th>
                    <th className="py-2 pr-3 font-medium">Cómo le fue</th>
                    <th className="py-2 font-medium">Por qué</th>
                  </tr>
                </thead>
                <tbody>
                  {lista.map((x) => <Renglon key={x.cron} cron={x.cron} l={x.l} />)}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
