#!/usr/bin/env node
// Fuentes de contrato: Supabase /reference/api/v1-get-project-api-keys;
// Vercel /docs/rest-api/projects/{edit-an-environment-variable,
// create-one-or-more-environment-variables}. Secretos sólo en memoria/HTTPS.
import { pathToFileURL } from 'node:url';
import { api, PROJECT, STAGING_REF, PRODUCTION_REF, validateSupabaseEnv } from './production-candidate.mjs';

export const KEYS = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
const asEnv = (values) => KEYS.map((key) => `${key}=${JSON.stringify(values[key])}`).join('\n');

export async function configurePreview(env = process.env, deps = {}) {
  if (env.CONFIGURE_PREVIEW !== 'ISOLATE_EXISTING_STAGING') throw new Error('Falta intención explícita de aislar Preview');
  if (!env.SUPABASE_ACCESS_TOKEN || !env.VERCEL_TOKEN) throw new Error('Faltan credenciales administrativas');
  const request = deps.vercel ?? ((path, options) => api(path, env, options));
  const response = await (deps.fetch ?? fetch)(`https://api.supabase.com/v1/projects/${STAGING_REF}/api-keys`, {
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` }, method: 'GET',
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error('No se pudieron consultar las claves del staging');
  const keys = await response.json();
  const values = { NEXT_PUBLIC_SUPABASE_URL: `https://${STAGING_REF}.supabase.co` };
  for (const [key, role] of [[KEYS[1], 'anon'], [KEYS[2], 'service_role']]) {
    const candidates = Array.isArray(keys) ? keys.filter((item) => item.name === role && !item.disabled) : [];
    if (candidates.length !== 1) throw new Error('Claves staging ausentes o ambiguas');
    values[key] = candidates[0].api_key;
  }
  validateSupabaseEnv(asEnv(values), STAGING_REF);

  const list = async () => {
    const result = await request(`/v9/projects/${PROJECT}/env`);
    if (!Array.isArray(result.envs)) throw new Error('Inventario Vercel inválido');
    const rows = result.envs.filter((item) => KEYS.includes(item.key));
    if (rows.some((item) => item.gitBranch || item.customEnvironmentIds?.length || !Array.isArray(item.target))) {
      throw new Error('Hay overrides Supabase que requieren revisión');
    }
    return rows;
  };
  const readTarget = async (rows, target) => {
    const result = {};
    for (const key of KEYS) {
      const matches = rows.filter((item) => item.key === key && item.target.includes(target));
      if (matches.length !== 1) throw new Error('Configuración ausente o ambigua');
      const row = await request(`/v1/projects/${PROJECT}/env/${encodeURIComponent(matches[0].id)}`);
      if (row.key !== key || typeof row.value !== 'string') throw new Error('No se pudo comprobar el valor Vercel');
      result[key] = row.value;
    }
    return result;
  };
  const rows = await list();
  const productionBefore = await readTarget(rows, 'production');
  validateSupabaseEnv(asEnv(productionBefore), PRODUCTION_REF);
  for (const key of KEYS) {
    const matches = rows.filter((item) => item.key === key && item.target.includes('preview'));
    if (matches.length > 1) throw new Error('Preview ambiguo');
    const current = matches[0];
    if (current && current.target.length > 1) {
      // Sólo separar targets: JAMÁS cambiar el valor del registro compartido.
      await request(`/v9/projects/${PROJECT}/env/${encodeURIComponent(current.id)}`, {
        method: 'PATCH', body: JSON.stringify({ target: current.target.filter((target) => target !== 'preview') }),
      });
    }
    const body = { key, value: values[key], type: 'encrypted', target: ['preview'] };
    if (current?.target.length === 1) {
      await request(`/v9/projects/${PROJECT}/env/${encodeURIComponent(current.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
    } else {
      const result = await request(`/v10/projects/${PROJECT}/env`, { method: 'POST', body: JSON.stringify(body) });
      if (result.failed?.length) throw new Error('Vercel rechazó la variable Preview');
    }
  }
  const after = await list();
  const productionAfter = await readTarget(after, 'production');
  if (KEYS.some((key) => productionBefore[key] !== productionAfter[key])) throw new Error('Production cambió durante la configuración; detener release');
  const previewAfter = await readTarget(after, 'preview');
  if (KEYS.some((key) => previewAfter[key] !== values[key])) throw new Error('Preview no conservó los valores esperados');
  return { preview_ref: STAGING_REF, production_preserved: true, variables: KEYS.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  configurePreview().then((result) => console.log(JSON.stringify(result))).catch(() => {
    console.error('No se completó el aislamiento de Preview. No desplegar; revisar configuración administrativa y reintentar.');
    process.exitCode = 1;
  });
}
