#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function validateDatabase(raw, ref) {
  if (!/^[a-z]{20}$/.test(ref ?? '')) throw new Error('Project ref inválido');
  let url;
  try { url = new URL(raw.trim()); } catch { throw new Error('URL PostgreSQL inválida'); }
  const direct = url.hostname === `db.${ref}.supabase.co`;
  const pooler = /^aws-[0-9]+-[a-z]+-[a-z]+-[0-9]+\.pooler\.supabase\.com$/.test(url.hostname);
  const user = decodeURIComponent(url.username);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || (!direct && !pooler) || (url.port && url.port !== '5432')
    || url.pathname !== '/postgres' || url.hash
    || user !== (direct ? 'postgres' : `postgres.${ref}`)
    || [...url.searchParams].some(([key, value]) => key !== 'sslmode' || !['require', 'verify-full'].includes(value))) {
    throw new Error('Destino PostgreSQL no corresponde al proyecto/session pooler permitido');
  }
  // No se devuelve una URL con contraseña ni se permite que parámetros libpq
  // reemplacen host, rol o base. PGPASSWORD va sólo al entorno del hijo psql.
  url.password = '';
  url.port = '5432';
  url.search = '?sslmode=verify-full&sslrootcert=system';
  return url.toString();
}

export function freshBackup(payload, now = Date.now()) {
  const candidates = (Array.isArray(payload?.backups) ? payload.backups : [])
    .filter((entry) => entry.status === 'COMPLETED')
    .map((entry) => ({ id: entry.id, at: Date.parse(entry.inserted_at) }))
    .filter((entry) => Number.isFinite(entry.at) && entry.at <= now && now - entry.at <= 86_400_000)
    .sort((a, b) => b.at - a.at);
  if (!candidates.length) throw new Error('No hay backup SQL COMPLETED de las últimas 24 horas');
  return { id: candidates[0].id, inserted_at: new Date(candidates[0].at).toISOString(), age_hours: (now - candidates[0].at) / 3_600_000 };
}

export async function run(mode, env = process.env, deps = {}) {
  const ref = env.SUPABASE_PROJECT_REF;
  if (!/^[a-z]{20}$/.test(ref ?? '')) throw new Error('Project ref inválido');
  if (mode === 'backup') {
    if (!env.SUPABASE_ACCESS_TOKEN) throw new Error('Falta token Supabase');
    const response = await (deps.fetch ?? fetch)(`https://api.supabase.com/v1/projects/${ref}/database/backups`, {
      method: 'GET', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` },
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Consulta backup rechazada (HTTP ${response.status})`);
    const backup = freshBackup(await response.json());
    console.log(JSON.stringify({ backup_sql: backup, restore_verificado: false, incluye_storage: false }));
    return;
  }
  if (mode !== 'preflight') throw new Error('Modo inválido');
  if (!env.SUPABASE_DB_PASSWORD) throw new Error('Falta contraseña PostgreSQL');
  const read = deps.read ?? readFileSync;
  if (read('supabase/.temp/project-ref', 'utf8').trim() !== ref) throw new Error('Link de otro proyecto');
  const url = validateDatabase(env.SUPABASE_DB_URL || read('supabase/.temp/pooler-url', 'utf8'), ref);
  const result = (deps.spawn ?? spawnSync)('psql', [url, '-X', '-v', 'ON_ERROR_STOP=1', '-f', 'scripts/ci/0335_preflight_retencion_indices.sql'], {
    env: { ...env, PGPASSWORD: env.SUPABASE_DB_PASSWORD, PGCONNECT_TIMEOUT: '15' }, stdio: 'pipe', encoding: 'utf8', timeout: 720_000,
  });
  // psql puede devolver el string de conexión en errores. No propagar stdout,
  // stderr ni objetos Error del proceso que pudieran incluir credenciales.
  if (result.status !== 0) throw new Error('Preflight PostgreSQL falló; revisar destino/índices con acceso administrativo');
  console.log('Preflight de índices concurrentes completado.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv[2]).catch((error) => {
    const safe = [
      'Project ref inválido', 'URL PostgreSQL inválida',
      'Destino PostgreSQL no corresponde al proyecto/session pooler permitido',
      'No hay backup SQL COMPLETED de las últimas 24 horas', 'Falta token Supabase',
      'Falta contraseña PostgreSQL', 'Link de otro proyecto',
      'Preflight PostgreSQL falló; revisar destino/índices con acceso administrativo',
    ];
    const message = safe.includes(error?.message) || /^Consulta backup rechazada \(HTTP [0-9]{3}\)$/.test(error?.message ?? '')
      ? error.message : 'Gate Supabase falló por transporte/configuración; no continuar migración/promoción.';
    console.error(message);
    process.exitCode = 1;
  });
}
