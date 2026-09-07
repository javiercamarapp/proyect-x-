import { describe, it, expect } from 'vitest';
import { AvisoEstado } from './inicio-contenido';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 25, MEDIO (línea 128) — si `contarEscalados` o
// `contarHuerfanosPendientes` fallan (devuelven `null`), el Resumen antes
// quedaba IDÉNTICO al de una flota sin escalados ni huérfanos: el renglón de
// alerta desaparecía (BloqueAlertas, gateado con `!== null && > 0`) y
// `AvisoEstado` tampoco se enteraba porque ni `pEscalados` ni `pHuerfanos`
// llegaban a `estadoPanel`. Esta prueba llama a `AvisoEstado` directamente
// (ahora exportado) con TODO lo demás en buen estado y solo escalados/
// huérfanos caídos, y verifica que el aviso de "pantalla incompleta" SÍ
// aparece — antes del arreglo, `AvisoEstado` no aceptaba estas dos promesas
// y por lo tanto no podía verlas caer.
// ═══════════════════════════════════════════════════════════════════════════

const BASE = {
  pAcred: Promise.resolve({}),
  pKpis: Promise.resolve({ viajesLiquidados: 12, porRevisar: 0 }),
  pAnomalias: Promise.resolve([]),
  pViajes: Promise.resolve([{ estatus: 'liquidado' }]),
  pSeriesKpis: Promise.resolve({}),
  pGastoSemanal: Promise.resolve({}),
  pLiquidadoSemanal: Promise.resolve({}),
  pTopRutas: Promise.resolve({}),
  pViajesPorMes: Promise.resolve([]),
  pCfgFiscal: Promise.resolve({}),
  pGastosFiscales: Promise.resolve([]),
} as unknown as Parameters<typeof AvisoEstado>[0];

/** Busca un texto dentro del árbol de elementos React devuelto — sin DOM,
 *  solo caminando `props.children`. */
function contieneTexto(nodo: unknown, texto: string): boolean {
  if (nodo == null || typeof nodo === 'boolean') return false;
  if (typeof nodo === 'string') return nodo.includes(texto);
  if (Array.isArray(nodo)) return nodo.some((n) => contieneTexto(n, texto));
  if (typeof nodo === 'object' && 'props' in nodo) {
    return contieneTexto((nodo as { props?: { children?: unknown } }).props?.children, texto);
  }
  return false;
}

describe('AvisoEstado — el fail path de escalados/huérfanos enciende el banner', () => {
  it('todo bien, escalados/huérfanos también bien → sin aviso', async () => {
    const el = await AvisoEstado({ ...BASE, pEscalados: Promise.resolve(0), pHuerfanos: Promise.resolve(0) });
    expect(el).toBeNull();
  });

  it('contarEscalados cae (null) → aparece "pantalla está incompleta", no silencio', async () => {
    const el = await AvisoEstado({ ...BASE, pEscalados: Promise.resolve(null), pHuerfanos: Promise.resolve(0) });
    expect(el).not.toBeNull();
    expect(contieneTexto(el, 'esta pantalla está incompleta')).toBe(true);
  });

  it('contarHuerfanosPendientes cae (null) → aparece el mismo aviso', async () => {
    const el = await AvisoEstado({ ...BASE, pEscalados: Promise.resolve(0), pHuerfanos: Promise.resolve(null) });
    expect(el).not.toBeNull();
    expect(contieneTexto(el, 'esta pantalla está incompleta')).toBe(true);
  });
});
