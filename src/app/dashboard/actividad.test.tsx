import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Actividad } from './actividad';
import type { DiaViajes } from './serie-diaria';

/** 30 días consecutivos, todos en cero salvo los que `conViajes` marque —
 *  el mismo tamaño que entrega `serie_comparativa_tenant` (DIAS_SERIE=30). */
function serieDeDias(conViajes: Record<number, number> = {}): DiaViajes[] {
  return Array.from({ length: 30 }, (_, i) => ({
    dia: `2026-08-${String(i + 1).padStart(2, '0')}`,
    viajes: conViajes[i] ?? 0,
    liquidados: 0,
  }));
}

// RUBRO 4 (honestidad de datos en UI), semana 36 — `getViajesPorMes` puede
// fallar y `BloqueEstadisticas` (inicio-contenido.tsx:725) lo colapsa con
// `viajesPorMes ?? []` ANTES de llegar aquí: el `null` de "no pude leer" y
// el `[]` de "leí y no hay nada" llegan indistinguibles. En modo histórico,
// `sinDatos = porMes.every(d => d.valor === 0)` es VACUAMENTE true sobre
// `[]`, así que una lectura caída pinta "Aún no hay viajes registrados." —
// la misma familia de bug que el propio archivo ya resuelve para `porDia`
// (FE-5: `porDia === null` → "No se pudo cargar esta gráfica.", nunca un
// vacío). `porMes` nunca tuvo ese blindaje.
describe('Actividad — histórico con la lectura caída no se pinta como "aún no hay viajes"', () => {
  it('porMes=null (lectura caída) dice que no pudo cargar, NUNCA que no hay viajes', () => {
    const html = renderToStaticMarkup(
      <Actividad porDia={[]} porMes={null} modo="historico" />,
    );
    expect(html).not.toMatch(/Aún no hay viajes registrados/);
    expect(html).toMatch(/No se pudo cargar esta gráfica/);
  });

  it('porMes=[] (leído de verdad, vacío real) sigue diciendo que aún no hay viajes', () => {
    const html = renderToStaticMarkup(
      <Actividad porDia={[]} porMes={[]} modo="historico" />,
    );
    expect(html).toMatch(/Aún no hay viajes registrados/);
  });

  it('porMes con datos reales no dice ni "no pudo cargar" ni "aún no hay viajes"', () => {
    const html = renderToStaticMarkup(
      <Actividad porDia={[]} porMes={[{ dia: '2026-08', valor: 12 }]} modo="historico" />,
    );
    expect(html).not.toMatch(/No se pudo cargar esta gráfica/);
    expect(html).not.toMatch(/Aún no hay viajes registrados/);
  });
});

// PRU-M3 (auditoría 28) — el blindaje gemelo de `porDia === null` (FE-5) para
// Semanal/Mensual no tenía UNA sola prueba: `actividad.test.tsx` solo
// ejercitaba `modo="historico"` y `porDia={[]}`. Mutación A2 (borrar
// `modo !== 'historico' && porDia === null` del `if`, actividad.tsx:46) deja
// la suite en verde porque nada renderiza Semanal/Mensual con `porDia=null`:
// sin este bloque, la lectura caída caía a `serie = porDia ?? [] = []`,
// `sinDatos` vacuamente `true` y la pantalla decía "Sin viajes iniciados en
// este periodo" — una flota parada donde en realidad la consulta reventó.
describe('Actividad — Semanal/Mensual con la lectura caída no se pinta como "sin viajes" (PRU-M3, mata A2)', () => {
  it('modo="semanal" con porDia=null dice que no pudo cargar, NUNCA "sin viajes iniciados"', () => {
    const html = renderToStaticMarkup(
      <Actividad porDia={null} porMes={[]} modo="semanal" />,
    );
    expect(html).toMatch(/No se pudo cargar esta gráfica/);
    expect(html).not.toMatch(/Sin viajes iniciados en este periodo/);
  });

  it('modo="mensual" con porDia=null dice que no pudo cargar, NUNCA "sin viajes iniciados"', () => {
    const html = renderToStaticMarkup(
      <Actividad porDia={null} porMes={[]} modo="mensual" />,
    );
    expect(html).toMatch(/No se pudo cargar esta gráfica/);
    expect(html).not.toMatch(/Sin viajes iniciados en este periodo/);
  });

  it('modo="semanal" con porDia=[] (leído de verdad, vacío real) sigue diciendo "sin viajes"', () => {
    const html = renderToStaticMarkup(
      <Actividad porDia={[]} porMes={[]} modo="semanal" />,
    );
    expect(html).not.toMatch(/No se pudo cargar esta gráfica/);
    expect(html).toMatch(/Sin viajes iniciados en este periodo/);
  });
});

// PRU-M2 (auditoría 28) — las pruebas históricas solo afirmaban AUSENCIA del
// mensaje equivocado, nunca PRESENCIA del gráfico correcto. Mutación A4
// (cambiar `<AreaChartSimple …/>` por `<></>`, actividad.tsx:72) apaga el
// histórico entero y la suite queda en verde porque ninguna prueba busca un
// nodo real del gráfico. Aquí se afirma el `<svg>`, la línea (`<path
// stroke="var(--marca)"`) y el texto que `etiquetaValor` produce — nada de
// eso puede salir de un fragmento vacío.
describe('Actividad — el gráfico realmente se pinta (PRU-M2, mata A4)', () => {
  it('modo="historico" con datos: el SVG y la línea del área están en el HTML', () => {
    const html = renderToStaticMarkup(
      <Actividad porDia={[]} porMes={[{ dia: '2026-06', valor: 5 }, { dia: '2026-07', valor: 12 }]} modo="historico" />,
    );
    expect(html).toContain('<svg');
    expect(html).toMatch(/<path[^>]*stroke="var\(--marca\)"/);
    // El texto del tooltip lo escribe `etiquetaValor`: solo puede aparecer si
    // el `AreaChartSimple` de verdad recibió y pintó ese punto.
    expect(html).toMatch(/12 viajes/);
  });

  it('modo="semanal" con datos: las barras están en el HTML, no un fragmento vacío', () => {
    const html = renderToStaticMarkup(
      <Actividad porDia={serieDeDias({ 29: 8 })} porMes={[]} modo="semanal" />,
    );
    expect(html).not.toBe('');
    expect(html).toMatch(/8 viajes/);
  });

  it('modo="mensual" con datos: las barras están en el HTML, no un fragmento vacío', () => {
    const html = renderToStaticMarkup(
      <Actividad porDia={serieDeDias({ 0: 3, 29: 6 })} porMes={[]} modo="mensual" />,
    );
    expect(html).toMatch(/6 viajes/);
  });
});

// La ventana de 7 días (Semanal) recorta la cola de los 30 buckets: si solo
// los últimos 7 días tienen viajes (los primeros 23 son operación previa a la
// ventana, en cero), la barra se pinta igual — la ventana no descarta la
// serie completa por error de índice.
describe('Actividad — Semanal solo mira los últimos 7 buckets, sin descartar la serie', () => {
  it('viajes solo en los últimos 7 de 30 días: el gráfico se pinta, no "sin viajes"', () => {
    const html = renderToStaticMarkup(
      <Actividad porDia={serieDeDias({ 25: 2, 26: 4, 27: 1, 29: 3 })} porMes={[]} modo="semanal" />,
    );
    expect(html).not.toMatch(/Sin viajes iniciados en este periodo/);
    expect(html).toMatch(/4 viajes/);
  });
});
