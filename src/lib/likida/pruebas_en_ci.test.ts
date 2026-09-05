import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fuentesDeProduccion, sinComentarios } from '@/lib/pruebas/codigo';
import { readdirSync } from 'node:fs';

// ═══════════════════════════════════════════════════════════════════════════
// RONDA 7 · DOS PRUEBAS EXISTÍAN Y CI NO LAS CORRÍA NI UNA VEZ.
//
// `vitest.config.ts` exporta `LIKIDA_COBERTURA=1` cuando hay `--coverage`, y dos
// pruebas de tiempo se saltan con esa bandera. La razón es buena: la
// instrumentación de v8 cobra por llamada, así que un umbral de milisegundos
// mediría la instrumentación y no el algoritmo.
//
// Lo que nadie ató: el workflow de CI corría SOLO `npm run test:coverage`. O sea
// que la guardia de ReDoS del buscador de fundamentos y la de crecimiento no
// lineal del deduplicador de CFDI —las dos que protegen contra que una entrada
// del operador cuelgue la función— vivían únicamente en la máquina de Javier.
//
// Una prueba que no corre en CI no es una prueba, es documentación con sintaxis
// de prueba. Y esta clase de hueco es invisible por construcción: la suite sale
// verde, el contador de pruebas se ve alto, y el número que baja —las saltadas—
// no lo mira nadie.
// ═══════════════════════════════════════════════════════════════════════════

const CI = readFileSync('.github/workflows/ci.yml', 'utf8');

/**
 * Archivos de prueba que SE SALTAN bajo `--coverage`.
 *
 * Se busca el SALTO, no la mención de la bandera, y sobre el código sin
 * comentarios: este mismo archivo nombra la bandera media docena de veces —en la
 * explicación y en el detector— sin saltarse nada. Buscar la mención lo detectaba
 * a sí mismo; buscar el salto en el archivo entero también, porque el comentario
 * de aquí arriba TIENE que poder escribir cómo se ve un salto para explicarlo.
 * Es la cuarta vez hoy que una red estructural se enreda con su propia prosa.
 */
const saltadas = (() => {
  const salida: string[] = [];
  const recorrer = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const ruta = `${dir}/${e.name}`;
      if (e.isDirectory()) recorrer(ruta);
      else if (e.name.endsWith('.test.ts') && /skipIf\([^)]*LIKIDA_COBERTURA/.test(sinComentarios(readFileSync(ruta, 'utf8')))) salida.push(ruta);
    }
  };
  recorrer('src');
  return salida;
})();

describe('lo que se salta bajo cobertura sí corre en CI', () => {
  it('hay pruebas que se saltan (si no, esta red sobra y hay que borrarla)', () => {
    // Sin esto, el día que desaparezca el último `skipIf` la prueba de abajo
    // pasaría por vacía y nadie se enteraría de que ya no vigila nada.
    expect(saltadas.length).toBeGreaterThan(0);
  });

  it('cada una está cubierta por el paso sin instrumentar', () => {
    // El comando del workflow: `npx vitest run fundamento duplicados`. Los
    // argumentos son filtros por ruta, así que basta con que uno aparezca en la
    // ruta del archivo.
    const paso = CI.match(/npx vitest run ([^\n]+)/)?.[1] ?? '';
    const filtros = paso.trim().split(/\s+/).filter(Boolean);
    expect(filtros.length, 'no se encontró el paso `npx vitest run …` en ci.yml').toBeGreaterThan(0);

    const huerfanas = saltadas.filter((f) => !filtros.some((filtro) => f.includes(filtro)));
    expect(
      huerfanas,
      `estas pruebas se saltan bajo --coverage y CI no las corre por ningún otro lado:\n  ${huerfanas.join('\n  ')}\n\n` +
      'Añade su filtro al paso "Pruebas de tiempo (sin cobertura)" de .github/workflows/ci.yml, ' +
      'o quítales el skipIf. Una prueba que no corre en CI es documentación con sintaxis de prueba.',
    ).toEqual([]);
  });

  it('vitest.config.ts exporta LA MISMA bandera que los skipIf leen', () => {
    // El modo de falla que esta red no veía (auditoría 3, PR-A2): el rename de
    // marca del 12-ago (b79f8e5) renombró los skipIf a LIKIDA_COBERTURA y dejó
    // el config exportando el nombre viejo. Nadie seteaba lo que los tests
    // leían: el skip murió en silencio y los umbrales de tiempo corrieron
    // INSTRUMENTADOS en el paso de cobertura — la medición que sus propios
    // comentarios declaran inválida. El detector de arriba y los skipIf
    // compartían el nombre nuevo, así que la red era internamente consistente
    // y externamente ciega. Config y lectores tienen que nombrar la misma
    // bandera, y ese nombre se verifica aquí, sobre el archivo real.
    //
    // Crudo y NO con sinComentarios: los globs del config ('**/dist/**')
    // abren un falso `/*` y el limpiador se come media configuración — la
    // misma trampa que descartó el primer grep de la auditoría 3. El ancla
    // `^\s*env:` ya deja fuera a cualquier cita dentro de un comentario.
    const config = readFileSync('vitest.config.ts', 'utf8');
    expect(config).toMatch(/^\s*env:\s*\{\s*LIKIDA_COBERTURA:/m);
  });

  it('y CI sigue corriendo la suite con umbral', () => {
    // El paso nuevo NO sustituye al de cobertura: si alguien lo cambiara por un
    // `npm test` a secas, el umbral —que es la puerta— dejaría de evaluarse.
    expect(CI).toMatch(/npm run test:coverage/);
  });

  it('el typecheck declara un techo de heap que le alcanza en frío', () => {
    // ═════════════════════════════════════════════════════════════════════
    // AUDITORÍA 24 · OP-1 — LA COMPUERTA NO PODÍA CORRER.
    //
    // El PR #303 afirmaba «`tsc --noEmit`: limpio» y era cierto EN LA MÁQUINA
    // DONDE SE ESCRIBIÓ. En CI el paso Typecheck moría con
    // `FATAL ERROR: Ineffective mark-compacts near heap limit — JavaScript
    // heap out of memory`, exit 134, en las dos corridas.
    //
    // Lo que hacía invisible el modo de falla: `tsconfig.json` tiene
    // `incremental: true`, y `tsconfig.tsbuildinfo` está en `.gitignore:10`.
    // O sea que en local el typecheck corre CALIENTE (con el .tsbuildinfo de
    // la corrida anterior) y en CI corre siempre en FRÍO, sobre un clon
    // nuevo. Medido el 2-sep-2026 sobre este árbol:
    //
    //   caliente @ 2048 MiB → exit 0     ← lo que ve quien lo corre en local
    //   FRÍO     @ 2048 MiB → exit 134   ← lo que ve CI, siempre
    //   FRÍO, pico real de RSS: 2,672 MiB
    //
    // Por eso la verificación local no podía atraparlo nunca: el caso que
    // revienta es justo el que en local no se da. El techo se declara en el
    // script de npm y no en el workflow a propósito — así lo heredan los DOS
    // workflows que corren `npm run typecheck` (ci.yml y
    // deploy-preview-promote.yml) y cualquiera que se agregue después.
    //
    // El número no es un adorno: 4096 es el piso con margen sobre los 2,672
    // medidos. Si esta prueba se pone roja porque alguien lo bajó, vuelve a
    // medir el pico en frío antes de tocarla — `rm tsconfig.tsbuildinfo` y
    // vigila VmHWM. No la relajes.
    // ═════════════════════════════════════════════════════════════════════
    const paquete = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    const techo = Number(paquete.scripts.typecheck?.match(/--max-old-space-size=(\d+)/)?.[1] ?? 0);

    expect(
      techo,
      'package.json → scripts.typecheck no declara --max-old-space-size. ' +
      'En frío el typecheck pica en 2,672 MiB y el runner de GitHub muere en ~2 GB con exit 134.',
    ).toBeGreaterThanOrEqual(4096);

    // Y que los dos workflows sigan entrando por el script, que es donde vive
    // el techo. Un `npx tsc --noEmit` suelto se lo saltaría entero.
    //
    // Las dos rutas se leen literales y no por un bucle sobre un arreglo: el
    // `readFileSync` con argumento variable dispara
    // `security/detect-non-literal-fs-filename` y el trinquete de lint —que
    // es lo que cazó esto antes del primer commit— rechaza el warning nuevo.
    const promote = readFileSync('.github/workflows/deploy-preview-promote.yml', 'utf8');
    for (const [nombre, texto] of [['ci.yml', CI], ['deploy-preview-promote.yml', promote]] as const) {
      expect(texto, `${nombre} dejó de invocar el typecheck por su script de npm`).toMatch(/npm run typecheck/);
      expect(texto, `${nombre} invoca tsc directo y se salta el techo de heap del script`).not.toMatch(/npx tsc --noEmit/);
    }
  });

  it('el ayudante de pruebas no se cuela al producto', () => {
    // `src/lib/pruebas/` existe solo para las redes estructurales. Si algo del
    // producto lo importara, `node:fs` entraría a un bundle del servidor.
    const importadores = fuentesDeProduccion('src')
      .filter((f) => !f.includes('/lib/pruebas/'))
      .filter((f) => /@\/lib\/pruebas\//.test(readFileSync(f, 'utf8')));
    expect(importadores, 'código de producción importando el ayudante de pruebas').toEqual([]);
  });
});

describe('retención 0332/0335: rollout concurrente y fail-closed', () => {
  const postgres = readFileSync('.github/workflows/ci-postgres.yml', 'utf8');
  const deploy = readFileSync('.github/workflows/deploy-preview-promote.yml', 'utf8');
  const manual = readFileSync('scripts/aplicar-migraciones-y-humos.sh', 'utf8');
  const migracion0332 = readFileSync('supabase/migrations/0332_db_retencion_producto.sql', 'utf8');
  const preflight = readFileSync('scripts/ci/0335_preflight_retencion_indices.sql', 'utf8');

  it('las dos pruebas shell usan el rol postgres explícito en el job existente', () => {
    expect(postgres).toContain('PGUSER=postgres bash supabase/tests/0332_db_retencion_concurrencia.sh');
    expect(postgres).toContain('PGUSER=postgres bash supabase/tests/0335_db_retencion_r3_concurrencia.sh');
  });

  it('staging y producción validan URL explícita o pooler enlazado antes de db push', () => {
    expect(deploy).toContain('secrets.SUPABASE_DB_URL_STAGING');
    expect(deploy).toContain('secrets.SUPABASE_DB_URL_PRODUCTION');
    const staging = deploy.slice(deploy.indexOf('\n  supabase-dry-run:'), deploy.indexOf('\n  preview:'));
    const produccion = deploy.slice(deploy.indexOf('\n  production_migrations:'), deploy.indexOf('\n  production_candidate:'));
    for (const [nombre, job] of [['staging', staging], ['production_migrations', produccion]] as const) {
      const preflightEnJob = job.indexOf('supabase-preflight.mjs preflight');
      expect(job.indexOf(' link --project-ref')).toBeLessThan(preflightEnJob);
      const primerPushEnJob = job.indexOf(' db push');
      expect(preflightEnJob, `${nombre}: falta el preflight`).toBeGreaterThan(-1);
      expect(primerPushEnJob, `${nombre}: falta db push`).toBeGreaterThan(-1);
      expect(preflightEnJob, `${nombre}: el preflight debe ocurrir antes del primer db push`).toBeLessThan(primerPushEnJob);
    }
  });

  it('el script manual también exige URL y hace preflight antes de migrar', () => {
    expect(manual).toContain('if [ -z "${SUPABASE_DB_URL:-}" ]');
    expect(manual.indexOf('0335_preflight_retencion_indices.sql')).toBeLessThan(manual.indexOf(' db push'));
  });

  it('0332 no crea índices bloqueantes y la comprobación exige forma exacta', () => {
    const lineasSql = sinComentarios(migracion0332).split('\n').map((linea) => linea.trim().toLowerCase());
    expect(lineasSql.some((linea) => linea.startsWith('create index ') || linea.startsWith('create unique index '))).toBe(false);
    for (const fuente of [migracion0332, preflight]) {
      expect(fuente).toContain('i.indnkeyatts=2');
      expect(fuente).toContain('i.indpred is null');
      expect(fuente).toContain("i.indoption='0 0'::int2vector");
      expect(fuente).toContain("array['updated_at','id']");
      expect(fuente).toContain("array['creado_en','id']");
    }
    expect(preflight.toLowerCase()).toContain('create index concurrently');
  });
});
