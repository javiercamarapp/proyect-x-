// ═══════════════════════════════════════════════════════════════════════════
// Las herramientas de DINERO del servidor MCP — todas detrás del área
// `dinero`, todas de solo lectura, y NINGUNA calcula nada nuevo: cada una
// pone un texto encima de un motor que ya existe y ya está probado
// (`getLibroViaje`, `getPorFacturar`, `getGastosFiscales`+`resumirFiscal`,
// `getKpis`). El MCP es una puerta, no un segundo cerebro.
//
// La regla de la casa sobre cifras aplica ÍNTEGRA: si el motor dice `null`,
// aquí se dice «no hay dato» — jamás un 0 con cara de medición.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from 'zod';
import { getLibroViaje, rotuloFacturacion, rotuloCobro, type RenglonLibro } from '@/lib/likida/libro_viaje';
import { getPorFacturar, resumen as resumenPorFacturar } from '@/lib/likida/facturacion/pendientes';
import {
  getGastosFiscales, resumirFiscal, resumirPerdidas, opcionesDe, opcionesFiscalesDelPeriodo, resolverPeriodo,
} from '@/lib/likida/fiscal';
import { getConfig } from '@/lib/likida/config';
import { getKpis } from '@/lib/likida/analytics';
import { mxn, numero, porcentaje, fechaCorta, hoyMx } from '@/lib/formato';
import { resolverViaje, rotuloViaje } from './viajes';
import type { Herramienta, ResultadoHerramienta } from '../tipos';

// ── cuadre_viaje ───────────────────────────────────────────────────────────

const esquemaCuadre = z.object({
  viaje: z.string().min(1).max(80)
    .describe('El folio del viaje tal como lo usa la flota (por ejemplo «F-0123»), o su identificador.'),
});

/** El renglón del libro mayor, contado en español. Los `null` se DICEN. */
export function contarRenglon(r: RenglonLibro): string {
  const lineas: string[] = [];
  lineas.push(`Viaje ${r.folio}${r.ruta ? ` · ${r.ruta}` : ''}${r.fechaInicio ? ` · inició ${fechaCorta(r.fechaInicio)}` : ''}`);
  lineas.push(`Estatus: ${r.estatus === 'en_cuadre' ? 'en cuadre' : r.estatus}${r.cliente ? ` · Cliente: ${r.cliente}` : ''}${r.unidad ? ` · Unidad: ${r.unidad}` : ''}`);
  lineas.push(`• Ingreso del flete: ${r.ingreso === null ? 'sin capturar' : mxn(r.ingreso)}`);
  lineas.push(`• Comprobado: ${r.comprobado === null ? 'sin liquidación todavía' : mxn(r.comprobado)}`);
  if (r.contribucion !== null && r.margenPct !== null) {
    lineas.push(`• Contribución: ${mxn(r.contribucion)} (margen ${porcentaje(r.margenPct)})`);
  } else if (r.falta) {
    lineas.push(`• Contribución: no se puede afirmar — ${r.falta}`);
  }
  lineas.push(`• Comprobantes: ${r.documental.rotulo}`);
  if (r.observaciones === null) {
    lineas.push('• Observaciones fiscales: aún no hay liquidación que revisar.');
  } else if (r.observaciones.length === 0) {
    lineas.push('• Observaciones fiscales: ninguna — el cuadre salió limpio.');
  } else {
    lineas.push(`• Observaciones fiscales (${r.observaciones.length}):`);
    for (const o of r.observaciones.slice(0, 8)) lineas.push(`   - ${o.nota}`);
    if (r.observaciones.length > 8) {
      lineas.push(`   - …y ${r.observaciones.length - 8} más en el panel.`);
    }
  }
  const cobro: string[] = [rotuloFacturacion(r.cobro.estadoFacturacion), rotuloCobro(r.cobro.estadoCobro)];
  if (r.cobro.saldo !== null && r.cobro.saldo > 0) {
    cobro.push(`saldo por cobrar ${mxn(r.cobro.saldo)}${r.cobro.diasVencida !== null ? ` (vencido hace ${r.cobro.diasVencida} día${r.cobro.diasVencida === 1 ? '' : 's'})` : ''}`);
  }
  if (r.cobro.importesCompartidos) {
    cobro.push('ojo: hay una factura que ampara varios viajes, los importes no son solo de éste');
  }
  lineas.push(`• Facturación y cobro: ${cobro.join(' · ')}`);
  return lineas.join('\n');
}

async function ejecutarCuadre(tenantId: string, args: z.infer<typeof esquemaCuadre>): Promise<ResultadoHerramienta> {
  const candidatos = await resolverViaje(tenantId, args.viaje);
  if (candidatos.length === 0) {
    return { texto: `No encontré ningún viaje «${args.viaje}» en tu flota. Revisa el folio; puedes listar los recientes con la herramienta de viajes.` };
  }
  if (candidatos.length > 1) {
    return {
      texto:
        `Hay ${candidatos.length} viajes con el folio «${args.viaje}» y no voy a adivinar cuál: ` +
        candidatos.map((c) => `${rotuloViaje(c)} (id ${c.id})`).join('; ') +
        '. Vuelve a pedirlo con el id.',
      estructurado: { ambiguo: true, candidatos },
    };
  }
  const renglon = await getLibroViaje(tenantId, candidatos[0].id);
  if (!renglon) {
    return { texto: `No encontré ningún viaje «${args.viaje}» en tu flota.` };
  }
  return { texto: contarRenglon(renglon), estructurado: { viaje: renglon } };
}

export const herramientaCuadreViaje: Herramienta<z.infer<typeof esquemaCuadre>> = {
  nombre: 'cuadre_viaje',
  titulo: 'Cuadre de un viaje',
  descripcion:
    'El cuadre completo de UN viaje: ingreso del flete, monto comprobado, contribución y margen, estado de los comprobantes, observaciones fiscales del motor y estado de facturación y cobro. Se pide por folio o identificador. Solo lectura.',
  area: 'dinero',
  esquema: esquemaCuadre,
  ejecutar: ejecutarCuadre,
};

// ── por_facturar ───────────────────────────────────────────────────────────

const esquemaPorFacturar = z.object({});

async function ejecutarPorFacturar(tenantId: string): Promise<ResultadoHerramienta> {
  const tickets = await getPorFacturar(tenantId);
  const r = resumenPorFacturar(tickets);
  if (r.total === 0) {
    return {
      texto: 'No hay comprobantes pendientes de facturar en la ventana vigente. Nada que perder por caducidad hoy.',
      estructurado: { resumen: r, urgentes: [] },
    };
  }
  const alerta = [...tickets]
    .filter((t) => t.caducidad.vencido || t.caducidad.urgente)
    .sort((a, b) => a.caducidad.diasRestantes - b.caducidad.diasRestantes)
    .slice(0, 10);
  const lineas = alerta.map((t) => {
    const estado = t.caducidad.vencido
      ? 'VENCIDO — el comercio ya no lo factura'
      : `vence en ${t.caducidad.diasRestantes} día${t.caducidad.diasRestantes === 1 ? '' : 's'}`;
    return `• ${t.concepto} de ${mxn(t.monto)}${t.fecha ? ` (${fechaCorta(t.fecha)})` : ''} — ${estado}`;
  });
  const texto = [
    `${numero(r.total)} comprobante${r.total === 1 ? '' : 's'} sin factura por ${mxn(r.montoTotal)} en total.`,
    `Vencidos: ${numero(r.vencidos)} (${mxn(r.montoVencido)} cuyo IVA ya no se va a poder acreditar). Urgentes (2 días o menos): ${numero(r.urgentes)}.`,
    ...(lineas.length > 0 ? ['', 'Los que piden acción ya:', ...lineas] : []),
    '',
    'La facturación se hace desde el panel; aquí solo se reporta.',
  ].join('\n');
  return {
    texto,
    estructurado: {
      resumen: r,
      urgentes: alerta.map((t) => ({
        concepto: t.concepto, monto: t.monto, fecha: t.fecha, folio: t.folio,
        vencido: t.caducidad.vencido, diasRestantes: t.caducidad.diasRestantes,
      })),
    },
  };
}

export const herramientaPorFacturar: Herramienta<z.infer<typeof esquemaPorFacturar>> = {
  nombre: 'por_facturar',
  titulo: 'Pendiente de facturar',
  descripcion:
    'Los comprobantes de gasto que aún no tienen factura (CFDI): cuántos son, cuánto dinero suman, cuáles ya vencieron y cuáles vencen en dos días o menos. No factura nada — eso se hace en el panel. Solo lectura.',
  area: 'dinero',
  esquema: esquemaPorFacturar,
  ejecutar: ejecutarPorFacturar,
};

// ── resumen_fiscal ─────────────────────────────────────────────────────────

const esquemaFiscal = z.object({
  periodo: z.enum(['mes', 'mes_anterior', 'ejercicio', 'todo']).optional()
    .describe('mes = el mes en curso; mes_anterior; ejercicio = el año en curso (por omisión); todo = el histórico completo.'),
});

async function ejecutarFiscal(tenantId: string, args: z.infer<typeof esquemaFiscal>): Promise<ResultadoHerramienta> {
  const periodo = resolverPeriodo(args.periodo, hoyMx());
  const cfg = await getConfig(tenantId);
  const opciones = opcionesDe(cfg);
  const gastos = await getGastosFiscales(tenantId, periodo, hoyMx(), opciones);
  // AUDITORÍA 25, FIS-C1/FIS-C2/ARQ-C1 (CRÍTICO): esta herramienta imprime la
  // MISMA cifra que `/dashboard/contador` — necesita el acumulado del
  // ejercicio para partir el IVA del diésel en efectivo igual que el motor,
  // o un agente la dicta distinta al PDF (el hallazgo era literal: la
  // divergencia «ya la puede dictar un agente»).
  const r = resumirFiscal(gastos, await opcionesFiscalesDelPeriodo(tenantId, periodo, cfg));
  const perdidas = resumirPerdidas(gastos, opciones);
  if (r.n === 0) {
    return {
      texto: `No hay comprobantes leídos en el periodo «${periodo.etiqueta}». Sin comprobantes no hay nada fiscal que afirmar.`,
      estructurado: { periodo: periodo.etiqueta, resumen: r },
    };
  }
  const texto = [
    `Estado fiscal — ${periodo.etiqueta}:`,
    `• ${numero(r.n)} comprobantes por ${mxn(r.gastoTotal)} de gasto total.`,
    `• Con CFDI: ${numero(r.conCfdi)} · Sin CFDI: ${numero(r.sinCfdi)}.`,
    `• IVA acreditable documentado: ${mxn(r.ivaAcreditable)} · IVA desglosado que NO se acredita: ${mxn(r.ivaNoAcreditable)}.`,
    // RE-AUDITORÍA 25, FIS-REAUD-3 (ALTO): esta cifra incluye combustible en
    // efectivo prorrateado al 15% de la RFA 2.9 contra el acumulado del
    // ejercicio A HOY — distinto del acumulado que tenía cada liquidación al
    // firmarse. No la dictes como si coincidiera con un PDF ya firmado.
    ...(r.combustible15SujetoADeriva
      ? ['• Ese IVA acreditable incluye combustible en efectivo prorrateado al 15% con el acumulado de HOY: puede no coincidir con lo que ya firmó una liquidación vieja del mismo periodo — la cifra archivada, que sí coincide con cada PDF, está en el panel del contador ("IVA acreditable de tus liquidaciones").']
      : []),
    ...(r.conCfdiSinDesglose > 0
      ? [`• ${numero(r.conCfdiSinDesglose)} comprobantes con CFDI pero sin XML leído: su IVA existe en papel y aquí no se afirma.`]
      : []),
    `• IEPS trasladado en CFDI de diésel con pago admitido (LISR 27-III) — NO es el estímulo (cuota × litros): ${mxn(r.iepsDieselDocumentado)}.`,
    `• Validación ante el SAT: ${numero(r.vigentes)} vigentes, ${numero(r.cancelados)} cancelados, ${numero(r.porValidar)} sin validar todavía.`,
    ...(perdidas.montoTotal > 0
      ? [
          `• Gasto tocado por alguna causa de pérdida de deducibilidad: ${mxn(perdidas.montoTotal)} — ` +
          `perdido ${mxn(perdidas.montoPerdido)}, en riesgo ${mxn(perdidas.montoEnRiesgo)}, recuperable pidiendo factura ${mxn(perdidas.montoRecuperable)}. ` +
          'El detalle por causa está en el panel del contador.',
        ]
      : ['• Sin pérdidas de deducibilidad detectadas en el periodo.']),
  ].join('\n');
  return {
    texto,
    estructurado: {
      periodo: periodo.etiqueta,
      resumen: r,
      perdidas: {
        montoTotal: perdidas.montoTotal,
        montoPerdido: perdidas.montoPerdido,
        montoEnRiesgo: perdidas.montoEnRiesgo,
        montoRecuperable: perdidas.montoRecuperable,
      },
    },
  };
}

export const herramientaResumenFiscal: Herramienta<z.infer<typeof esquemaFiscal>> = {
  nombre: 'resumen_fiscal',
  titulo: 'Estado fiscal del periodo',
  descripcion:
    'El estado fiscal de los gastos de la flota en un periodo: cuántos comprobantes hay, cuánto IVA acreditable está documentado, cuánto IEPS de diésel, qué está validado ante el SAT y cuánta deducibilidad está en riesgo. Las cifras salen del mismo motor que usa el panel del contador. Solo lectura.',
  area: 'dinero',
  esquema: esquemaFiscal,
  ejecutar: ejecutarFiscal,
};

// ── metricas_flota ─────────────────────────────────────────────────────────

const esquemaMetricas = z.object({
  ventana_dias: z.number().int().min(1).max(365).optional()
    .describe('La ventana en días hacia atrás (por ejemplo 7 o 30). Sin ella, el histórico completo.'),
});

async function ejecutarMetricas(tenantId: string, args: z.infer<typeof esquemaMetricas>): Promise<ResultadoHerramienta> {
  const k = await getKpis(tenantId, args.ventana_dias);
  const rotulo = args.ventana_dias ? `últimos ${args.ventana_dias} días` : 'todo el histórico';
  if (k.viajesLiquidados === 0) {
    return {
      texto: `Sin liquidaciones en ${rotulo}. No hay métricas que afirmar sobre cero liquidaciones.`,
      estructurado: { ventana: rotulo, kpis: k },
    };
  }
  const texto = [
    `Métricas de la flota — ${rotulo}:`,
    `• Viajes liquidados: ${numero(k.viajesLiquidados)}.`,
    `• Monto comprobado: ${mxn(k.montoComprobado)}.`,
    `• Diferencias detectadas por el motor: ${mxn(k.diferenciaDetectada)} en ${numero(k.conDiferencias)} liquidaciones.`,
    `• Por revisar: ${numero(k.porRevisar)}.`,
    `• Tasa de cuadre limpio: ${porcentaje(k.tasaCuadre)}.`,
  ].join('\n');
  return { texto, estructurado: { ventana: rotulo, kpis: k } };
}

export const herramientaMetricasFlota: Herramienta<z.infer<typeof esquemaMetricas>> = {
  nombre: 'metricas_flota',
  titulo: 'Métricas de la flota',
  descripcion:
    'Las métricas de liquidación de la flota en una ventana de días: viajes liquidados, monto comprobado, diferencias que el motor detectó, liquidaciones por revisar y tasa de cuadre limpio. Solo lectura.',
  area: 'dinero',
  esquema: esquemaMetricas,
  ejecutar: ejecutarMetricas,
};
