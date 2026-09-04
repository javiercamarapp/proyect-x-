// Cuadre determinístico a partir del estado en la DB (viaje + gastos + config).
// Fuente única de verdad del cuadre; la usan las tools del agente Y la guardia
// determinística del processor (para no depender de que el LLM llame la tool).

import { cuadrarViaje, medioNoAdmitidoCombustible } from './engine';
import { ventanaDelViaje } from './fecha_dudosa';
import { getViaje, getGastos, getOperador, getAcumuladoCombustible, getPerfilCrudo } from '../repo';
import { getConfig } from '../config';
import { calificaEstimuloPeaje, facilidad15Declarada } from '../perfil/preguntas';
import { logger } from '@/lib/logger';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { acotada } from '../presupuesto';
import type { Liquidacion, Gasto } from '@/types/likida';
import type { LineaEccRef } from '../intake/evidencia_monedero';

/**
 * La ventana de un viaje sin cuadrarlo entero.
 *
 * La usa el INTAKE, que necesita saber si la fecha que acaba de leer cuadra con
 * el viaje —para pedirle otra foto al operador mientras todavía tiene el ticket
 * en la mano— y no puede pagar un cuadre completo por cada foto.
 */
export async function ventanaDesdeDB(tenantId: string, viajeId: string) {
  const [viaje, config] = await Promise.all([
    getViaje(viajeId, tenantId),
    getConfig(tenantId),
  ]);
  if (!viaje) return undefined;
  return ventanaDelViaje(
    viaje.fechaInicio, config.validacion.fechaToleranciaDiasAntes, new Date(),
  );
}

export async function cuadrarDesdeDB(
  tenantId: string,
  viajeId: string,
  /**
   * AUDITORÍA 25, BE-C1a/BE-C1b/DATOS-C1 (CRÍTICO): cuando `revisar_liquidacion`
   * ajusta un monto a mano, `revision.ts` necesita el cuadre RECALCULADO con
   * ese monto nuevo ANTES de escribirlo en `gasto` (la RPC es quien lo
   * escribe, dentro de su propia transacción) — así que aquí se puede pasar
   * la lista de gastos YA CORREGIDA en vez de leerla de la base. `undefined`
   * (el default) es el camino de siempre: se lee `gasto` tal cual está.
   *
   * Nota: el contador del 15% de combustible (abajo) sigue leyendo el
   * acumulado del ejercicio de la BASE, que en este camino todavía no tiene
   * el monto nuevo — para un ajuste sobre diésel en efectivo de una flota con
   * la facilidad del 15% activa, `efectivoPrevEjercicio` puede quedar
   * calculado contra el monto VIEJO de este mismo comprobante hasta que la
   * RPC lo persista. Ventana angosta y ya documentada; no es un caso nuevo
   * de "cifra inventada" — es la misma naturaleza aproximada que ya declara
   * el resto de este contador.
   */
  gastosOverride?: Gasto[],
  opciones: { modo?: 'best_effort' | 'cierre' } = {},
): Promise<Omit<Liquidacion, 'id' | 'creadaEn'>> {
  const cierreEstricto = opciones.modo === 'cierre';
  const [viaje, gastosDb, config, perfilCrudo] = await Promise.all([
    getViaje(viajeId, tenantId),
    gastosOverride ? Promise.resolve(gastosOverride) : getGastos(viajeId, tenantId),
    getConfig(tenantId),
    // El perfil solo gobierna un BENEFICIO fiscal. Los usos informativos
    // conservan el fallback sin estímulo; el cierre exige que la lectura sea
    // determinada para que PDF, hash y persistencia partan del mismo insumo.
    cierreEstricto
      ? getPerfilCrudo(tenantId)
      : getPerfilCrudo(tenantId).catch((e) => {
          logger.warn('desde_db.perfil_no_disponible', { tenant: tenantId, err: e instanceof Error ? e.message : String(e) });
          return {};
        }),
  ]);
  const gastos = gastosOverride ?? gastosDb;
  if (!viaje) throw new Error('viaje no encontrado');
  // `elegible: null` (perfil sin declarar o ilegible) se traduce a
  // `undefined`; el motor no acredita estímulo sin una declaración positiva.
  const { elegible: elegiblePeajeODeclarado } = calificaEstimuloPeaje(perfilCrudo);
  const elegiblePeaje = elegiblePeajeODeclarado ?? undefined;
  // AUDITORÍA 12, MEDIO (fiscal): `operadorRfc` no tenía productor — la rama
  // buena de RLISR 57 (viático timbrado al RFC del operador, trabajador
  // subordinado) era inalcanzable y todo viático a su nombre caía en 'revisar'.
  // El RFC vive en operador.rfc (mig. 0080); null = no capturado, y el motor
  // ya maneja ese caso con el aviso honesto en vez de quitar la deducción.
  //
  // SIN `.catch(() => null)` desde el E1 (auditoría 4): la fila del operador
  // ahora trae `oposicion_automatizada` (0100), y tragarse un fallo de lectura
  // aquí liquidaría EN AUTOMÁTICO a un titular que ejerció su derecho a que no
  // se decida así — el mismo criterio de `getConfig`: liquidar con los datos
  // equivocados es peor que no liquidar. `getViaje`/`getConfig` en el
  // Promise.all de arriba ya lanzan por esta misma razón.
  const operador = viaje.operadorId
    ? await getOperador(viaje.operadorId, tenantId)
    : null;
  const operadorRfc = operador?.rfc ?? undefined;
  const oposicionTitular = operador?.oposicionAutomatizada != null;

  // ── RFA 2026 regla 2.9 — la facilidad del 15% (deber ser completo) ────────
  // El motor necesita tres insumos del EJERCICIO, no de este viaje:
  //   1. ¿la flota declaró dedicación exclusiva Y régimen elegible? (config)
  //   2. el total pagado por combustible en el ejercicio (la base del 15%)
  //   3. el efectivo ya corrido ANTES de esta liquidación (el contador previo)
  // Los tres se calculan aquí —el motor es puro— con el mismo patrón de
  // agregación del resto del archivo.
  // Paso 6: el perfil es la fuente. `tenant.config` queda como legado
  // (el alta vieja escribía ahí) — si el dueño ya declaró en el perfil,
  // esa declaración gana. No se inventa un no a partir de un config vacío.
  const f15Perfil = facilidad15Declarada(perfilCrudo);
  const f15 = config.facilidadCombustibleEfectivo;
  const facilidad15 = f15Perfil
    ? (f15Perfil.dedicacionExclusivaCarga && f15Perfil.regimenElegible)
    : (f15 && f15.dedicacionExclusivaCarga !== undefined && f15.regimenElegible !== undefined)
      ? (f15.dedicacionExclusivaCarga === true && f15.regimenElegible === true)
      : undefined;
  // AUDITORÍA 14, MEDIO: el ejercicio es el de los COMPROBANTES, no el del
  // proceso — una liquidación de diciembre cerrada en enero declaraba todo el
  // diésel en efectivo NO deducible contra un tope de $0 (año equivocado).
  // El ancla es la fecha del viaje; los gastos sin fecha no pueden anclar.
  const anioEjercicio = String(
    (viaje.fechaInicio ?? gastos.find((g) => g.fecha)?.fecha ?? new Date().toISOString()).slice(0, 4),
  );
  const clavesCombustible = config.hidrocarburos?.claves ?? [];
  // AUDITORÍA 14, MEDIO: se REUSA getAcumuladoCombustible (el mismo que usa la
  // tool de periodo) con las claves del SAT — una sola barrida del ejercicio,
  // no dos consultas duplicadas con criterios que podían divergir.
  //
  // Los usos informativos son best-effort: si falla, el motor recibe ceros y
  // marca el efectivo para revisar. El cierre, en cambio, propaga el fallo:
  // degradar a cero produciría un PDF y un snapshot fiscal inventados.
  let totalesEjercicio = { efectivo: 0, totalCombustible: 0 };
  try {
    totalesEjercicio = await getAcumuladoCombustible(tenantId, Number(anioEjercicio), clavesCombustible);
  } catch (e) {
    if (cierreEstricto) throw e;
    logger.warn('desde_db.contador_15_no_disponible', { tenant: tenantId, err: e instanceof Error ? e.message : String(e) });
  }
  // El efectivo PREVIO excluye los gastos de ESTE viaje (los está procesando
  // el motor; sumarlos doblaría el contador). AUDITORÍA 16, ALTO (datos): solo
  // los del MISMO ejercicio — un gasto de otro año (o sin fecha) no está en el
  // contador y restarlo fabricaba un previo negativo.
  //
  // AUDITORÍA 19 (fiscal F2, CRÍTICO): `formaPago === '01'` era la MISMA
  // frontera equivocada que `sumar_combustible_ejercicio` (mig. 0190) —
  // `medioNoAdmitidoCombustible` es el predicado real, ya verificado contra
  // la LISR 27-III. Sin este cambio, restar solo el '01' de este viaje contra
  // un total SQL que ahora sí cuenta los demás medios habría dejado el
  // "previo" con la porción no-'01' de ESTE viaje contada DOS veces.
  const efectivoDeEsteViaje = gastos
    .filter((g) => (g.fecha?.slice(0, 4) ?? anioEjercicio) === anioEjercicio
      && medioNoAdmitidoCombustible(g.formaPago) && (g.concepto === 'diesel' || clavesCombustible.includes(g.claveProdServ ?? '')))
    .reduce((s, g) => s + Number(g.monto ?? 0), 0);
  const efectivoPrevEjercicio = Math.max(0, totalesEjercicio.efectivo - efectivoDeEsteViaje);
  const totalCombustibleEjercicio = totalesEjercicio.totalCombustible;

  // La ventana la calcula `ventanaDelViaje`, que es la MISMA que usa el intake
  // para decidir si le pide otra foto al operador. Calculadas por separado se
  // separan en silencio, y el operador acaba mandando fotos que el cuadre no
  // pedía —o al revés, recibiendo el reproche en el PDF sin que nadie se lo
  // hubiera dicho a tiempo.
  const { fechaMin, fechaMax, hoy } = ventanaDelViaje(
    viaje.fechaInicio, config.validacion.fechaToleranciaDiasAntes, new Date(),
  );
  return cuadrarViaje({
    viajeId,
    anticipo: viaje.anticipo,
    gastos,
    politica: config.politica,
    // B4: el umbral de confianza del OCR es estrategia del Agente de
    // Liquidación, editable por flota (default 0.85 — el que era fijo).
    umbralConfianza: config.agentes.liquidacion.umbralConfianza,
    ruta: viaje.destino,
    empresaRfc: config.empresa.rfc,
    rfcsAdicionales: config.empresa.rfcsAdicionales,
    hidrocarburos: config.hidrocarburos,
    estimulos: config.estimulos,
    fechaMin,
    fechaMax,
    operadorRfc,
    oposicionTitular,
    facilidad15,
    elegiblePeaje,
    lineasEcc: cierreEstricto
      ? await lineasEccParaCuadre(tenantId, gastos)
      : await lineasEccParaCuadre(tenantId, gastos).catch((e) => {
          logger.warn('desde_db.ecc_no_disponible', { tenant: tenantId, err: e instanceof Error ? e.message : String(e) });
          return [] as LineaEccRef[];
        }),
    totalCombustibleEjercicio,
    efectivoPrevEjercicio,
    anioEjercicio,
    // El motor es puro y no lee el reloj: la fecha se le inyecta aquí, que es
    // el borde con el mundo. Sin esto el aviso de "ticket por facturar" nunca
    // correría en producción aunque sus pruebas estén verdes.
    hoy,
  });
}

/** Líneas ECC del tenant en la ventana de los gastos (±1 día). Best-effort
 *  caller: un fallo no tumba el cuadre, solo apaga el camino B.
 *
 *  FASE 2 · el filtro es el MISMO que `evidenciaMonedero` ya aplica en
 *  memoria, movido al WHERE: camino B exige `estacionRfc` y `fecha`, y solo
 *  `ecc12` los trae (`concepto_base` no da ninguno de los dos — ver
 *  `cfdi_xml.ts`). Traerse las líneas de un consolidado de TAG para que el
 *  matcher las descarte una por una era leer la cola entera de casetas de la
 *  flota EN CADA CUADRE, en el camino caliente de WhatsApp, para no usar ni
 *  una. Mismo resultado, menos filas; el índice parcial de la 0242 es
 *  exactamente este predicado. */
async function lineasEccParaCuadre(tenantId: string, gastos: Gasto[]): Promise<LineaEccRef[]> {
  const fechas = gastos.map((g) => g.fecha?.slice(0, 10)).filter((f): f is string => !!f);
  if (fechas.length === 0) return [];
  const ordenadas = [...fechas].sort();
  const shift = (iso: string, d: number): string => {
    const x = new Date(`${iso}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() + d);
    return x.toISOString().slice(0, 10);
  };
  const { data, error } = await acotada(
    supabaseAdmin().from('cfdi_consolidado_linea')
      .select('fecha, monto, estacion_rfc')
      .eq('tenant_id', tenantId)
      .eq('fuente', 'ecc12')
      .not('estacion_rfc', 'is', null)
      .gte('fecha', shift(ordenadas[0], -1))
      .lte('fecha', shift(ordenadas[ordenadas.length - 1], 1)),
    'desde_db.lineas_ecc',
  );
  if (error) throw new Error(`lineas ecc: ${error.message}`);
  if (!Array.isArray(data) || data.some((r) => {
    const fila = r as { fecha?: unknown; monto?: unknown; estacion_rfc?: unknown } | null;
    return !fila || typeof fila.fecha !== 'string'
      || typeof fila.estacion_rfc !== 'string' || !Number.isFinite(Number(fila.monto));
  })) {
    throw new Error('lineas ecc: respuesta inválida');
  }
  return (data as Array<{ fecha: string; monto: unknown; estacion_rfc: string }>).map((r) => ({
    fecha: r.fecha,
    monto: Number(r.monto),
    estacionRfc: r.estacion_rfc,
  }));
}
