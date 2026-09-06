#!/usr/bin/env node
// Fuentes de contrato: Supabase /reference/api/v1-get-project-api-keys;
// Vercel /docs/rest-api/projects/{edit-an-environment-variable,
// create-one-or-more-environment-variables}. Secretos sólo en memoria/HTTPS.
import { pathToFileURL } from 'node:url';
import { api, PROJECT, STAGING_REF, PRODUCTION_REF, validateSupabaseEnv } from './production-candidate.mjs';

export const KEYS = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
const asEnv = (values) => KEYS.map((key) => `${key}=${JSON.stringify(values[key])}`).join('\n');
const sameTargets = (left, right) => Array.isArray(left) && Array.isArray(right)
  && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const sameRecord = (row, expected, targets) => row?.id === expected.id && row?.key === expected.key
  && row?.type === expected.type && sameTargets(row?.target, targets);

const CAUSES = new Map([
  ['Falta intención explícita de aislar Preview', 'INTENT'], ['Faltan credenciales administrativas', 'CREDENTIALS'],
  ['Claves staging ausentes o ambiguas', 'KEY_SELECTION'], ['Clave staging sin valor revelado', 'KEY_VALUE_MISSING'],
  ['No se pudo comprobar ref de la credencial Supabase', 'KEY_FORMAT'], ['Credencial Supabase de otro proyecto/rol', 'KEY_IDENTITY'],
  ['El entorno Vercel no apunta al proyecto Supabase autorizado', 'PROJECT_MISMATCH'],
  ['Inventario Vercel inválido', 'INVENTORY_FORMAT'], ['Hay overrides Supabase que requieren revisión', 'OVERRIDES'],
  ['Configuración ausente o ambigua', 'ENV_SELECTION'], ['No se pudo comprobar el valor Vercel', 'ENV_VALUE'],
  ['Preview ambiguo', 'PREVIEW_SELECTION'], ['Vercel rechazó la variable Preview', 'WRITE_REJECTED'],
  ['Production cambió durante la configuración; detener release', 'PRODUCTION_CHANGED'], ['Preview no conservó los valores esperados', 'PREVIEW_MISMATCH'],
]);
class ConfigurationError extends Error {
  constructor(stage, error) {
    const http = /^(?:Vercel|Supabase) API HTTP ([1-5][0-9]{2})$/.exec(error?.message ?? '');
    const reason = http ? 'HTTP' : CAUSES.get(error?.message) ?? (error instanceof SyntaxError ? 'INVALID_JSON'
      : ['TimeoutError', 'AbortError'].includes(error?.name) ? 'TIMEOUT' : 'TRANSPORT_OR_UNEXPECTED');
    const detail = CAUSES.has(error?.message) ? error.message : 'Fallo de transporte o respuesta; detener configuración y revisar la etapa indicada.';
    super(`PREVIEW_CONFIG ${stage}/${reason}${http ? ` HTTP ${http[1]}` : ''}: ${detail}`);
    this.diagnostic = { stage, reason, ...(http ? { http_status: Number(http[1]) } : {}) };
  }
}

export async function configurePreview(env = process.env, deps = {}) {
  let stage = 'INTENT';
  try { return await configurePreviewWork(env, deps, (next) => { stage = next; }); }
  catch (error) { throw new ConfigurationError(stage, error); }
}

async function configurePreviewWork(env, deps, at) {
  if (env.CONFIGURE_PREVIEW !== 'ISOLATE_EXISTING_STAGING') throw new Error('Falta intención explícita de aislar Preview');
  at('CREDENTIALS');
  if (!env.SUPABASE_ACCESS_TOKEN || !env.VERCEL_TOKEN) throw new Error('Faltan credenciales administrativas');
  const request = deps.vercel ?? ((path, options) => api(path, env, options));
  at('SUPABASE_KEYS_HTTP');
  const response = await (deps.fetch ?? fetch)(`https://api.supabase.com/v1/projects/${STAGING_REF}/api-keys?reveal=true`, {
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` }, method: 'GET',
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Supabase API HTTP ${response.status}`);
  at('SUPABASE_KEYS_PARSE');
  const keys = await response.json();
  at('SUPABASE_KEYS_SELECT');
  const values = { NEXT_PUBLIC_SUPABASE_URL: `https://${STAGING_REF}.supabase.co` };
  for (const [key, role] of [[KEYS[1], 'anon'], [KEYS[2], 'service_role']]) {
    const candidates = Array.isArray(keys) ? keys.filter((item) => item.name === role && !item.disabled) : [];
    if (candidates.length !== 1) throw new Error('Claves staging ausentes o ambiguas');
    if (typeof candidates[0].api_key !== 'string' || !candidates[0].api_key) throw new Error('Clave staging sin valor revelado');
    values[key] = candidates[0].api_key;
  }
  at('SUPABASE_KEYS_VALIDATE');
  validateSupabaseEnv(asEnv(values), STAGING_REF);

  const list = async (stage) => {
    at(stage);
    const result = await request(`/v9/projects/${PROJECT}/env`);
    if (!Array.isArray(result.envs)) throw new Error('Inventario Vercel inválido');
    const rows = result.envs.filter((item) => KEYS.includes(item.key));
    if (rows.some((item) => item.gitBranch || item.customEnvironmentIds?.length || !Array.isArray(item.target))) {
      throw new Error('Hay overrides Supabase que requieren revisión');
    }
    return rows;
  };
  const selectTarget = (rows, target, key) => {
    const matches = rows.filter((item) => item.key === key && item.target.includes(target));
    if (matches.length !== 1 || typeof matches[0].id !== 'string' || !matches[0].id) throw new Error('Configuración ausente o ambigua');
    return matches[0];
  };
  const readTarget = async (rows, target, stage) => {
    at(stage);
    const result = {};
    for (const key of KEYS) {
      const selected = selectTarget(rows, target, key);
      // Sensitive es deliberadamente irrecuperable por la API de lectura.
      // No rebajar su tipo ni intentar revelarlo mediante otro endpoint.
      if (selected.type === 'sensitive') continue;
      const row = await request(`/v1/projects/${PROJECT}/env/${encodeURIComponent(selected.id)}`);
      if (row.key !== key || typeof row.value !== 'string') throw new Error('No se pudo comprobar el valor Vercel');
      result[key] = row.value;
    }
    return result;
  };
  const rows = await list('VERCEL_LIST_BEFORE');
  const productionRecords = Object.fromEntries(KEYS.map(key => [key, selectTarget(rows, 'production', key)]));
  const productionBefore = await readTarget(rows, 'production', 'VERCEL_PRODUCTION_READ_BEFORE');
  at('VERCEL_PRODUCTION_VALIDATE');
  const productionReadable = KEYS.every(key => typeof productionBefore[key] === 'string');
  if (productionReadable) validateSupabaseEnv(asEnv(productionBefore), PRODUCTION_REF);
  const written = {};
  for (const key of KEYS) {
    at('VERCEL_PREVIEW_SELECT');
    const matches = rows.filter((item) => item.key === key && item.target.includes('preview'));
    if (matches.length > 1) throw new Error('Preview ambiguo');
    const current = matches[0];
    if (current && current.target.length > 1) {
      // Sólo separar targets: JAMÁS cambiar el valor del registro compartido.
      at('VERCEL_PREVIEW_DETACH');
      const detached = await request(`/v9/projects/${PROJECT}/env/${encodeURIComponent(current.id)}`, {
        method: 'PATCH', body: JSON.stringify({ target: current.target.filter((target) => target !== 'preview') }),
      });
      if (!sameRecord(detached, current, current.target.filter(target => target !== 'preview'))) throw new Error('Vercel rechazó la variable Preview');
    }
    const type = current?.type === 'sensitive' || productionRecords[key].type === 'sensitive' ? 'sensitive' : 'encrypted';
    const body = { key, value: values[key], type, target: ['preview'] };
    let acknowledged;
    if (current?.target.length === 1) {
      at('VERCEL_PREVIEW_PATCH');
      acknowledged = await request(`/v9/projects/${PROJECT}/env/${encodeURIComponent(current.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
    } else {
      at('VERCEL_PREVIEW_CREATE');
      const result = await request(`/v10/projects/${PROJECT}/env`, { method: 'POST', body: JSON.stringify(body) });
      // POST de un objeto devuelve created singular y failed obligatorio.
      // https://vercel.com/docs/rest-api/projects/create-one-or-more-environment-variables
      if (!Array.isArray(result.failed) || result.failed.length) throw new Error('Vercel rechazó la variable Preview');
      acknowledged = result.created;
    }
    if (typeof acknowledged?.id !== 'string' || !acknowledged.id
      || !sameRecord(acknowledged, { id: current?.target.length === 1 ? current.id : acknowledged.id, key, type }, ['preview'])) {
      throw new Error('Vercel rechazó la variable Preview');
    }
    written[key] = acknowledged;
  }
  const after = await list('VERCEL_LIST_AFTER');
  const productionAfter = await readTarget(after, 'production', 'VERCEL_PRODUCTION_READ_AFTER');
  at('VERCEL_PRODUCTION_COMPARE');
  if (KEYS.some(key => !sameRecord(selectTarget(after, 'production', key), productionRecords[key], productionRecords[key].target.filter(target => target !== 'preview')))) {
    throw new Error('Production cambió durante la configuración; detener release');
  }
  if (KEYS.some((key) => productionBefore[key] !== productionAfter[key])) throw new Error('Production cambió durante la configuración; detener release');
  const previewAfter = await readTarget(after, 'preview', 'VERCEL_PREVIEW_READ_AFTER');
  at('VERCEL_PREVIEW_COMPARE');
  if (KEYS.some((key) => !sameRecord(selectTarget(after, 'preview', key), written[key], ['preview'])
    || (written[key].type !== 'sensitive' && previewAfter[key] !== values[key]))) throw new Error('Preview no conservó los valores esperados');
  // Metadatos y ACK no demuestran igualdad de un secreto oculto ni detectan
  // una escritura concurrente de su valor. El pull/guard antes del build sigue
  // comprobando ref/roles; este resultado jamás certifica esos valores.
  return { preview_ref: STAGING_REF, production_verification: productionReadable ? 'values_and_metadata' : 'metadata_only',
    preview_verification: KEYS.some(key => written[key].type === 'sensitive') ? 'write_ack_and_metadata' : 'values_and_metadata', variables: KEYS.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  configurePreview().then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(JSON.stringify(error instanceof ConfigurationError ? error.diagnostic : { stage: 'UNKNOWN', reason: 'UNEXPECTED' }));
    process.exitCode = 1;
  });
}
