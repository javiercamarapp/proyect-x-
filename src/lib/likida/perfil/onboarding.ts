import type { DatosOnboarding } from './preguntas';
import { declararOnboarding } from './preguntas';

/** Interpreta un select de sí/no. Vacío = no declarado (no se inventa un no). */
export function siNo(v: string): boolean | undefined {
  if (v === 'si') return true;
  if (v === 'no') return false;
  return undefined;
}

/** AUDITORÍA 28 (FIS-C1, mitad quirúrgica): las mismas 6 claves que
 *  `entrevista.ts` acepta para `regimenSat` — la elegibilidad del 15% se
 *  deriva de la clave real, nunca de un "sí califico" capturado a mano. */
const CLAVES_REGIMEN_SAT = new Set(['601', '603', '612', '621', '624', '626']);

/** Mismo cálculo que `entrevista.ts:704` (`case 'regimenSat'`): solo 612
 *  (Personas Físicas con Actividades Empresariales) y 624 (Coordinados)
 *  abren la facilidad del 15% en efectivo. */
export function regimenElegibleDeClave(clave: string): boolean | undefined {
  if (!CLAVES_REGIMEN_SAT.has(clave)) return undefined;
  return clave === '612' || clave === '624';
}

export function parseOnboarding(fd: {
  get(name: string): FormDataEntryValue | null;
}): { ok: true; datos: DatosOnboarding } | { ok: false; error: string } {
  const ingresos = String(fd.get('ingresos') ?? '');
  const parte = String(fd.get('parte') ?? '');
  if (ingresos !== 'menor' && ingresos !== 'mayor') {
    return { ok: false, error: 'Falta decir si los ingresos del último ejercicio fueron menores a $300 millones.' };
  }
  if (parte !== 'si' && parte !== 'no') {
    return { ok: false, error: 'Falta decir si la flota es parte relacionada (LISR art. 179).' };
  }

  const pago = String(fd.get('pagoOperador') ?? '');
  const pagoOperador = pago === 'viaje' || pago === 'km' || pago === 'sueldo' ? pago : undefined;

  const limpio = (k: string): string | undefined => {
    const t = String(fd.get(k) ?? '').trim();
    return t === '' ? undefined : t;
  };

  // AUDITORÍA 28 (FIS-C1, mitad quirúrgica): antes `regimenElegible` venía
  // directo de un select sí/no (`fd.get('regimen')`) — un dueño podía marcar
  // "sí" sin que su régimen real calificara. Ahora se captura la clave SAT
  // (`regimenSat`, mismo campo y mismas opciones que la entrevista
  // conversacional) y `regimenElegible` se DERIVA de ella; un POST que mande
  // `regimen=si` sin una clave válida en `regimenSat` ya no concede nada.
  const regimenSat = limpio('regimenSat');
  const regimenElegible = regimenSat ? regimenElegibleDeClave(regimenSat) : undefined;

  return {
    ok: true,
    datos: {
      ingresosMenoresA300M: ingresos === 'menor',
      parteRelacionada: parte === 'si',
      dedicacionExclusivaCarga: siNo(String(fd.get('dedicacion') ?? '')),
      regimenSat,
      regimenElegible,
      transporteDedicado: siNo(String(fd.get('dedicado') ?? '')),
      hombreCamion: siNo(String(fd.get('hombreCamion') ?? '')),
      gps: limpio('gps'),
      erp: limpio('erp'),
      tag: limpio('tag'),
      monedero: limpio('monedero'),
      stackOtro: limpio('stackOtro'),
      pagoOperador,
      tanquePropio: siNo(String(fd.get('tanquePropio') ?? '')),
    },
  };
}

export function patchOnboarding(datos: DatosOnboarding): Record<string, unknown> {
  return declararOnboarding(datos);
}
