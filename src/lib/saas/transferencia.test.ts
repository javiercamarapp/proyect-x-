import { describe, it, expect, afterEach } from 'vitest';
import { clabeValida, referenciaDe, datosBancarios } from './transferencia';

// ═══════════════════════════════════════════════════════════════════════════
// COBRAR POR TRANSFERENCIA — donde no hay red de seguridad.
//
// Con una pasarela, un dato mal puesto lo rechaza la pasarela. Aquí no: la app
// le enseña unos dígitos a un contralor, él los teclea en su banca y el dinero
// SE VA. Si la CLABE está mal, el depósito llega a la cuenta de un desconocido y
// no hay `payment_failed` que avise. Por eso todo se valida antes de mostrarse.
// ═══════════════════════════════════════════════════════════════════════════

// CLABE INVENTADA para las pruebas, con dígito verificador correcto. La real de
// Likida NO va aquí: este repo es PÚBLICO y quedaría en el historial de git para
// siempre. Vive en variables de entorno.
const CLABE_PRUEBA = '002180000000000009';

describe('clabeValida — el dígito verificador atrapa el dedazo', () => {
  it('acepta una CLABE bien formada', () => {
    expect(clabeValida(CLABE_PRUEBA)).toBe(true);
  });

  it('rechaza la MISMA CLABE con un dígito cambiado', () => {
    // Este es el caso que importa: se ve idéntica y manda el dinero a otro lado.
    expect(clabeValida('002180000000000000')).toBe(false);
    expect(clabeValida('002180000000000109')).toBe(false);
  });

  it('rechaza longitudes que no sean 18', () => {
    expect(clabeValida(CLABE_PRUEBA.slice(0, 17))).toBe(false);
    expect(clabeValida(`${CLABE_PRUEBA}1`)).toBe(false);
    expect(clabeValida('')).toBe(false);
  });

  it('tolera espacios pero no letras', () => {
    expect(clabeValida('0021 8000 0000 0000 09')).toBe(true);
    expect(clabeValida('00218000000000000X')).toBe(false);
  });
});

describe('referenciaDe — el puente entre el depósito y la factura', () => {
  const T = 'a3f21b4c-0000-0000-0000-000000000000';

  it('es DETERMINISTA: el mismo mes da la misma referencia', () => {
    // Reemitir no puede generar un segundo código para un solo cobro.
    expect(referenciaDe(T, '2026-08-01')).toBe(referenciaDe(T, '2026-08-01'));
  });

  it('cambia con el mes y con la flota', () => {
    expect(referenciaDe(T, '2026-08-01')).not.toBe(referenciaDe(T, '2026-09-01'));
    expect(referenciaDe(T, '2026-08-01')).not.toBe(referenciaDe('b0000000-0000-0000-0000-000000000000', '2026-08-01'));
  });

  it('solo letras y números: va en el concepto de una app bancaria', () => {
    // Los bancos recortan o rechazan caracteres raros, y una referencia mutilada
    // ya no casa con nada.
    expect(referenciaDe(T, '2026-08-01')).toMatch(/^[A-Z0-9]+$/);
    expect(referenciaDe(T, '2026-08-01').length).toBeLessThanOrEqual(16);
  });
});

describe('datosBancarios — falla cerrado', () => {
  afterEach(() => {
    delete process.env.LIKIDA_CLABE;
    delete process.env.LIKIDA_BANCO;
    delete process.env.LIKIDA_BENEFICIARIO;
  });

  const poner = (clabe: string) => {
    process.env.LIKIDA_CLABE = clabe;
    process.env.LIKIDA_BANCO = 'BBVA México';
    process.env.LIKIDA_BENEFICIARIO = 'BENEFICIARIO DE PRUEBA';
  };

  it('con los tres datos y CLABE válida, los devuelve', () => {
    poner(CLABE_PRUEBA);
    const d = datosBancarios();
    expect(d?.clabe).toBe(CLABE_PRUEBA);
    expect(d?.clabeUltimos4).toBe('0009');
  });

  it('SIN configurar devuelve null — no se enseña una cuenta a medias', () => {
    expect(datosBancarios()).toBeNull();
  });

  it('con un solo dato faltante también devuelve null', () => {
    poner(CLABE_PRUEBA);
    delete process.env.LIKIDA_BENEFICIARIO;
    // Una transferencia sin beneficiario la rebota el banco, o peor: la manda
    // igual y nadie sabe de quién era.
    expect(datosBancarios()).toBeNull();
  });

  it('con CLABE INVÁLIDA devuelve null, aunque estén los tres', () => {
    // Es la protección que importa: antes de enseñar dígitos que alguien va a
    // teclear en su banca, se comprueban.
    poner('002180000000000000');
    expect(datosBancarios()).toBeNull();
  });
});

// ── Que no vuelva a colarse una cuenta real al repo ────────────────────────
//
// Este guardián existe porque el error ya se cometió: la primera versión de
// ESTE archivo traía la CLABE real de Likida, en un repo PÚBLICO, donde habría
// quedado en el historial de git para siempre — ligando el nombre y la cuenta
// del dueño a un artefacto público. Se cazó antes de commitear, de pura suerte.
//
// Una CLABE de verdad es difícil de reconocer a ojo: son 18 dígitos entre otros
// números. Lo que SÍ la distingue es que pasa su dígito verificador, y eso una
// máquina lo comprueba. Se escanea el código y se falla si aparece cualquiera
// que no sea la inventada de arriba.

describe('ninguna CLABE real vive en el código', () => {
  it('el árbol de fuentes no trae cuentas bancarias válidas', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const raiz = fileURLToPath(new URL('../..', import.meta.url));   // src/

    const sospechosas: string[] = [];
    const recorrer = (dir: string) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const e = d.name;
        const ruta = `${dir}/${e}`;
        if (d.isDirectory()) { recorrer(ruta); continue; }
        if (!d.isFile() || !/\.(ts|tsx|md|sql|json)$/.test(e)) continue;
        const texto = readFileSync(ruta, 'utf8');
        for (const m of texto.matchAll(/\b\d{18}\b/g)) {
          if (m[0] === CLABE_PRUEBA) continue;      // la inventada, a propósito
          if (clabeValida(m[0])) sospechosas.push(`${ruta.split('/src/')[1]}: ${m[0].slice(0, 6)}…`);
        }
      }
    };
    recorrer(raiz);

    expect(
      sospechosas,
      `esto parece una CLABE real en el código de un repo PÚBLICO:\n  ${sospechosas.join('\n  ')}\n\n` +
      'Las cuentas bancarias van en variables de entorno (LIKIDA_CLABE), nunca en el repo.',
    ).toEqual([]);
  });
});
