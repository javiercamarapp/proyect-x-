import { describe, it, expect } from 'vitest';
import { avisoIntegral, type DatosIntegral } from './privacidad';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24, LEG-3 (ALTO): ningún aviso enumeraba los eventos que la
// cámara/telemetría del camión reporta (`evento_seguridad_flota`, 0203) —
// `grep -i 'cámara|camara|conducci' privacidad.ts privacidad/page.tsx` daba 0.
// `sincronizar_eventos.ts` los guarda desde la MISMA credencial y cadencia
// del GPS, así que el aviso reutiliza la señal `gps` (ver el comentario del
// archivo) en vez de inventar un conector propio que no existe.
//
// Esta prueba fija: (a) la categoría aparece con sus etiquetas reales cuando
// hay conector; (b) la finalidad "atender un accidente" está declarada y NO
// admite oposición (es el circuito de asistencia); (c) NO se promete un
// plazo de borrado que ningún código ejecuta — ese es justo el error que
// LEG-6 encontró para `incidencia.lat/lng` con "90 días" falso, y no se
// repite aquí; (d) sin conector, no se declara un tratamiento que no ocurre.
// ═══════════════════════════════════════════════════════════════════════════

const BASE: Omit<DatosIntegral, 'gps'> = {
  razonSocial: 'TRANSPORTES DEL SURESTE SA DE CV',
  domicilio: 'Av. Itzáes 500, Mérida, Yucatán',
  urlAvisoIntegral: 'https://transportesdelsureste.mx/privacidad',
  contactoPrivacidad: null,
};

function textoCompleto(gps: DatosIntegral['gps']): string {
  return avisoIntegral({ ...BASE, gps }).flatMap((s) => s.parrafos).join(' ');
}

describe('LEG-3 · el aviso integral enumera los eventos de cámara/telemetría', () => {
  it('con conector activo: enumera las etiquetas reales y liga al video', () => {
    const t = textoCompleto('conectado');
    expect(t).toMatch(/cámara|telemetría/i);
    expect(t).toMatch(/frenad|colisión|impacto|volcadura/i);
    expect(t).toMatch(/liga al video|video/i);
  });

  it('declara la finalidad "atender un accidente" y que NO admite oposición', () => {
    const t = textoCompleto('conectado');
    expect(t).toMatch(/atender un accidente/i);
    expect(t).toMatch(/no admite oposición/i);
  });

  it('AUDITORÍA 28 (LEG-B1): promete el plazo REAL que 0335 ya ejecuta, no "90 días" ni el silencio viejo', () => {
    // La 0335 dio de alta `purgar_evento_seguridad_flota(180, 365, …)` en
    // `mantenimiento_de_datos` (cron `/api/cron/purgar`): 180 días para los
    // eventos leves, 365 para los `grave` (choque, impacto, volcadura). La
    // aserción vieja ("no tienen fecha de borrado") se escribió cuando ningún
    // código purgaba (LEG-6: no prometer un plazo que nadie ejecuta) — ahora
    // sería la MISMA mentira en sentido contrario: silenciar un borrado que sí
    // corre. Sigue prohibido "90 días", porque ese es el plazo de `posicion`
    // (purgar_posicion), no el de los eventos de cámara.
    const t = textoCompleto('conectado');
    const parrafoCamara = avisoIntegral({ ...BASE, gps: 'conectado' })
      .find((s) => s.fundamento === 'LFPDPPP art. 15 fr. II')!
      .parrafos.find((p) => /cámara|telemetría/i.test(p))!;
    expect(parrafoCamara).not.toMatch(/90 días/);
    expect(t).not.toMatch(/no tienen una fecha de borrado automático/i);
    expect(t).toMatch(/180 días/);
    expect(t).toMatch(/365 días/);
    expect(t).toMatch(/grave/i);
  });

  it('sin conector: no declara un tratamiento de cámara que no ocurre', () => {
    const t = textoCompleto('sin_conector');
    expect(t).toMatch(/no tiene conectado un sistema de cámara/i);
    expect(t).not.toMatch(/atender un accidente/i);
  });

  it('no medible (caso amplio): declara el tratamiento por si acaso, sin inventar certeza', () => {
    const t = textoCompleto('no_medible');
    expect(t).toMatch(/cámara|telemetría/i);
  });

  it('el aviso completo, en los tres estados, sigue devolviendo solo strings (sin huecos)', () => {
    for (const gps of ['conectado', 'sin_conector', 'no_medible'] as const) {
      const secciones = avisoIntegral({ ...BASE, gps });
      for (const s of secciones) {
        for (const p of s.parrafos) expect(typeof p).toBe('string');
      }
    }
  });
});
