// ═══════════════════════════════════════════════════════════════════════════
// CONSULTA DEL CORPUS NORMATIVO — el experto fiscal del chat (Fase 9).
//
// El analista ya tiene el candado (`guardiaFundamento`: solo cita lo que una
// tool devolvió EN ESE TURNO), pero hasta hoy la única puerta era la norma de
// Carta Porte. Este módulo abre el corpus COMPLETO al chat, y lo hace por
// TEMAS CERRADOS — no por texto libre — por la misma doctrina de chat-tools:
// "ninguna tool acepta texto libre; los únicos parámetros son enums".
//
// El mapa TEMAS es un índice curado, no una segunda verdad: cada entrada
// apunta a una ficha que YA existe en `NORMAS` (indice.ts), y la prueba de
// sincronía obliga en las dos direcciones — un tema no puede citar una ficha
// inexistente, y una ficha nueva no puede quedar sin tema (si nadie puede
// preguntarle al corpus por ella, ¿para qué se verificó?).
//
// La honestidad viaja en el resultado, no en el prompt: cada norma sale con
// su `estado` de verificación y su `afirmable` (una ficha `sin_verificar` se
// ENSEÑA — existe y está declarada — pero el producto no la afirma: eso dice
// normas/README.md y aquí es un booleano, no una esperanza).
// ═══════════════════════════════════════════════════════════════════════════

import { NORMAS, esVinculante, type Norma } from './indice';

/** Los temas por los que el chat puede preguntar. Cerrado a propósito. */
export const TEMAS_NORMATIVOS = [
  'diesel_y_combustible',
  'peajes_y_casetas',
  'carta_porte',
  'viaticos_y_efectivo',
  'cfdi_y_facturacion',
  'iva_acreditable',
  'nomina_imss_y_descuentos',
  'privacidad_de_datos',
  'contabilidad_y_multas',
  'regimen_de_autotransporte',
  'jornada_y_horas_de_trabajo',
] as const;

export type TemaNormativo = (typeof TEMAS_NORMATIVOS)[number];

/**
 * Qué fichas responden cada tema. Una ficha puede vivir en varios temas (la
 * LIF 20-A es diésel Y peajes Y IVA acreditable) — eso no es duplicación,
 * es que la norma toca varios dolores.
 */
export const TEMAS: Record<TemaNormativo, readonly string[]> = {
  diesel_y_combustible: [
    'lif-2026-art-20-A', 'criterio-1-LIF-PI', 'rfa-2026-2.9',
    'rmf-2026-2.7.1.48', 'rmf-2026-3.3.1.7', 'lisr-27-fr-III',
  ],
  peajes_y_casetas: [
    'lif-2026-art-20-A', 'rmf-2026-9.1.7', 'rmf-2026-9.1.8',
    'red-nacional-autopistas', 'tesis-autotransporte',
  ],
  carta_porte: ['rmf-2026-2.7.7', 'rliva-3-fr-II'],
  viaticos_y_efectivo: [
    'lisr-27-fr-III', 'lisr-28-fr-V', 'lisr-28-fr-XX', 'rlisr-57',
    'rfa-2026-2.2', 'lft-110-111-263',
  ],
  cfdi_y_facturacion: [
    'cff-29-A', 'criterio-1-CFF-PI', 'cff-69-B', 'rmf-2026-2.7.1.21', 'rmf-2026-2.7.1.29',
    'rmf-2026-2.7.1.48', 'politica-portales-plazos-facturacion',
  ],
  iva_acreditable: ['liva-art-5', 'lif-2026-art-20-A', 'rliva-3-fr-II'],
  nomina_imss_y_descuentos: [
    'lss-27', 'criterios-imss-sbc', 'lft-110-111-263', 'rlisr-57',
    'rfa-2026-2.1',
  ],
  privacidad_de_datos: [
    'lfpdppp-2025-art-15-16', 'lfpdppp-2025-art-2-fr-XII-XX',
    'lfpdppp-2025-art-26-fr-II', 'lfpdppp-2025-art-59',
  ],
  contabilidad_y_multas: ['cff-30', 'cff-89-90'],
  regimen_de_autotransporte: [
    'rfa-2026-2.2', 'tesis-autotransporte', 'red-nacional-autopistas',
    'rmf-2026-9.1.7', 'nom-087-sct-2-2017', 'reglamento-transito-83',
    'lisr-72-73', 'rfa-2026-2.3', 'rfa-2026-2.5',
  ],
  // El tema del registro de jornada (mig. 0241). Las tres fichas conviven a
  // propósito y NO dicen lo mismo: la LFT manda registrar la jornada y pone los
  // topes que el motor sí puede citar; la NOM-087 mide CONDUCCIÓN, que es otra
  // magnitud y que Likida no registra —está aquí para que el chat pueda nombrar
  // lo que el producto se abstiene de evaluar—; y el art. 83 del Reglamento de
  // Tránsito es la bitácora de horas de servicio, un documento DISTINTO, con
  // otra autoridad y otro plazo de conservación. Quien pregunte por horas de un
  // operador tiene que ver las tres para no confundir una con otra.
  jornada_y_horas_de_trabajo: [
    'lft-132-XXXIV-jornada', 'reglamento-transito-83', 'nom-087-sct-2-2017',
  ],
};

/** La forma con la que una norma sale hacia el chat: lo citable y su verdad. */
export interface NormaConsultada {
  norma_id: string;
  /** Cómo se cita ("LISR 27-III") — la forma que `guardiaFundamento` protege. */
  cita: string;
  titulo: string | null;
  /** 1=ley … 6=política de un tercero. La escala de normas/README.md. */
  jerarquia: Norma['jerarquia'];
  /** false de 5 para abajo: orienta o informa, NO obliga. */
  vinculante: boolean;
  estado: Norma['estado'];
  /** true solo si la ficha está verificada: lo `sin_verificar` se enseña
   *  como pendiente pero el producto NO lo afirma. */
  afirmable: boolean;
  /** Desde cuándo es exigible, si alguna fuente lo respalda. null = nadie lo
   *  confirmó: se puede avisar, nunca declarar con fecha. */
  exigible_desde: string | null;
}

/**
 * La cita que se le enseña al chat. `n.citas` viene de `citas_en_codigo` de la
 * ficha YAML, y ahí conviven citas de verdad ("LIVA art. 5") con
 * IDENTIFICADORES DE CÓDIGO que marcan dónde vive la norma en el repo
 * ("plazoVerificado"). AUDITORÍA FABLE CICLO 3 (c3-6): la ficha de portales
 * solo trae el identificador, y salía al chat como cita textual — el contralor
 * podía leer "plazoVerificado — pendiente de verificación" como si fuera una
 * norma. Un token camelCase de una sola palabra no es una cita: se cae al
 * instrumento, que sí es legible.
 */
function citaLegible(n: Norma): string {
  const legible = n.citas.find((c) => !/^[a-z][a-zA-Z0-9]*$/.test(c));
  return legible ?? n.instrumento ?? n.id;
}

function aConsultada(n: Norma): NormaConsultada {
  return {
    norma_id: n.id,
    cita: citaLegible(n),
    titulo: n.titulo ?? null,
    jerarquia: n.jerarquia,
    vinculante: esVinculante(n.jerarquia),
    estado: n.estado,
    afirmable: n.estado !== 'sin_verificar',
    exigible_desde: n.exigibleDesde ?? null,
  };
}

/**
 * Las normas de un tema, la de más peso primero (ley antes que criterio) —
 * el orden en el que un fiscalista las leería. Lanza ante un tema desconocido
 * en vez de devolver vacío: un tema que no existe contestado con `[]` se
 * leería como "no hay norma", que es una afirmación.
 */
export function normasPorTema(tema: string): NormaConsultada[] {
  const ids = (TEMAS as Record<string, readonly string[]>)[tema];
  if (!ids) throw new Error(`consultar_normas: tema desconocido "${tema}"`);
  return ids
    .map((id) => {
      const n = NORMAS[id];
      if (!n) throw new Error(`consultar_normas: la ficha "${id}" del tema "${tema}" no existe en el índice`);
      return aConsultada(n);
    })
    .sort((a, b) => a.jerarquia - b.jerarquia);
}
