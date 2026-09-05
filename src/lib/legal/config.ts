/** El valor ENTERO (no una palabra dentro de él) es uno de estos placeholders sueltos. */
const PLACEHOLDERS_SUELTOS = new Set(['completar', 'pendiente', 'todo', 'tbd']);

/**
 * Datos legales que solo puede proporcionar la entidad operadora.
 *
 * LEGAL-19C2-A7: antes rechazaba cualquier valor que trajera "completar",
 * "pendiente", "todo" o "tbd" como PALABRA SUELTA en CUALQUIER PARTE del
 * texto — una razón social real como "Grupo Todo Carga SA de CV" se leía
 * como placeholder sin llenar y se descartaba en silencio. Ahora exige que
 * el valor COMPLETO (recortado) sea uno de esos placeholders, o el
 * marcador `[COMPLETAR...]` de `LEGAL_PLACEHOLDERS`, no que la palabra
 * aparezca en cualquier parte de un valor más largo.
 */
export function datoLegal(valorCrudo: string | undefined): string | null {
  const valor = valorCrudo?.trim();
  if (!valor) return null;
  if (/^\[completar\b/i.test(valor)) return null;
  if (PLACEHOLDERS_SUELTOS.has(valor.toLowerCase())) return null;
  return valor;
}

const contactoConfigurado = datoLegal(process.env.LEGAL_CONTACT_EMAIL);
export const LEGAL_CONFIG = {
  razonSocial: datoLegal(process.env.LEGAL_ENTITY_NAME),
  domicilio: datoLegal(process.env.LEGAL_ENTITY_ADDRESS),
  jurisdiccion: datoLegal(process.env.LEGAL_JURISDICTION),
  contacto: contactoConfigurado ?? 'likida.ai@gmail.com',
  contactoConfigurado,
  dpaVersion: datoLegal(process.env.LEGAL_DPA_VERSION),
  slaVersion: datoLegal(process.env.LEGAL_SLA_VERSION),
  seguridadVersion: datoLegal(process.env.LEGAL_SECURITY_ANNEX_VERSION),
  subencargadosVersion: datoLegal(process.env.LEGAL_SUBPROCESSORS_VERSION),
} as const;

export const LEGAL_PLACEHOLDERS = {
  razonSocial: '[COMPLETAR: razón social inscrita de la entidad operadora]',
  domicilio: '[COMPLETAR: domicilio legal/fiscal para notificaciones]',
  jurisdiccion: '[COMPLETAR: entidad federativa y tribunales competentes]',
  contacto: '[COMPLETAR: correo legal o de privacidad bajo control de la entidad]',
  dpa: '[COMPLETAR Y FIRMAR: versión del DPA]',
  sla: '[COMPLETAR Y FIRMAR: versión del SLA]',
  seguridad: '[COMPLETAR Y APROBAR: versión del anexo de seguridad]',
  subencargados: '[COMPLETAR Y APROBAR: versión del anexo de subencargados]',
} as const;

/**
 * QUIÉN ES LA ENTIDAD. Sin esto no se puede publicar un aviso de privacidad ni
 * unos términos: son los datos que la ley obliga a exhibir. Bloquean el build.
 */
const REQUISITOS_ENTIDAD: Array<[keyof typeof LEGAL_CONFIG, string]> = [
  ['razonSocial', 'LEGAL_ENTITY_NAME'],
  ['domicilio', 'LEGAL_ENTITY_ADDRESS'],
  ['jurisdiccion', 'LEGAL_JURISDICTION'],
  ['contactoConfigurado', 'LEGAL_CONTACT_EMAIL'],
];

/**
 * LOS CUATRO DOCUMENTOS. En producción bloquean por default; el estado siempre
 * los reporta como faltantes aunque se use la válvula temporal de hotfix.
 *
 * ── POR QUÉ SE SEPARARON (24-ago-2026) ──────────────────────────────────
 *
 * Estos cuatro estaban en la misma lista que los de arriba, y el resultado fue
 * que un producto sin DPA firmado NO PODÍA DESPLEGARSE EN ABSOLUTO. El día que
 * se midió, eso significó: (a) no poder publicar el arreglo de un bug de nueve
 * días, y (b) no poder revertir un cambio propio que había tumbado el OCR en
 * producción — hubo que hacer `vercel promote` al deployment anterior porque
 * era la única vía que no exigía build.
 *
 * Un guardarraíl que también bloquea las REPARACIONES no protege: amplifica.
 * Convirtió un error de diez minutos en uno de horas.
 *
 * Por eso existe una válvula explícita para publicar una reparación urgente:
 * `LEGAL_ENFORCE_DOCS=false`. No es un alta enterprise y no oculta faltantes;
 * omitir la variable mantiene el gate cerrado.
 */
const REQUISITOS_DOCUMENTOS: Array<[keyof typeof LEGAL_CONFIG, string]> = [
  ['dpaVersion', 'LEGAL_DPA_VERSION'],
  ['slaVersion', 'LEGAL_SLA_VERSION'],
  ['seguridadVersion', 'LEGAL_SECURITY_ANNEX_VERSION'],
  ['subencargadosVersion', 'LEGAL_SUBPROCESSORS_VERSION'],
];

const faltan = (reqs: typeof REQUISITOS_ENTIDAD) =>
  reqs.filter(([campo]) => !LEGAL_CONFIG[campo]).map(([, env]) => env);

export function estadoLegalProduccion() {
  const faltantesEntidad = faltan(REQUISITOS_ENTIDAD);
  const faltantesDocumentos = faltan(REQUISITOS_DOCUMENTOS);
  const faltantes = [...faltantesEntidad, ...faltantesDocumentos];
  return {
    listo: faltantes.length === 0,
    faltantes,
    faltantesEntidad,
    faltantesDocumentos,
    /** Estado mínimo de identidad; `exigirLegalEnProduccion` aplica además
     * los anexos según la política de despliegue. */
    bloqueado: faltantesEntidad.length > 0,
  };
}

/** En producción los anexos son bloqueantes por defecto. Un hotfix puede usar
 * `LEGAL_ENFORCE_DOCS=false` de forma explícita y temporal; omitir la variable
 * ya no convierte documentos ausentes en un alta enterprise válida. */
export function exigirLegalEnProduccion(): void {
  if (process.env.VERCEL_ENV !== 'production' && process.env.LEGAL_ENFORCE_PRODUCTION !== 'true') return;
  const estado = estadoLegalProduccion();
  const exigirDocs = process.env.LEGAL_ENFORCE_DOCS !== 'false';
  const bloqueantes = exigirDocs ? estado.faltantes : estado.faltantesEntidad;
  if (bloqueantes.length > 0) {
    throw new Error(`LEGAL_PRODUCTION_BLOCKED: faltan ${bloqueantes.join(', ')}`);
  }
}
