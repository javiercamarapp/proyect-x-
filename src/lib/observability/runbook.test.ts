import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SILENCIOSAS } from './arranque';

// ═══════════════════════════════════════════════════════════════════════════
// Auditoría 5 · `.env.example` y `DEPLOY.md` como parte del sistema, no como
// prosa suelta.
//
// Dos hallazgos con la misma forma: el código lee una variable, el documento al
// que manda el runbook no la menciona, y si falta **el sistema arranca igual,
// mal y en silencio**. Los casos medidos fueron `SENTRY_DSN` (nadie recibe los
// errores) y `DEMO_TENANT_ID` (el panel consulta otro tenant y pinta cero
// liquidaciones, que en un demo se lee como "el producto no guardó nada").
//
// Un documento no se puede "probar", pero sí se puede probar que no se ha
// quedado atrás del código, que es exactamente cómo se rompieron los dos.
// ═══════════════════════════════════════════════════════════════════════════

const RAIZ = process.cwd();

// Las pone la plataforma o el arnés de pruebas: no van en `.env.example`.
const DE_LA_PLATAFORMA = new Set([
  'NODE_ENV', 'VERCEL_ENV', 'NEXT_RUNTIME',
  // Inyectada por Vercel al ejecutar la función; identifica al worker y tiene
  // fallback local. No es un secreto ni configuración manual del operador.
  // https://vercel.com/docs/environment-variables/system-environment-variables#vercel_region
  'VERCEL_REGION',
  // El sha del deploy, inyectado por Vercel en build (lo leen /api/health y el
  // agente `releases`, 0234).
  'VERCEL_GIT_COMMIT_SHA',
  // La rama del deploy, del mismo lote que el sha y con la misma razón: la
  // inyecta Vercel en build y nadie la pone a mano. La lee el agente
  // `releases` (0234) para el parte de qué está corriendo; cuando NO llega, el
  // parte escribe «NO CONSTA» en vez de rellenarla con «master».
  'VERCEL_GIT_COMMIT_REF',
  'TICKET_PATH', 'TICKET_HOY', 'TICKET_ANTICIPO',
]);

function archivosFuente(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) archivosFuente(p, acc);
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) acc.push(p);
  }
  return acc;
}

/** Variables que el código lee de verdad, medidas sobre el árbol de fuentes. */
function leidasPorElCodigo(): Set<string> {
  const out = new Set<string>();
  for (const f of archivosFuente(join(RAIZ, 'src'))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      if (!DE_LA_PLATAFORMA.has(m[1])) out.add(m[1]);
    }
  }
  return out;
}

/** Variables declaradas (no comentadas) en `.env.example`. */
function declaradasEnEjemplo(): string[] {
  return readFileSync(join(RAIZ, '.env.example'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('=')[0].trim())
    .filter(Boolean);
}

describe('.env.example no se queda atrás del código', () => {
  it('documenta TODAS las variables que el código lee', () => {
    const declaradas = new Set(declaradasEnEjemplo());
    const faltantes = [...leidasPorElCodigo()].filter((v) => !declaradas.has(v)).sort();
    expect(faltantes).toEqual([]);
  });

  it('no documenta variables que ya no lee nadie', () => {
    // `FACTURAPI_KEY` sobrevivió a que se quitara esa dependencia (ronda 16 el
    // UPSTASH_QSTASH_TOKEN VOLVIÓ vivo: el cron se encola cuando hay token).
    // Documentación muerta que ensucia el inventario: al desplegar hay que
    // decidir una por una si hace falta.
    const leidas = leidasPorElCodigo();
    const sobrantes = declaradasEnEjemplo().filter((v) => !leidas.has(v)).sort();
    expect(sobrantes).toEqual([]);
  });

  it('no declara la misma variable dos veces', () => {
    // `SENTRY_DSN` aparecía dos veces con dos comentarios distintos: al pegarlas
    // en Vercel una pisa a la otra y no hay forma de saber cuál manda.
    const todas = declaradasEnEjemplo();
    const repetidas = todas.filter((v, i) => todas.indexOf(v) !== i);
    expect(repetidas).toEqual([]);
  });

  it('no promete palancas que el código no tiene', () => {
    // El "Plan B demo en vivo" (ANTHROPIC_API_KEY / GOOGLE_API_KEY) no lo lee
    // nadie: `openrouter.ts` solo mira OPENROUTER_API_KEY. Descubrirlo durante
    // el demo cuesta el tiempo de ponerla y redesplegar antes de entender que no
    // había ruta. Peligroso porque las palancas LIKIDA_MODEL_* del mismo bloque
    // comentado SÍ funcionan, y desde el archivo no se distingue cuál es cuál.
    const texto = readFileSync(join(RAIZ, '.env.example'), 'utf8');
    const leidas = leidasPorElCodigo();
    for (const v of ['ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'FACTURAPI_KEY']) {
      if (!leidas.has(v)) expect(texto).not.toContain(v);
    }
    // `UPSTASH_QSTASH_TOKEN` SÍ lo lee el cron (ronda 16) — el `QSTASH_TOKEN`
    // a secas (sin el prefijo) es el que no existe y no debe prometerse.
    if (!leidas.has('QSTASH_TOKEN')) expect(texto).not.toMatch(/\bQSTASH_TOKEN\b/);
  });
});

describe('npm install no depende de un host fuera del registry (M16)', () => {
  // `xlsx` apuntaba a cdn.sheetjs.com (403 en la corrida de la auditoría 18):
  // un tercero ajeno al registry tenía voto sobre si Likida podía desplegar un
  // hotfix. Va vendorizado en vendor/ y el lockfile lo resuelve por `file:`.
  it('ninguna dependencia se resuelve por http(s) en package.json ni en el lockfile', () => {
    const pkg = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const porUrl = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(([, v]) => /^(https?|git)/.test(v));
    expect(porUrl).toEqual([]);
    const lock = JSON.parse(readFileSync(join(RAIZ, 'package-lock.json'), 'utf8')) as { packages: Record<string, { resolved?: string }> };
    const fuera = Object.entries(lock.packages)
      .filter(([, p]) => p.resolved && /^https?:/.test(p.resolved) && !p.resolved.startsWith('https://registry.npmjs.org/'))
      .map(([k, p]) => `${k} → ${p.resolved}`);
    expect(fuera).toEqual([]);
  });

  it('el tarball vendorizado existe y es el que el lockfile fija', () => {
    const lock = JSON.parse(readFileSync(join(RAIZ, 'package-lock.json'), 'utf8')) as { packages: Record<string, { resolved?: string }> };
    const ruta = lock.packages['node_modules/xlsx']?.resolved ?? '';
    expect(ruta).toMatch(/^file:vendor\//);
    expect(statSync(join(RAIZ, ruta.replace(/^file:/, ''))).size).toBeGreaterThan(1_000_000);
  });
});

describe('DEPLOY.md pide lo que hace falta para que el sistema no arranque ciego', () => {
  const deploy = () => readFileSync(join(RAIZ, 'docs/conocimiento/DEPLOY.md'), 'utf8');

  it('nombra TODAS las variables cuya ausencia es silenciosa — las de la lista viva, no un literal', () => {
    // AUDITORÍA 18, A18: esto iteraba sobre `['SENTRY_DSN','DEMO_TENANT_ID']`, y
    // las dos que entraron después a `SILENCIOSAS` (`NEXT_PUBLIC_APP_URL`,
    // `ALERTA_EMAIL`) llegaron al código sin que el runbook las conociera: el
    // único canal push del sistema quedó construido, probado y desconectado, y
    // el documento de las 3 a.m. decía que no existía ningún canal.
    const texto = deploy();
    expect(SILENCIOSAS.length).toBeGreaterThanOrEqual(4);
    for (const v of ['SENTRY_DSN', ...SILENCIOSAS.map((s) => s.nombre)]) {
      expect(texto, `DEPLOY.md no menciona ${v}`).toContain(v);
    }
  });

  it('manda buscar los `msg` de arranque que el código de verdad emite', () => {
    // Mandaba buscar `startup.entorno`, que no existe: un grep a las 3 a.m.
    // contra el nombre del runbook devolvía cero sobre un sistema que sí
    // estaba gritando. Se verifica contra el fuente, no contra la memoria.
    const fuente = readFileSync(join(RAIZ, 'src/lib/observability/arranque.ts'), 'utf8');
    const texto = deploy();
    for (const msg of ['startup.config_silenciosa', 'startup.entorno_grupos']) {
      expect(fuente, `arranque.ts ya no emite ${msg}`).toContain(`'${msg}'`);
      expect(texto, `DEPLOY.md no menciona ${msg}`).toContain(msg);
    }
    expect(texto).not.toMatch(/startup\.entorno[^_]/);
  });

  it('sabe que existe /api/health y el monitor que lo consume (M18)', () => {
    // La ruta nació declarando «un monitor pegándole a esto cada minuto
    // convierte ese modo de falla en una alerta de minutos» y dos rondas
    // después nadie la consumía ni el runbook la nombraba.
    expect(deploy()).toContain('/api/health');
    // Leer directamente comprueba existencia y contenido, sin stat separado.
    expect(readFileSync(join(RAIZ, '.github/workflows/salud-produccion.yml'), 'utf8')).toContain('/api/health');
  });

  it('dice dónde se miran los logs cuando algo falla', () => {
    // Es el documento al que se acude a las 3 a.m. y no contenía nada de lo que
    // a esa hora se necesita.
    expect(deploy()).toMatch(/vercel logs|runtime log/i);
  });

  // AUDITORÍA 25, MEDIO REINCIDENTE — la PRIMERA pantalla del runbook
  // anunciaba «backup programado de Storage», y 84 líneas después el propio
  // documento decía en negritas «Este proyecto no tiene respaldo automático
  // ni PITR». Las dos son ciertas a su manera (hay un script que SÍ respalda
  // Storage, bajo demanda) pero la primera, la que se lee primero, no lo decía.
  it('la primera pantalla no promete un backup "programado" sin la salvedad de que está apagado', () => {
    const primeraPantalla = deploy().slice(0, 600);
    expect(primeraPantalla).toMatch(/backup/i);
    // Si menciona backup de Storage arriba, tiene que traer la salvedad EN LA
    // MISMA pantalla — no 84 líneas después, donde nadie la lee primero.
    expect(primeraPantalla).toMatch(/apagad[oa]|bajo demanda|no hay backup programado/i);
  });

  it('sigue siendo verdad, y consistente con RESILIENCIA-DEPLOY.md: el schedule diario está apagado a propósito', () => {
    const resiliencia = readFileSync(join(RAIZ, 'docs/operacion/RESILIENCIA-DEPLOY.md'), 'utf8');
    expect(resiliencia).toMatch(/schedule.*apagad[oa] a propósito/is);
    const wf = readFileSync(join(RAIZ, '.github/workflows/backup-storage.yml'), 'utf8');
    expect(wf).not.toMatch(/^\s*schedule:/m);
  });
});
