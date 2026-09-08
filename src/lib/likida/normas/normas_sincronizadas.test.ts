import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NORMAS, IDS_NORMA, esVinculante, type Jerarquia } from './indice';

// ═══════════════════════════════════════════════════════════════════════════
// EL ÍNDICE Y LAS FICHAS NO PUEDEN SEPARARSE.
//
// La fuente de verdad son los YAML de `normas/`: traen el texto vigente
// transcrito y la trazabilidad de verificación. El índice de TS es una copia
// compacta para runtime, y una copia sin verificación es exactamente el patrón
// que ya falló dos veces en este repo con las etiquetas de concepto.
//
// Si alguien añade una ficha, cambia un `estado_verificacion` tras verificarla,
// o corrige una jerarquía, esto falla hasta que el índice lo refleje.
// ═══════════════════════════════════════════════════════════════════════════
const DIR = new URL('../../../../normas/', import.meta.url);

function campo(txt: string, n: string): string | undefined {
  const m = new RegExp(`^${n}:\\s*(.+)$`, 'm').exec(txt);
  const v = m?.[1]?.trim().replace(/^["']|["']$/g, '');
  return v && v !== 'null' ? v : undefined;
}

/**
 * AUDITORÍA 28, FIS-M2 (MEDIO, mecánico): a diferencia de `campo()`, esto
 * distingue los TRES estados de un campo YAML: presente con valor, presente
 * con `null` explícito, y AUSENTE. `campo()` colapsa los dos últimos —
 * correcto para `fecha_vigencia_desde` (el índice también colapsa null y
 * ausente a `null` ahí), pero `fecha_vigencia_hasta`/`exigibleHasta` necesita
 * los tres para poder decir "nadie lo confirmó" (`null`) sin confundirlo con
 * "esta ficha no trae el campo" (`undefined`).
 */
function campoTriEstado(txt: string, n: string): { presente: boolean; valor: string | null } {
  const m = new RegExp(`^${n}:\\s*(.+)$`, 'm').exec(txt);
  if (!m) return { presente: false, valor: null };
  const v = m[1].trim().replace(/^["']|["']$/g, '');
  return { presente: true, valor: v === 'null' ? null : v };
}

/**
 * El `titulo` de la ficha: inline entre comillas (el caso común) o un escalar
 * YAML plegado (`titulo: >`, líneas indentadas debajo). FISCAL (barrido
 * MEDIO/BAJO): `criterio-1-CFF-PI.yaml` usa la forma plegada, y quien copió el
 * título al índice pegó el literal ">" en vez de las líneas de abajo — el
 * plegado las junta con un espacio, sin el salto de línea.
 */
function tituloDeFicha(txt: string): string | undefined {
  const idx = txt.search(/^titulo:/m);
  if (idx === -1) return undefined;
  const resto = txt.slice(idx);
  const primeraLinea = resto.split('\n')[0].replace(/^titulo:\s*/, '').trim();
  if (!primeraLinea.startsWith('>') && !primeraLinea.startsWith('|')) {
    return primeraLinea.replace(/^["']|["']$/g, '');
  }
  const partes: string[] = [];
  for (const linea of resto.split('\n').slice(1)) {
    if (!/^\s+\S/.test(linea)) break;
    partes.push(linea.trim());
  }
  return partes.join(' ');
}

const archivos = readdirSync(DIR).filter((f) => f.endsWith('.yaml'));
const fichas = archivos.map((f) => {
  const txt = readFileSync(new URL(f, DIR), 'utf8');
  return { archivo: f, txt, id: campo(txt, 'id'), estado: campo(txt, 'estado_verificacion'), jerarquia: campo(txt, 'jerarquia') };
});

describe('índice de normas vs fichas', () => {
  it('hay al menos una ficha por cada entrada del índice', () => {
    const idsFicha = new Set(fichas.map((f) => f.id));
    for (const id of IDS_NORMA) {
      expect(idsFicha.has(id), `el índice tiene "${id}" y no hay ficha con ese id`).toBe(true);
    }
  });

  it('no hay fichas fuera del índice', () => {
    // Una ficha que el código no puede citar es trabajo que no llega a nadie.
    for (const f of fichas) {
      expect(IDS_NORMA, `la ficha ${f.archivo} (id "${f.id}") no está en el índice`).toContain(f.id!);
    }
  });

  it('el estado de verificación coincide, ficha por ficha', () => {
    // Es el campo que decide si el producto puede afirmar algo o tiene que
    // condicionarlo. Desincronizarlo significa afirmar sobre algo sin verificar.
    for (const f of fichas) {
      expect(NORMAS[f.id!].estado, `estado distinto en ${f.archivo}`).toBe(f.estado);
    }
  });

  it('la jerarquía coincide: confundirla es "el error más caro del dominio"', () => {
    for (const f of fichas) {
      expect(NORMAS[f.id!].jerarquia, `jerarquía distinta en ${f.archivo}`).toBe(Number(f.jerarquia));
    }
  });

  it('toda norma tiene al menos una forma de citarse', () => {
    // Sin `citas`, la guardia no puede reconocerla en un texto ni sustituirla.
    for (const id of IDS_NORMA) {
      expect(NORMAS[id].citas.length, `"${id}" no tiene citas_en_codigo`).toBeGreaterThan(0);
    }
  });

  it('las CITAS coinciden con las de la ficha, no solo su cantidad', () => {
    // Este test solo comprobaba que el arreglo no estuviera vacío, y por eso
    // `rlisr-57` pudo estar con `citas_en_codigo: []` en la ficha mientras el
    // índice decía ["RLISR 57"] sin que nada fallara. Las citas SON el patrón
    // con el que la guardia reconoce una norma en un mensaje: si se separan, la
    // guardia le quita al agente una cita legítima o le deja pasar una que no.
    for (const f of fichas) {
      const enFicha = campo(f.txt, 'citas_en_codigo') ?? '[]';
      let lista: string[] = [];
      try { lista = JSON.parse(enFicha.replace(/'/g, '"')); } catch { /* mal formada → [] */ }
      expect(NORMAS[f.id!].citas, `citas distintas en ${f.archivo}`).toEqual(lista);
    }
  });

  it('el título coincide con la ficha, incluida la forma plegada', () => {
    // FISCAL (barrido MEDIO/BAJO): `criterio-1-CFF-PI` tenía `titulo: ">"` en
    // el índice — el literal del plegado YAML, no el texto de abajo — porque
    // nada cotejaba este campo.
    for (const f of fichas) {
      expect(NORMAS[f.id!].titulo, `título distinto en ${f.archivo}`).toBe(tituloDeFicha(f.txt));
    }
  });

  it('la ruta de la ficha existe de verdad', () => {
    for (const id of IDS_NORMA) {
      expect(archivos, `${NORMAS[id].ficha} no existe`).toContain(NORMAS[id].ficha.replace('normas/', ''));
    }
  });

  it('la FECHA DE EXIGIBILIDAD del índice es la de la ficha, no la del código', () => {
    // Es el campo que enciende o apaga un veredicto DURO. `config.ts` traía
    // `vigenteDesde: '2026-04-24'` fundado en una cita sin ficha (RMF 2.7.1.8) y
    // el motor tiraba con ella una deducción entera más su IVA acreditable. La
    // única fuente admisible de esa fecha es `fecha_vigencia_desde` de la ficha:
    // si nadie la confirmó, es `null` y el motor no puede afirmar vigencia.
    for (const f of fichas) {
      const enFicha = campo(f.txt, 'fecha_vigencia_desde') ?? null;
      const enIndice = NORMAS[f.id!].exigibleDesde ?? null;
      expect(enIndice, `fecha_vigencia_desde distinta en ${f.archivo}`).toBe(enFicha);
    }
  });

  // ── AUDITORÍA 28, FIS-M2 (MEDIO, mecánico) ──────────────────────────────
  //
  // Espejo del `it` de arriba, pero para `fecha_vigencia_hasta`/
  // `exigibleHasta`. A diferencia de `exigibleDesde` (que colapsa "sin
  // confirmar" y "no aplica" al mismo `null`), aquí los TRES estados
  // importan: una fecha real, `null` EXPLÍCITO ("se confirmó que no caduca"),
  // y AUSENTE (la ficha no declara el campo — ni fecha ni null). Confundir
  // "ausente" con "null confirmado" haría parecer verificado algo que nadie
  // ha mirado.
  it('la FECHA DE FIN DE VIGENCIA del índice es la de la ficha: fecha, null explícito o ausente', () => {
    for (const f of fichas) {
      const enFicha = campoTriEstado(f.txt, 'fecha_vigencia_hasta');
      const enIndice = NORMAS[f.id!].exigibleHasta;
      if (!enFicha.presente) {
        expect(enIndice, `${f.archivo} no declara fecha_vigencia_hasta y el índice sí trae exigibleHasta`).toBeUndefined();
      } else {
        expect(enIndice, `fecha_vigencia_hasta distinta en ${f.archivo}`).toBe(enFicha.valor);
      }
    }
  });

  it('las cinco RFA 2026 traen fecha_vigencia_hasta (para que nadie la borre sin verla)', () => {
    for (const id of ['rfa-2026-2.1', 'rfa-2026-2.2', 'rfa-2026-2.3', 'rfa-2026-2.5', 'rfa-2026-2.9']) {
      expect(typeof NORMAS[id].exigibleHasta, `${id} debería traer fecha_vigencia_hasta`).toBe('string');
    }
  });
});

// ── usado_en_codigo ──────────────────────────────────────────────────────────
// AUDITORÍA 4, E3: tres fichas llevaban semanas citando código podrido —un
// FISCAL_LEGAL.md que ya no existe, un "processor.ts:238" que hoy es otra
// cosa, y un "no existe todavía" sobre un contador que ya vivía en repo.ts—
// y nada fallaba, porque este archivo cotejaba todo MENOS `usado_en_codigo`.
// Que es justo el campo que el README vende como "si cambias la norma, ese es
// tu impacto": un impacto que apunta a un archivo inexistente manda al que
// edita la norma a corregir un fantasma y a NO corregir el código real.
//
// Se coteja lo mecánicamente cotejable: que cada RUTA citada exista en el
// repo. Los símbolos ("— tal función") NO se exigen a propósito: grepear
// nombres desde aquí acoplaría cada rename a los YAML y el test moriría por
// falsos positivos. Y los números de línea quedan prohibidos de facto: una
// cita "archivo.ts:238" no existe como ruta, así que el único formato que
// pasa es el estable — "ruta — símbolo/qué hace", sin :línea.

/** Las entradas de `usado_en_codigo`: lista en línea (`[...]`) o por renglones. */
function usadoEnCodigo(txt: string): string[] {
  const idx = txt.search(/^usado_en_codigo:/m);
  if (idx === -1) return [];
  const lineas = txt.slice(idx).split('\n');
  const resto = lineas[0].replace(/^usado_en_codigo:/, '').trim();
  if (resto.startsWith('[')) {
    const dentro = resto.slice(1, resto.endsWith(']') ? -1 : undefined);
    return dentro.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  const out: string[] = [];
  for (const linea of lineas.slice(1)) {
    const m = /^\s+-\s+(.*)$/.exec(linea);
    if (m) out.push(m[1].trim().replace(/^["']|["']$/g, ''));
    else if (linea.trim() !== '') break; // llegó otro campo: la lista terminó
  }
  return out;
}

/**
 * La ruta que cita una entrada, o `null` si la entrada no cita ninguna.
 * Es el primer token; cuenta como ruta si trae `/` o una extensión conocida.
 * `:238` NO se recorta: una cita con línea debe fallar, no colarse.
 */
function rutaCitada(entrada: string): string | null {
  const token = /^[\w@./:-]+/.exec(entrada.trim())?.[0]?.replace(/[.,;:]+$/, '') ?? '';
  if (!token) return null;
  return token.includes('/') || /\.(ts|tsx|mjs|sql|md|json|ya?ml)\b/.test(token) ? token : null;
}

// Las fichas citan de tres maneras (medido, no supuesto): relativo a
// `src/lib/likida/` —el estilo dominante: "cuadre/engine.ts", "repo.ts"—,
// desde la raíz ("supabase/migrations/...", "src/app/..."), y a veces desde
// `src/` o `src/lib/`. Se prueba contra las cuatro bases.
const RAIZ = new URL('../../../../', import.meta.url);
const BASES = ['', 'src/', 'src/lib/', 'src/lib/likida/'];
const existeEnRepo = (ruta: string) => BASES.some((b) => existsSync(new URL(b + ruta, RAIZ)));

describe('usado_en_codigo apunta a código que existe', () => {
  it('cada ruta citada existe en el repo, sin :línea', () => {
    for (const f of fichas) {
      for (const entrada of usadoEnCodigo(f.txt)) {
        const ruta = rutaCitada(entrada);
        if (!ruta) continue;
        expect(
          existeEnRepo(ruta),
          `${f.archivo}: "${entrada}" cita "${ruta}" y esa ruta no existe ` +
          `(se resolvió contra la raíz, src/, src/lib/ y src/lib/likida/). ` +
          `El formato estable es "ruta — símbolo/qué hace", sin números de línea.`,
        ).toBe(true);
      }
    }
  });

  // ── AUDITORÍA 24 · FIS-A1 (ALTO, reincidente 23) ────────────────────────
  //
  // La ruta existía, el símbolo no. `rfa-2026-2.9.yaml` citaba
  // «cuadre/engine.ts — SIN_ACREDITAMIENTO: la facilidad salva la deducción de
  // ISR, NO el IEPS ni el IVA» durante tres auditorías. `SIN_ACREDITAMIENTO`
  // se había partido en dos (`SIN_IVA_ACREDITABLE` y `SIN_ESTIMULO`) porque la
  // facilidad SÍ salva el IVA, y la ficha se quedó con la frase vieja. No es
  // un comentario: `corpus_texto.ts` la mete VERBATIM en el prompt del agente
  // contador («son tu ÚNICO material afirmable», agents/contador.ts), así que
  // el contralor preguntaba en el chat y recibía «no» sobre el mismo caso que
  // el PDF de su liquidación imprime en verde.
  //
  // Se cotejan solo los símbolos INEQUÍVOCOS —MAYÚSCULAS con guion bajo y
  // `nombre()` con paréntesis—: la prosa de una ficha es española y un
  // heurístico más ancho ("CFDI", "SAT") daría falsos positivos.
  // Sin cuantificadores anidados (`security/detect-unsafe-regex`): MAYÚSCULAS
  // con al menos un guion bajo, o un identificador seguido de `()`.
  const SIMBOLOS = /\b[A-Z][A-Z0-9_]*_[A-Z0-9_]*\b|\b[A-Za-z_$][\w$]*(?=\(\))/g;

  // Los COMENTARIOS no cuentan. Justo lo que pasó: `SIN_ACREDITAMIENTO` seguía
  // nombrado en tres comentarios de engine.ts años después de partirse en dos,
  // así que un `grep` crudo sobre el archivo habría dado verde igual.
  const sinComentarios = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('cada SÍMBOLO citado existe en el archivo que la ficha nombra', () => {
    let cotejados = 0;
    for (const f of fichas) {
      for (const entrada of usadoEnCodigo(f.txt)) {
        const ruta = rutaCitada(entrada);
        if (!ruta) continue;
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- `ruta` sale de las fichas YAML del propio repo, en tiempo de prueba; no hay entrada de usuario en el camino.
        const base = BASES.find((b) => existsSync(fileURLToPath(new URL(b + ruta, RAIZ))));
        if (base === undefined) continue; // lo reporta el `it` de arriba
        const archivo = fileURLToPath(new URL(base + ruta, RAIZ));
        let fuente: string;
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- misma razón que arriba: fuente del propio repo, ruta de una ficha YAML versionada.
        try { fuente = sinComentarios(readFileSync(archivo, 'utf8')); } catch { continue; } // carpeta
        for (const simbolo of entrada.replace(ruta, '').match(SIMBOLOS) ?? []) {
          cotejados++;
          expect(
            fuente.includes(simbolo),
            `${f.archivo}: "${entrada}" cita el símbolo "${simbolo}" y ${ruta} no lo ` +
            `contiene. Este texto viaja VERBATIM al prompt del agente contador ` +
            `(corpus_texto.ts): un símbolo renombrado deja a la ficha afirmando la ` +
            `regla vieja. Corrige la ficha y corre node scripts/generar-corpus-contador.mjs.`,
          ).toBe(true);
        }
      }
    }
    // Que el heurístico no se quede mudo y haga pasar todo en silencio.
    expect(cotejados).toBeGreaterThan(10);
  });

  it('el coteo no está ciego: el barrido extrae rutas de verdad', () => {
    // Un parser que devolviera [] para todo haría pasar el test de arriba en
    // silencio — el mismo modo de falla que este archivo existe para evitar.
    const rutas = fichas.flatMap((f) => usadoEnCodigo(f.txt)).map(rutaCitada).filter(Boolean);
    expect(rutas.length).toBeGreaterThan(15);
  });
});

// ── AUDITORÍA 28, FIS-M2 (MEDIO, mecánico, opcional) ────────────────────────
// El SKILL.md de vigilancia-normativa citaba "18 fichas" congelado, con 39 en
// disco. Este `it` no copia el número real: lee la carpeta (`archivos`, ya
// calculado arriba) y falla si SKILL.md vuelve a citar un conteo de fichas
// que no coincida.
describe('SKILL.md de vigilancia-normativa no congela el número de fichas', () => {
  it('cualquier "<N> fichas" que cite coincide con el conteo real de normas/*.yaml', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- ruta fija de este repo, escrita en el propio archivo de prueba; no hay entrada de usuario.
    const skill = readFileSync(new URL('../../../../.claude/skills/vigilancia-normativa/SKILL.md', import.meta.url), 'utf8');
    const matches = [...skill.matchAll(/(\d+)\s+fichas/gi)];
    for (const m of matches) {
      expect(Number(m[1]), `SKILL.md cita "${m[0]}" y hay ${archivos.length} fichas en normas/*.yaml`).toBe(archivos.length);
    }
  });
});

describe('esVinculante', () => {
  it('ley, reglamento, regla general y anexo obligan', () => {
    for (const j of [1, 2, 3, 4] as Jerarquia[]) expect(esVinculante(j)).toBe(true);
  });

  it('un criterio NO vinculativo y la política de un tercero NO obligan', () => {
    // Presentar el plazo de facturación de una gasolinera como obligación fiscal
    // es el error de nivel 6 que el README señala explícitamente.
    for (const j of [5, 6] as Jerarquia[]) expect(esVinculante(j)).toBe(false);
  });
});
