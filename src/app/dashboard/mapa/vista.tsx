import { Map, MapPinOff, Satellite } from 'lucide-react';
import { numero, fechaHoraMx } from '@/lib/formato';
import { BarraPagina } from '../resumen-visual';
import { MapaVivo, type ViajeEnMapa, type PinUnidad } from './mapa-vivo';

export interface SinUbicar {
  id: string;
  folio: string;
  operadorNombre: string | null;
  /** Con las palabras exactas de qué faltó — nunca se omite en silencio. */
  motivo: string;
}

/** El GPS de la flota tal como se pudo leer — o el porqué de que no. */
export interface Rastreo {
  /** `null` = la lectura se completó. Con texto, NADA de lo demás se afirma. */
  error: string | null;
  /** `estado_rastreo_tenant` (0162): cuántas unidades tienen alguna posición. */
  unidadesConPosicion: number | null;
  /** La posición más reciente de TODA la flota (`max(medida_en)`). */
  ultimaPosicion: string | null;
  proveedores: Array<{ proveedor: string; ultimos4: string | null; activo: boolean; probadaEn: string | null; ultimoError: string | null }>;
  /** Salud del poller (0324). `ultimoPoll` es recepción; `ultimaMedida` es el
   * reloj del dispositivo. Nunca se presenta una como si fuera la otra. */
  polls: Array<{
    proveedor: string; recurso: 'posiciones' | 'eventos'; ultimoPoll: string | null;
    ultimoCompleto: string | null; ultimaMedida: string | null;
    backlogPendiente: boolean; paginas: number; elementos: number; error: string | null;
    eventosInvalidosUltima: number; eventosInvalidosTotal: number;
    eventosEnCuarentena: number; eventosCuarentenaMuertos: number;
    eventosOutboxPendientes: number; eventosOutboxMuertos: number;
    avisosPendientes: number; avisosMuertos: number;
  }>;
  /** Una por unidad activa con posición, ya proyectada al viewBox. */
  pines: PinUnidad[];
}

/** A partir de aquí el pin se pinta apagado y la lista lo dice: no es "ahí
 *  está el camión", es "ahí estaba hace rato". Seis horas es más de un turno
 *  de manejo — con eso el camión pudo cruzar medio país. */
export const MINUTOS_POSICION_FRESCA = 360;

/** «Hace 4 h», «hace 2 días» — con la hora exacta siempre al lado, para que
 *  nadie tenga que confiar en el redondeo. */
function antiguedad(minutos: number): string {
  if (minutos < 1) return 'ahora mismo';
  if (minutos < 60) return `hace ${minutos} min`;
  const horas = Math.round(minutos / 60);
  if (horas < 24) return `hace ${horas} h`;
  const dias = Math.round(horas / 24);
  return `hace ${dias} ${dias === 1 ? 'día' : 'días'}`;
}

/**
 * El marco del mapa (F3): KPIs medidos arriba, el mapa vivo al centro, y la
 * lista honesta de lo que NO se pudo ubicar abajo. La leyenda del trayecto
 * ilustrativo vive junto al mapa, no en un tooltip escondido.
 */
export function VistaMapa({ ubicados, sinUbicar, totalVivos, tope, rastreo }: {
  ubicados: ViajeEnMapa[];
  sinUbicar: SinUbicar[];
  /** Cuántos viajes EN CURSO tiene la flota (`count exact` en la base, FE-5).
   *  `null` = no se pudo contar, y entonces no se afirma ningún total. */
  totalVivos: number | null;
  /** Cuántos cabe dibujar. Lo que pase de aquí se declara, no se esconde. */
  tope: number;
  /** El GPS: los pines medidos y la salud del conector (auditoría 20, H5). */
  rastreo: Rastreo;
}) {
  const escalados = ubicados.filter((v) => v.escalado).length;
  const dibujados = ubicados.length + sinUbicar.length;
  const recortado = totalVivos !== null && totalVivos > dibujados;

  return (
    <main className="h-full">
      <div className="rounded-2xl min-h-full hairline flex flex-col" style={{ background: 'var(--g1)' }}>
        <BarraPagina
          icono={<Map width={15} height={15} strokeWidth={1.75} style={{ color: 'var(--muted)' }} />}
          titulo="Mapa de la operación"
        />
        <div className="px-5 py-5 flex-1 space-y-4">

          <div>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              {/* FE-5: este KPI contaba los vivos ENTRE las 100 filas más
                  recientes — ~90 minutos de operación a 50k viajes/mes. Ahora
                  es el conteo real de la flota; lo acotado es el DIBUJO. */}
              <Kpi titulo="Viajes en curso" valor={totalVivos === null ? '—' : numero(totalVivos)}
                nota={totalVivos === null ? 'no se pudo contar' : 'abiertos o en cuadre'} />
              <Kpi titulo="En el mapa" valor={numero(ubicados.length)} />
              <Kpi titulo="Sin ubicar" valor={numero(sinUbicar.length)}
                nota={sinUbicar.length > 0 ? 'listados abajo, no omitidos' : undefined}
                tono={sinUbicar.length > 0 ? 'warn' : undefined} />
              <Kpi titulo="Escalados" valor={numero(escalados)} tono={escalados > 0 ? 'bad' : undefined} />
              {/* AUDITORÍA 20 (H5): el GPS existía y no se veía. `null` cuando
                  la lectura no se pudo hacer — nunca un 0 inventado, que aquí
                  significaría "ninguna unidad reporta". */}
              <Kpi titulo="Unidades con posición"
                valor={rastreo.unidadesConPosicion === null ? '—' : numero(rastreo.unidadesConPosicion)}
                nota={rastreo.error !== null
                  ? 'no se pudo leer el rastreo'
                  : rastreo.ultimaPosicion !== null
                    ? `última: ${fechaHoraMx(rastreo.ultimaPosicion)}`
                    : 'sin una sola posición todavía'}
                tono={rastreo.error !== null ? 'warn' : undefined} />
            </div>
            {/* El tope se declara. Antes decía "los N viajes más recientes"
                mezclando liquidados y vivos; ahora la base ya filtró por
                estatus y lo único que se recorta es cuántos caben dibujados. */}
            <p className="text-[11px] mt-2" style={{ color: 'var(--faint)' }}>
              {recortado
                ? `Se dibujan los ${numero(tope)} viajes en curso más recientes de ${numero(totalVivos!)} — el resto está en el registro.`
                : 'Se dibujan todos los viajes en curso de la flota. El trayecto es ilustrativo: es la línea origen→destino, no la posición del camión.'}
            </p>
          </div>

          <MapaVivo viajes={ubicados} pines={rastreo.pines} minutosFrescos={MINUTOS_POSICION_FRESCA} />

          {/* ── EL GPS, CON SUS PALABRAS ──────────────────────────────────
              Tres estados y ninguno se confunde con otro: no se pudo leer /
              no hay conector ni un solo pin / esto es lo que reportaron las
              unidades. El tercero se lista con hora y proveedor porque una
              coordenada sin cuándo ni quién la mandó no es verificable. */}
          <section className="card p-4">
            <div className="flex items-center gap-2 mb-1">
              <Satellite width={14} height={14} strokeWidth={1.75} style={{ color: 'var(--muted)' }} />
              <h2 className="font-display text-[15px] font-semibold">Últimas posiciones</h2>
            </div>

            {rastreo.error !== null ? (
              <p className="text-[12px] mt-1" style={{ color: 'var(--warn)' }}>
                No se pudo leer el rastreo de esta flota ({rastreo.error.slice(0, 140)}). Recarga en un
                momento — mientras tanto esta sección no afirma nada sobre tus unidades.
              </p>
            ) : (
              <>
                {rastreo.polls.map((p) => (
                  <p key={`${p.proveedor}:${p.recurso}`} className="text-[11px] mt-1" style={{ color: p.backlogPendiente || p.eventosCuarentenaMuertos > 0 || p.eventosOutboxMuertos > 0 || p.avisosMuertos > 0 ? 'var(--warn)' : 'var(--faint)' }}>
                    {p.proveedor} · {p.recurso}: poll {p.ultimoPoll ? fechaHoraMx(p.ultimoPoll) : 'nunca'};
                    {' '}medida {p.ultimaMedida ? fechaHoraMx(p.ultimaMedida) : 'ninguna'};
                    {' '}{p.backlogPendiente ? `backlog pendiente${p.error ? ` (${p.error.slice(0, 100)})` : ''}` : `${numero(p.elementos)} elementos / ${numero(p.paginas)} páginas`}.
                    {p.recurso === 'eventos' && (p.eventosEnCuarentena + p.eventosOutboxPendientes + p.avisosPendientes + p.eventosCuarentenaMuertos + p.eventosOutboxMuertos + p.avisosMuertos > 0)
                      ? ` Atención: ${numero(p.eventosEnCuarentena)} en cuarentena, ${numero(p.eventosOutboxPendientes)} eventos pendientes, ${numero(p.avisosPendientes)} avisos pendientes; ${numero(p.eventosCuarentenaMuertos + p.eventosOutboxMuertos + p.avisosMuertos)} agotaron reintentos.`
                      : ''}
                  </p>
                ))}
                <p className="text-[11px] mb-3" style={{ color: 'var(--faint)' }}>
                  Posición MEDIDA de cada unidad: la que manda tu proveedor de GPS o el pin que el chofer
                  comparte por WhatsApp. Es un dato con hora, no el trayecto ilustrativo del mapa.
                </p>

                {rastreo.proveedores.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-3">
                    {rastreo.proveedores.map((p) => (
                      <span key={p.proveedor} className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] hairline"
                        style={{ background: 'var(--surface)' }}>
                        <span className="font-medium">{p.proveedor}</span>
                        <span style={{ color: p.ultimoError ? 'var(--bad)' : p.activo ? 'var(--ok)' : 'var(--faint)' }}>
                          {p.ultimoError ? `con error: ${p.ultimoError.slice(0, 60)}` : p.activo ? 'conectado' : 'apagado'}
                        </span>
                        {p.ultimos4 && <span className="cifra-mono" style={{ color: 'var(--faint)' }}>····{p.ultimos4}</span>}
                      </span>
                    ))}
                  </div>
                )}

                {rastreo.pines.length === 0 ? (
                  <p className="text-[12.5px]" style={{ color: 'var(--muted)' }}>
                    {rastreo.proveedores.length === 0
                      ? 'Todavía no hay un proveedor de GPS conectado. Se captura en Conexiones, y el número de dispositivo de cada camión en su ficha de Unidades. Mientras tanto, un chofer puede mandar su ubicación por WhatsApp y aparece aquí.'
                      : 'El conector está dado de alta pero ninguna unidad activa ha reportado una posición todavía. Revisa que las unidades tengan capturado su número de dispositivo GPS.'}
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-[12.5px]">
                      <thead>
                        <tr style={{ color: 'var(--faint)' }} className="text-left">
                          <th className="py-2 font-medium">Unidad</th>
                          <th className="py-2 font-medium">Reportó</th>
                          <th className="py-2 font-medium">Origen del dato</th>
                          <th className="py-2 font-medium text-right">Velocidad</th>
                          <th className="py-2 font-medium text-right">Coordenadas</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rastreo.pines.map((p) => {
                          const vieja = p.minutos > MINUTOS_POSICION_FRESCA;
                          return (
                            <tr key={p.unidadId} className="border-t" style={{ borderColor: 'var(--line)' }}>
                              <td className="py-2.5">
                                <span className="font-medium">{p.etiqueta}</span>
                                {p.placas && <span className="ml-2 cifra-mono text-[11px]" style={{ color: 'var(--faint)' }}>{p.placas}</span>}
                              </td>
                              <td className="py-2.5" style={vieja ? { color: 'var(--warn)' } : undefined}>
                                {antiguedad(p.minutos)}
                                <span className="block text-[11px]" style={{ color: 'var(--faint)' }}>{fechaHoraMx(p.medidaEn)}</span>
                              </td>
                              <td className="py-2.5" style={{ color: 'var(--muted)' }}>
                                {p.proveedor === 'whatsapp' ? 'pin del chofer (WhatsApp)' : p.proveedor}
                              </td>
                              <td className="py-2.5 text-right tabular">
                                {/* `null` NO es cero: cero es «parado», null es
                                    «el proveedor no manda velocidad». */}
                                {p.velocidadKmh === null ? '—' : `${numero(Math.round(p.velocidadKmh))} km/h`}
                              </td>
                              <td className="py-2.5 text-right cifra-mono text-[11px]" style={{ color: 'var(--faint)' }}>
                                {p.lat.toFixed(4)}, {p.lng.toFixed(4)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <p className="text-[11px] mt-2" style={{ color: 'var(--faint)' }}>
                      Lo que lleva más de {Math.round(MINUTOS_POSICION_FRESCA / 60)} horas sin reportar se marca en ámbar
                      aquí y se dibuja apagado en el mapa: sigue siendo la última posición conocida, no dónde
                      está el camión ahora.
                    </p>
                  </div>
                )}
              </>
            )}
          </section>

          {sinUbicar.length > 0 && (
            <section className="card p-4">
              <h2 className="font-display text-[15px] font-semibold mb-1">Sin ubicar en el mapa</h2>
              <p className="text-[11px] mb-3" style={{ color: 'var(--faint)' }}>
                Viajes vivos cuya ciudad no está en la tabla del mapa — existen igual, solo no se dibujan
              </p>
              <div className="space-y-2">
                {sinUbicar.map((v) => (
                  <div key={v.id} className="flex items-center gap-2.5 text-[12.5px]">
                    <MapPinOff width={13} height={13} strokeWidth={1.75} className="shrink-0" style={{ color: 'var(--warn)' }} />
                    <span className="font-medium">{v.folio}</span>
                    {v.operadorNombre && <span style={{ color: 'var(--muted)' }}>{v.operadorNombre}</span>}
                    <span className="ml-auto text-right" style={{ color: 'var(--faint)' }}>{v.motivo}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </main>
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
