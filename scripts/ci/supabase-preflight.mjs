#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Sólo textos propios llegan a logs: nunca interpolar stderr, stdout, Error,
// nombres SQL ni URLs. La verbosidad de psql permite reconocer SQLSTATE.
const DIAGNOSTICS = {
  PREFLIGHT_PSQL_MISSING: 'No se encontró psql; instalar el cliente PostgreSQL en el runner.',
  PREFLIGHT_PSQL_PERMISSION: 'El runner no puede ejecutar psql; revisar permisos del binario.',
  PREFLIGHT_PROCESS_TIMEOUT: 'El proceso superó el plazo del preflight; revisar actividad y bloqueos antes de reintentar.',
  PREFLIGHT_OUTPUT_LIMIT: 'psql superó el límite de salida capturada; revisar el preflight con acceso administrativo.',
  PREFLIGHT_SPAWN: 'No se pudo ejecutar psql; revisar el runtime del runner.',
  PREFLIGHT_TLS_CA: 'No se pudo cargar la CA de confianza; comprobar libpq y el almacén CA del runner, sin desactivar verify-full.',
  PREFLIGHT_TLS_CERTIFICATE: 'Falló la verificación del certificado o su identidad; verificar CA y destino del proyecto, sin desactivar verify-full.',
  PREFLIGHT_TLS: 'Falló la negociación TLS; revisar cliente y configuración TLS del destino.',
  PREFLIGHT_AUTH: 'Autenticación rechazada; verificar contraseña PostgreSQL, rol y proyecto enlazado.',
  PREFLIGHT_DNS: 'No se resolvió el destino; revisar DNS y endpoint del session pooler.',
  PREFLIGHT_CONNECT_TIMEOUT: 'Venció el plazo de conexión; revisar disponibilidad y restricciones de red del proyecto.',
  PREFLIGHT_CONNECT: 'No se estableció o se perdió la conexión; revisar disponibilidad y restricciones de red.',
  PREFLIGHT_SQL_PERMISSION: 'El rol no tiene permisos suficientes; revisar privilegios para el preflight.',
  PREFLIGHT_SQL_SCHEMA: 'El esquema no coincide con el preflight; contrastar migraciones y columnas antes de continuar.',
  PREFLIGHT_SQL_LOCK: 'No se obtuvo el bloqueo SQL; revisar DDL concurrente antes de reintentar.',
  PREFLIGHT_SQL_CANCELLED: 'La sentencia fue cancelada; revisar timeout y actividad antes de reintentar.',
  PREFLIGHT_SQL_CONDITION: 'Falló una condición explícita del preflight; revisar sus tablas e índices con acceso administrativo.',
  PREFLIGHT_SQL_OTHER: 'PostgreSQL devolvió un error SQL no clasificado; revisar con acceso administrativo.',
  PREFLIGHT_UNKNOWN: 'psql falló sin diagnóstico reconocido; revisar con acceso administrativo. No continuar migraciones.',
  PREFLIGHT_CONNECTION_RESULT: 'psql terminó sin confirmar SELECT 1; no declarar la conexión verificada.',
};

class PreflightError extends Error {}

function preflightFailure(result) {
  let code;
  let state;
  if (result.error) {
    code = new Map([
      ['ENOENT', 'PREFLIGHT_PSQL_MISSING'], ['EACCES', 'PREFLIGHT_PSQL_PERMISSION'],
      ['ETIMEDOUT', 'PREFLIGHT_PROCESS_TIMEOUT'], ['ENOBUFS', 'PREFLIGHT_OUTPUT_LIMIT'],
    ]).get(result.error.code) ?? 'PREFLIGHT_SPAWN';
  } else {
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    const observed = stderr.match(/\b(?:ERROR|FATAL|PANIC):\s+([0-9A-Z]{5}):/)?.[1];
    const sql = new Map([
      ['42501', 'PREFLIGHT_SQL_PERMISSION'], ['42P01', 'PREFLIGHT_SQL_SCHEMA'],
      ['42703', 'PREFLIGHT_SQL_SCHEMA'], ['55P03', 'PREFLIGHT_SQL_LOCK'],
      ['57014', 'PREFLIGHT_SQL_CANCELLED'], ['P0001', 'PREFLIGHT_SQL_CONDITION'],
      ['28P01', 'PREFLIGHT_AUTH'], ['28000', 'PREFLIGHT_AUTH'],
      ['08001', 'PREFLIGHT_CONNECT'], ['08006', 'PREFLIGHT_CONNECT'],
    ]);
    if (observed) {
      code = sql.get(observed) ?? 'PREFLIGHT_SQL_OTHER';
      // Únicamente códigos conocidos: un texto arbitrario de cinco caracteres
      // no se transforma en un canal de publicación de datos del servidor.
      if (sql.has(observed)) state = observed;
    } else if (/root certificate file|could not (?:read|load).*certificate|sslrootcert/i.test(stderr)) code = 'PREFLIGHT_TLS_CA';
    else if (/certificate verify failed|certificate.*does not match host|certificate verification failed/i.test(stderr)) code = 'PREFLIGHT_TLS_CERTIFICATE';
    else if (/password authentication failed|no password supplied|authentication failed|no pg_hba.conf entry/i.test(stderr)) code = 'PREFLIGHT_AUTH';
    else if (/could not translate host name|name or service not known|nodename nor servname/i.test(stderr)) code = 'PREFLIGHT_DNS';
    else if (/timeout expired|connection timed out/i.test(stderr)) code = 'PREFLIGHT_CONNECT_TIMEOUT';
    else if (/SSL error|SSL was required|TLS|SSL negotiation/i.test(stderr)) code = 'PREFLIGHT_TLS';
    else if (/connection refused|network is unreachable|no route to host|server closed the connection|could not connect|connection to server/i.test(stderr)) code = 'PREFLIGHT_CONNECT';
    else code = 'PREFLIGHT_UNKNOWN';
  }
  return new PreflightError(`${code}${state ? `; SQLSTATE=${state}` : ''}: ${DIAGNOSTICS[code]}`);
}

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
  if (mode !== 'preflight' && mode !== 'connection') throw new Error('Modo inválido');
  if (!env.SUPABASE_DB_PASSWORD) throw new Error('Falta contraseña PostgreSQL');
  const read = deps.read ?? readFileSync;
  if (read('supabase/.temp/project-ref', 'utf8').trim() !== ref) throw new Error('Link de otro proyecto');
  const url = validateDatabase(env.SUPABASE_DB_URL || read('supabase/.temp/pooler-url', 'utf8'), ref);
  const connection = mode === 'connection';
  if (connection) console.log(JSON.stringify({ connection_host: new URL(url).hostname, tls: 'verify-full', read_only: true }));
  const operation = connection ? ['-At', '-c', 'SELECT 1'] : ['-f', 'scripts/ci/0335_preflight_retencion_indices.sql'];
  let result;
  try {
    result = (deps.spawn ?? spawnSync)('psql', [url, '-X', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', ...operation], {
      env: { ...env, LC_ALL: 'C', PGPASSWORD: env.SUPABASE_DB_PASSWORD, PGCONNECT_TIMEOUT: '15',
        ...(connection ? { PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=15000' } : {}),
      }, stdio: 'pipe', encoding: 'utf8', timeout: connection ? 30_000 : 720_000,
    });
  } catch (error) { throw preflightFailure({ error }); }
  // psql puede devolver el string de conexión en errores. No propagar stdout,
  // stderr ni objetos Error del proceso que pudieran incluir credenciales.
  if (result.status !== 0 || result.error) throw preflightFailure(result);
  if (connection && result.stdout?.trim() !== '1') throw new PreflightError(`PREFLIGHT_CONNECTION_RESULT: ${DIAGNOSTICS.PREFLIGHT_CONNECTION_RESULT}`);
  console.log(connection ? 'Conexión PostgreSQL verificada (SELECT 1; sólo lectura).' : 'Preflight de índices concurrentes completado.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv[2]).catch((error) => {
    const safe = [
      'Project ref inválido', 'URL PostgreSQL inválida',
      'Destino PostgreSQL no corresponde al proyecto/session pooler permitido',
      'No hay backup SQL COMPLETED de las últimas 24 horas', 'Falta token Supabase',
      'Falta contraseña PostgreSQL', 'Link de otro proyecto',
    ];
    const message = error instanceof PreflightError || safe.includes(error?.message) || /^Consulta backup rechazada \(HTTP [0-9]{3}\)$/.test(error?.message ?? '')
      ? error.message : 'Gate Supabase falló por transporte/configuración; no continuar migración/promoción.';
    console.error(message);
    process.exitCode = 1;
  });
}
