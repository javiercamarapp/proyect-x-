import { describe, expect, it } from 'vitest';
import { rutasPdfVersionadas, rutaPdfOperador } from './liquidacion/rutas_pdf';

describe('una versión selecciona los dos ejemplares PDF', () => {
  it('cada generación tiene objetos distintos y operador deriva del puntero contralor', () => {
    const a = rutasPdfVersionadas('tenant', 'viaje');
    const b = rutasPdfVersionadas('tenant', 'viaje');
    expect(a.contralor).not.toBe(b.contralor);
    expect(a.operador).toBe(rutaPdfOperador(a.contralor, 'tenant', 'viaje'));
    expect(a.operador).not.toBe(a.contralor);
  });
  it('los documentos antiguos conservan el mismo par legacy', () => {
    expect(rutaPdfOperador('tenant/viaje.pdf', 'tenant', 'viaje')).toBe('tenant/viaje-operador.pdf');
  });
  it.each(['otro/viaje.pdf', 'tenant/otro.pdf', 'tenant/viaje-operador.pdf', 'tenant/viaje/../secreto.pdf', 'https://external.test/doc.pdf'])('rechaza una ruta fuera del par: %s', (path) => {
    expect(() => rutaPdfOperador(path, 'tenant', 'viaje')).toThrow();
  });
});
