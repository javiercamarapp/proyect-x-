// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 18-c3 · ARQ-C3-1 (CRÍTICO) — la pantalla nueva de detalle
// reconstruía la cubeta fiscal del gasto en vez de leerla del motor.
//
// `engine.ts` deja escrito, sobre `cubetaDe`, que es «LA ÚNICA definición de en
// qué cubeta cae un gasto … vive aquí, exportada, para que nadie la
// reconstruya», y cuenta el bug que costó: `pdf.ts` la reconstruía desde
// `diferencias` y se desincronizó. `vista.tsx` (nuevo en `c007312`) hizo
// exactamente eso otra vez, con un `Set` a mano que no coincidía con ninguna de
// las dos listas del motor:
//
//   - le FALTABA `rfc_receptor`: el motor lo pone en NO_DEDUCIBLE_ISR y la
//     tabla lo pintaba «Por revisar» en ámbar. Una factura de $6,400 timbrada
//     al RFC del operador salía perdida arriba y recuperable abajo.
//   - le SOBRABA `combustible_efectivo`: el motor lo pone en POR_CONFIRMAR —es
//     deducible hasta el 15% de la RFA 2.9— y la tabla lo pintaba «No
//     deducible» en rojo. Es el mismo error que `engine.ts:1061-1066` ya
//     documenta haber cometido y corregido una vez.
//
// Esta prueba no repite la lista: la LEE del motor. Si mañana alguien mueve un
// tipo de cubeta y no toca el panel, se pone roja.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { NO_DEDUCIBLE_ISR, POR_CONFIRMAR, cubetaDe } from '@/lib/likida/cuadre/engine';
import type { TipoDiferencia } from '@/types/likida';
import { estadoRenglon } from './vista';

/** Un gasto con CFDI vigente: lo único que decide es la lista de diferencias. */
const conCfdi = { cfdiUuid: 'uuid-1', estadoSat: 'vigente', cfdiValido: true };

describe('ARQ-C3-1 · el renglón del panel y la cubeta del motor dicen lo mismo', () => {
  it('TODO tipo que el motor declara NO deducible se pinta «No deducible»', () => {
    for (const tipo of NO_DEDUCIBLE_ISR) {
      const e = estadoRenglon(conCfdi, [tipo]);
      expect(e.etiqueta, `${tipo} debería pintarse «No deducible»`).toBe('No deducible');
      expect(e.estado).toBe('bad');
    }
  });

  it('NINGÚN tipo que el motor deja POR CONFIRMAR se pinta «No deducible»', () => {
    for (const tipo of POR_CONFIRMAR) {
      const e = estadoRenglon(conCfdi, [tipo]);
      expect(e.etiqueta, `${tipo} NO es una pérdida: es recuperable`).not.toBe('No deducible');
      expect(e.estado, `${tipo} no puede pintarse en rojo`).not.toBe('bad');
    }
  });

  // Los dos renglones del escenario del reporte, con sus valores.
  it('factura al RFC del operador (rfc_receptor) → «No deducible», como el PDF', () => {
    expect(estadoRenglon(conCfdi, ['rfc_receptor']).etiqueta).toBe('No deducible');
  });

  it('diésel en efectivo dentro del 15% (combustible_efectivo) → «Por confirmar», no rojo', () => {
    const e = estadoRenglon(conCfdi, ['combustible_efectivo']);
    expect(e.etiqueta).toBe('Por confirmar');
    expect(e.estado).toBe('warn');
  });

  it('el orden de gravedad se conserva: no deducible gana a por confirmar', () => {
    const e = estadoRenglon(conCfdi, ['combustible_efectivo', 'cfdi_cancelado']);
    expect(e.etiqueta).toBe('No deducible');
  });

  it('los problemas de captura no afirman una cubeta fiscal que el motor no dio', () => {
    // `duplicado`, `monto_invalido` y `comprobante_no_fiscal` no están en
    // ninguna de las dos listas del motor: son problemas del comprobante, no un
    // veredicto de deducibilidad. Se nombran por lo que son.
    expect(estadoRenglon(conCfdi, ['duplicado']).etiqueta).toBe('Duplicado');
    expect(estadoRenglon(conCfdi, ['monto_invalido']).etiqueta).toBe('Monto inválido');
    expect(estadoRenglon(conCfdi, ['comprobante_no_fiscal']).etiqueta).toBe('No es comprobante fiscal');
  });

  it('sin diferencias y con CFDI vigente sigue siendo «CFDI vigente» validado', () => {
    const e = estadoRenglon(conCfdi, []);
    expect(e.etiqueta).toBe('CFDI vigente');
    expect(e.validado).toBe(true);
  });

  // ARQ-25 (ALTO) — el motor pone `pagoPendiente` (a crédito, forma '99', sin
  // REP) en `por_confirmar` vía `cubetaDe`, pero `estadoRenglon` solo mira
  // `tipos` (las diferencias) y el motor no emite ninguna para este caso
  // (`medioNoAdmitidoCombustible('99') === false` a propósito). El renglón
  // salía «CFDI vigente ✓» en verde mientras el bloque de deducibilidad de la
  // MISMA pantalla decía «Por confirmar» sobre el mismo comprobante.
  it('a crédito (forma 99) y sin pagar → «Por confirmar», nunca verde, aunque el motor no emita diferencias', () => {
    const gastoACredito = { cfdiUuid: 'uuid-2', estadoSat: 'vigente', cfdiValido: true, formaPago: '99' };
    const e = estadoRenglon(gastoACredito, []);
    expect(e.etiqueta).toBe('Por confirmar');
    expect(e.estado).toBe('warn');
  });

  it('a crédito (forma 99) pero YA pagado (con REP) sí puede salir verde', () => {
    const gastoPagado = { cfdiUuid: 'uuid-3', estadoSat: 'vigente', cfdiValido: true, formaPago: '99', pagadoEn: '2026-08-01' };
    const e = estadoRenglon(gastoPagado, []);
    expect(e.etiqueta).toBe('CFDI vigente');
  });

  // AUDITORÍA 28, ARQ-B2 (BAJO, reincidente 25/26/27) — `estadoRenglon`
  // reconstruía el veredicto de `cubetaDe` con un `Set` propio más
  // `pagoPendiente(g)` aparte, y le faltaba el tercer motivo de la función
  // del motor: `!g.cfdiUuid → 'por_confirmar'` (engine.ts:474, «un ticket no
  // es una factura»). Un ticket de diésel sin CFDI y sin diferencias caía en
  // `{estado:'neutral', etiqueta:'Ticket'}` mientras el bloque de
  // deducibilidad de la MISMA hoja (que sí llama `cubetaDe`) decía «Por
  // confirmar» sobre el mismo comprobante. `estadoRenglon` ahora LLAMA
  // `cubetaDe` en vez de reconstruirla, así que el caso ya no existe.
  it('sin CFDI y sin diferencias → «Por confirmar» warn, ya no «Ticket» neutral', () => {
    const sinCfdi = { estadoSat: undefined, cfdiValido: false };
    const e = estadoRenglon(sinCfdi, []);
    expect(e.etiqueta).toBe('Por confirmar');
    expect(e.estado).toBe('warn');
  });

  it('paridad: estadoRenglon nunca contradice a cubetaDe (rojo ⇔ no_deducible; verde solo si deducible)', () => {
    // Muestra de gastos: sin CFDI, con CFDI vigente, a crédito (forma '99')
    // sin REP y a crédito ya pagado — los cuatro caminos que `cubetaDe`
    // distingue.
    const MUESTRA_GASTOS = [
      {},
      { cfdiUuid: 'u1', estadoSat: 'vigente', cfdiValido: true },
      { cfdiUuid: 'u2', estadoSat: 'vigente', cfdiValido: true, formaPago: '99' },
      { cfdiUuid: 'u3', estadoSat: 'vigente', cfdiValido: true, formaPago: '99', pagadoEn: '2026-08-01' },
    ];
    // Muestra de listas de tipos: vacía, un NO_DEDUCIBLE_ISR y un
    // POR_CONFIRMAR — las tres formas que mueven la cubeta.
    const MUESTRA_TIPOS: string[][] = [[], [NO_DEDUCIBLE_ISR[0]], [POR_CONFIRMAR[0]]];

    for (const g of MUESTRA_GASTOS) {
      for (const tipos of MUESTRA_TIPOS) {
        const cubeta = cubetaDe(g, tipos.map((tipo) => ({ tipo: tipo as TipoDiferencia })));
        const e = estadoRenglon(g, tipos);
        const contexto = `gasto=${JSON.stringify(g)} tipos=${JSON.stringify(tipos)} cubeta=${cubeta} etiqueta=${e.etiqueta}`;
        expect(e.estado === 'bad', contexto).toBe(cubeta === 'no_deducible');
        if (e.estado === 'ok') expect(cubeta, contexto).toBe('deducible');
      }
    }
  });
});
