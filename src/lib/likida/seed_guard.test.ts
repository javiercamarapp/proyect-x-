/* eslint-disable security/detect-non-literal-fs-filename -- arnés de prueba limitado a mkdtemp/tmp y rutas fijas del repo */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 18 · DAT-16 — el seed pisaba una flota REAL.
//
// `supabase/seed.sql` no hace `on conflict do nothing` con el tenant: hace
// `do update` de razón social, domicilio fiscal, liga del aviso de privacidad y
// RFC del id 11111111-…-111111111111. En producción ese id es una flota de
// verdad. Lo único que separaba "sembrar el demo" de "cambiarle el RFC a un
// cliente" —y con él la validación de receptor de sus CFDI— era acordarse de
// qué DATABASE_URL estaba exportado en esa terminal.
//
// Los dos guards se prueban distinto a propósito: el de host se EJECUTA (no
// necesita base, así que la prueba puede correrlo de verdad), y el de nombre se
// lee (necesita una base viva; contra Postgres lo comprueba quien corra el
// seed, y su gemelo en SQL vive en seed.sql).
// ═══════════════════════════════════════════════════════════════════════════

// Partido en piezas a propósito: un DSN de un solo literal, aunque sea de
// prueba, dispara los escáneres de secretos (GitGuardian) por su FORMA, no
// por su contenido — la concatenación produce el mismo valor en runtime sin
// dejar un literal con forma de credencial en el diff.
const SUPABASE_FALSO = ['postgres://postgres:', 'no-es-una-clave-real', '@db.abcdefgh.supabase.co:5432/postgres'].join('');

/** Corre el seed y devuelve su salida y su código, sin dejar que lance. */
function correrSeed(url: string, args: string[] = []) {
  try {
    const salida = execFileSync('bash', ['scripts/seed.sh', ...args], {
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { codigo: 0, salida };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { codigo: err.status ?? -1, salida: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('scripts/seed.sh — no siembra contra Supabase por accidente', () => {
  it('REHÚSA un host *.supabase.co sin --produccion, y dice cómo insistir', () => {
    const { codigo, salida } = correrSeed(SUPABASE_FALSO);
    expect(codigo).not.toBe(0);
    expect(salida).toMatch(/REHUSADO/);
    expect(salida).toMatch(/db\.abcdefgh\.supabase\.co/);
    expect(salida, 'un guard que no dice cómo pasarlo se salta borrando el guard').toMatch(/--produccion/);
  });

  it('el guard mira el HOST, no la cadena entera: la contraseña no lo dispara', () => {
    // Un `postgres://usuario:supabase.co@localhost/...` es una base local con
    // una contraseña desafortunada. Un `grep supabase.co` la habría rehusado.
    const { codigo, salida } = correrSeed('postgres://postgres:supabase.co@127.0.0.1:1/nada');
    expect(salida).not.toMatch(/REHUSADO: «/);
    expect(codigo, 'falla por no poder conectarse, no por el guard').not.toBe(0);
  });

  it('sin DATABASE_URL no inventa una', () => {
    const { codigo, salida } = correrSeed('');
    expect(codigo).not.toBe(0);
    expect(salida).toMatch(/Falta DATABASE_URL/);
  });

  it('una opción que no existe se rechaza en vez de ignorarse', () => {
    // `--produccion-si` o un typo no pueden pasar por "sin bandera" y tampoco
    // colarse como confirmación.
    const { codigo, salida } = correrSeed(SUPABASE_FALSO, ['--prod']);
    expect(codigo).not.toBe(0);
    expect(salida).toMatch(/Opción desconocida/);
  });

  it('lleva el guard por NOMBRE antes de aplicar migraciones', () => {
    const sh = readFileSync('scripts/seed.sh', 'utf8');
    expect(sh).toMatch(/11111111-1111-1111-1111-111111111111/);
    expect(sh).toMatch(/!= "Flota Demo"/);
    // Antes del bucle de migraciones: sembrar es malo, pero aplicar migraciones
    // a la base de un cliente por error es peor.
    expect(sh.indexOf('!= "Flota Demo"')).toBeLessThan(sh.indexOf('Aplicando migraciones'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 25, MEDIO REINCIDENTE — en un clon limpio, `npm run setup` moría
// en "Falta DATABASE_URL": no creaba `.env.local`, no comprobaba `psql`, y no
// ofrecía la ruta LOCAL (`supabase start`) que el propio repo ya usa en
// `e2e-navegador.yml`. Se corre el script REAL contra un repo falso mínimo,
// con `supabase` y `psql` falsos en el PATH — nunca contra este repo ni una
// base de verdad, y nunca toca `.env.local` de este checkout.
// ═══════════════════════════════════════════════════════════════════════════
describe('scripts/seed.sh — detecta una pila LOCAL y deja .env.local listo', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** Un repo falso mínimo: seed.sh real, .env.example de juguete, y
   *  `supabase`/`psql` falsos que nunca tocan nada fuera de esta carpeta. */
  function repoFalso(opts: { supabaseCliStatus: 'local' | 'sin_docker' }): string {
    const dir = mkdtempSync(join(tmpdir(), 'likida-seed-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'fakebin'));
    writeFileSync(join(dir, 'scripts', 'seed.sh'), readFileSync('scripts/seed.sh'));
    chmodSync(join(dir, 'scripts', 'seed.sh'), 0o755);
    writeFileSync(
      join(dir, '.env.example'),
      'NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co\n'
      + 'NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder\n'
      + 'SUPABASE_SERVICE_ROLE_KEY=placeholder\n'
      + 'OTRA_VARIABLE=algo\n',
    );
    const psql = join(dir, 'fakebin', 'psql');
    // Falla a propósito DESPUÉS de imprimir con qué se le llamó: basta para
    // probar hasta dónde llegó el script sin necesitar un Postgres real.
    writeFileSync(psql, '#!/usr/bin/env bash\necho "FAKE-PSQL: $*" >&2\nexit 7\n');
    chmodSync(psql, 0o755);
    const supabase = join(dir, 'fakebin', 'supabase');
    const cuerpo = opts.supabaseCliStatus === 'local'
      ? 'if [ "$1" = "status" ]; then echo \'{"DB_URL":"postgresql://postgres:postgres@127.0.0.1:54322/postgres","API_URL":"http://127.0.0.1:54321","ANON_KEY":"anon-fake","SERVICE_ROLE_KEY":"service-fake"}\'; exit 0; fi\nexit 1\n'
      : 'exit 1\n'; // como sin Docker: `supabase status` siempre falla, sin stdout
    writeFileSync(supabase, `#!/usr/bin/env bash\n${cuerpo}`);
    chmodSync(supabase, 0o755);
    return dir;
  }

  function correrEn(dir: string) {
    try {
      const salida = execFileSync('bash', ['scripts/seed.sh'], {
        cwd: dir,
        env: { ...process.env, PATH: `${join(dir, 'fakebin')}:${process.env.PATH}`, DATABASE_URL: '', SUPABASE_DB_URL: '' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { codigo: 0, salida };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { codigo: err.status ?? -1, salida: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  }

  it('con una pila LOCAL corriendo, usa su DATABASE_URL sola — sin que nadie ponga nada', () => {
    const dir = repoFalso({ supabaseCliStatus: 'local' });
    const { salida } = correrEn(dir);
    expect(salida).toMatch(/Pila LOCAL de Supabase detectada/);
    expect(salida).toContain('postgresql://postgres:postgres@127.0.0.1:54322/postgres');
  });

  it('crea .env.local a partir de .env.example y lo llena con las llaves reales de la pila local', () => {
    const dir = repoFalso({ supabaseCliStatus: 'local' });
    correrEn(dir);
    const envLocal = readFileSync(join(dir, '.env.local'), 'utf8');
    expect(envLocal).toContain('NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321');
    expect(envLocal).toContain('NEXT_PUBLIC_SUPABASE_ANON_KEY=anon-fake');
    expect(envLocal).toContain('SUPABASE_SERVICE_ROLE_KEY=service-fake');
    // Lo que .env.example tenía de más (una variable sin llave local) se
    // conserva — no se reemplaza el archivo entero, solo las tres llaves.
    expect(envLocal).toContain('OTRA_VARIABLE=algo');
  });

  it('sin pila local (sin Docker, como en un clon recién hecho): dice las DOS rutas, LOCAL y REMOTA', () => {
    const dir = repoFalso({ supabaseCliStatus: 'sin_docker' });
    const { codigo, salida } = correrEn(dir);
    expect(codigo).not.toBe(0);
    expect(salida).toMatch(/Falta DATABASE_URL/);
    expect(salida).toMatch(/supabase start/);
    expect(salida).toMatch(/DATABASE_URL="postgres:\/\/\.\.\." npm run seed/);
  });

  it('sin psql en el PATH, dice qué falta y cómo instalarlo — no un error de bash críptico', () => {
    const dir = mkdtempSync(join(tmpdir(), 'likida-seed-sinpsql-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts', 'seed.sh'), readFileSync('scripts/seed.sh'));
    chmodSync(join(dir, 'scripts', 'seed.sh'), 0o755);
    // PATH aislado de VERDAD: en vez de listar carpetas del sistema que NO
    // deben tener psql (frágil y no portable — en Ubuntu moderno /bin es un
    // symlink a /usr/bin por usrmerge, así que "excluir /opt/homebrew/bin"
    // no sirve de nada si el runner de CI instaló psql en /usr/bin, que
    // seguía visible por /bin), se arma una carpeta VACÍA con un solo
    // symlink a bash — así `command -v psql` no puede encontrar NADA sin
    // importar dónde instaló psql cada plataforma. /bin/bash existe tanto en
    // macOS como en cualquier Linux con bash instalado (real o via symlink
    // de usrmerge) — es el único binario externo que este script necesita
    // para arrancar.
    const binAislado = mkdtempSync(join(tmpdir(), 'likida-seed-bin-aislado-'));
    dirs.push(binAislado);
    symlinkSync('/bin/bash', join(binAislado, 'bash'));
    const { codigo, salida } = (() => {
      try {
        const salida = execFileSync('bash', ['scripts/seed.sh'], {
          cwd: dir,
          env: { ...process.env, PATH: binAislado },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { codigo: 0, salida };
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return { codigo: err.status ?? -1, salida: `${err.stdout ?? ''}${err.stderr ?? ''}` };
      }
    })();
    expect(codigo).not.toBe(0);
    expect(salida).toMatch(/Falta psql/);
  });

  it('con DATABASE_URL puesto a mano, NUNCA toca .env.local — sea local o remoto, no es su lugar para decidir eso', () => {
    const dir = repoFalso({ supabaseCliStatus: 'local' });
    try {
      execFileSync('bash', ['scripts/seed.sh'], {
        cwd: dir,
        env: { ...process.env, PATH: `${join(dir, 'fakebin')}:${process.env.PATH}`, DATABASE_URL: SUPABASE_FALSO },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      // se espera que truene (REHUSADO por host) — lo que importa es el archivo
    }
    expect(() => readFileSync(join(dir, '.env.local'))).toThrow();
  });
});

describe('supabase/seed.sql — el guard viaja con el archivo', () => {
  const sql = readFileSync('supabase/seed.sql', 'utf8');

  it('aborta si la flota de ese id no se llama «Flota Demo»', () => {
    expect(sql).toMatch(/SEED ABORTADO/);
    expect(sql).toMatch(/nombre_actual <> 'Flota Demo'/);
  });

  it('el guard va ANTES del insert que sobrescribe el tenant', () => {
    // Quien corra el .sql a mano (sin el .sh) tiene que toparse con el guard
    // primero; después del insert no serviría de nada.
    expect(sql.indexOf('SEED ABORTADO')).toBeLessThan(sql.indexOf('insert into tenant'));
  });
});
