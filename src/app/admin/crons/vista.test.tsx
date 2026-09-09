import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// `EstadoError` usa `router.refresh()` para reintentar, y `useRouter` fuera
// del App Router revienta — mismo router de mentiras que `bloque.test.tsx`:
// lo que se mira aquí es QUÉ se pinta, no a dónde navega el botón.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
import { CRONS, type CronId, type LatidoDetallado } from '@/lib/admin/salud';
import { VistaCrons, resumenRelojes, cadaCuanto, desdeHace } from './vista';

// ═══════════════════════════════════════════════════════════════════════════
// TABLEROS AL DÍA (28-ago-2026) — el bug que esta prueba caza, medido: el
// card superior de /admin/crons solo miraba la cadencia (`estado !== 'ok'`),
// así que un cron que latía puntual reportando `fallo` cada minuto salía en
// «Los 10 relojes latieron dentro de su cadencia» — el panel del operador era
// MÁS LAXO que /api/health, que sí degrada por `ultimoEstado !== 'ok'`.
// Ninguna prueba ejercía la vista, y por eso vivió.
// ═══════════════════════════════════════════════════════════════════════════

function latido(sobre: Partial<LatidoDetallado> = {}): LatidoDetallado {
  return {
    estado: 'ok',
    haceMin: 1,
    ultimoEstado: 'ok',
    ultimoLatido: '2026-08-28T12:00:00.000Z',
    cadenciaMs: 60_000,
    detalle: {},
    motivoSalto: null,
    ...sobre,
  };
}

function todos(sobre: Partial<Record<CronId, Partial<LatidoDetallado>>> = {}): Record<CronId, LatidoDetallado> {
  const salida = {} as Record<CronId, LatidoDetallado>;
  for (const c of CRONS) salida[c] = latido(sobre[c]);
  return salida;
}

describe('resumenRelojes', () => {
  it('un cron puntual que reporta fallo NO cuenta como sano', () => {
    const lista = CRONS.map((cron) => ({
      cron,
      l: latido(cron === 'facturar' ? { ultimoEstado: 'fallo' as const } : {}),
    }));
    const r = resumenRelojes(lista);
    expect(r.sinLatir).toEqual([]);
    expect(r.conFallo).toEqual(['facturar']);
  });

  it('separa los tres ejes: cadencia, fallo y parcial', () => {
    const lista = CRONS.map((cron) => ({
      cron,
      l: latido(
        cron === 'gps' ? { estado: 'vencido' as const }
        : cron === 'purgar' ? { ultimoEstado: 'fallo' as const }
        : cron === 'runner' ? { ultimoEstado: 'parcial' as const }
        : {},
      ),
    }));
    const r = resumenRelojes(lista);
    expect(r.sinLatir).toEqual(['gps']);
    expect(r.conFallo).toEqual(['purgar']);
    expect(r.parciales).toEqual(['runner']);
  });

  it('un salto declarado (apagado a propósito) sigue sano en el card', () => {
    // `saltado` con su motivo es una decisión, no una avería: el renglón lo
    // dice con la palanca, y el card no grita.
    const lista = CRONS.map((cron) => ({
      cron,
      l: latido(cron === 'escalar' ? { ultimoEstado: 'saltado' as const, motivoSalto: 'apagado por la palanca «global»' } : {}),
    }));
    const r = resumenRelojes(lista);
    expect(r.sinLatir).toEqual([]);
    expect(r.conFallo).toEqual([]);
  });
});

describe('VistaCrons — el card dice la verdad', () => {
  it('con un fallo fresco, el card NO afirma que todo late bien', () => {
    const html = renderToStaticMarkup(
      <VistaCrons latidos={todos({ facturar: { ultimoEstado: 'fallo' } })} />,
    );
    expect(html).not.toContain('ninguno reportó fallo');
    expect(html).toContain('última corrida reportó');
    expect(html).toContain('facturar');
  });

  it('todo sano: lo afirma con las dos patas (cadencia Y resultado)', () => {
    const html = renderToStaticMarkup(<VistaCrons latidos={todos()} />);
    expect(html).toContain('ninguno reportó fallo en su última corrida');
  });

  it('base caída: no pinta una tabla vacía, dice que no se sabe', () => {
    const html = renderToStaticMarkup(<VistaCrons latidos={null} />);
    expect(html).toContain('NO significa que estén corriendo');
  });

  it('el porqué de un fallo con código llega al renglón', () => {
    const html = renderToStaticMarkup(
      <VistaCrons latidos={todos({ jornada: { ultimoEstado: 'fallo', detalle: { codigo: 'interruptor_ilegible' } } })} />,
    );
    expect(html).toContain('interruptor_ilegible');
  });

  // El card superior prometía "el detalle está abajo" para una corrida
  // `parcial`, pero el renglón sólo sabía mostrar un `codigo` de `fallo` — un
  // rótulo que promete un detalle que la tabla nunca pintaba, contra la regla
  // del propio panel: "aquí sí se dice cuál, desde cuándo y por qué".
  it('una corrida parcial muestra su detalle real, no un guion vacío', () => {
    const html = renderToStaticMarkup(
      <VistaCrons latidos={todos({ 'wa-outbox': { ultimoEstado: 'parcial', detalle: { enviadas: 5, fallidas: 3 } } })} />,
    );
    expect(html).toContain('fallidas');
    expect(html).toContain('3');
  });

  it('una corrida parcial con arreglos en el detalle también se cuenta (no sólo números)', () => {
    const html = renderToStaticMarkup(
      <VistaCrons latidos={todos({ gps: { ultimoEstado: 'parcial', detalle: { proveedoresConError: ['samsara', 'geotab'] } } })} />,
    );
    expect(html).toContain('proveedoresConError');
    expect(html).toContain('2');
  });

  it('un fallo SIN código conocido también muestra el resto del detalle, en vez de un guion', () => {
    const html = renderToStaticMarkup(
      <VistaCrons latidos={todos({ purgar: { ultimoEstado: 'fallo', detalle: { tablasConError: 3 } } })} />,
    );
    expect(html).toContain('tablasConError');
  });

  it('un detalle vacío ({}) sigue mostrando el guion — no se inventa contenido', () => {
    const html = renderToStaticMarkup(
      <VistaCrons latidos={todos({ runner: { ultimoEstado: 'parcial', detalle: {} } })} />,
    );
    // El renglón de `runner` (sin nada que decir) no debe ganar texto nuevo.
    expect(html).not.toMatch(/runner[\s\S]{0,200}fallidas/);
  });
});

describe('cadaCuanto / desdeHace', () => {
  it('cadaCuanto habla en la unidad natural', () => {
    expect(cadaCuanto(60_000)).toBe('cada 1 min');
    expect(cadaCuanto(4 * 3_600_000)).toBe('cada 4 h');
    expect(cadaCuanto(86_400_000)).toBe('una vez al día');
  });
  it('desdeHace pinta null como «nunca», jamás como 0', () => {
    expect(desdeHace(null)).toBe('nunca');
    expect(desdeHace(3)).toBe('hace 3 min');
    expect(desdeHace(150)).toBe('hace 2.5 h');
  });
});
