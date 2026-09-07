import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BloqueDineroObservado } from './vista';
import type { DineroObservadoTipo } from '@/lib/likida/analytics';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28 · L09 (DAT-A1/DAT-M4) — "un rótulo tiene que ser verdad".
//
// `BloqueDineroObservado` pinta el desglose de `getDineroObservadoPorTipo`
// (RPC `dinero_observado_por_tipo_tenant`): TODOS los tipos de diferencia
// (~40, `anticipo` incluido), sin filtro de fecha. Antes el subtítulo decía
// "Lo que el agente atrapó fuera de regla o duplicado" — falso en cuanto
// aparecía cualquier otro tipo, como `anticipo`, en el desglose. Esta
// prueba siembra justo ese caso y exige el subtítulo preciso.
// ═══════════════════════════════════════════════════════════════════════════

const pintar = async (porTipo: DineroObservadoTipo[] | null) =>
  renderToStaticMarkup(await BloqueDineroObservado({ porTipo: Promise.resolve(porTipo) }));

describe('BloqueDineroObservado — el subtítulo dice qué suma de verdad', () => {
  it('con un tipo "anticipo" en el desglose, el subtítulo NO promete solo "fuera de regla o duplicado"', async () => {
    const html = await pintar([
      { tipo: 'anticipo', monto: 500, n: 2 },
      { tipo: 'sobre_politica', monto: 100, n: 1 },
    ]);
    // El rótulo anterior era literalmente falso frente a este dataset.
    expect(html).not.toContain('Lo que el agente atrapó fuera de regla o duplicado');
    // El subtítulo nuevo declara que es TODO tipo, histórico completo.
    expect(html).toContain('Todas las diferencias que el motor registró, por tipo');
    // Y el tipo `anticipo` sí aparece pintado con su rótulo en español.
    expect(html).toContain('Diferencia contra el anticipo');
  });

  it('vacío: la leyenda no afirma nada sobre "fuera de regla o duplicado" tampoco', async () => {
    const html = await pintar([]);
    expect(html).not.toContain('fuera de regla o duplicado');
  });

  it('null: se declara que no se pudo leer, no se inventa un cero', async () => {
    const html = await pintar(null);
    expect(html).toContain('No se pudo leer el desglose ahora mismo.');
  });
});
