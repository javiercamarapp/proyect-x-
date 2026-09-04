import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sinComentarios } from '@/lib/pruebas/codigo';
import { execSync } from 'node:child_process';
import { instanteRFC3339, mxn, usd, usd4, mxnCompacto, litros, fechaMx, fechaCorta, fechaHoraMx, round2, pctCambio, porcentaje, hoyMx, inicioDiaMx, finDiaMx, pesoArchivo } from './formato';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 7 · MEDIO REINCIDENTE POR TERCERA RONDA — y el número CRECÍA:
//
//     ronda 6 →  3 copias de `mxn()` escritas a mano
//     ronda 7 →  8
//     31-jul  → 11
//
// Siete de ellas eran la misma línea, repetida en cada archivo que imprime
// dinero que el contralor lee: el PDF, el resumen de WhatsApp, el panel, el
// aviso del tope del 15%, los acreditables y el motor.
//
// Que fueran idénticas no era defensa: el hallazgo gemelo de `litros()` YA se
// divergió una vez —el panel decía "1,235 L" donde el PDF decía "1,234.56 L"—.
// Una cifra fiscal que se lee distinta en dos pantallas se lee como dos
// cálculos distintos.
// ═══════════════════════════════════════════════════════════════════════════

describe('el formato del dinero', () => {
  it('es el que espera un contador mexicano', () => {
    expect(mxn(1234.5)).toBe('$1,234.50');
    expect(mxn(0)).toBe('$0.00');
    expect(mxn(839.7)).toBe('$839.70');
  });

  it('un negativo se ve como negativo', () => {
    // El operador que puso de su bolsa lee un número en rojo, no un paréntesis
    // contable que no todo el mundo interpreta igual.
    expect(mxn(-1250)).toContain('-');
    expect(mxn(-1250)).toContain('1,250.00');
  });

  it('redondea a centavos, que es lo que existe en un CFDI', () => {
    expect(mxn(0.005)).toBe('$0.01');
  });

  it('litros: hasta dos decimales, sin rellenar ceros', () => {
    expect(litros(1234.56)).toBe('1,234.56 L');
    expect(litros(200)).toBe('200 L');
    // El motor redondea a dos decimales; esto solo evita que un
    // 1234.5600000001 de coma flotante salga con tres cifras.
    expect(litros(1234.5600000001)).toBe('1,234.56 L');
  });

  it('fecha: el cierre nocturno NO se pasa al día siguiente', () => {
    // 31-jul 19:30 en México (CST, UTC−6) = 01:30 UTC del 1-ago.
    expect(fechaMx('2026-08-01T01:30:00.000Z')).toContain('31');
    expect(fechaMx('2026-08-01T01:30:00.000Z')).toContain('jul');
  });

  it('fechaCorta: mismo día que fechaMx, sin año — para etiquetas angostas', () => {
    expect(fechaCorta('2026-08-01T01:30:00.000Z')).toContain('31');
    expect(fechaCorta('2026-08-01T01:30:00.000Z')).toContain('jul');
    expect(fechaCorta('2026-08-01T01:30:00.000Z')).not.toMatch(/2026/);
  });

  it('fechaCorta: fecha simple (sin hora) no se corre un día', () => {
    // Columna `date`, sin zona — se formatea en UTC para no moverse.
    expect(fechaCorta('2026-08-04')).toContain('04');
    expect(fechaCorta('2026-08-04')).toContain('ago');
  });

  it('fechaCorta: ausente o ilegible da "—", no "Invalid Date"', () => {
    expect(fechaCorta(null)).toBe('—');
    expect(fechaCorta('no es una fecha')).toBe('—');
  });
});

describe('pctCambio', () => {
  it('sube 20% cuando el actual es 120 contra una base de 100', () => {
    expect(pctCambio(120, 100)).toBe(20);
  });

  it('baja cuando el actual es menor que la base', () => {
    expect(pctCambio(80, 100)).toBe(-20);
  });

  it('sin base (null o cero) no hay "% de cambio" que calcular honesto', () => {
    expect(pctCambio(500, null)).toBeNull();
    expect(pctCambio(500, 0)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 10, BAJO — `mxn(1.83)` y `usd(1.83)` daban el MISMO string,
// "$1.83": los dos `Intl.NumberFormat` de moneda usan el signo genérico "$".
// En /admin, "Gastado en IA" y "Costo de IA" son dólares en la misma pantalla
// que todo lo demás muestra en pesos, y nada en el texto distinguía cuál era
// cuál. `usd()` ahora antepone "US$" — el símbolo real que se usa para no
// confundir dólares con las otras monedas que también usan "$".
// ═══════════════════════════════════════════════════════════════════════════
describe('el formato del dinero — pesos y dólares NO se escriben igual', () => {
  it('mxn() y usd() del mismo número ya NO son el string idéntico', () => {
    expect(mxn(1.83)).not.toBe(usd(1.83));
  });

  it('usd() lleva el prefijo US$', () => {
    expect(usd(1234.5)).toBe('US$1,234.50');
    expect(usd(0)).toBe('US$0.00');
  });

  it('mxn() se queda con el signo genérico, el que espera un contador mexicano', () => {
    expect(mxn(1234.5)).toBe('$1,234.50');
  });

  it('un dólar negativo se sigue leyendo como negativo', () => {
    expect(usd(-12.5)).toContain('-');
    expect(usd(-12.5)).toContain('US$12.50');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LA HORA, no solo el día. La confirmación del chofer (mig. 0058) se decide por
// horas —el plazo de escalación son 5— y `fechaMx` solo imprime el día, así que
// "confirmó el 4 de agosto" no le sirve a nadie para decidir si cambia de
// personal. Es la misma función de siempre con hora, en la misma zona, en el
// mismo archivo: una hora formateada a mano en el componente es exactamente
// como se divergieron `mxn()` y `litros()` tres rondas seguidas.
// ═══════════════════════════════════════════════════════════════════════════
describe('fechaHoraMx: el día Y la hora del cliente', () => {
  it('las 20:00 de CDMX no saltan al día siguiente ni a otra hora', () => {
    expect(fechaHoraMx('2026-08-05T02:00:00.000+00:00')).toBe('04 ago 2026, 20:00');
  });

  it('la medianoche se imprime 00:00, no 24:00', () => {
    // `hour12: false` puede dar "24:00" según la versión de ICU, y las 24:00 no
    // son una hora que exista: por eso el `hourCycle: 'h23'` explícito.
    expect(fechaHoraMx('2026-08-05T06:00:00.000+00:00')).toBe('05 ago 2026, 00:00');
  });

  it('a un valor de SOLO FECHA no se le inventa una hora', () => {
    // No tiene hora que enseñar, y convertirlo además lo correría un día
    // (medianoche UTC leída en UTC−6 cae el día anterior).
    expect(fechaHoraMx('2026-08-04')).toBe('04 ago 2026');
  });

  it('ausente o ilegible se pinta como guion, no como "Invalid Date"', () => {
    expect(fechaHoraMx(null)).toBe('—');
    expect(fechaHoraMx(undefined)).toBe('—');
    expect(fechaHoraMx('')).toBe('—');
    expect(fechaHoraMx('no es una fecha')).toBe('—');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 9, ALTO REINCIDENTE (arquitectura) — `round2()` reimplementado en
// CUATRO archivos de dinero (`engine.ts`, `analytics.ts`, `pagadero.ts`,
// `combustible.ts`), las cuatro copias idénticas y las cuatro con el MISMO
// bug: `Math.round(n * 100) / 100` redondea mal cuando el número no es
// representable exacto en punto flotante. `round2(1.005)` da `1`, no `1.01`
// —1.005 se guarda como 1.00499999999999989…, y `Math.round(100.4999…)` cae
// para abajo—. Ya lo había marcado la ronda 8 como advertencia y nadie lo
// atacó: por la regla del rubro, una advertencia que vuelve a ocurrir es un
// hallazgo, no una advertencia.
// ═══════════════════════════════════════════════════════════════════════════
describe('round2 — redondeo a centavos que no le cree a la coma flotante', () => {
  it('el caso que reprueba Math.round(n*100)/100 a secas', () => {
    expect(round2(1.005)).toBe(1.01);
  });

  it('otros valores de la misma familia (x.xx5) que la coma flotante representa mal', () => {
    expect(round2(35.645)).toBe(35.65);
    expect(round2(0.145)).toBe(0.15);
  });

  it('el caso común (nada especial en punto flotante) sigue redondeando normal', () => {
    expect(round2(1234.567)).toBe(1234.57);
    expect(round2(839.7)).toBe(839.7);
  });

  it('negativos', () => {
    expect(round2(-1.005)).toBe(-1.01);
  });

  it('cero y enteros no se mueven', () => {
    expect(round2(0)).toBe(0);
    expect(round2(500)).toBe(500);
  });
});

describe('NO puede volver a haber una copia de round2', () => {
  // Mismo mecanismo que el guardarraíl de `mxn()` de arriba: se mide el
  // código, no una lista escrita a mano. La ronda 9 encontró las cuatro
  // copias por `command grep`; esto asegura que una quinta no pase inadvertida.
  const archivos = execSync(
    `command grep -rl "function round2\\|const round2\\s*=" src/ --include='*.ts' || true`,
    { encoding: 'utf8' },
  ).split('\n').filter(Boolean);

  it('solo `formato.ts` define round2', () => {
    const fuera = archivos.filter((f) => !f.includes('lib/formato.ts') && !f.includes('.test.'));
    expect(
      fuera,
      `estos archivos reimplementan round2 en vez de importarlo de formato.ts:\n${fuera.join('\n')}`,
    ).toEqual([]);
  });
});

describe('NO puede volver a haber una copia a mano', () => {
  // LA RED QUE FALTABA, y es la razón por la que el hallazgo sobrevivió tres
  // rondas: cada vez se arreglaban las copias conocidas, nadie impedía la
  // siguiente, y al archivo nuevo le salía la suya. Esto lo mide sobre el
  // código, no sobre una lista escrita a mano que también se desactualiza.
  // SE MIRA EL CÓDIGO, NO LOS COMENTARIOS (`sinComentarios`). La primera versión
  // hacía grep del literal sobre el archivo entero y se rompió con su propio
  // comentario: el encabezado de `dashboard/formato.ts` CITA
  // `toLocaleString('es-MX')` para contar la historia del hallazgo. Una prueba
  // que prohíbe hablar del bug que vigila obliga a borrar justo la explicación
  // que hace falta para no repetirlo.
  const archivos = execSync(
    `grep -rl "toLocaleString('es-MX'" src/ --include='*.ts' --include='*.tsx' || true`,
    { encoding: 'utf8' },
  ).split('\n').filter(Boolean);

  it('solo `formato.ts` formatea cifras mexicanas', () => {
    const fuera = archivos
      .filter((f) => !f.includes('lib/formato.ts') && !f.includes('.test.'))
      .filter((f) => /toLocaleString\('es-MX'/.test(sinComentarios(readFileSync(f, 'utf8'))));
    expect(
      fuera,
      `estos archivos formatean por su cuenta en vez de usar formato.ts:\n${fuera.join('\n')}`,
    ).toEqual([]);
  });

  // B2 (auditoría 18): el guardia cubría las CIFRAS y no las FECHAS. "Hoy en
  // México" se escribía de dos maneras en ~38 sitios y dos hardcodeaban la
  // zona. Ahora `hoyMx()` vive aquí y nadie más deletrea 'en-CA' ni la zona.
  const archivosFecha = execSync(
    `grep -rlE "'en-CA'|'America/Mexico_City'" src/ --include='*.ts' --include='*.tsx' || true`,
    { encoding: 'utf8' },
  ).split('\n').filter(Boolean)
    .filter((f) => !f.includes('lib/formato.ts') && !f.includes('.test.'));

  it('solo `formato.ts` deletrea la zona horaria de México', () => {
    const fuera = archivosFecha
      .filter((f) => /'America\/Mexico_City'/.test(sinComentarios(readFileSync(f, 'utf8'))));
    expect(
      fuera,
      `estos archivos hardcodean la zona en vez de usar TZ_MX:\n${fuera.join('\n')}`,
    ).toEqual([]);
  });

  it('solo `formato.ts` calcula el día de México con `en-CA` (usa hoyMx)', () => {
    const fuera = archivosFecha
      .filter((f) => /'en-CA'/.test(sinComentarios(readFileSync(f, 'utf8'))));
    expect(
      fuera,
      `estos archivos calculan el día de México a mano en vez de usar hoyMx():\n${fuera.join('\n')}`,
    ).toEqual([]);
  });

  // ── c7-34 · EL COPY QUE SALE A LA CALLE NO FORMATEA A MANO ──────────────
  //
  // El guardia de arriba mira `toLocaleString('es-MX')`, que es la ortografía
  // CORRECTA usada fuera de sitio. Le faltaba la incorrecta: `toFixed`, que ni
  // pone separador de millares ni respeta la coma decimal del español, y que
  // el ciclo 7 encontró DENTRO del texto que `copyPorCanal` pega en LinkedIn,
  // Instagram y TikTok (`crecimiento.ts:622`, `$${numero(...)}` armado a mano
  // más `(factor*100).toFixed(0)`). Un formato divergente ahí sale con la
  // marca encima.
  //
  // El guardia es ESTRECHO a propósito: los diez agentes de crecimiento, que
  // son los que producen material para publicar. Extenderlo al repo entero
  // sería otra decisión y otro PR — un ratchet que nace fallando no se
  // respeta, se desactiva.
  it('c7-34 · ningún agente de crecimiento formatea cifras con toFixed', () => {
    // Rutas LITERALES (y no un `readdirSync` sobre el directorio) por el
    // ratchet de eslint: `detect-non-literal-fs-filename` cuenta warnings y un
    // guardia nuevo no puede subir esa cuenta.
    const deCrecimiento: Array<[string, string]> = [
      ['src/lib/likida/agentes/crecimiento.ts', readFileSync('src/lib/likida/agentes/crecimiento.ts', 'utf8')],
      ['src/lib/likida/agentes/contenido.ts', readFileSync('src/lib/likida/agentes/contenido.ts', 'utf8')],
    ];
    const fuera = deCrecimiento
      .filter(([, fuente]) => /\.toFixed\(/.test(sinComentarios(fuente)))
      .map(([f]) => f);
    expect(
      fuera,
      `estos agentes formatean a mano en vez de usar mxn()/numero()/porcentaje() de formato.ts:\n${fuera.join('\n')}`,
    ).toEqual([]);
  });

  it('y `formato.ts` no importa NADA, para que el motor pueda usarlo', () => {
    // `engine.ts` es puro y sin I/O, y `pdf.ts` viaja en el bundle del webhook.
    // Un archivo sin imports no depende de que nadie, algún día, le cuelgue una
    // dependencia pesada por accidente — un archivo sin imports no depende de
    // la suerte.
    const fuente = readFileSync('src/lib/formato.ts', 'utf8');
    expect(fuente).not.toMatch(/^\s*import\s/m);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B2 BIS (auditoría prod, DAT-08/DAT-23/DAT-28/FE-20) — el guardia de fechas
// cubría las DOS ortografías de "hoy en México" ('en-CA' y la zona escrita a
// mano) y dejaba pasar la tercera, que es la que de verdad mentía: NO calcular
// el día de México en absoluto.
//
//     new Date().toISOString().slice(0, 10)
//
// Eso es el día de LONDRES. México va seis horas atrás, así que de las 18:00 a
// las 24:00 hora local ese "hoy" es ya el de mañana. El peor caso tiene fecha:
// el 31 de diciembre a las 19:00 devuelve el 1 de enero, y con él el panel
// abría el ejercicio fiscal equivocado, la ventana "últimos 7 días" empezaba y
// terminaba un día corrida, y el render del servidor no coincidía con el del
// navegador del cliente (que sí está en México) — mismatch de hidratación.
//
// El guardia mira SOLO el patrón que toma el RELOJ y lo trunca en UTC
// (`new Date()`, `Date.now()`, `ahoraMs()`). La aritmética de calendario sobre
// un día ya resuelto —`new Date(\`${dia}T00:00:00Z\`)` para sumar días, o un
// timestamp de Excel— NO es una conversión de zona y sigue permitida: es la
// misma distinción que ya documenta `fechaMx` (un valor de solo fecha se
// formatea en UTC justo para que no se mueva).
// ═══════════════════════════════════════════════════════════════════════════
describe('nadie vuelve a cortar el día en UTC', () => {
  // `new Date()` / `new Date(Date.now() ± …)` / `new Date(ahoraMs())` seguido,
  // en la MISMA sentencia, de `.toISOString().slice(0, 10)`.
  const PATRON = /new Date\(\s*(\)|Date\.now\(\)|ahoraMs\(\))[^;\n]*?\.toISOString\(\)\.slice\(0, *10\)/;

  const candidatos = execSync(
    `grep -rl "toISOString()\.slice(0, 10)" src/ --include='*.ts' --include='*.tsx' || true`,
    { encoding: 'utf8' },
  ).split('\n').filter(Boolean)
    .filter((f) => !f.includes('lib/formato.ts') && !f.includes('.test.'));

  it('el día de HOY se saca con hoyMx(), no truncando el reloj en UTC', () => {
    const fuera = candidatos
      .filter((f) => PATRON.test(sinComentarios(readFileSync(f, 'utf8'))));
    expect(
      fuera,
      'estos archivos cortan el día en UTC en vez de usar hoyMx():\n' + fuera.join('\n'),
    ).toEqual([]);
  });
});

describe('el corte de un día de México (inicioDiaMx/finDiaMx)', () => {
  it('la medianoche de México son las 06:00 UTC, no las 00:00', () => {
    expect(inicioDiaMx('2026-12-31')).toBe('2026-12-31T00:00:00-06:00');
    expect(new Date(inicioDiaMx('2026-12-31')).toISOString()).toBe('2026-12-31T06:00:00.000Z');
  });

  it('el cierre del día alcanza a lo capturado a las 19:00 hora local', () => {
    // Las 19:00 del 31-dic en México son las 01:00 UTC del 1-ene: con el corte
    // viejo (`T23:59:59.999Z`) esta liquidación quedaba FUERA de su ejercicio.
    const cierre = new Date('2027-01-01T01:00:00Z').getTime();
    expect(cierre).toBeLessThanOrEqual(new Date(finDiaMx('2026-12-31')).getTime());
    expect(cierre).toBeGreaterThan(new Date(inicioDiaMx('2026-12-31')).getTime());
    expect(cierre).toBeGreaterThan(new Date('2026-12-31T23:59:59.999Z').getTime());
  });
});

describe('usd4 — el costo de una corrida de IA', () => {
  it('cuatro decimales, para que una fracción de centavo no se lea como gratis', () => {
    expect(usd4(0.0003)).toBe('US$0.0003');
    expect(usd(0.0003)).toBe('US$0.00');
  });

  it('con separador de millares, que es lo que `toFixed(4)` no ponía', () => {
    expect(usd4(1234.5678)).toBe('US$1,234.5678');
    expect((1234.5678).toFixed(4)).toBe('1234.5678');
  });

  it('cero y negativos', () => {
    expect(usd4(0)).toBe('US$0.0000');
    expect(usd4(-1.5)).toContain('-');
  });
});

describe('mxnCompacto — la cifra que no cabe en la tarjeta', () => {
  it('debajo de un millón NO cambia nada: es `mxn()` tal cual', () => {
    expect(mxnCompacto(839.7)).toBe(mxn(839.7));
    expect(mxnCompacto(999_999)).toBe(mxn(999_999));
  });

  it('nueve mil millones caben en ocho caracteres', () => {
    expect(mxn(9_000_000_000)).toBe('$9,000,000,000.00');
    // El espacio es NO-SEPARABLE (U+00A0), el que pone Intl: la cifra y su
    // magnitud nunca se parten en dos renglones dentro de la tarjeta.
    expect(mxnCompacto(9_000_000_000)).toBe('$9,000\u00a0M');
    expect(mxnCompacto(9_000_000_000).length).toBeLessThanOrEqual(9);
  });

  it('un millón y pico se abrevia con su decimal, y el signo se conserva', () => {
    expect(mxnCompacto(1_234_567)).toBe('$1.2\u00a0M');
    expect(mxnCompacto(-1_234_567)).toContain('-');
  });
});

describe('hoyMx', () => {
  it('da AAAA-MM-DD del día de México, no del UTC', () => {
    // 2026-08-22T03:30Z son las 21:30 del 21 en CDMX (UTC-6 fijo).
    expect(hoyMx(new Date('2026-08-22T03:30:00Z'))).toBe('2026-08-21');
    expect(hoyMx(new Date('2026-08-22T06:00:00Z'))).toBe('2026-08-22');
  });
  it('sin argumento usa ahora y tiene forma ISO', () => {
    expect(hoyMx()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// c7-34 · `porcentaje()` — el formato que faltaba en la caja de herramientas.
//
// Sin él, cada llamador escribía `${n.toFixed(1)}%` y el repo tenía tantas
// ortografías del porcentaje como sitios que lo imprimen.
// ═══════════════════════════════════════════════════════════════════════════
describe('porcentaje — puntos porcentuales, no fracción', () => {
  it('recibe el número YA en puntos porcentuales', () => {
    expect(porcentaje(42.9)).toBe('42.9%');
    expect(porcentaje(50, 0)).toBe('50%');
  });

  it('los decimales son EXACTOS, no un máximo: 50.0% y 50% dicen precisiones distintas', () => {
    expect(porcentaje(50, 1)).toBe('50.0%');
    expect(porcentaje(50, 2)).toBe('50.00%');
  });

  it('lleva separador de millares — que es lo que `toFixed` NO hace', () => {
    expect(porcentaje(1234.5, 1)).toBe('1,234.5%');
    // La ortografía vieja, para que se vea la diferencia que salía a LinkedIn.
    expect((1234.5).toFixed(1)).toBe('1234.5');
  });

  it('un negativo se escribe como negativo', () => {
    expect(porcentaje(-12.34, 2)).toBe('-12.34%');
  });
});

describe('pesoArchivo — bytes, KB o MB, nunca "0 KB" para lo que nadie midió', () => {
  it('bytes debajo de 1 KB se escriben tal cual', () => {
    expect(pesoArchivo(0)).toBe('0 B');
    expect(pesoArchivo(512)).toBe('512 B');
  });

  it('entre 1 KB y 1 MB, redondeado a KB', () => {
    expect(pesoArchivo(2048)).toBe('2 KB');
    expect(pesoArchivo(348_160)).toBe('340 KB');
  });

  it('1 MB o más, con un decimal si es menor a 10 MB', () => {
    expect(pesoArchivo(8 * 1024 * 1024)).toBe('8.0 MB');
    expect(pesoArchivo(2_411_724)).toBe('2.3 MB');
    expect(pesoArchivo(50 * 1024 * 1024)).toBe('50 MB');
  });

  it('null/undefined/negativo/NaN son "—", NUNCA "0 KB" — un tamaño desconocido no es un archivo vacío', () => {
    expect(pesoArchivo(null)).toBe('—');
    expect(pesoArchivo(undefined)).toBe('—');
    expect(pesoArchivo(-5)).toBe('—');
    expect(pesoArchivo(NaN)).toBe('—');
  });
});


describe('instanteRFC3339: calendario y gramática compartidos', () => {
  it.each([
    ['2024-02-29T23:15:30-06:00', '2024-03-01T05:15:30.000Z'],
    ['2000-02-29T00:00:00Z', '2000-02-29T00:00:00.000Z'],
    ['2026-01-01T00:00:00.123456Z', '2026-01-01T00:00:00.123Z'],
    ['2026-01-01T00:00:00+05:30', '2025-12-31T18:30:00.000Z'],
  ])('%s normaliza el instante sin cambiar el día local antes de aplicar offset', (valor, esperado) => {
    expect(instanteRFC3339(valor)).toBe(esperado);
  });
  it.each([
    '2026-02-29T00:00:00Z', '1900-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z', '2026-00-01T00:00:00Z',
    '2026-01-01T24:00:00Z', '2026-01-01T00:60:00Z',
    '2026-01-01T00:00:60Z', '2026-01-01T00:00:00+24:00',
    '2026-01-01T00:00:00-00:60', '2026-01-01T00:00:00',
    '2026-01-01T00:00:00.Z', '2026-01-01T00:00:00.1.2Z',
    ' 2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z ',
  ])('rechaza %s sin normalizaciones permisivas', (valor) => {
    expect(instanteRFC3339(valor)).toBeNull();
  });
  it('rechaza una fracción larga con sufijo inválido y valores no textuales', () => {
    expect(instanteRFC3339('2026-01-01T00:00:00.' + '1'.repeat(100_000) + '!Z')).toBeNull();
    expect(instanteRFC3339(null)).toBeNull();
  });
});
