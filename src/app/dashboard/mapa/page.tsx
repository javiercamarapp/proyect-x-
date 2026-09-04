import { redirect } from 'next/navigation';
import { resolverTenantEfectivo } from '@/lib/auth/tenant-efectivo';
import { puedeVerRuta } from '@/lib/auth/visibilidad';
import { acotada } from '@/lib/likida/presupuesto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { resolverCiudad, type Ciudad } from '@/lib/likida/geo/ciudades';
import { getEstadoRastreo, getUltimasPosiciones } from '@/lib/likida/comercial';
import { ahoraMs } from '@/lib/saludo';
import { proyectar } from './mexico-geo';
import { VistaMapa, type SinUbicar, type Rastreo } from './vista';
import type { ViajeEnMapa, PinUnidad } from './mapa-vivo';

export const dynamic = 'force-dynamic';

/** Km en línea recta (haversine) — se rotula "en línea recta" SIEMPRE: no es
 *  el kilometraje de carretera y no se presenta como tal. */
function kmEntre(a: Ciudad, b: Ciudad): number {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

/** Los dos estatus que cuentan como "en curso" (`viaje_estatus_dominio`). */
const VIVOS = ['abierto', 'en_cuadre'];

/** Cuántos viajes vivos se DIBUJAN. El mapa es un dibujo: pasado cierto
 *  número de trayectos deja de decir nada aunque los datos estén bien, y
 *  cargar 50,000 sería una pantalla que no abre. Se declara en el pie. */
const TOPE_MAPA = 200;

interface FilaViva {
  id: string; folio: string; origen: string | null; destino: string | null;
  operadorNombre: string | null; fechaInicio: string | null;
  intakePendientes: number; escaladoEn: string | null; aceptadoEn: string | null;
}

/**
 * Los viajes VIVOS de la flota — filtrados en la BASE, no en memoria (FE-5).
 *
 * El mapa hacía `getViajes(tenantId)` (las 100 filas más recientes, sin
 * importar su estatus) y filtraba los vivos en JS. Dos problemas de golpe: a
 * 50,000 viajes/mes esas 100 filas son ~90 minutos, así que un viaje en
 * curso desde ayer NO SALÍA EN EL MAPA de la operación; y de esas 100, las
 * liquidadas se traían para tirarlas. Ahora el filtro va en el `.in()` y el
 * tope es explícito.
 */
async function viajesVivos(tenantId: string): Promise<FilaViva[]> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('viaje')
    .select('id, folio, origen, destino, fecha_inicio, intake_pendientes, escalado_en, aceptado_en, operador:operador_id(nombre)')
    .eq('tenant_id', tenantId)
    .in('estatus', VIVOS)
    .order('created_at', { ascending: false })
    .limit(TOPE_MAPA), 'mapa.viajesVivos');
  // Sin catch: un mapa vacío afirma "no hay nada en la carretera", que con la
  // base caída es exactamente lo contrario de lo que el jefe necesita saber.
  if (error) throw new Error(`mapa.viajesVivos: ${error.message}`);
  return (data ?? []).map((v) => ({
    id: v.id as string,
    folio: (v.folio as string) || (v.id as string).slice(0, 8),
    origen: (v.origen as string) || null,
    destino: (v.destino as string) || null,
    operadorNombre: ((v.operador as { nombre?: string } | null)?.nombre) ?? null,
    fechaInicio: (v.fecha_inicio as string) || null,
    intakePendientes: Number(v.intake_pendientes ?? 0),
    escaladoEn: (v.escalado_en as string) || null,
    aceptadoEn: (v.aceptado_en as string) || null,
  }));
}

/** Cuántos viajes vivos hay DE VERDAD (`count exact, head`). `null` = no se
 *  pudo contar, y entonces la pantalla no afirma ningún total. */
async function contarVivos(tenantId: string): Promise<number | null> {
  const { count, error } = await acotada(supabaseAdmin()
    .from('viaje')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .in('estatus', VIVOS), 'mapa.contarVivos');
  if (error) {
    logger.warn('mapa.contarVivos', { tenantId, err: error.message });
    return null;
  }
  return count ?? null;
}

/**
 * El GPS de la flota, si lo hay — `getEstadoRastreo` (0162) + las últimas
 * posiciones por unidad (0269).
 *
 * FALLA CERRADO SIN TUMBAR EL MAPA: si la lectura del rastreo truena, los
 * viajes vivos se siguen dibujando y el bloque de GPS enseña su error. Lo que
 * NO puede pasar es que un fallo de lectura se pinte como "todavía no llega
 * ninguna posición": esa frase afirma algo sobre el GPS de la flota y aquí no
 * se pudo ni preguntar.
 */
async function rastreoDe(tenantId: string, ahora: number): Promise<Rastreo> {
  try {
    const [estado, posiciones] = await Promise.all([
      getEstadoRastreo(tenantId), getUltimasPosiciones(tenantId),
    ]);
    return {
      error: null,
      unidadesConPosicion: estado.unidadesConPosicion,
      ultimaPosicion: estado.ultimaPosicion,
      proveedores: estado.proveedores,
      polls: estado.polls,
      pines: posiciones.map((p): PinUnidad => {
        const { x, y } = proyectar(p.lat, p.lng);
        return {
          unidadId: p.unidadId,
          etiqueta: p.numeroEconomico || p.placas || 'Unidad sin número',
          placas: p.placas,
          estadoUnidad: p.estadoUnidad,
          x: +x.toFixed(1), y: +y.toFixed(1),
          lat: p.lat, lng: p.lng,
          medidaEn: p.medidaEn,
          // Los minutos se calculan AQUÍ, en el servidor: un `Date.now()` en
          // el cliente daría una antigüedad distinta a la que el servidor
          // rotuló y el número bailaría en cada rerender.
          minutos: Math.max(0, Math.round((ahora - Date.parse(p.medidaEn)) / 60_000)),
          velocidadKmh: p.velocidadKmh,
          proveedor: p.proveedor,
        };
      }),
    };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    logger.warn('mapa.rastreo', { tenantId, err });
    return { error: err, unidadesConPosicion: null, ultimaPosicion: null, proveedores: [], polls: [], pines: [] };
  }
}

/**
 * El mapa de la operación (F3 del plan): los viajes VIVOS sobre México y, desde
 * la auditoría 20, las ÚLTIMAS POSICIONES REALES de las unidades.
 *
 * LA VERDAD DE LOS DATOS, Y CAMBIÓ: hasta el 29-ago-2026 esta página declaraba
 * que «`posicion` y `geocerca` están vacías — no hay GPS». Era cierto cuando se
 * escribió y dejó de serlo sin que nadie moviera el rótulo: `posicion` tiene
 * dos escritores reales —el pin que el chofer manda por WhatsApp
 * (`processor.ts`) y el poller del conector GPS (`conectores/sincronizar_gps.ts`
 * vía `/api/cron/gps`)— y `getEstadoRastreo` (0162) llevaba semanas sin un solo
 * llamador. Hoy se pintan las dos cosas, SEPARADAS y rotuladas como lo que son:
 *
 *   · el PIN — posición medida, con su hora y quién la reportó. Es un dato.
 *   · el ARCO — trayecto ILUSTRATIVO origen→destino geocodificado contra la
 *     tabla estática de ciudades. Nunca "posición actual", nunca ETA.
 *
 * `geocerca` SÍ sigue sin escritor (solo lectores), así que aquí no se dibuja
 * ninguna. Una ciudad no reconocida NO desaparece el viaje: se lista aparte con
 * sus palabras.
 *
 * Área `operacion` (el jefe de tráfico es quien vigila rutas) y por eso
 * CERO pesos: las cards llevan días en ruta y fotos, no gasto.
 */
export default async function PaginaMapa({
  searchParams,
}: {
  searchParams: Promise<{ vista?: string; tenant?: string; rol?: string }>;
}) {
  const sp = await searchParams;
  const { tenantId, rol } = await resolverTenantEfectivo('/dashboard/mapa', sp);
  if (!puedeVerRuta(rol, '/dashboard/mapa')) redirect('/dashboard');

  const ahora = ahoraMs();
  const [vivos, totalVivos, rastreo] = await Promise.all([
    viajesVivos(tenantId), contarVivos(tenantId), rastreoDe(tenantId, ahora),
  ]);

  const ubicados: ViajeEnMapa[] = [];
  const sinUbicar: SinUbicar[] = [];

  for (const v of vivos) {
    const origen = resolverCiudad(v.origen);
    const destino = resolverCiudad(v.destino);
    if (!origen || !destino) {
      const faltas: string[] = [];
      if (!origen) faltas.push(v.origen ? `«${v.origen}» no está en el mapa todavía` : 'sin origen capturado');
      if (!destino) faltas.push(v.destino ? `«${v.destino}» no está en el mapa todavía` : 'sin destino capturado');
      sinUbicar.push({ id: v.id, folio: v.folio, operadorNombre: v.operadorNombre, motivo: faltas.join(' · ') });
      continue;
    }
    const o = proyectar(origen.lat, origen.lng);
    const d = proyectar(destino.lat, destino.lng);
    ubicados.push({
      id: v.id,
      folio: v.folio,
      operadorNombre: v.operadorNombre,
      origenNombre: origen.nombre,
      destinoNombre: destino.nombre,
      ox: +o.x.toFixed(1), oy: +o.y.toFixed(1),
      dx: +d.x.toFixed(1), dy: +d.y.toFixed(1),
      dias: v.fechaInicio
        ? Math.max(0, Math.floor((ahora - Date.parse(`${v.fechaInicio}T00:00:00Z`)) / 86_400_000))
        : null,
      fotos: v.intakePendientes,
      escalado: v.escaladoEn !== null && v.aceptadoEn === null,
      kmRecta: kmEntre(origen, destino),
    });
  }

  // Lo más atorado primero — mismo criterio que la cola de cobranza.
  ubicados.sort((a, b) => (b.dias ?? -1) - (a.dias ?? -1));

  return (
    <VistaMapa ubicados={ubicados} sinUbicar={sinUbicar} totalVivos={totalVivos} tope={TOPE_MAPA}
      rastreo={rastreo} />
  );
}
