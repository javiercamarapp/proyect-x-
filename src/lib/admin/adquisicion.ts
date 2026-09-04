// ═══════════════════════════════════════════════════════════════════════════
// ADQUISICIÓN — costo por lead y alertas (panel-de-adquisicion §2 y §5).
//
// LA REGLA QUE GOBIERNA LAS CIFRAS: costo REAL solo donde existe por diseño
// ($0 del censo/DENUE/manual); donde la integración de gasto no existe
// (Maps, Ads), la fila dice "falta integración" — jamás un $0 ni una
// proyección con cara de medición (§2: "mostrar un número proyectado como
// si fuera medido es exactamente el error que el paquete prohíbe").
//
// LAS ALERTAS heredan su umbral de los documentos que YA lo fijaron (§5) —
// este módulo no inventa umbrales: fuente muerta (días sin capturar, el
// concepto de alarma del Cazador), SLA de primer toque (>48h en `nuevo` sin
// contacto — proceso-de-prospeccion §1) y leads quemados (~10% de perdidos
// sobre contactados — agentes-ia-de-ventas §4). Las dos que NO tienen
// fuente de datos todavía (lead caliente INTERES_REAL, CPL de campañas) se
// declaran así, con nombre.
// ═══════════════════════════════════════════════════════════════════════════
import { supabaseAdmin } from '@/lib/supabase/admin';
import { traerTodo, conteo } from '@/lib/likida/pg';
import {
  listarProspectos,
  normalizarEstadoProspecto,
  type ProspectoRow,
} from '@/lib/likida/vendedores';

export interface FuenteAdquisicion {
  fuente: string;
  leads: number;
  /** El más nuevo capturado — la señal de vida de la fuente. */
  ultimoCapturado: string | null;
  /** `{ usd: 0 }` solo cuando el costo ES $0 por diseño; `null` = el gasto
   *  real no se puede medir todavía, y `costoNota` dice por qué. */
  costo: { usd: number } | null;
  costoNota: string;
}

export interface AlertaAdquisicion {
  id: 'fuente_muerta' | 'sla_primer_toque' | 'leads_quemados';
  titulo: string;
  detalle: string;
  /** La regla de la que hereda el umbral — citada, no inventada. */
  regla: string;
}

export interface Adquisicion {
  porFuente: FuenteAdquisicion[];
  alertas: AlertaAdquisicion[];
  /** Alertas del blueprint SIN fuente de datos hoy — declaradas por nombre. */
  sinFuenteDeDatos: Array<{ alerta: string; falta: string }>;
  totalProspectos: number;
}

/** Fuentes con costo $0 POR DISEÑO (panel-de-adquisicion §1). */
const COSTO_CERO: Record<string, string> = {
  censo: '$0 por diseño — bolsas de trabajo públicas',
  denue: '$0 por diseño — directorio público del INEGI',
  manual: '$0 — alta a mano desde /admin/vendedores',
  inbound: '$0 en adquisición — el lead llegó solo',
  aaag: '$0 por diseño — padrón público de transportistas de la Asociación de Agentes Aduanales de Guadalajara',
  bolsa: '$0 por diseño — bolsas de trabajo públicas (histórico)',
  'scribd-tampico': '$0 por diseño — directorio público del corredor Tampico-Madero',
  landing: '$0 por diseño — formulario orgánico de la landing',
};
const SIN_INTEGRACION: Record<string, string> = {
  maps: 'falta integración con el consumo de la API de Google Cloud',
  linkedin: 'costo de suscripción, no por lead — sin integración',
  ads: 'falta integración con Meta/Google Ads',
  // NO es $0: directorio de socios COMPRADO a CANACAR (~$800 MXN, pago
  // único, 17-ago) — no hay integración de gasto que lo trackee por lead,
  // así que no se reparte un costo-por-lead que nadie midió. El monto real
  // vive aquí en texto, no como cifra — inventar un $/lead sería la
  // "proyección con cara de medición" que la regla de arriba prohíbe.
  canacar: 'directorio comprado (~$800 MXN, pago único, 17-ago-2026) — sin integración de gasto que reparta el costo por lead',
};

const CANALES_PAGADOS = new Set(['ads', 'ads-meta', 'ads-google']);

const DIAS_FUENTE_MUERTA = 7;
const HORAS_SLA_PRIMER_TOQUE = 48;
const PCT_LEADS_QUEMADOS = 10;

/** LANZA si el pipeline no se puede leer — un panel de adquisición vacío por
 *  base caída afirmaría "no hay pipeline". */
export async function getAdquisicion(ahoraMs: number): Promise<Adquisicion> {
  const prospectos = await listarProspectos();

  // Los prospectos que YA recibieron un primer toque (salida en 0118).
  // Fail-closed: si el historial no se puede leer, LANZA — calcular el SLA
  // sin él marcaría "sin contacto" a leads ya contactados.
  const contactados = new Set(
    (await traerTodo<{ prospecto_id: string }>(
      (d, h) => supabaseAdmin().from('prospecto_contacto')
        .select('prospecto_id', conteo(d))
        .eq('direccion', 'salida')
        .order('id').range(d, h),
      'adquisicion.contactos',
    )).map((c) => c.prospecto_id),
  );

  // ── Por fuente ───────────────────────────────────────────────────────────
  const grupos = new Map<string, ProspectoRow[]>();
  for (const p of prospectos) {
    const g = grupos.get(p.fuente) ?? [];
    g.push(p);
    grupos.set(p.fuente, g);
  }
  const porFuente: FuenteAdquisicion[] = [...grupos.entries()].map(([fuente, filas]) => {
    const ultimo = filas.reduce<string | null>((m, p) => (m === null || p.createdAt > m ? p.createdAt : m), null);
    const cero = COSTO_CERO[fuente];
    return {
      fuente,
      leads: filas.length,
      ultimoCapturado: ultimo,
      costo: cero ? { usd: 0 } : null,
      costoNota: cero ?? (CANALES_PAGADOS.has(fuente) ? SIN_INTEGRACION.ads : SIN_INTEGRACION[fuente]) ?? 'sin regla de costo declarada para esta fuente',
    };
  }).sort((a, b) => b.leads - a.leads);

  // ── Alertas con umbral heredado ──────────────────────────────────────────
  const alertas: AlertaAdquisicion[] = [];

  for (const f of porFuente) {
    const dias = f.ultimoCapturado === null
      ? null
      : Math.floor((ahoraMs - Date.parse(f.ultimoCapturado)) / 86_400_000);
    if (dias !== null && dias > DIAS_FUENTE_MUERTA) {
      alertas.push({
        id: 'fuente_muerta',
        titulo: `Fuente «${f.fuente}» sin capturar hace ${dias} días`,
        detalle: `El prospecto más nuevo de esta fuente entró hace ${dias} días — si el Cazador debía correr, no está corriendo.`,
        regla: 'prompts/cazador.md — "días desde la última corrida exitosa es LA alarma"',
      });
    }
  }

  const hace48h = ahoraMs - HORAS_SLA_PRIMER_TOQUE * 3_600_000;
  const slaRoto = prospectos.filter((p) =>
    p.estado === 'nuevo' && Date.parse(p.createdAt) < hace48h && !contactados.has(p.id));
  if (slaRoto.length > 0) {
    alertas.push({
      id: 'sla_primer_toque',
      titulo: `${slaRoto.length} lead${slaRoto.length === 1 ? '' : 's'} en «nuevo» sin primer toque en 48h`,
      detalle: 'Llevan más de 48 horas capturados sin un solo contacto de salida en su historial.',
      regla: 'proceso-de-prospeccion §1 — SLA de primer toque: 48h',
    });
  }

  // Quemados = perdidos sobre los que salieron de `nuevo` (contactados en
  // adelante) — SIEMPRE con el absoluto al lado, nunca el % suelto.
  const tocados = prospectos.filter((p) => p.estado !== 'nuevo');
  const perdidos = tocados.filter((p) => normalizarEstadoProspecto(p.estado) === 'lost');
  if (tocados.length > 0) {
    const pct = (perdidos.length / tocados.length) * 100;
    if (pct > PCT_LEADS_QUEMADOS) {
      alertas.push({
        id: 'leads_quemados',
        titulo: `Leads quemados: ${perdidos.length} de ${tocados.length} contactados (${Math.round(pct)}%)`,
        detalle: 'Sobre el umbral del ~10%: se detiene el envío y se revisan mensaje y segmentación antes de seguir. El censo es finito.',
        regla: 'agentes-ia-de-ventas §4 / redactor.md — la métrica de alarma',
      });
    }
  }

  return {
    porFuente,
    alertas,
    sinFuenteDeDatos: [
      { alerta: 'Lead caliente sin atender (INTERES_REAL en minutos)', falta: 'el calificador de conversaciones todavía no clasifica respuestas en el producto' },
      { alerta: 'CPL disparado (2× el objetivo aprobado)', falta: 'cero campañas activas y sin integración de gasto de Meta/Google Ads' },
    ],
    totalProspectos: prospectos.length,
  };
}
