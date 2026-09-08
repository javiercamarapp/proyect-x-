import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { VistaMapa, type Rastreo } from './vista';

/** Un `Rastreo` sin GPS, para variar solo lo que cada prueba necesita. */
function rastreoBase(parcial: Partial<Rastreo> = {}): Rastreo {
  return {
    error: null,
    unidadesConPosicion: null,
    ultimaPosicion: null,
    proveedores: [],
    polls: [],
    pines: [],
    ...parcial,
  };
}

// AUDITORÍA 28, FE-M4 — el mensaje crudo de PostgREST (que `page.tsx` recibe
// de `getEstadoRastreo`/`getUltimasPosiciones` cuando truenan) NO debe llegar
// a la pantalla del contralor. Antes esta vista hacía
// `rastreo.error.slice(0, 140)` y lo pintaba tal cual.
describe('VistaMapa — el error del rastreo no expone el mensaje crudo de Postgres (FE-M4)', () => {
  it('con rastreo.error = mensaje crudo de PostgREST, el HTML no lo contiene y sí pinta la frase fija', () => {
    const html = renderToStaticMarkup(
      <VistaMapa
        ubicados={[]} sinUbicar={[]} totalVivos={0} tope={200}
        rastreo={rastreoBase({ error: 'permission denied for table unidad' })}
      />,
    );
    expect(html).not.toMatch(/permission denied/);
    expect(html).not.toMatch(/table unidad/);
    expect(html).toMatch(/No se pudo leer el rastreo de esta flota/);
  });

  it('sin error, no aparece la frase de fallo y sí las últimas posiciones', () => {
    const html = renderToStaticMarkup(
      <VistaMapa
        ubicados={[]} sinUbicar={[]} totalVivos={0} tope={200}
        rastreo={rastreoBase()}
      />,
    );
    expect(html).not.toMatch(/No se pudo leer el rastreo de esta flota/);
  });

  it('el `ultimo_error` de un poll (ya nuestro tras el arreglo de sincronizar_gps.ts) se sigue pintando', () => {
    const html = renderToStaticMarkup(
      <VistaMapa
        ubicados={[]} sinUbicar={[]} totalVivos={0} tope={200}
        rastreo={rastreoBase({
          polls: [{
            proveedor: 'samsara', recurso: 'posiciones', ultimoPoll: '2026-09-07T12:00:00Z',
            ultimoCompleto: null, ultimaMedida: null, backlogPendiente: true,
            paginas: 0, elementos: 0, error: 'no se pudieron leer las unidades de la flota',
            eventosInvalidosUltima: 0, eventosInvalidosTotal: 0, eventosEnCuarentena: 0,
            eventosCuarentenaMuertos: 0, eventosOutboxPendientes: 0, eventosOutboxMuertos: 0,
            avisosPendientes: 0, avisosMuertos: 0,
          }],
        })}
      />,
    );
    expect(html).toMatch(/no se pudieron leer las unidades de la flota/);
  });
});
