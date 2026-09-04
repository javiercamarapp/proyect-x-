// ═══════════════════════════════════════════════════════════════════════════
// TOOLS 🟢 del COPILOTO DEL FUNDADOR (Fase 2 del blueprint, 16-ago-2026).
// Espejo de chat-tools.ts pero a nivel COMPAÑÍA: envuelven las MISMAS
// funciones que pintan las pantallas de /admin — jamás SQL libre.
//
// La única superficie que las expone es /api/admin/copiloto, detrás de
// sesión superadmin: el registro de tools es global, pero el analista del
// cliente lista sus tools por nombre (TOOLS_LECTURA en analista.ts) y estas
// no están en esa lista — un tenant no puede alcanzarlas.
//
// Cada resultado lleva `pantalla`: la ruta de /admin donde vive esa lectura.
// Es lo que hace clicable la fuente de cada cifra (guardarraíl §5.2 del
// diseño) — la interfaz pinta el chip determinísticamente desde aquí.
// ═══════════════════════════════════════════════════════════════════════════

import { registerTool } from '@/lib/llm/tool-executor';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getFichaCliente } from '@/lib/admin/ficha-cliente';
import { getAdquisicion } from '@/lib/admin/adquisicion';
import { gastoDelDiaUsd } from '@/lib/likida/agentes/runner';
import { ultimasCorridasNegocio } from '@/lib/likida/agentes/corridas';
import { getResumenNegocio, getConteosPlataforma, getCostoPorFaseModelo } from '@/lib/admin/negocio';
import { getBandejaEscalaciones } from '@/lib/admin/escalaciones';
import { clasificacionDeGuardia } from '@/lib/admin/guardia';
import { ultimasEntradasBitacora } from '@/lib/admin/bitacora';
import { corridasRecientes, trazaDeCorrida } from '@/lib/admin/corridas-cruzadas';
import { listarInterruptores } from '@/lib/likida/interruptores';
import { listarProspectos, listarVendedores, conteosVacios, normalizarEstadoProspecto } from '@/lib/likida/vendedores';
import { getPorCobrar } from '@/lib/saas/transferencia';
import { ahoraMs } from '@/lib/saludo';

const SIN_PARAMS = { type: 'object', properties: {}, additionalProperties: false } as const;

/** Los nombres que el motor del copiloto expone al modelo — la lista es el
 *  sandbox: una tool que no esté aquí no existe para este agente. */
export const TOOLS_COPILOTO_LECTURA = [
  'metrica_negocio', 'conteos_plataforma', 'bandeja', 'guardia', 'metrica_norte',
  'estado_agentes', 'traza_corrida', 'pipeline_ventas', 'cobranza_saas',
  'costo_por_fase_modelo', 'bitacora', 'ficha_cliente', 'estado_runner', 'adquisicion',
] as const;

/** tool → la pantalla de /admin que muestra lo mismo (la fuente clicable). */
export const PANTALLA_POR_TOOL: Record<string, { ruta: string; etiqueta: string }> = {
  metrica_negocio: { ruta: '/admin', etiqueta: 'Consola / Inicio' },
  conteos_plataforma: { ruta: '/admin', etiqueta: 'Consola / Inicio' },
  bandeja: { ruta: '/admin/escalaciones', etiqueta: 'Escalaciones' },
  guardia: { ruta: '/admin/escalaciones', etiqueta: 'Escalaciones' },
  metrica_norte: { ruta: '/admin', etiqueta: 'Consola / Inicio' },
  estado_agentes: { ruta: '/admin/observabilidad', etiqueta: 'Observabilidad' },
  traza_corrida: { ruta: '/admin/corridas', etiqueta: 'Corridas' },
  pipeline_ventas: { ruta: '/admin/vendedores', etiqueta: 'Vendedores' },
  cobranza_saas: { ruta: '/admin/costos-facturacion', etiqueta: 'Costos y facturación' },
  costo_por_fase_modelo: { ruta: '/admin/costos-facturacion', etiqueta: 'Costos' },
  bitacora: { ruta: '/admin/observabilidad', etiqueta: 'Observabilidad' },
  ficha_cliente: { ruta: '/admin/flotas', etiqueta: 'Flotas / Clientes' },
  estado_runner: { ruta: '/admin/observabilidad', etiqueta: 'Observabilidad' },
  adquisicion: { ruta: '/admin/crecimiento', etiqueta: 'Crecimiento' },
};

registerTool('metrica_negocio', {
  schema: {
    type: 'function',
    function: {
      name: 'metrica_negocio',
      description: 'Las métricas del negocio Likida (cross-tenant): flotas dadas de alta, viajes procesados, costo de IA USD con tendencia 7d, tokens, facturas procesadas. MRR hoy es $0 — cero clientes de pago, y se dice así.',
      parameters: SIN_PARAMS,
    },
  },
  handler: async () => {
    const r = await getResumenNegocio();
    return {
      pantalla: PANTALLA_POR_TOOL.metrica_negocio.ruta,
      mrrUsd: 0,
      nota_mrr: 'Cero clientes de pago (verificado): el MRR es $0 real, no un hueco de datos.',
      flotas: r.tenants,
      viajesProcesados: r.viajesProcesados,
      costoIaUsd: Math.round(r.costoIaUsd * 100) / 100,
      tendenciaCosto7dPct: r.tendenciaCosto,
      facturasProcesadasTotal: r.facturasTotal,
      porFlota: r.flotas.slice(0, 20).map((f) => ({
        nombre: f.nombre, plan: f.plan, viajes: f.viajes, costoIaUsd: Math.round(f.costoIaUsd * 100) / 100,
      })),
    };
  },
});

registerTool('conteos_plataforma', {
  schema: {
    type: 'function',
    function: {
      name: 'conteos_plataforma',
      description: 'Conteos de la plataforma: operadores dados de alta, liquidaciones generadas, conversaciones de WhatsApp, usuarios por rol.',
      parameters: SIN_PARAMS,
    },
  },
  handler: async () => ({ pantalla: PANTALLA_POR_TOOL.conteos_plataforma.ruta, ...(await getConteosPlataforma()) }),
});

registerTool('bandeja', {
  schema: {
    type: 'function',
    function: {
      name: 'bandeja',
      description: 'La bandeja de escalaciones: TODO lo que espera decisión humana hoy (ARCO, corridas en fallo, talachas, facturas de proveedor, tickets, liquidaciones por revisar), con sus conteos y qué fuentes NO se pudieron leer.',
      parameters: SIN_PARAMS,
    },
  },
  handler: async () => {
    const b = await getBandejaEscalaciones(ahoraMs());
    // Una fuente ciega se DICE por nombre: null ≠ 0 es la regla de la
    // bandeja misma, y esconderla aquí pintaría una cola más corta que la real.
    const fuentesCiegas = Object.entries(b.fuentes)
      .filter(([, f]) => f.items === null)
      .map(([nombre, f]) => ({ fuente: nombre, error: f.error }));
    return {
      pantalla: PANTALLA_POR_TOOL.bandeja.ruta,
      conteos: b.conteos,
      fuentesCiegas,
      cola: b.cola.slice(0, 12).map((i) => ({
        fuente: i.fuente, titulo: i.titulo, flota: i.tenantNombre, desde: i.desde, vence: i.vence,
      })),
      enCola: b.cola.length,
    };
  },
});

registerTool('guardia', {
  schema: {
    type: 'function',
    function: {
      name: 'guardia',
      description: 'El guardia de alertas (A0): clasifica la bandeja completa por severidad del runbook (S2 = una función dejó de operar; S3 = espera decisión con el sistema operando; fuente ciega = S2 por sí misma), con la regla citada por item. NO detecta S1 (el sistema mintiendo) — eso llega por otro canal y lo dice.',
      parameters: SIN_PARAMS,
    },
  },
  handler: async () => {
    const c = await clasificacionDeGuardia(ahoraMs());
    return {
      pantalla: PANTALLA_POR_TOOL.guardia.ruta,
      porSeveridad: c.porSeveridad,
      fuentesCiegas: c.fuentesCiegas,
      items: c.items.slice(0, 15),
      limites: c.limites,
    };
  },
});

registerTool('metrica_norte', {
  schema: {
    type: 'function',
    function: {
      name: 'metrica_norte',
      description: 'La métrica norte: liquidaciones que NO esperan revisión humana hoy, sobre el total histórico. El dato afirma el estado ACTUAL, no "nunca la tocó un humano".',
      parameters: SIN_PARAMS,
    },
  },
  handler: async () => {
    const [conteos, bandeja] = await Promise.all([
      getConteosPlataforma(),
      getBandejaEscalaciones(ahoraMs()),
    ]);
    const enRevisar = bandeja.conteos.liquidacionesRevisar;
    return {
      pantalla: PANTALLA_POR_TOOL.metrica_norte.ruta,
      liquidacionesTotal: conteos.liquidaciones,
      enRevisionHumana: enRevisar,
      sinHumanoHoy: enRevisar === null ? null : conteos.liquidaciones - enRevisar,
      nota: enRevisar === null ? 'La fuente de "por revisar" no se pudo leer — el numerador no se afirma.' : 'Estado de hoy: un re-cuadre puede reescribir el estatus sin rastro.',
    };
  },
});

registerTool('estado_agentes', {
  schema: {
    type: 'function',
    function: {
      name: 'estado_agentes',
      description: 'El estado de los agentes: los 8 interruptores del kill switch (quién está apagado, por qué y desde cuándo) y las corridas recientes cruzando todas las flotas.',
      parameters: SIN_PARAMS,
    },
  },
  handler: async () => {
    const [interruptores, corridas] = await Promise.all([
      listarInterruptores(),
      corridasRecientes(10),
    ]);
    return {
      pantalla: PANTALLA_POR_TOOL.estado_agentes.ruta,
      interruptores: interruptores.map((i) => ({
        id: i.id, apagado: i.apagado, motivo: i.motivo, cambiadoPor: i.cambiadoPorNombre, cambiadoEn: i.cambiadoEn,
      })),
      corridasRecientes: corridas.map((c) => ({
        agente: c.agente, flota: c.tenantNombre, estado: c.estado, disparo: c.disparo, inicio: c.inicio, error: c.error,
      })),
    };
  },
});

registerTool('traza_corrida', {
  schema: {
    type: 'function',
    function: {
      name: 'traza_corrida',
      description: 'La traza de UNA corrida de agente por su id (uuid): agente, flota, estado, error redactado, tareas y costo de IA en su ventana.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'El uuid de la corrida (viene de estado_agentes o de la bandeja).' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
  handler: async (args) => {
    const id = String((args as { id?: unknown }).id ?? '').trim();
    // El uuid se valida ANTES de tocar la base: basura aquí llegaría a
    // Postgres como 22P02, que no le dice nada a nadie.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return { error: 'Ese id no tiene forma de corrida. Pídele los ids a estado_agentes primero.' };
    }
    const t = await trazaDeCorrida(id);
    if (!t) return { error: 'No existe una corrida con ese id.' };
    return { pantalla: `${PANTALLA_POR_TOOL.traza_corrida.ruta}/${id}`, ...t };
  },
});

registerTool('pipeline_ventas', {
  schema: {
    type: 'function',
    function: {
      name: 'pipeline_ventas',
      description: 'El pipeline de ventas de LIKIDA (no de una flota): prospectos por estado del embudo, cuántos viven sin vendedor, y el desempeño de cada vendedor.',
      parameters: SIN_PARAMS,
    },
  },
  handler: async () => {
    const [prospectos, vendedores] = await Promise.all([
      listarProspectos(),
      listarVendedores(),
    ]);
    const porEstado = conteosVacios();
    let sinVendedor = 0;
    for (const p of prospectos) {
      const estado = normalizarEstadoProspecto(p.estado);
      if (estado !== null) porEstado[estado]++;
      if (p.vendedorId === null && p.estado === 'nuevo') sinVendedor++;
    }
    return {
      pantalla: PANTALLA_POR_TOOL.pipeline_ventas.ruta,
      prospectosTotal: prospectos.length,
      porEstado,
      nuevosSinVendedor: sinVendedor,
      vendedores: vendedores.map((v) => ({
        nombre: v.nombre ?? v.email, asignados: v.asignados, vivos: v.vivos, cerrados: v.cerrados,
      })),
    };
  },
});

registerTool('cobranza_saas', {
  schema: {
    type: 'function',
    function: {
      name: 'cobranza_saas',
      description: 'La cobranza SaaS de Likida: facturas de mensualidad por cobrar (hoy $0 — cero clientes de pago, y se dice así).',
      parameters: SIN_PARAMS,
    },
  },
  handler: async () => {
    const porCobrar = await getPorCobrar();
    return {
      pantalla: PANTALLA_POR_TOOL.cobranza_saas.ruta,
      facturasPorCobrar: porCobrar.length,
      detalle: porCobrar.slice(0, 10),
      nota: porCobrar.length === 0 ? 'Cero por cobrar porque hay cero clientes de pago — es el estado real, no un hueco.' : undefined,
    };
  },
});

registerTool('costo_por_fase_modelo', {
  schema: {
    type: 'function',
    function: {
      name: 'costo_por_fase_modelo',
      description: 'El costo de IA desglosado por fase (ocr, cuadre, chat, …) y por modelo real usado, en USD.',
      parameters: SIN_PARAMS,
    },
  },
  handler: async () => ({
    pantalla: PANTALLA_POR_TOOL.costo_por_fase_modelo.ruta,
    moneda: 'USD',
    desglose: (await getCostoPorFaseModelo()).slice(0, 20),
  }),
});

registerTool('bitacora', {
  schema: {
    type: 'function',
    function: {
      name: 'bitacora',
      description: 'Las últimas entradas de la bitácora de auditoría: quién hizo qué y cuándo (interruptores, aprobaciones, altas). Acepta un filtro de acción.',
      parameters: {
        type: 'object',
        properties: { filtro: { type: 'string', description: 'Filtro de acción (ej. "interruptor"). Opcional.' } },
        additionalProperties: false,
      },
    },
  },
  handler: async (args) => {
    const filtro = typeof (args as { filtro?: unknown }).filtro === 'string' ? (args as { filtro: string }).filtro : undefined;
    const entradas = await ultimasEntradasBitacora({ limite: 20, filtroAccion: filtro });
    return {
      pantalla: PANTALLA_POR_TOOL.bitacora.ruta,
      entradas: entradas.map((e) => ({
        accion: e.accion, entidad: e.entidad, entidadId: e.entidadId,
        actor: e.actor ?? 'sistema', flota: e.tenantNombre, cuando: e.ocurrioEn,
      })),
    };
  },
});

registerTool('ficha_cliente', {
  schema: {
    type: 'function',
    function: {
      name: 'ficha_cliente',
      description: 'La ficha 360 de UNA flota/cliente por su nombre (búsqueda parcial): de qué prospecto nació, operación (viajes, monto comprobado, por revisar), señales de PMF, costo de IA (30d e histórico), suscripción y facturas SaaS, tickets y últimas corridas de agentes. Para "¿cómo va el cliente X?" en una consulta.',
      parameters: {
        type: 'object',
        properties: { nombre: { type: 'string', description: 'El nombre (o parte) de la flota, como aparece en /admin/flotas.' } },
        required: ['nombre'],
        additionalProperties: false,
      },
    },
  },
  handler: async (args) => {
    const q = String((args as { nombre?: unknown }).nombre ?? '').trim();
    if (q.length < 2) return { error: 'Dame al menos 2 letras del nombre de la flota.' };
    // Resolución por nombre ANTES de armar nada: 0 = se dice; >1 = se listan
    // para desambiguar — adivinar la flota equivocada respondería sobre otro
    // cliente como si fuera este.
    const { data, error } = await supabaseAdmin()
      .from('tenant').select('id, nombre').ilike('nombre', `%${q}%`).limit(6);
    if (error) return { error: 'No se pudo buscar la flota — la base no respondió.' };
    const candidatos = (data ?? []) as Array<{ id: string; nombre: string }>;
    if (candidatos.length === 0) return { error: `Ninguna flota coincide con «${q}».` };
    if (candidatos.length > 1) {
      return { desambiguar: candidatos.map((c) => c.nombre), nota: 'Más de una coincide — pregunta cuál.' };
    }
    const ficha = await getFichaCliente(candidatos[0].id);
    if (!ficha) return { error: 'La flota desapareció entre la búsqueda y la lectura — reintenta.' };
    return { pantalla: `/admin/flotas/${candidatos[0].id}`, ...ficha };
  },
});


registerTool('estado_runner', {
  schema: {
    type: 'function',
    function: {
      name: 'estado_runner',
      description: 'El pulso del runner nivel 2 (los agentes AUTONOMOS): que agentes estan habilitados, su techo de dinero declarado vs el gasto MEDIDO de hoy, las ultimas corridas del redactor y cuantas piezas esperan aprobacion. Para "que han hecho mis agentes" y "cuanto han gastado hoy".',
      parameters: SIN_PARAMS,
    },
  },
  handler: async () => {
    const { data, error } = await supabaseAdmin()
      .from('agente_definicion')
      .select('id, nombre, estado, disparador, runner_habilitado, presupuesto_dia_usd')
      .eq('runner_habilitado', true);
    if (error) return { error: 'No se pudo leer el catalogo de agentes del runner.' };
    const agentes = await Promise.all(((data ?? []) as Array<{ id: string; nombre: string; estado: string; presupuesto_dia_usd: number | null }>).map(async (a) => {
      let gastadoHoyUsd: number | null = null;
      try { gastadoHoyUsd = Math.round((await gastoDelDiaUsd(a.id)) * 10000) / 10000; } catch { /* se dice null */ }
      return {
        agente: a.id, nombre: a.nombre, estado: a.estado,
        techoDiaUsd: a.presupuesto_dia_usd,
        gastadoHoyUsd,
        nota_gasto: gastadoHoyUsd === null ? 'el gasto del dia no se pudo leer — el runner tampoco correria asi (fail closed)' : undefined,
      };
    }));
    let corridas: unknown = null;
    try {
      corridas = (await ultimasCorridasNegocio('redactor', 5)).map((c) => ({
        estado: c.estado, disparo: c.disparo, fin: c.fin, resumen: c.resumen,
      }));
    } catch { /* se dice null */ }
    const { count } = await supabaseAdmin().from('cola_aprobacion')
      .select('id', { count: 'exact', head: true }).eq('estado', 'pendiente');
    return {
      pantalla: PANTALLA_POR_TOOL.estado_runner.ruta,
      agentes,
      ultimasCorridasRedactor: corridas,
      piezasPendientesAprobacion: typeof count === 'number' ? count : null,
      nota: 'El runner corre cada 4 horas (cron) y se puede adelantar con la accion correr_runner (confirmada). Todo lo fabricado espera aprobacion humana.',
    };
  },
});

registerTool('adquisicion', {
  schema: {
    type: 'function',
    function: {
      name: 'adquisicion',
      description: 'Como van los ACERCAMIENTOS: costo por lead por fuente (real solo donde es $0 por diseno; sin integracion se dice), alertas de adquisicion con umbral heredado (fuente muerta, SLA de primer toque 48h, leads quemados) y el total de prospectos. Complementa a pipeline_ventas (que da el embudo por etapa).',
      parameters: SIN_PARAMS,
    },
  },
  handler: async () => {
    const a = await getAdquisicion(ahoraMs());
    return { pantalla: PANTALLA_POR_TOOL.adquisicion.ruta, ...a };
  },
});
