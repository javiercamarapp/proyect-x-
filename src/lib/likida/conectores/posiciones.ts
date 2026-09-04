// ═══════════════════════════════════════════════════════════════════════════
// LEER POSICIONES DE VERDAD — lo que faltaba para que «el GPS de tu flota» sea
// una fuente y no una promesa.
//
// Los cuatro conectores de GPS declaran `leer_posiciones` entre sus
// capacidades, tienen su `probar()` verificado contra documentación primaria…
// y ninguno trae una sola posición. `posicion` tiene un único escritor: el pin
// que un chofer manda a mano por WhatsApp. La capacidad estaba declarada y no
// implementada, que es la distancia exacta entre lo que promete la landing y
// lo que hace el producto.
//
// ── QUÉ SE IMPLEMENTA HOY, Y POR QUÉ SOLO ESO ─────────────────────────────
// Samsara. Es el único de los cuatro cuya autenticación no necesita abrir
// sesión —el token viaja en cada petición— así que un lector suyo se puede
// escribir y probar sin una cuenta viva. Los otros tres (Wialon, Geotab,
// Navixy) hacen login primero y devuelven un identificador de sesión; su
// lector se escribe cuando haya una cuenta de piloto contra la cual verificarlo,
// porque escribirlo a ciegas contra la documentación es exactamente cómo se
// consigue un adaptador que parece funcionar y no funciona.
//
// `leerPosiciones` no está en la interfaz `Conector` obligatoria: es opcional
// a propósito. Un conector sin lector devuelve `null` y el poller lo salta
// diciendo por qué — mejor que un método vacío que finge.
// ═══════════════════════════════════════════════════════════════════════════
import type { Http, ValoresCredencial } from './tipos';

/** Una lectura de GPS, ya normalizada. */
export interface PosicionLeida {
  /** Id del dispositivo EN EL SISTEMA DEL PROVEEDOR. Se liga vía unidad.gps_device_id. */
  deviceId: string;
  lat: number;
  lng: number;
  /** ISO. Es la hora que declara el proveedor, no la de recepción. */
  medidaEn: string;
  /** km/h. `null` cuando el proveedor no la da. */
  velocidad: number | null;
  /** Grados. `null` cuando no viene. */
  rumbo: number | null;
}

export type ResultadoPosiciones =
  | { ok: true; posiciones: PosicionLeida[]; paginas: number; completo: true; invalidas: number }
  | { ok: false; motivo: string; paginas?: number; backlog?: boolean };

export interface OpcionesLecturaPaginada {
  /** Instante absoluto tras el que no se abre otra petición ni se duerme. */
  venceEn?: number;
  ahora?: () => number;
  dormir?: (ms: number) => Promise<void>;
}

const MAX_PAGINAS_DEFENSIVO = 1_000;
const MAX_REINTENTOS_429 = 3;
const MAX_REINTENTOS_5XX = 3;

function retryAfterMs(valor: string | undefined, ahora: number): number {
  if (!valor) return 1_000;
  const segundos = Number(valor);
  if (Number.isFinite(segundos) && segundos >= 0) return Math.min(segundos * 1_000, 30_000);
  const fecha = Date.parse(valor);
  if (!Number.isFinite(fecha)) return 1_000;
  return Math.min(Math.max(0, fecha - ahora), 30_000);
}

/** Una lectura sin coordenadas válidas no es una lectura: se descarta. */
function coordenadaValida(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === 'number' && typeof lng === 'number' &&
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 &&
    // (0,0) es el Golfo de Guinea. Ningún camión mexicano está ahí: es el valor
    // que devuelven los dispositivos que todavía no fijan señal.
    !(lat === 0 && lng === 0)
  );
}

/**
 * Samsara: `GET /fleet/vehicles/stats?types=gps` devuelve la última posición
 * conocida de cada vehículo de la organización.
 *
 * Fuente: https://developers.samsara.com/reference/getvehiclestats
 * Consultada el 23-ago-2026. El token va como `Authorization: Bearer`, igual
 * que en `probar()`.
 */
export async function leerPosicionesSamsara(
  valores: ValoresCredencial,
  http: Http,
  opciones: OpcionesLecturaPaginada = {},
): Promise<ResultadoPosiciones> {
  const token = (valores.token ?? '').trim();
  if (!token) return { ok: false, motivo: 'falta el token de Samsara' };

  const posiciones: PosicionLeida[] = [];
  let cursor: string | null = null;
  let paginas = 0;
  let reintentos429 = 0;
  let reintentos5xx = 0;
  let invalidas = 0;
  const vistos = new Set<string>();
  const ahora = opciones.ahora ?? Date.now;
  const dormir = opciones.dormir ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // Todas las páginas pertenecen al mismo snapshot. Sin `time`, la página 2
  // puede observar posiciones posteriores y mezclar universos/cursor.
  const snapshotIso = new Date(ahora()).toISOString();
  // No existe un tope de negocio: 5,100 unidades son 11 páginas y tienen que
  // llegar completas. El único fusible (1,000 páginas/cursor cíclico/reloj)
  // termina como ERROR explícito; jamás devuelve `ok` con cola escondida.
  while (paginas < MAX_PAGINAS_DEFENSIVO) {
    if (opciones.venceEn !== undefined && ahora() >= opciones.venceEn) {
      return { ok: false, motivo: 'Samsara quedó con páginas pendientes al vencer el presupuesto.', paginas, backlog: true };
    }
    let r;
    try {
      const url = new URL('https://api.samsara.com/fleet/vehicles/stats?types=gps');
      url.searchParams.set('time', snapshotIso);
      if (cursor) url.searchParams.set('after', cursor);
      r = await http({
        url: url.toString(), metodo: 'GET',
        encabezados: { Authorization: `Bearer ${token}`, accept: 'application/json' },
      });
    } catch (e) {
      return { ok: false, motivo: `no se pudo llamar a Samsara: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (r.estado >= 500 && r.estado <= 599) {
      if (reintentos5xx >= MAX_REINTENTOS_5XX) {
        return { ok: false, motivo: `Samsara mantuvo ${r.estado} después de 3 reintentos.`, paginas, backlog: true };
      }
      const espera = Math.min(1_000 * 2 ** reintentos5xx, 8_000);
      if (opciones.venceEn !== undefined && ahora() + espera >= opciones.venceEn) {
        return { ok: false, motivo: 'Samsara siguió en 5xx más allá del presupuesto disponible.', paginas, backlog: true };
      }
      reintentos5xx += 1;
      await dormir(espera);
      continue;
    }
    if (r.estado === 429) {
      if (reintentos429 >= MAX_REINTENTOS_429) {
        return { ok: false, motivo: 'Samsara mantuvo el límite 429 después de 3 reintentos.', paginas, backlog: true };
      }
      const espera = retryAfterMs(r.encabezados?.['retry-after'], ahora());
      if (opciones.venceEn !== undefined && ahora() + espera >= opciones.venceEn) {
        return { ok: false, motivo: 'Samsara pidió Retry-After más allá del presupuesto disponible.', paginas, backlog: true };
      }
      reintentos429 += 1;
      await dormir(espera);
      continue;
    }
    reintentos429 = 0;
    reintentos5xx = 0;
    if (r.estado === 401) return { ok: false, motivo: 'Samsara rechazó el token (401). Hay que regenerarlo.', paginas };
    if (r.estado === 403) return { ok: false, motivo: 'El token no tiene permiso de lectura de flota (403). Faltan scopes.', paginas };
    if (r.estado !== 200) return { ok: false, motivo: `Samsara contestó ${r.estado}.` };
    paginas += 1;

    let json: {
      data?: Array<{ id?: string; gps?: { latitude?: number; longitude?: number; time?: string; speedMilesPerHour?: number; headingDegrees?: number } }>;
      pagination?: { hasNextPage?: boolean; endCursor?: string | null };
    };
    try { json = JSON.parse(r.cuerpo); } catch { return { ok: false, motivo: 'Samsara contestó 200 con un cuerpo que no es JSON.' }; }
    for (const v of json.data ?? []) {
      const g = v.gps;
      if (!v.id || !g || !coordenadaValida(g.latitude, g.longitude) || !g.time) {
        invalidas += 1;
        continue;
      }
      posiciones.push({
        deviceId: String(v.id), lat: g.latitude as number, lng: g.longitude as number, medidaEn: g.time,
        velocidad: typeof g.speedMilesPerHour === 'number' ? Math.round(g.speedMilesPerHour * 1.609344 * 10) / 10 : null,
        rumbo: typeof g.headingDegrees === 'number' ? g.headingDegrees : null,
      });
    }
    if (!json.pagination?.hasNextPage) {
      return { ok: true, posiciones, paginas, completo: true, invalidas };
    }
    const siguiente = json.pagination.endCursor?.trim() || null;
    if (!siguiente || siguiente === cursor || vistos.has(siguiente)) {
      return { ok: false, motivo: 'Samsara anunció otra página sin entregar un cursor nuevo; la lectura no es completa.', paginas, backlog: true };
    }
    vistos.add(siguiente);
    cursor = siguiente;
  }
  return { ok: false, motivo: 'Samsara excedió el fusible de 1,000 páginas; la lectura no se declaró completa.', paginas, backlog: true };
}

/** Los lectores que existen HOY. Un proveedor que no está aquí no se sincroniza. */
export const LECTORES_POSICION: Record<
  string,
  (v: ValoresCredencial, http: Http, opciones?: OpcionesLecturaPaginada) => Promise<ResultadoPosiciones>
> = {
  samsara: leerPosicionesSamsara,
};

/** `null` si ese proveedor todavía no tiene lector. El poller lo dice, no lo calla. */
export function lectorDe(proveedor: string) {
  return LECTORES_POSICION[proveedor] ?? null;
}
