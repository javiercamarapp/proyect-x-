import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { cotejarConjuntos, prefijosDeFilas } from './verificar-migraciones-aplicadas.mjs';

// ═══════════════════════════════════════════════════════════════════════════
// OP-M4 (auditoría 28, MEDIO REINCIDENTE 27) — el verificador que reemplaza a
// la lista a mano de tablas de la era 0115-0125 (222 migraciones atrás) por el
// cotejo del CONJUNTO completo contra `migraciones_aplicadas()`.
// ═══════════════════════════════════════════════════════════════════════════

describe('cotejarConjuntos: el repo contra lo que la base tiene aplicado', () => {
  it('repo ⊆ aplicados pero la base trae una de más: NO ok — esa de más es la deriva "adelante" (OP-C1), no algo a ignorar', () => {
    const v = cotejarConjuntos({ repo: ['0001', '0002'], aplicados: ['0001', '0002', '0003'] });
    expect(v.ok).toBe(false);
    expect(v.faltantes).toEqual([]);
    expect(v.sobrantes).toEqual(['0003']);
  });

  it('conjuntos idénticos: ok, sin faltantes ni sobrantes', () => {
    const v = cotejarConjuntos({ repo: ['0001', '0002', '0003'], aplicados: ['0003', '0001', '0002'] });
    expect(v).toEqual({ faltantes: [], sobrantes: [], ok: true });
  });

  it('falta una en la base (deriva "atrás"): faltantes la nombra, ok=false', () => {
    const v = cotejarConjuntos({ repo: ['0001', '0002', '0003'], aplicados: ['0001', '0002'] });
    expect(v.ok).toBe(false);
    expect(v.faltantes).toEqual(['0003']);
    expect(v.sobrantes).toEqual([]);
  });

  it('sobra una en la base que el repo no conoce (deriva "adelante", OP-C1): sobrantes la nombra, ok=false', () => {
    const v = cotejarConjuntos({ repo: ['0001', '0002'], aplicados: ['0001', '0002', '0347'] });
    expect(v.ok).toBe(false);
    expect(v.faltantes).toEqual([]);
    expect(v.sobrantes).toEqual(['0347']);
  });

  it('las dos derivas a la vez: ambas se reportan', () => {
    const v = cotejarConjuntos({ repo: ['0001', '0002', '0003'], aplicados: ['0001', '0002', '0347'] });
    expect(v.ok).toBe(false);
    expect(v.faltantes).toEqual(['0003']);
    expect(v.sobrantes).toEqual(['0347']);
  });
});

describe('prefijosDeFilas: extrae prefijos de cuatro dígitos, sin inventar', () => {
  it('extrae el prefijo del nombre de cada fila, sin repetir y ordenado', () => {
    expect(prefijosDeFilas([{ nombre: '0271_mcp_oauth_rol' }, { nombre: '0002_algo' }, { nombre: '0002_otra' }]))
      .toEqual(['0002', '0271']);
  });

  it('una fila con formato raro (sin prefijo de cuatro dígitos) NO inventa un prefijo: se ignora', () => {
    expect(prefijosDeFilas([{ nombre: '0343' }, { nombre: 'sin_prefijo' }, { nombre: '0001_valida' }]))
      .toEqual(['0001']);
  });

  it('una fila sin `nombre` (o no string) se ignora sin lanzar', () => {
    expect(prefijosDeFilas([{}, { nombre: 123 }, { nombre: null }, { nombre: '0005_x' }])).toEqual(['0005']);
  });

  it('lista vacía: arreglo vacío', () => {
    expect(prefijosDeFilas([])).toEqual([]);
  });
});

describe('aplicar-migraciones-y-humos.sh ya no verifica con la lista a mano de 0115-0125', () => {
  const script = () => readFileSync('scripts/aplicar-migraciones-y-humos.sh', 'utf8');

  it('invoca el verificador nuevo', () => {
    expect(script()).toContain('scripts/ci/verificar-migraciones-aplicadas.mjs');
  });

  it('ya no trae la lista de tablas/columnas/RPC congelada en la era 0115-0125', () => {
    const texto = script();
    for (const literal of ['0115', '0125', 'agente_definicion.modelo_rol', 'reservar_envio_prospecto']) {
      expect(texto, `todavía menciona "${literal}"`).not.toContain(literal);
    }
  });

  it('el mensaje final ya no promete el rango 0115-0125 como si fuera el pendiente de hoy', () => {
    expect(script()).not.toContain('migraciones 0115-0125 + todo lo del 16-ago');
  });
});
