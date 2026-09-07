import { redirect } from 'next/navigation';
import { resolverTenantEfectivo } from '@/lib/auth/tenant-efectivo';
import { puedeVerRuta } from '@/lib/auth/visibilidad';
import { contarEscalados, getEventosConductores } from '@/lib/likida/analytics';
import { viajesEsperandoAceptarPaginados } from '@/lib/likida/repo_paginado';
import { acotada } from '@/lib/likida/presupuesto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { ahoraMs } from '@/lib/saludo';
import { sufijoTenant } from '../../sufijo';
import { VistaAgenteConductores, type EsperaAceptar, type ConteosConductores, type ColaConductores } from './vista';
import { SeccionNotificaciones } from '../seccion-notificaciones';
import { FichaCorridas } from '../ficha-corridas';
import { ultimasCorridas } from '@/lib/likida/agentes/corridas';
import { puedeAdministrar } from '@/lib/auth/permisos';
import { getConfig, type LikidaConfig } from '@/lib/likida/config';
import { validarHorasEscalacion, guardarEstrategiaAgente } from '@/lib/likida/agentes/estrategia';
import { mensajeParaPantalla } from '@/lib/likida/errores';
import { revalidatePath } from 'next/cache';
import { FormaEstrategiaConductores, type ResultadoEstrategia } from '../estrategia-forma';
import { Bloque, EsqTabla, vigilar } from '../../bloque';

export const dynamic = 'force-dynamic';

/** Sección secundaria que no se pudo leer → null → su leyenda honesta. */
function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  return fn().catch(() => null);
}

/** Los dos estatus que cuentan como "en curso" (`viaje_estatus_dominio`). */
const VIVOS = ['abierto', 'en_cuadre'];

/**
 * Los KPIs de arriba, CONTADOS EN LA BASE (FE-5, 22-ago-2026).
 *
 * "Viajes en curso", "Aceptados" y "Esperan aceptar" se calculaban filtrando
 * en memoria `getViajes(tenantId)` — las 100 filas más recientes. A 50,000
 * viajes/mes eso son ~90 minutos de operación, así que "Viajes en curso: 43"
 * era el conteo de la última hora y media, no el de la flota. El rótulo de
 * abajo lo confesaba ("sobre los 100 viajes más recientes"), pero una cifra
 * verdadera es mejor que una falsa bien rotulada: la pregunta del jefe de
 * tráfico es cuántos trae HOY, y la respuesta cabía en tres `count`.
 *
 * `count exact, head`: cero filas de vuelta. `null` en cualquiera = no se
 * pudo contar, y la tarjeta pinta "—" — nunca un 0 que se lea como medición.
 */
async function contarVivos(
  tenantId: string,
  afinar: (q: ReturnType<typeof consultaVivos>) => ReturnType<typeof consultaVivos>,
  nombre: string,
): Promise<number | null> {
  const { count, error } = await acotada(afinar(consultaVivos(tenantId)), nombre);
  if (error) {
    logger.warn('conductores.conteo', { tenantId, nombre, err: error.message });
    return null;
  }
  return count ?? null;
}

function consultaVivos(tenantId: string) {
  return supabaseAdmin()
    .from('viaje')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .in('estatus', VIVOS);
}

/**
 * Agente de Conductores (F4 del plan) — la ventana del agente que habla con
 * los choferes: avisa el viaje, persigue la aceptación (y escala a las 5 h),
 * sella los hitos "ya llegué / descargando / de regreso" (0090) y recibe al
 * jefe despachando por WhatsApp.
 *
 * Área `operacion` y no `dinero` como sus hermanos: este agente no toca un
 * peso, y su usuario diario ES el jefe de tráfico. CERO pesos en pantalla.
 */
export default async function PaginaAgenteConductores({
  searchParams,
}: {
  searchParams: Promise<{ vista?: string; tenant?: string; rol?: string }>;
}) {
  const sp = await searchParams;
  const { tenantId, rol } = await resolverTenantEfectivo('/dashboard/agentes/conductores', sp);
  if (!puedeVerRuta(rol, '/dashboard/agentes/conductores')) redirect('/dashboard');

  // ── FE-14: LANZADAS DE UNA, ESPERADAS POR TARJETA ──────────────────────
  // Nueve lecturas en un solo `Promise.all` retenían el HTML hasta la última:
  // hasta la carta "Lo que entiende por WhatsApp", que es TEXTO FIJO y no lee
  // nada, esperaba a los cuatro `count` de la flota. Ahora la cáscara sale
  // con el primer flush y cada tarjeta aterriza cuando su consulta contesta.
  const pEscalados = vigilar(contarEscalados(tenantId));
  const pEventos = safe(() => getEventosConductores(tenantId));
  // La ficha de corridas (B3): null = no se pudo leer, y la ficha lo dice.
  const pCorridas = ultimasCorridas(tenantId, 'conductores').catch(() => null);
  // La estrategia (B4): sin config legible no se pinta la forma — editar
  // sobre un "valor actual" inventado guardaría a ciegas.
  const pConfig = safe(() => getConfig(tenantId));
  // Los cuatro conteos REALES de la flota (FE-5) — ver `contarVivos`.
  const pVivos = contarVivos(tenantId, (q) => q, 'conductores.vivos');
  const pAceptados = contarVivos(tenantId, (q) => q.not('aceptado_en', 'is', null), 'conductores.aceptados');
  const pEsperan = contarVivos(
    tenantId,
    (q) => q.not('avisado_en', 'is', null).is('aceptado_en', null).is('escalado_en', null),
    'conductores.esperan',
  );
  const pSinAvisar = contarVivos(tenantId, (q) => q.is('avisado_en', null), 'conductores.sin_avisar');

  const pConteos: Promise<ConteosConductores> = vigilar(
    Promise.all([pVivos, pAceptados, pEsperan, pEscalados]).then(([vivos, aceptados, esperan, escalados]) =>
      ({ vivos, aceptados, esperan, escalados })));

  const ahora = ahoraMs();
  // FE-6: la cola honesta ya NO sale de `getViajes(tenantId)` (los 100 viajes
  // más recientes) filtrada en memoria — a 500 viajes/día eso son ~4.8 h, así
  // que el viaje avisado hace 6 h (el que el agente escala) ya no estaba en
  // la ventana. `viajesEsperandoAceptarPaginados` pregunta directo por
  // `avisado_en not null and aceptado_en is null and escalado_en is null`,
  // ordenado por antigüedad del aviso — el más urgente primero — con
  // `count: 'exact'`.
  const pCola: Promise<ColaConductores> = vigilar(
    Promise.all([viajesEsperandoAceptarPaginados(tenantId, ahora, { porPagina: 20 }), pSinAvisar])
      .then(([pagina, sinAvisar]) => {
        const esperan: EsperaAceptar[] = pagina.filas.map((v) => ({
          id: v.id, folio: v.folio, operadorNombre: v.operadorNombre,
          horasDesdeAviso: v.horasDesdeAviso, avisos: v.avisosEnviados,
        }));
        return { esperan, totalEsperan: pagina.total, sinAvisar, error: pagina.error, truncada: pagina.truncada };
      }));

  async function guardarEstrategia(_previo: ResultadoEstrategia, fd: FormData): Promise<ResultadoEstrategia> {
    'use server';
    const s = await resolverTenantEfectivo('/dashboard/agentes/conductores', sp);
    if (!puedeVerRuta(s.rol, '/dashboard/agentes/conductores') || !puedeAdministrar(s.rol)) {
      return { ok: false, error: 'Solo el dueño de la flota cambia la estrategia del agente.' };
    }
    try {
      const horas = validarHorasEscalacion(String(fd.get('horasEscalacion') ?? ''));
      await guardarEstrategiaAgente(s.tenantId, { conductores: { horasEscalacion: horas } }, { id: s.userId });
      revalidatePath('/dashboard/agentes/conductores');
      return { ok: true, mensaje: `Listo: se escala a las ${horas} horas sin confirmación, desde la siguiente corrida.` };
    } catch (e) {
      return { ok: false, error: mensajeParaPantalla(e, 'guardar la estrategia') };
    }
  }

  return (
    <VistaAgenteConductores
      kpis={pConteos}
      cola={pCola}
      eventos={pEventos}
      sufijo={sufijoTenant(sp)}
      notificaciones={
        <>
          {/* La estrategia (B4): solo el dueño la edita, y solo con la config
              actual legible — sin ella, la forma guardaría a ciegas. */}
          {puedeAdministrar(rol) && (
            <Bloque mensaje="No se pudo leer la estrategia del agente." esqueleto={null}>
              <BloqueEstrategia pConfig={pConfig} accion={guardarEstrategia} />
            </Bloque>
          )}
          <Bloque mensaje="No se pudo leer la bitácora de corridas." esqueleto={<EsqTabla filas={3} />}>
            <BloqueCorridas pCorridas={pCorridas} />
          </Bloque>
          {/* Notificaciones hace SUS propias lecturas: en su propio boundary
              no retiene a nadie. */}
          <Bloque mensaje="No se pudo leer la configuración de avisos." esqueleto={<EsqTabla filas={4} />}>
            <SeccionNotificaciones tenantId={tenantId} agenteId="conductores" />
          </Bloque>
        </>
      }
    />
  );
}

async function BloqueEstrategia({ pConfig, accion }: {
  pConfig: Promise<LikidaConfig | null>;
  accion: (previo: ResultadoEstrategia, fd: FormData) => Promise<ResultadoEstrategia>;
}) {
  const config = await pConfig;
  if (config === null) return null;
  return <FormaEstrategiaConductores accion={accion}
    horasActuales={config.agentes.conductores.horasEscalacion} />;
}

async function BloqueCorridas({ pCorridas }: {
  pCorridas: Promise<Awaited<ReturnType<typeof ultimasCorridas>> | null>;
}) {
  return <FichaCorridas corridas={await pCorridas} />;
}
