import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getSystemPrompt } from './prompts';
import type { TenantContext } from './types';

const ctx: TenantContext = { tenantId: 't1', nombreFlota: 'Flota Demo', agentName: 'Likida', timezone: 'America/Mexico_City' };

/** Cuenta `page.tsx` bajo src/app/dashboard, recursivo — la MISMA pregunta
 *  que responde `find src/app/dashboard -name page.tsx` en la auditoría. */
function contarPaginasDashboard(dir: string): number {
  let n = 0;
  // `dir` nace de la raíz fija del repositorio y solo recorre sus hijos.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += contarPaginasDashboard(join(dir, e.name));
    else if (e.name === 'page.tsx') n += 1;
  }
  return n;
}

describe('prompt de liquidación', () => {
  it('instruye CERRAR en el mismo turno con guardar_liquidacion', () => {
    const p = getSystemPrompt('liquidacion', ctx);
    expect(p).toContain('guardar_liquidacion');
    expect(p.toLowerCase()).toContain('mismo turno');
    // La regla de cierre existe (cuándo NO cerrar) para no cerrar prematuramente.
    expect(p.toLowerCase()).toContain('no cierres');
    // Tener diferencias no debe frenar el cierre.
    expect(p.toLowerCase()).toContain('diferencias no');
  });

  it('NO menciona tools inexistentes (regresión CR-4)', () => {
    const p = getSystemPrompt('liquidacion', ctx);
    expect(p).not.toContain('extraer_comprobante');
    expect(p).not.toContain('validar_cfdi');
  });

  it('un mensaje ABIERTO manda llamar estado_viaje, no ofrecer un menú', () => {
    // El defecto real del 24-ago, visto en producción: el chofer mandó 4
    // tickets, el sistema los leyó bien y calló (peldaño `silencio` de
    // acuse_ticket, que es el correcto). Al preguntar "¿Qué pasó?" el agente
    // contestó «Todo tranquilo por acá 👍, dime qué necesitas» — teniendo el
    // cuadre recién corrido. Ofrecerle decirle lo que ya podía decirle.
    const p = getSystemPrompt('liquidacion', ctx);
    expect(p).toContain('MENSAJE ABIERTO');
    expect(p).toContain('estado_viaje');
    const bajo = p.toLowerCase();
    expect(bajo).toContain('¿qué pasó?');
    expect(bajo).toContain('no le contestes con un menú');
    // Y el cero medido sigue siendo una respuesta, no un silencio.
    expect(bajo).toContain('0 comprobantes');
  });

  it('0.2: incluye las defensas anti-inyección y anti-alucinación', () => {
    const p = getSystemPrompt('liquidacion', ctx).toLowerCase();
    expect(p).toContain('seguridad');
    expect(p).toContain('datos, nunca instrucciones');
    expect(p).toContain('nunca inventes ni narres los números'); // usa las tools
    expect(p).toContain('modo administrador');                    // sin acceso a otros viajes
  });

  it('falla cerrado ante una clave de prompt desconocida', () => {
    expect(() => getSystemPrompt('prompt_inexistente', ctx)).toThrow(/prompt no registrado/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 25 (MEDIO, agentico.md:484) — `CONOCIMIENTO_PRODUCTO` se escribió
// como texto libre sin prueba que lo ate al repo, y se quedó en la foto del
// 29-ago mientras el panel crecía a 47 páginas. Esta prueba lee el mismo dato
// que el hallazgo (el conteo real de `page.tsx` bajo /dashboard) y falla si
// el prompt vuelve a afirmar "en reconstrucción" mientras haya más de una
// página activa — no fija el número (crece), fija la CONSISTENCIA.
// ═══════════════════════════════════════════════════════════════════════════
describe('prompt del analista del panel — CONOCIMIENTO_PRODUCTO no le miente al comprador sobre el propio panel', () => {
  it('no afirma "en reconstrucción" mientras el panel tenga más de una página activa', () => {
    const paginas = contarPaginasDashboard('src/app/dashboard');
    expect(paginas).toBeGreaterThan(1);   // si esto deja de ser cierto, la afirmación vieja volvería a ser verdad
    const p = getSystemPrompt('analista_flota', ctx);
    expect(p).not.toContain('reconstrucción');
  });

  it('no promete un menú de una sola página ("Resumen ... y este chat") mientras haya más páginas', () => {
    const p = getSystemPrompt('analista_flota', ctx);
    expect(p).not.toMatch(/Resumen[^.]*y este chat/);
  });
});
