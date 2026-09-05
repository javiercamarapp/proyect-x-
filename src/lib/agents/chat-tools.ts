// ═══════════════════════════════════════════════════════════════════════════
// TOOLS del agente `analista_flota` (el chat "Pregunta a tus datos" del
// panel, 12-ago-2026). TODAS DE SOLO LECTURA y ancladas a `ctx.tenantId` —
// el modelo decide CUÁL llamar y con qué ventana, NUNCA de qué flota: el
// tenant lo fijó el servidor al autorizar. Ninguna tool acepta texto libre
// que llegue a una consulta: los únicos parámetros son enums cerrados.
// Es la alternativa deliberada a "lenguaje natural → SQL", que esta caja
// jamás debe tener (la usa un tenant real, y el panel corre con service
// role — ver el mismo criterio en chat.tsx desde su primera versión).
//
// Los resultados van RECORTADOS (topes de filas) a propósito: el costo del
// turno es proporcional a lo que el modelo lee, y 100 viajes completos por
// pregunta es pagar tokens por filas que la respuesta no usa.
// ═══════════════════════════════════════════════════════════════════════════

import { registerTool } from '@/lib/llm/tool-executor';
import {
  getKpis, getAcreditables, detectarAnomalias, getViajes, getLiquidaciones,
  getGastoPorSemanaSeries, getLiquidadoPorSemanaSeries, getTopRutasPorGastoSeries,
} from '@/lib/likida/analytics';
import { getConfig } from '@/lib/likida/config';
import { getEstadoCartaPorte } from '@/lib/likida/carta_porte_datos';
import { NORMAS, esVinculante } from '@/lib/likida/normas/indice';
import { TEMAS_NORMATIVOS, normasPorTema } from '@/lib/likida/normas/consulta';
import { resolverPeriodo, getGastosFiscales, resumirPerdidas, opcionesDe } from '@/lib/likida/fiscal';
import { ahoraMs } from '@/lib/saludo';
import { hoyMx } from '@/lib/formato';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { acotada } from '@/lib/likida/presupuesto';
import { logger } from '@/lib/logger';

const SIN_PARAMS = { type: 'object', properties: {}, additionalProperties: false } as const;

/**
 * AUDITORÍA 24, TC-N3 (MEDIO): `viajes_flota` y `liquidaciones_flota` publicaban
 * `total: vs.length` — el LÍMITE de la consulta (100 y 50), no el total de la
 * flota. Con 15,000 viajes el analista decía «llevan 100 viajes» y la guardia
 * lo respaldaba porque la tool lo devolvió. El total sale de un `count` real;
 * si el conteo falla, `null` con nota — nunca un número que no se midió.
 */
async function contarDeLaFlota(tabla: 'viaje' | 'liquidacion', tenantId: string): Promise<number | null> {
  try {
    const { count, error } = await acotada(
      supabaseAdmin().from(tabla).select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
      `chat-tools.contar_${tabla}`,
    );
    if (error) throw new Error(error.message);
    if (typeof count !== 'number') throw new Error('PostgREST no devolvió el conteo');
    return count;
  } catch (e) {
    logger.warn('chat_tools.conteo_fallo', { tabla, tenantId, err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** `total` real o `null` con su nota: la regla del repo, nunca inventar una cifra. */
function conTotal(total: number | null): { total: number | null; nota?: string } {
  return total === null ? { total: null, nota: 'no se pudo contar el total de la flota; `mostrando` es lo que sí se leyó' } : { total };
}

/** Único parámetro que existe en este set: la ventana, como enum cerrado. */
const PARAM_MODO = {
  type: 'object',
  properties: {
    modo: { type: 'string', enum: ['semanal', 'mensual', 'historico'], description: 'Ventana: últimos 7 días, últimos 30, o todo el histórico.' },
  },
  required: ['modo'],
  additionalProperties: false,
} as const;

type Modo = 'semanal' | 'mensual' | 'historico';
function modoDe(args: Record<string, unknown>): Modo {
  const m = args.modo;
  return m === 'mensual' || m === 'historico' ? m : 'semanal';
}
/** DAT-23 (auditoría prod): era el día UTC. El dueño que le pregunta al
 *  copiloto a las 19:00 recibía las cifras de MAÑANA —y el 31 de diciembre,
 *  las del ejercicio siguiente— porque las tres `*Series` de `analytics.ts`
 *  cuelgan sus ventanas de este `hoy`. La flota, el contralor y el SAT están
 *  todos en México. */
function hoyIso(): string {
  return hoyMx(new Date(ahoraMs()));
}

/**
 * El modo pedido, o LANZA.
 *
 * ESCALA 50k / FE-4 (22-ago-2026): las tres funciones `*Series` de
 * `analytics.ts` pasaron a `Promise.allSettled` por modo — un modo que no se
 * pudo cargar vale `null` en vez de tumbar los otros dos, que es lo que la
 * PANTALLA necesita (pinta los que sí llegaron). El chat no: aquí el modo
 * que se pide ES la respuesta, y un `null` convertido en "0 categorías" o
 * "ninguna ruta" sería el modelo AFIRMÁNDOLE al dueño que su flota no gastó
 * nada. Se lanza, y el ejecutor de tools reporta el fallo.
 */
function exigirModo<T>(v: T | null, tool: string, modo: Modo): T {
  if (v === null) throw new Error(`${tool}: no se pudo cargar la vista "${modo}" (ver analytics.modo_caido)`);
  return v;
}

registerTool('kpis_flota', {
  schema: {
    type: 'function',
    function: {
      name: 'kpis_flota',
      description: 'KPIs de cuadre de la flota (histórico completo): viajes liquidados, monto comprobado MXN, dinero observado, con diferencias, por revisar, tasa de cuadre %.',
      parameters: SIN_PARAMS,
    },
  },
  handler: async (_a, ctx) => ({ moneda: 'MXN', ...(await getKpis(ctx.tenantId)) }),
});

registerTool('acreditables_periodo', {
  schema: {
    type: 'function',
    function: {
      name: 'acreditables_periodo',
      description: 'Acreditables fiscales del ejercicio en curso: IVA MXN, peaje al 50% MXN y litros de diésel elegibles para el estímulo (LIF 2026 Art. 20-A). El estímulo en pesos NO se calcula aquí: es cuota DOF semanal × litros.',
      parameters: SIN_PARAMS,
    },
  },
  handler: async (_a, ctx) => {
    const hoy = hoyIso();
    const periodo = resolverPeriodo(undefined, hoy);
    const dias = periodo.desde
      ? Math.floor((Date.parse(`${hoy}T00:00:00Z`) - Date.parse(`${periodo.desde}T00:00:00Z`)) / 86_400_000) + 1
      : undefined;
    const a = await getAcreditables(ctx.tenantId, dias);
    return { periodo: periodo.etiqueta, moneda: 'MXN', ivaAcreditable: a.iva, peajeAcreditable50pct: a.peaje, litrosDieselElegibles: a.litrosDiesel };
  },
});

registerTool('motor_fiscal', {
  schema: {
    type: 'function',
    function: {
      name: 'motor_fiscal',
      description: 'El motor fiscal del ejercicio: monto perdido, en riesgo y recuperable pidiendo factura (MXN), con el desglose por causa. Es la lectura de deducciones del ejercicio en curso.',
      parameters: SIN_PARAMS,
    },
  },
  handler: async (_a, ctx) => {
    const periodo = resolverPeriodo(undefined, hoyIso());
    const [cfg, gastos] = await Promise.all([
      getConfig(ctx.tenantId),
      getGastosFiscales(ctx.tenantId, periodo),
    ]);
    const r = resumirPerdidas(gastos, opcionesDe(cfg));
    return {
      periodo: periodo.etiqueta, moneda: 'MXN',
      montoPerdido: r.montoPerdido, montoEnRiesgo: r.montoEnRiesgo, montoRecuperable: r.montoRecuperable,
      porCausa: r.porCausa.slice(0, 6),
    };
  },
});

registerTool('viajes_flota', {
  schema: {
    type: 'function',
    function: {
      name: 'viajes_flota',
      description: 'Los viajes más recientes de la flota (máx. 25): folio, origen→destino, estatus (abierto|en_cuadre|liquidado), anticipo MXN, operador y fecha de inicio. `total` es el conteo REAL de viajes de la flota (null si no se pudo contar); `mostrando`, cuántos van en la lista.',
      parameters: SIN_PARAMS,
    },
  },
  handler: async (_a, ctx) => {
    const [vs, total] = await Promise.all([getViajes(ctx.tenantId), contarDeLaFlota('viaje', ctx.tenantId)]);
    return {
      ...conTotal(total), mostrando: Math.min(vs.length, 25), moneda: 'MXN',
      viajes: vs.slice(0, 25).map((v) => ({
        folio: v.folio, origen: v.origen, destino: v.destino, estatus: v.estatus,
        anticipo: v.anticipo, operador: v.operadorNombre, inicio: v.fechaInicio,
      })),
    };
  },
});

registerTool('liquidaciones_flota', {
  schema: {
    type: 'function',
    function: {
      name: 'liquidaciones_flota',
      description: 'Las liquidaciones vigentes más recientes, excluyendo rechazadas (máx. 20): folio del viaje, monto comprobado MXN, diferencia MXN y estatus (cuadrada|con_diferencias|revisar). `total` es el conteo REAL histórico de liquidaciones de la flota, incluidas las rechazadas (null si no se pudo contar); `mostrando`, cuántas van en la lista.',
      parameters: SIN_PARAMS,
    },
  },
  handler: async (_a, ctx) => {
    const [ls, total] = await Promise.all([getLiquidaciones(ctx.tenantId), contarDeLaFlota('liquidacion', ctx.tenantId)]);
    return {
      ...conTotal(total), mostrando: Math.min(ls.length, 20), moneda: 'MXN',
      filtro: 'sin_rechazadas', totalIncluyeRechazadas: true,
      liquidaciones: ls.slice(0, 20).map((l) => ({
        folio: l.folio, comprobado: l.comprobado, diferencia: l.diferencia, estatus: l.estatus, creadaEn: l.creadoEn,
      })),
    };
  },
});

registerTool('serie_gasto', {
  schema: {
    type: 'function',
    function: {
      name: 'serie_gasto',
      description: 'Serie de gasto por categoría (diésel, casetas, viáticos...) en la ventana pedida, en MXN — para tendencias y comparaciones de gasto.',
      parameters: PARAM_MODO,
    },
  },
  handler: async (args, ctx) => {
    const s = exigirModo((await getGastoPorSemanaSeries(ctx.tenantId, hoyIso()))[modoDe(args)], 'serie_gasto', modoDe(args));
    return { modo: modoDe(args), moneda: 'MXN', categorias: s.categorias, series: s.series };
  },
});

registerTool('serie_liquidado', {
  schema: {
    type: 'function',
    function: {
      name: 'serie_liquidado',
      description: 'Serie de monto liquidado por bucket de tiempo en la ventana pedida, en MXN — para ver el ritmo de cierres.',
      parameters: PARAM_MODO,
    },
  },
  handler: async (args, ctx) => {
    const s = exigirModo((await getLiquidadoPorSemanaSeries(ctx.tenantId, hoyIso()))[modoDe(args)], 'serie_liquidado', modoDe(args));
    return { modo: modoDe(args), moneda: 'MXN', puntos: s.slice(0, 60) };
  },
});

registerTool('top_rutas', {
  schema: {
    type: 'function',
    function: {
      name: 'top_rutas',
      description: 'Las 5 rutas con más gasto en la ventana pedida, en MXN.',
      parameters: PARAM_MODO,
    },
  },
  handler: async (args, ctx) => {
    const s = exigirModo((await getTopRutasPorGastoSeries(ctx.tenantId, 5, hoyIso()))[modoDe(args)], 'top_rutas', modoDe(args));
    return { modo: modoDe(args), moneda: 'MXN', rutas: s };
  },
});

/** Proyección determinística: promedio de los últimos cortes CON datos,
 *  extendido hacia adelante. Es una estimación y lo dice — el supuesto viaja
 *  en el resultado y el prompt obliga a narrarlo (regla del producto: una
 *  estimación se muestra declarada, nunca disfrazada de medición). */
export function proyectarPuntos(valores: number[]): {
  cortesConDatos: number; promedioPorCorte: number; sumaObservada: number;
  proyeccionSiguienteCorte: number; proyeccionSiguientes4: number; supuesto: string;
} | { sinDatos: true } {
  const conDatos = valores.filter((v) => v > 0);
  if (conDatos.length === 0) return { sinDatos: true };
  const base = conDatos.slice(-4);
  const promedio = Math.round((base.reduce((a, b) => a + b, 0) / base.length) * 100) / 100;
  return {
    cortesConDatos: conDatos.length,
    promedioPorCorte: promedio,
    sumaObservada: Math.round(valores.reduce((a, b) => a + b, 0) * 100) / 100,
    proyeccionSiguienteCorte: promedio,
    proyeccionSiguientes4: Math.round(promedio * 4 * 100) / 100,
    supuesto: `promedio simple de los últimos ${base.length} cortes con datos, extendido hacia adelante — no considera estacionalidad ni viajes ya planeados`,
  };
}

registerTool('proyectar_serie', {
  schema: {
    type: 'function',
    function: {
      name: 'proyectar_serie',
      description: 'PROYECCIÓN determinística (calculada por el sistema, no por ti) del gasto o del liquidado: promedio de los últimos cortes con datos extendido hacia adelante, con su supuesto declarado. Úsala para "cuánto voy a gastar/liquidar" — y SIEMPRE narra el supuesto.',
      parameters: {
        type: 'object',
        properties: {
          serie: { type: 'string', enum: ['gasto', 'liquidado'], description: 'Qué proyectar.' },
          modo: { type: 'string', enum: ['semanal', 'mensual', 'historico'], description: 'Ventana de la serie base.' },
        },
        required: ['serie', 'modo'],
        additionalProperties: false,
      },
    },
  },
  handler: async (args, ctx) => {
    const modo = modoDe(args);
    if (args.serie === 'liquidado') {
      const s = exigirModo((await getLiquidadoPorSemanaSeries(ctx.tenantId, hoyIso()))[modo], 'proyeccion/liquidado', modo);
      return { serie: 'liquidado', modo, moneda: 'MXN', ...proyectarPuntos(s.map((p) => p.valor)) };
    }
    const g = exigirModo((await getGastoPorSemanaSeries(ctx.tenantId, hoyIso()))[modo], 'proyeccion/gasto', modo);
    // Total por corte = suma de todas las categorías en ese corte.
    const n = Math.max(...g.series.map((x) => x.valores.length), 0);
    const totales = Array.from({ length: n }, (_, i) => g.series.reduce((a, x) => a + (x.valores[i] ?? 0), 0));
    return { serie: 'gasto', modo, moneda: 'MXN', ...proyectarPuntos(totales) };
  },
});

registerTool('duplicados_detectados', {
  schema: {
    type: 'function',
    function: {
      name: 'duplicados_detectados',
      description: 'Comprobantes repetidos entre viajes distintos (posible doble cobro) — detalle y monto MXN. Coincidencia detectada, no un veredicto.',
      parameters: SIN_PARAMS,
    },
  },
  handler: async (_a, ctx) => {
    const as = await detectarAnomalias(ctx.tenantId);
    return { total: as.length, moneda: 'MXN', anomalias: as.slice(0, 10) };
  },
});

registerTool('consultar_carta_porte', {
  schema: {
    type: 'function',
    function: {
      name: 'consultar_carta_porte',
      description: 'El semáforo de Carta Porte de los viajes en curso: si cada uno necesita el complemento (o qué falta declarar), y cuántos de los 37 datos del Apéndice 3 faltan por responsable. SOLO LECTURA — las declaraciones se firman en el panel o por WhatsApp, nunca desde el chat.',
      parameters: SIN_PARAMS,
    },
  },
  handler: async (_a, ctx) => {
    const e = await getEstadoCartaPorte(ctx.tenantId);
    const n = NORMAS['rmf-2026-2.7.7'];
    return {
      total_en_curso: e.total,
      evaluados: e.viajes.length,
      // Declarado en el PERFIL, nunca inferido; null = sin declarar.
      hazmat_declarado: e.hazmatDeclarado,
      transporte_dedicado_declarado: e.dedicadoDeclarado,
      // Recortado a lo que una respuesta usa: el veredicto con fundamento y
      // los conteos. El detalle campo por campo vive en el panel.
      viajes: e.viajes.map((v) => ({
        folio: v.folio,
        ruta: v.origen && v.destino ? `${v.origen} → ${v.destino}` : null,
        necesita_complemento: v.decision.necesita,
        fundamento: v.decision.fundamento,
        pendientes_para_decidir: v.decision.pendientes,
        faltan_datos_transportista: v.checklist.faltanTransportista,
        faltan_datos_cliente: v.checklist.faltanCliente,
        borrador_armable: v.borrador.borrador !== null,
        fallas_validador: v.borrador.fallas.map((f) => f.campo),
      })),
      advertencia: 'Likida no timbra ni afirma exenciones: un «no necesita» requiere la declaración firmada de la flota (el veredicto de arriba ya la refleja si existe).',
      fundamentos: [{
        norma_id: n.id,
        cita: n.citas[0],
        jerarquia: n.jerarquia,
        verificada: n.estado !== 'sin_verificar',
        vinculante: esVinculante(n.jerarquia),
      }],
    };
  },
});

// ── El experto fiscal del chat (Fase 9) ────────────────────────────────────
// Abre el corpus de `normas/` completo, por TEMAS CERRADOS (la doctrina de
// este archivo: nada de texto libre). El candado duro no vive aquí sino en
// `guardiaFundamento`: el modelo solo puede citar una norma que esta tool le
// devolvió en el turno — lo demás se quita del texto. Aquí lo que viaja es
// la HONESTIDAD de cada ficha: jerarquía (una política de portal no es una
// obligación fiscal), estado de verificación y si el producto puede afirmarla.
registerTool('consultar_normas', {
  schema: {
    type: 'function',
    function: {
      name: 'consultar_normas',
      description: 'El corpus normativo verificado de Likida, por tema: qué normas fundan lo que el producto mide (deducibilidad, IVA, peajes, carta porte, IMSS, privacidad). Devuelve cada norma con su cita, jerarquía (ley > reglamento > RMF/RFA > criterio > política de tercero), estado de verificación y si es afirmable. ÚSALA antes de responder cualquier pregunta con fondo legal o fiscal — solo puedes citar lo que esta tool te devuelva.',
      parameters: {
        type: 'object',
        properties: {
          tema: {
            type: 'string',
            enum: [...TEMAS_NORMATIVOS],
            description: 'El tema de la pregunta. Si toca varios, llama la tool una vez por tema.',
          },
        },
        required: ['tema'],
        additionalProperties: false,
      },
    },
  },
  handler: async (args) => {
    const tema = String(args.tema ?? '');
    const normas = normasPorTema(tema);
    const sinVerificar = normas.filter((n) => !n.afirmable);
    return {
      tema,
      normas,
      // Las reglas de uso viajan CON el dato, no solo en el prompt: el turno
      // que las necesita las tiene enfrente.
      reglas: [
        'Cita SOLO estas normas, con su campo "cita" textual. Nada de memoria.',
        'jerarquia 5-6 NO obliga (criterio no vinculativo / política de un tercero): preséntala como orientación, jamás como obligación fiscal.',
        ...(sinVerificar.length > 0
          ? [`SIN AFIRMAR (ficha sin verificar contra fuente primaria): ${sinVerificar.map((n) => n.cita).join(', ')} — decláralo como pendiente de verificación.`]
          : []),
        'Si el tema de la pregunta no está cubierto por estas fichas, dilo tal cual y recomienda validarlo con su contador o fiscalista — no rellenes el hueco.',
        'Esto es el corpus del motor de reglas, no un dictamen: toda respuesta fiscal cierra recomendando validarla con su contador.',
      ],
    };
  },
});
