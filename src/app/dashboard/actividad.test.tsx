import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Actividad } from './actividad';

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
