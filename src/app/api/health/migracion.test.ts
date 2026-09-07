import { describe, it, expect } from 'vitest';
import { cotejar } from './migracion';

// AUD28 OP-C1 — la deriva INVERSA que ningún cotejo podía denunciar.
//
// `atras` se diseñó como una magnitud de un solo signo («cuánto le falta a la
// base») y se clampaba con `Math.max(0, codigo − base)`. Eso hace que el estado
// contrario —la base con MÁS migraciones aplicadas que las que conoce el código
// que atiende peticiones— se reporte con exactamente los mismos valores que
// «todo al día»: `atras: 0`, sin `motivo`, y `route.ts` en `status: ok`.
//
// No es hipotético: el 7-sep-2026 el commit `d56e626` («producción al día:
// migraciones 0304-0347 aplicadas y verificadas») aplicó el esquema pero Vercel
// no publicó el código. Producción quedó con `base=0347` y `codigo=0303`, y
// `/api/health` respondió HTTP 200 `estado=ok migracion={"base":"0347",
// "codigo":"0303","atras":0}` — medido en la corrida 34092224844 de
// `salud-produccion.yml`. La 0317, ya aplicada, había dropeado la firma de
// `gastos_fiscales_agregados_tenant` que ese código llama.
describe('cotejar — la deriva inversa (base ADELANTE del código) no puede leerse como "al día"', () => {
  it('base 0347 contra código 0303: lo denuncia con un motivo, y NO se ve igual que estar al día', () => {
    const derivaInversa = cotejar('0347', '0303');
    const alDia = cotejar('0303', '0303');

    // Lo que rompía: los dos objetos eran indistinguibles.
    expect(derivaInversa).not.toEqual(alDia);
    expect(derivaInversa.motivo).toBeDefined();
    expect(derivaInversa.motivo).toContain('0303');
    expect(derivaInversa.motivo).toContain('0347');
    // 44 migraciones aplicadas que el código no conoce.
    expect(derivaInversa.adelante).toBe(44);

    // Y el caso sano sigue sano, sin motivo y sin deriva en ningún sentido.
    expect(alDia.atras).toBe(0);
    expect(alDia.adelante).toBe(0);
    expect(alDia.motivo).toBeUndefined();
  });

  it('la deriva normal (base atrás del código) no cambia de comportamiento', () => {
    const v = cotejar('0303', '0347');
    expect(v.atras).toBe(44);
    expect(v.adelante).toBe(0);
    expect(v.motivo).toContain('atrás del código');
  });

  it('sin base o sin código el veredicto sigue siendo "no se pudo saber", no una deriva', () => {
    expect(cotejar(null, '0347').atras).toBeNull();
    expect(cotejar('0347', null).atras).toBeNull();
    expect(cotejar(null, '0347').adelante).toBeNull();
  });
});
