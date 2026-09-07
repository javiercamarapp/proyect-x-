import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BloqueCola, type ColaConductores } from './vista';

// ═══════════════════════════════════════════════════════════════════════════
// FE-6 (auditoría 24): "Esperan aceptar" salía de `getViajes(tenantId)` (los
// 100 viajes más recientes) filtrados y ordenados en memoria — a 500
// viajes/día, ~4.8 h, así que el viaje avisado hace 6 h (el que el agente
// SÍ escala) ya no estaba en la ventana leída. Ahora sale de
// `viajesEsperandoAceptarPaginados`, que pregunta directo por
// avisado_en/aceptado_en/escalado_en con `count` real. Esta prueba fija que
// una lectura caída se dice — no se pinta como "nadie debe respuesta".
// ═══════════════════════════════════════════════════════════════════════════

async function pintar(cola: ColaConductores) {
  const el = await BloqueCola({ cola: Promise.resolve(cola), sufijo: '' });
  return renderToStaticMarkup(el);
}

describe('Conductores — "Esperan aceptar" con lectura dedicada (FE-6)', () => {
  it('lectura caída: dice que no se pudo leer, no "nadie debe respuesta"', async () => {
    const html = await pintar({ esperan: [], totalEsperan: null, sinAvisar: null, error: 'timeout' });
    expect(html).toContain('No se pudo leer la cola de aceptación');
    expect(html).not.toContain('Nadie debe respuesta');
  });

  it('con más en cola de las que se listan, declara el total MEDIDO', async () => {
    const cola: ColaConductores = {
      esperan: Array.from({ length: 20 }, (_, i) => ({
        id: `v${i}`, folio: `F-${i}`, operadorNombre: `Op ${i}`, horasDesdeAviso: 20 - i, avisos: 1,
      })),
      totalEsperan: 47, sinAvisar: null, error: null,
    };
    const html = await pintar(cola);
    expect(html).toContain('47');
    // No debe seguir afirmando que el resto son viajes "más antiguos": con el
    // orden por urgencia, lo que sobra del tope espera MENOS tiempo.
    expect(html).not.toContain('más antiguos');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FE-B1 (auditoría 28): `Pagina.truncada` tampoco lo leía esta pantalla. Aquí
// no hay botón "Siguiente" que pueda quedar muerto, pero SÍ hay que declarar
// que la cola no alcanza a mostrarlos todos cuando la lectura viene truncada
// — igual que `despacho/vista.tsx` y `descarga-sat/bandeja/vista.tsx`.
// ═══════════════════════════════════════════════════════════════════════════

describe('Conductores — "Esperan aceptar" declara el recorte de la paginación (FE-B1)', () => {
  it('con truncada=true, declara que hay más de los que esta lectura alcanza y ofrece el registro', async () => {
    const cola: ColaConductores = {
      esperan: Array.from({ length: 20 }, (_, i) => ({
        id: `v${i}`, folio: `F-${i}`, operadorNombre: `Op ${i}`, horasDesdeAviso: 20 - i, avisos: 1,
      })),
      totalEsperan: 6000, sinAvisar: null, error: null, truncada: true,
    };
    const html = await pintar(cola);
    expect(html).not.toContain('Siguiente');
    // Frase propia de la declaración del recorte — no la del "Se listan X de
    // Y" (esa ya existe y también menciona "registro", pero no dice que la
    // LECTURA misma no alcanza a traerlos a todos).
    expect(html).toContain('no alcanza a traerlos a todos');
  });

  it('sin truncada, no declara ningún recorte de la lectura', async () => {
    const cola: ColaConductores = {
      esperan: Array.from({ length: 5 }, (_, i) => ({
        id: `v${i}`, folio: `F-${i}`, operadorNombre: `Op ${i}`, horasDesdeAviso: 1, avisos: 1,
      })),
      totalEsperan: 5, sinAvisar: null, error: null, truncada: false,
    };
    const html = await pintar(cola);
    expect(html).not.toContain('no alcanza a traerlos a todos');
  });
});
