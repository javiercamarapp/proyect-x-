#!/usr/bin/env node
// Vercel pull conserva Sensitive como [SENSITIVE]. Las credenciales de build
// provienen del proyecto Supabase autorizado; no se cambia su tipo en Vercel.
import { readFileSync, writeFileSync, writeSync, openSync, closeSync, fstatSync, fchmodSync, ftruncateSync, constants as fsConstants } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import { PROJECT, TEAM, STAGING_REF, PRODUCTION_REF, validateSupabaseEnv } from './production-candidate.mjs';

const KEYS = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
const ADMIN_KEYS = ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'SUPABASE_DB_URL'];
const serialize = values => KEYS.map(key => `${key}=${JSON.stringify(values[key])}`).join('\n');
const hidden = value => value === '[SENSITIVE]';

export function sanitizeBuildLog(text, knownValues) {
  let safe = String(text ?? '');
  const secrets = [...new Set(knownValues.filter(value => typeof value === 'string' && value.length > 0)
    .flatMap(value => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]))].sort((a, b) => b.length - a.length);
  for (const secret of secrets) safe = safe.replaceAll(secret, '[REDACTED]');
  safe = safe.replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]')
    .replace(/\b(?:vcp_|sk[-_]|sb_secret_)[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_TOKEN]');
  // Cortar después de redacción evita mostrar fragmentos de secretos conocidos.
  return safe.slice(-65_536);
}

export async function prepareBuild(target, env = process.env, deps = {}) {
  let stage = 'INPUT';
  try {
    if (!['preview', 'production'].includes(target) || env.CI !== 'true' || !env.SUPABASE_ACCESS_TOKEN) throw new Error('INPUT');
    const ref = target === 'preview' ? STAGING_REF : PRODUCTION_REF;
    const cwd = deps.cwd ?? process.cwd();
    const file = resolve(cwd, `.vercel/.env.${target}.local`);
    stage = 'PROJECT';
    const project = JSON.parse(readFileSync(resolve(cwd, '.vercel/project.json'), 'utf8')); // eslint-disable-line security/detect-non-literal-fs-filename -- ruta fija del checkout CI.
    if (project.projectId !== PROJECT || project.orgId !== TEAM) throw new Error('PROJECT');
    stage = 'PULLED_ENV';
    // AUDITORÍA CodeQL (244-246): abrir UNA vez con O_NOFOLLOW y operar por
    // descriptor (fstat/write posicional) en vez de por ruta cierra la
    // ventana TOCTOU entre validar el archivo y leerlo/escribirlo/restaurarlo
    // — O_NOFOLLOW hace que un symlink falle en el propio open() (ELOOP), no
    // en un lstat separado que ya no describe el archivo real al leer.
    let fd;
    try { fd = openSync(file, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW); } catch { throw new Error('FILE'); }
    try {
      if (!fstatSync(fd).isFile()) throw new Error('FILE');
      const original = readFileSync(fd, 'utf8');
      const pulled = parseEnv(original);
      if (ADMIN_KEYS.some(key => pulled[key] !== undefined)) throw new Error('ADMIN_IN_PULLED_ENV');
      for (const key of KEYS) {
        const assignments = original.split('\n').filter(line => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line));
        if (assignments.length !== 1 || !pulled[key]) throw new Error('MISSING_OR_DUPLICATE');
      }
      stage = 'SUPABASE_HTTP';
      const response = await (deps.fetch ?? fetch)(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`, {
        method: 'GET', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` },
        redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error('HTTP');
      stage = 'SUPABASE_KEYS';
      const keys = await response.json();
      const values = { NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co` };
      for (const [key, role] of [[KEYS[1], 'anon'], [KEYS[2], 'service_role']]) {
        const matches = Array.isArray(keys) ? keys.filter(item => item?.name === role && !item.disabled) : [];
        if (matches.length !== 1 || typeof matches[0].api_key !== 'string' || !matches[0].api_key) throw new Error('KEYS');
        values[key] = matches[0].api_key;
      }
      validateSupabaseEnv(serialize(values), ref);
      stage = 'ENV_CONFLICT';
      // Una máscara puede hidratarse; un valor real contrario no se tapa.
      for (const key of KEYS) {
        if (!hidden(pulled[key]) && pulled[key] !== values[key]) throw new Error('PULLED_CONFLICT');
        if (env[key] !== undefined && env[key] !== values[key]) throw new Error('PROCESS_CONFLICT');
      }
      const childEnv = { ...env, ...values };
      for (const key of ADMIN_KEYS) delete childEnv[key];
      // Precedencia explícita del hijo: dotenv/Next no pueden introducir claves
      // de .env.local de otro destino. No se borra ningún archivo del usuario.
      const remaining = original.split('\n').filter(line => !KEYS.some(key => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line))).join('\n');
      const hydrated = `${remaining}\n${serialize(values)}\n`;
      validateSupabaseEnv(hydrated, ref);
      // Escribe por posición (0) sin depender del cursor del fd: sea cual sea
      // la posición tras el read anterior, esto siempre sobreescribe desde el
      // inicio, y el truncate previo evita dejar cola del contenido viejo.
      const escribir = (contenido) => {
        const buf = Buffer.from(contenido, 'utf8');
        ftruncateSync(fd, 0);
        writeSync(fd, buf, 0, buf.length, 0);
      };
      stage = 'WRITE';
      try {
        fchmodSync(fd, 0o600);
        escribir(hydrated);
        stage = 'BUILD';
        const args = ['--yes', 'vercel@59.1.4', 'build', ...(target === 'production' ? ['--prod'] : [])];
        const result = (deps.spawn ?? spawnSync)('npx', args, {
          cwd, env: childEnv, encoding: 'utf8', stdio: 'pipe', timeout: 1_200_000, maxBuffer: 64 * 1024 * 1024,
        });
        const safeLog = sanitizeBuildLog(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, [
          ...Object.values(env), ...Object.values(values), ...Object.values(pulled),
        ]);
        writeFileSync(resolve(cwd, `.vercel/build-${target}.sanitized.log`), safeLog, { mode: 0o600 }); // eslint-disable-line security/detect-non-literal-fs-filename -- target allowlisted y contenido redactado/acotado.
        if (result.error || result.status !== 0) {
          stage = result.error?.code === 'ETIMEDOUT' ? 'BUILD_TIMEOUT'
            : Number.isInteger(result.status) && result.status > 0 && result.status < 256 ? `BUILD_EXIT_${result.status}` : 'BUILD_SPAWN';
          throw new Error('BUILD_FAILED');
        }
      } finally {
        const previousStage = stage;
        stage = 'RESTORE';
        escribir(original);
        stage = previousStage;
      }
      return { target, supabase_ref: ref, variables: 3, build: 'passed' };
    } finally {
      closeSync(fd);
    }
  } catch {
    // Sólo enums internos; nunca error/URL/cuerpo de proveedores ni child stdout.
    throw new Error(`BUILD_ENV_${stage}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareBuild(process.argv[2]).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
