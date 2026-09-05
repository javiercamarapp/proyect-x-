import { redirect } from 'next/navigation';
import { resolverTenantEfectivo } from '@/lib/auth/tenant-efectivo';
import { sufijoTenant } from '../sufijo';
import { requireSessionTenant } from '@/lib/auth/guard';
import { puedeVerRuta, puedeVerArea } from '@/lib/auth/visibilidad';
import { puedeAsignar } from '@/lib/auth/permisos';
import {
  getTableroOperacion, getViajesSinAsignar, getCargaOperadores, crearViaje, avisarAlChofer,
  asignarUnidad,
} from '@/lib/likida/operacion';
import { reasignarOperador, buscarCatalogo, contarCatalogo, type OpcionCatalogo, type TipoCatalogo } from '@/lib/likida/repo';
import { crearOperador } from '@/lib/likida/administracion';
import { DatoInvalido } from '@/lib/likida/errores';
import { viajesEnCursoPaginados } from '@/lib/likida/repo_paginado';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { VistaDespacho } from './vista';
import { validarIngreso } from '@/lib/likida/ingreso_viaje';

export const dynamic = 'force-dynamic';

/**
 * El chequeo que TODA action repite: sesión viva, rol que asigna, y que la
 * flota de la sesión sea la del render (superadmin exento: su tenant efectivo
 * es el del demo/`?tenant=`).
 *
 * ── POR QUÉ VIVE AQUÍ Y NO DENTRO DEL COMPONENTE ──────────────────────────
 *
 * Estaba declarada dentro de la página, y las seis acciones inline la
 * capturaban por closure. Next tiene que serializar las variables capturadas
 * de un `'use server'` inline (`encryptActionBoundArgs`), y UNA FUNCIÓN NO ES
 * SERIALIZABLE: el bundle compilado quedaba
 *
 *     I = z.bind(null, encryptActionBoundArgs("709f…", H, c))
 *                                                       ↑ guardia
 *
 * y producía, en CADA render de /dashboard/despacho, un rechazo no manejado
 * con «Functions cannot be passed directly to Client Components». Sentry lo
 * registró 204 veces en nueve días y su mensaje mostraba literalmente el array
 * de argumentos capturados: `[function H, ..., ...]`.
 *
 * El síntoma visible era otro y por eso costó: el combo de Operador contestaba
 * «No se pudo buscar en el catálogo» — la acción nunca llegaba al servidor, así
 * que no había ni una consulta en los logs de Postgres que mirar.
 *
 * A nivel de módulo no es una variable capturada, es una referencia del módulo.
 * Las acciones ahora solo cierran sobre `tenantId` y `destino`, dos strings.
 */
async function guardiaDespacho(tenantId: string, requiereDinero = false): Promise<string | null> {
  const sesion = await requireSessionTenant('/dashboard/despacho');
  if (!puedeAsignar(sesion.rol)) return 'Tu rol no puede despachar viajes.';
  if (requiereDinero && !puedeVerArea(sesion.rol, 'dinero')) return 'Tu rol no puede consultar ni capturar datos de dinero o clientes.';
  if (sesion.rol !== 'superadmin' && sesion.tenantId !== tenantId) return 'Este despacho no es de tu flota.';
  return null;
}

function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  return fn().catch(() => null);
}

/**
 * Despacho — la página donde se ACTÚA (13-ago-2026): crear viaje, asignar
 * y avisar en un paso, insistirle al chofer que no acepta, y dar de alta
 * operadores sin brincar de página. La foto de solo lectura de la mañana
 * vive en el Resumen del encargado; aquí viven los botones.
 *
 * Área `operacion`: el jefe de tráfico entra y NO hay un peso en pantalla.
 * Toda action re-verifica sesión y permiso ADENTRO (alcanzables por POST
 * directo), y el tenant viaja por closure del render, nunca del cliente.
 */
export default async function PaginaDespacho({
  searchParams,
}: {
  searchParams: Promise<{ vista?: string; tenant?: string; rol?: string; p?: string; q?: string }>;
}) {
  const sp = await searchParams;
  const { tenantId, rol } = await resolverTenantEfectivo('/dashboard/despacho', sp);
  if (!puedeVerRuta(rol, '/dashboard/despacho')) redirect('/dashboard');

  const puedeCapturarDinero = puedeVerArea(rol, 'dinero');
  const sufijo = sufijoTenant(sp);
  const destino = `/dashboard/despacho${sufijo}`;
  const paginaPedida = Math.max(1, Number.parseInt(sp.p ?? '1', 10) || 1);
  const folioPedido = (sp.q ?? '').trim();

  // ── FE-2: LOS CATÁLOGOS YA NO SE CARGAN ─────────────────────────────────
  // Aquí se traían los tres ENTEROS (operadores, clientes, unidades) para
  // pintarlos como `<option>`; a 7,500/5,000 filas eran megabytes de HTML, y
  // los tres los recortaba PostgREST a 1,000 EN SILENCIO — el chofer 1,001 no
  // existía para el despacho. Ahora solo se CUENTAN (`count exact, head`: cero
  // filas de vuelta) y la búsqueda vive en `buscarCatalogoAccion`, que la UI
  // llama al escribir. El conteo es lo único que la pantalla necesita saber
  // sin traer nada: distingue "todavía no das de alta a nadie" (0) de "no se
  // pudo contar" (`null`), y alimenta la pista "20 de N" del combo.
  //
  // `contarCatalogo` no lanza (devuelve `null` y loguea): un conteo caído no
  // puede tumbar el despacho, igual que antes un catálogo caído no lo hacía.
  // FE-2: "En curso" ya no es un recorte de "los últimos 100 viajes creados"
  // filtrado en memoria — es su propia consulta, ordenada por urgencia
  // (primero lo no aceptado, y entre eso lo avisado hace más tiempo), con
  // `count: 'exact'` y un buscador por folio (`?q=`).
  const [tablero, sinAsignar, activos, carga, totalOperadores, totalClientes, totalUnidades] = await Promise.all([
    safe(() => getTableroOperacion(tenantId)),
    getViajesSinAsignar(tenantId),
    viajesEnCursoPaginados(tenantId, { pagina: paginaPedida, folio: folioPedido }),
    safe(() => getCargaOperadores(tenantId)),
    contarCatalogo(tenantId, 'operador'),
    puedeCapturarDinero ? contarCatalogo(tenantId, 'cliente') : Promise.resolve(null),
    contarCatalogo(tenantId, 'unidad'),
  ]);


  /**
   * La búsqueda de catálogo del panel, como server action: el `tenantId` va
   * por CLOSURE del render — el cliente manda el texto y el tipo, nunca la
   * flota. Devuelve a lo más 20 opciones (`TOPE_CATALOGO`).
   *
   * Repite la guardia completa igual que las mutaciones: es alcanzable por
   * POST directo, y aunque solo devuelva nombres de choferes y unidades, ésos
   * son datos de UNA flota.
   *
   * LANZA ante rechazo o fallo — no devuelve lista vacía. Una lista vacía es
   * una AFIRMACIÓN ("no hay ningún chofer que se llame así") y sería falsa;
   * `ComboCatalogo` atrapa el fallo y escribe "No se pudo buscar en el
   * catálogo", que es lo que de verdad pasó.
   */
  async function buscarCatalogoAccion(tipo: TipoCatalogo, q: string): Promise<OpcionCatalogo[]> {
    'use server';
    const rechazo = await guardiaDespacho(tenantId, tipo === 'cliente');
    if (rechazo) throw new Error(rechazo);
    if (tipo !== 'operador' && tipo !== 'cliente' && tipo !== 'unidad') {
      throw new Error('Catálogo desconocido.');
    }
    try {
      return await buscarCatalogo(tenantId, tipo, typeof q === 'string' ? q : '');
    } catch (err) {
      logger.error('despacho.catalogo.fallo', { tipo, err: err instanceof Error ? err.message : String(err) });
      throw new Error('No se pudo buscar en el catálogo.');
    }
  }

  async function crear(_prev: { error?: string } | null, fd: FormData): Promise<{ error?: string } | null> {
    'use server';
    // La presencia se valida antes de leer valores: un POST manual, incluso
    // vacío o con claves repetidas, no concede al encargado captura financiera.
    const requiereDinero = ['anticipo', 'ingresoFlete', 'clienteId'].some((campo) => fd.has(campo));
    const rechazo = await guardiaDespacho(tenantId, requiereDinero);
    if (rechazo) return { error: rechazo };

    const texto = (n: string, max: number) => {
      const v = fd.get(n);
      return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
    };
    const anticipoCrudo = fd.get('anticipo');
    const anticipo = typeof anticipoCrudo === 'string' && anticipoCrudo.trim() !== '' ? Number(anticipoCrudo) : 0;
    if (!Number.isFinite(anticipo) || anticipo < 0) {
      return { error: 'El anticipo tiene que ser un monto válido (o dejarse vacío).' };
    }
    // `viaje.operador_id` es NOT NULL (0001). Sin este guard, elegir "sin
    // operador" llegaba a la base y volvía como un 23502 traducido a "No se
    // pudo crear el viaje": un mensaje que no dice qué arreglar.
    if (!texto('operadorId', 64)) {
      return { error: 'Elige un operador: un viaje no puede existir sin quién lo maneje.' };
    }
    const fecha = texto('fechaInicio', 10);
    if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return { error: 'La fecha de inicio no tiene un formato válido.' };
    }
    try {
      // `crearViaje` re-valida que el operador sea de ESTA flota y manda el
      // aviso de WhatsApp él mismo (y se traga el fallo del aviso a
      // propósito: el viaje ya existe y "Reavisar" vive aquí abajo).
      // El lado del ingreso. `validarIngreso` distingue VACÍO de CERO, que es
      // la distinción de la que depende toda la medición de margen: con
      // `Number('')` un viaje sin capturar se contaría como uno que no produjo
      // nada, y su -100% se vería perfectamente plausible.
      const ing = validarIngreso({
        clienteId: String(fd.get('clienteId') ?? ''),
        ingresoFlete: String(fd.get('ingresoFlete') ?? ''),
        kmRecorridos: String(fd.get('kmRecorridos') ?? ''),
      });

      const operadorId = texto('operadorId', 64);
      await crearViaje(tenantId, {
        folio: texto('folio', 40),
        origen: texto('origen', 120),
        destino: texto('destino', 120),
        fechaInicio: fecha,
        anticipo,
        operadorId,
        // '' → null (sin unidad, que la base admite). Que el id sea de ESTA
        // flota lo re-verifica `crearViaje` (`unidadPropia`), igual que hace
        // con el operador — el `<select>` es UI, no servidor.
        unidadId: texto('unidadId', 64),
        clienteId: ing.clienteId,
        ingresoFlete: ing.ingresoFlete,
        kmRecorridos: ing.kmRecorridos,
      });
    } catch (err) {
      // FE-13: `crearViaje` ya distingue "operador/unidad dado de baja" con
      // `DatoInvalido` (mensaje escrito para pantalla) — antes ese catch lo
      // aplastaba igual que cualquier otro fallo ("Revisa los datos…"), el
      // mensaje MENOS útil posible para el error que a 500 viajes/día va a
      // ser el más común: "ese operador ya trae un viaje abierto"
      // (`uq_viaje_abierto_por_operador`, 0029) llega como un 23505 genérico
      // envuelto por operacion.ts, sin `.code` — el nombre del índice sigue
      // en el texto del mensaje de Postgres, así que se detecta ahí.
      if (err instanceof DatoInvalido) return { error: err.message };
      const detalle = err instanceof Error ? err.message : String(err);
      if (detalle.includes('uq_viaje_abierto_por_operador')) {
        const operadorId = texto('operadorId', 64);
        // El filtro de abajo (tenant+operador+estatus vivo) es exactamente
        // el de `uq_viaje_abierto_por_operador` (0029): a lo más UNA fila.
        const { data: abierto } = await supabaseAdmin()
          .from('viaje').select('folio')
          .eq('tenant_id', tenantId).eq('operador_id', operadorId)
          // orden-no-importa: índice único parcial (0029) garantiza ≤1 fila
          .in('estatus', ['abierto', 'en_cuadre']).limit(1).maybeSingle();
        const folio = (abierto?.folio as string | undefined) || null;
        return {
          error: folio
            ? `Ese operador ya trae el viaje ${folio} abierto — ciérralo o asígnale otro chofer.`
            : 'Ese operador ya trae un viaje abierto — ciérralo o asígnale otro chofer.',
        };
      }
      logger.error('despacho.crear.fallo', { err: detalle });
      return { error: 'No se pudo crear el viaje. Revisa los datos e inténtalo de nuevo.' };
    }
    redirect(destino);
  }

  async function asignarYAvisar(_prev: { error?: string } | null, fd: FormData): Promise<{ error?: string } | null> {
    'use server';
    const rechazo = await guardiaDespacho(tenantId);
    if (rechazo) return { error: rechazo };

    const viajeId = typeof fd.get('viajeId') === 'string' ? (fd.get('viajeId') as string).trim().slice(0, 64) : '';
    const operadorId = typeof fd.get('operadorId') === 'string' ? (fd.get('operadorId') as string).trim().slice(0, 64) : '';
    if (!viajeId || !operadorId) return { error: 'Falta el viaje o el operador.' };

    try {
      // `reasignarOperador` verifica que el operador sea de ESTA flota y el
      // update ancla tenant — un id ajeno no encuentra fila.
      await reasignarOperador(tenantId, viajeId, operadorId);
    } catch (err) {
      logger.error('despacho.asignar.fallo', { viajeId, err: err instanceof Error ? err.message : String(err) });
      return { error: 'No se pudo asignar. Inténtalo de nuevo.' };
    }
    try {
      await avisarAlChofer(tenantId, operadorId, viajeId);
    } catch (err) {
      // Asignado SÍ quedó; el aviso no salió — se dice y "Reavisar" existe.
      logger.error('despacho.aviso.fallo', { viajeId, err: err instanceof Error ? err.message : String(err) });
      return { error: 'Quedó asignado, pero el aviso de WhatsApp no salió — usa Reavisar en "En curso".' };
    }
    redirect(destino);
  }

  async function asignarUnidadViaje(_prev: { error?: string } | null, fd: FormData): Promise<{ error?: string } | null> {
    'use server';
    const rechazo = await guardiaDespacho(tenantId);
    if (rechazo) return { error: rechazo };

    const viajeId = typeof fd.get('viajeId') === 'string' ? (fd.get('viajeId') as string).trim().slice(0, 64) : '';
    const unidadId = typeof fd.get('unidadId') === 'string' ? (fd.get('unidadId') as string).trim().slice(0, 64) : '';
    if (!viajeId) return { error: 'Falta el viaje.' };

    try {
      // `asignarUnidad` verifica que la unidad sea de ESTA flota, ancla el
      // update a tenant Y comprueba filas afectadas: un viaje ajeno no se
      // reporta como "asignado". `'' → null` desasigna — opción legítima,
      // `viaje.unidad_id` es nullable.
      await asignarUnidad(tenantId, viajeId, unidadId || null);
    } catch (err) {
      logger.error('despacho.asignar_unidad.fallo', { viajeId, err: err instanceof Error ? err.message : String(err) });
      return { error: 'No se pudo asignar la unidad. Inténtalo de nuevo.' };
    }
    redirect(destino);
  }

  async function reenviarAviso(_prev: { error?: string } | null, fd: FormData): Promise<{ error?: string } | null> {
    'use server';
    const rechazo = await guardiaDespacho(tenantId);
    if (rechazo) return { error: rechazo };

    const viajeId = typeof fd.get('viajeId') === 'string' ? (fd.get('viajeId') as string).trim().slice(0, 64) : '';
    if (!viajeId) return { error: 'Falta el viaje.' };

    // El destinatario se resuelve AQUÍ, anclado al tenant — el cliente no
    // elige a quién se le manda el WhatsApp.
    const { data: v, error } = await supabaseAdmin()
      .from('viaje').select('operador_id')
      .eq('id', viajeId).eq('tenant_id', tenantId).maybeSingle();
    if (error || !v?.operador_id) {
      return { error: 'Ese viaje no tiene operador asignado (o no se pudo leer).' };
    }
    try {
      await avisarAlChofer(tenantId, v.operador_id as string, viajeId);
    } catch (err) {
      logger.error('despacho.reaviso.fallo', { viajeId, err: err instanceof Error ? err.message : String(err) });
      return { error: 'El aviso no salió — inténtalo de nuevo en un momento.' };
    }
    redirect(destino);
  }

  async function altaOperador(_prev: { error?: string } | null, fd: FormData): Promise<{ error?: string } | null> {
    'use server';
    const rechazo = await guardiaDespacho(tenantId);
    if (rechazo) return { error: rechazo };

    const nombre = typeof fd.get('nombre') === 'string' ? (fd.get('nombre') as string).trim().slice(0, 120) : '';
    const telefono = typeof fd.get('telefono') === 'string' ? (fd.get('telefono') as string).trim().slice(0, 20) : '';
    if (!nombre || !telefono) return { error: 'Faltan el nombre o el WhatsApp.' };

    const sesion = await requireSessionTenant('/dashboard/despacho');
    try {
      // `crearOperador` normaliza la lada 52 y falla CERRADO ante duplicados
      // (incluso entre flotas) — sus mensajes están escritos para pantalla.
      await crearOperador(tenantId, { nombre, telefono }, { id: sesion.userId });
    } catch (err) {
      if (err instanceof DatoInvalido) return { error: err.message };
      logger.error('despacho.alta_operador.fallo', { err: err instanceof Error ? err.message : String(err) });
      return { error: 'No se pudo dar de alta. Inténtalo de nuevo.' };
    }
    redirect(destino);
  }

  return (
    <VistaDespacho
      puedeCapturarDinero={puedeCapturarDinero}
      tablero={tablero}
      sinAsignar={sinAsignar}
      activos={activos}
      sufijo={sufijo}
      folioPedido={folioPedido}
      buscarCatalogo={buscarCatalogoAccion}
      totalOperadores={totalOperadores}
      totalClientes={totalClientes}
      totalUnidades={totalUnidades}
      carga={carga}
      crear={crear}
      asignarYAvisar={asignarYAvisar}
      asignarUnidadViaje={asignarUnidadViaje}
      reenviarAviso={reenviarAviso}
      altaOperador={altaOperador}
    />
  );
}
