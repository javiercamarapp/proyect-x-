import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { VistaDespacho } from './vista';
import type { Pagina, ViajeEnCursoRow } from '@/lib/likida/repo_paginado';

// ═══════════════════════════════════════════════════════════════════════════
// FE-2 (auditoría 24): "En curso" ya no puede ser un recorte de 12 filas
// sacado de "los últimos 100 viajes creados" — a 500 viajes/día eso son
// ~30 minutos de operación y el viaje de ayer sin aceptar desaparecía sin
// dejar dónde reavisarlo. Esta prueba fija lo que reemplaza ese recorte: un
// `count` real (no `filas.length`) y un control para llegar al resto
// (buscador + paginación), no solo una leyenda que confiesa el tope.
// ═══════════════════════════════════════════════════════════════════════════

const accionOk = async () => null;

function filaViaje(n: number): ViajeEnCursoRow {
  return {
    id: `v${n}`, folio: `F-${1000 + n}`, origen: 'León', destino: 'CDMX', estatus: 'abierto',
    operadorNombre: `Operador ${n}`, unidadId: null, unidadEco: null,
    fechaInicio: '2026-08-20', avisadoEn: null, aceptadoEn: null, escaladoEn: null, avisosEnviados: 0,
  };
}

function pintar(activos: Pagina<ViajeEnCursoRow>) {
  return renderToStaticMarkup(
    <VistaDespacho
      tablero={null}
      sinAsignar={[]}
      activos={activos}
      sufijo=""
      folioPedido=""
      buscarCatalogo={async () => []}
      totalOperadores={5}
      totalClientes={5}
      totalUnidades={5}
      carga={[]}
      crear={accionOk}
      asignarYAvisar={accionOk}
      asignarUnidadViaje={accionOk}
      reenviarAviso={accionOk}
      altaOperador={accionOk}
    />,
  );
}

describe('Despacho — "En curso" con count real y paginación (FE-2)', () => {
  it('con más filas de las que caben en una página, declara el total MEDIDO y ofrece "Siguiente"', () => {
    const activos: Pagina<ViajeEnCursoRow> = {
      filas: Array.from({ length: 25 }, (_, i) => filaViaje(i)),
      pagina: 1, porPagina: 25, total: 140, paginaMax: 200, truncada: false, error: null,
    };
    const html = pintar(activos);
    // El total es el MEDIDO (140), no la cuenta de filas de esta página (25).
    expect(html).toContain('140');
    expect(html).not.toMatch(/Se muestran 12/);
    expect(html).toContain('Siguiente');
  });

  it('sin más páginas, no ofrece "Siguiente" y sí "Anterior" desde la página 2', () => {
    const activos: Pagina<ViajeEnCursoRow> = {
      filas: [filaViaje(0)],
      pagina: 2, porPagina: 25, total: 26, paginaMax: 200, truncada: false, error: null,
    };
    const html = pintar(activos);
    expect(html).toContain('Anterior');
    expect(html).not.toContain('Siguiente');
  });

  it('trae el buscador por folio, no un catálogo completo', () => {
    const activos: Pagina<ViajeEnCursoRow> = {
      filas: [], pagina: 1, porPagina: 25, total: 0, paginaMax: 200, truncada: false, error: null,
    };
    const html = pintar(activos);
    expect(html).toContain('Buscar viaje en curso por folio');
  });

  it('lectura caída: dice que no se pudo leer, no pinta "ningún viaje en curso"', () => {
    const activos: Pagina<ViajeEnCursoRow> = {
      filas: [], pagina: 1, porPagina: 25, total: null, paginaMax: 200, truncada: false, error: 'timeout',
    };
    const html = pintar(activos);
    expect(html).toContain('No se pudo leer');
    expect(html).toContain('En curso');
    expect(html).not.toContain('Ningún viaje en curso ahora mismo');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FE-M1 (auditoría 28): con `?p=8` sobre 140 viajes en curso, la página 8
// (fuera de las 6 páginas reales de 25) trae `filas: []` con `total: 140` —
// antes eso pintaba "Ningún viaje en curso ahora mismo", una afirmación
// falsa sobre el NEGOCIO cuando lo que pasó fue que la CONSULTA de esta
// página en particular no trajo filas. Estas pruebas separan los tres casos:
// vacío de negocio (total === 0), vacío de consulta (total > 0) y "no se
// pudo contar" (total === null) — y afirman el texto correcto, no solo la
// ausencia del texto viejo.
// ═══════════════════════════════════════════════════════════════════════════

describe('Despacho — "En curso" vacío de consulta vs vacío de negocio (FE-M1)', () => {
  it('página fuera de rango con total > 0: NO dice "ningún viaje", SÍ declara el total y ofrece "Anterior"', () => {
    const activos: Pagina<ViajeEnCursoRow> = {
      filas: [], pagina: 8, porPagina: 25, total: 140, paginaMax: 200, truncada: false, error: null,
    };
    const html = pintar(activos);
    expect(html).not.toContain('Ningún viaje en curso');
    expect(html).toContain('140');
    expect(html).toContain('Anterior');
    expect(html).toContain('0–0');
  });

  it('total === 0 (sin folio): sigue diciendo "Ningún viaje en curso ahora mismo"', () => {
    const activos: Pagina<ViajeEnCursoRow> = {
      filas: [], pagina: 1, porPagina: 25, total: 0, paginaMax: 200, truncada: false, error: null,
    };
    const html = pintar(activos);
    expect(html).toContain('Ningún viaje en curso ahora mismo');
  });

  it('total === null (no se pudo contar) sin error explícito: no afirma "ningún viaje"', () => {
    const activos: Pagina<ViajeEnCursoRow> = {
      filas: [], pagina: 1, porPagina: 25, total: null, paginaMax: 200, truncada: false, error: null,
    };
    const html = pintar(activos);
    expect(html).not.toContain('Ningún viaje en curso');
    expect(html).toContain('No se pudo contar');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FE-B1 (auditoría 28): `Pagina.truncada` no se leía — en `?p=200` con la
// página al tope (`paginaMax`) y un total que rebasa lo que la paginación
// alcanza, "Siguiente →" seguía pintado y apuntaba a `?p=201`, que
// `leerPagina` clampa de vuelta a 200: un botón que nunca avanza. Ahora, al
// tope, no se ofrece "Siguiente" y se declara el recorte con un link al
// registro completo.
// ═══════════════════════════════════════════════════════════════════════════

describe('Despacho — "En curso" declara el recorte de la paginación (FE-B1)', () => {
  it('en la última página posible (paginaMax) con truncada=true: sin "Siguiente", con la declaración del recorte', () => {
    const activos: Pagina<ViajeEnCursoRow> = {
      filas: Array.from({ length: 25 }, (_, i) => filaViaje(i)),
      pagina: 200, porPagina: 25, total: 6000, paginaMax: 200, truncada: true, error: null,
    };
    const html = pintar(activos);
    expect(html).not.toContain('Siguiente');
    expect(html).toContain('registro');
  });
});
