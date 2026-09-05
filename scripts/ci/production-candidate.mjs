#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

export const PROJECT = 'prj_OnrG9eY8WQzj35I3jtAZX2wTJ2sn';
export const TEAM = 'team_uelpa362TxivuQUHNzTGLWNv';
export const DOMAIN = 'app.likida.ai';
export const DOMAINS = [DOMAIN, 'likidaai.vercel.app'];
export const STAGING_REF = 'dmhhygwzgudwgcbixuwp';
export const PRODUCTION_REF = 'gngoqsvrxdguxvsizpbw';

export function validateSupabaseEnv(text, expectedRef) {
  if (![STAGING_REF, PRODUCTION_REF].includes(expectedRef)) throw new Error('Ref de entorno no autorizado');
  const entries = {};
  for (const line of text.split('\n')) {
    const match = /^(NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY)=(.*)$/.exec(line.trim());
    if (!match) continue;
    if (entries[match[1]]) throw new Error('Variable Supabase duplicada en entorno Vercel');
    entries[match[1]] = match[2].startsWith('"') ? JSON.parse(match[2]) : match[2];
  }
  if (entries.NEXT_PUBLIC_SUPABASE_URL !== `https://${expectedRef}.supabase.co`) throw new Error('El entorno Vercel no apunta al proyecto Supabase autorizado');
  for (const [key, role] of [['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon'], ['SUPABASE_SERVICE_ROLE_KEY', 'service_role']]) {
    let payload;
    try { payload = JSON.parse(Buffer.from(entries[key].split('.')[1], 'base64url').toString()); } catch { throw new Error('No se pudo comprobar ref de la credencial Supabase'); }
    if (payload.ref !== expectedRef || payload.role !== role) throw new Error('Credencial Supabase de otro proyecto/rol');
  }
}

export const validatePreviewEnv = (text) => validateSupabaseEnv(text, STAGING_REF);

export function validateDeployment(deployment, sha, target, expectedId) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '') || !['production', 'preview'].includes(target)) throw new Error('Identidad esperada inválida');
  if (!/^dpl_[A-Za-z0-9]+$/.test(deployment?.id ?? '')
    || deployment.projectId !== PROJECT || deployment.readyState !== 'READY'
    || (deployment.target ?? 'preview') !== target
    || deployment.meta?.releaseSha !== sha
    || (expectedId && deployment.id !== expectedId)
    || !/^[a-z0-9-]+\.vercel\.app$/.test(deployment.url ?? '')) throw new Error('Candidato no coincide con proyecto/SHA/target/ID READY');
  return { id: deployment.id, url: `https://${deployment.url}` };
}

export function validateCron(before, after) {
  if (before !== after) throw new Error('El destino de Cron cambió antes de promover; investigar efectos ya posibles');
}

export function validateBaseline(value) {
  if (!/^dpl_[A-Za-z0-9]+$/.test(value?.current ?? '')
    || !(value.cron === null || /^dpl_[A-Za-z0-9]+$/.test(value.cron ?? ''))) {
    throw new Error('Identidad de baseline inválida');
  }
  return { current: value.current, cron: value.cron };
}

export function parseCookie(headers, origin) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.vercel\.app$/.test(url.hostname)) throw new Error('Origin de cookie inválido');
  const line = headers.find((value) => value.startsWith('__vercel_live_token='));
  const value = line?.split(';')[0].slice('__vercel_live_token='.length);
  if (!value || /[\s;,]/.test(value)) throw new Error('No se obtuvo cookie de Deployment Protection');
  // Cookie host-only: nunca heredar Domain=.vercel.app del servidor al navegador.
  return { name: '__vercel_live_token', value, url: url.origin, secure: true, httpOnly: true, sameSite: 'Lax' };
}

export function validateBrowserCookie(cookie, base) {
  if (cookie.name !== '__vercel_live_token' || cookie.url !== new URL(base).origin
    || new URL(base).protocol !== 'https:' || cookie.domain || cookie.path
    || cookie.secure !== true || cookie.httpOnly !== true || typeof cookie.value !== 'string'
    || !cookie.value || /[\s;,]/.test(cookie.value)) throw new Error('Cookie protegida fuera del origin esperado');
  return cookie;
}

export function validateLanding(url, base, text) {
  if (new URL(url).origin !== new URL(base).origin || /Authentication Required|Log in to Vercel/i.test(text)) {
    throw new Error('Puerta de Deployment Protection en lugar de la aplicación');
  }
}

export async function api(path, env = process.env, options = {}) {
  if (!env.VERCEL_TOKEN) throw new Error('Falta token Vercel');
  const response = await fetch(`https://api.vercel.com${path}${path.includes('?') ? '&' : '?'}teamId=${TEAM}`, {
    ...options, headers: { Authorization: `Bearer ${env.VERCEL_TOKEN}`, 'Content-Type': 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Vercel API HTTP ${response.status}`);
  return response.json();
}

export async function withProtection(project, request, action) {
  const existing = Object.entries(project.protectionBypass ?? {}).find(([, item]) => item.scope === 'automation-bypass')?.[0];
  if (existing) return action(existing);
  // Identidad propia conocida incluso si la respuesta de creación se pierde.
  const secret = randomBytes(32).toString('hex');
  try {
    await request({ method: 'PATCH', body: JSON.stringify({ generate: { secret } }) });
    return await action(secret);
  } finally {
    try {
      await request({ method: 'PATCH', body: JSON.stringify({ revoke: { secret, regenerate: false } }) });
    } catch {
      console.error('::error::Falló la revocación del bypass creado por esta ejecución; requiere revisión administrativa.');
      throw new Error('Cleanup de Deployment Protection falló');
    }
  }
}

export async function main(mode, reference, sha, extra, env = process.env) {
  if (mode === 'preview-env') {
    validatePreviewEnv(readFileSync('.vercel/.env.preview.local', 'utf8'));
    console.log('Preview: URL y referencias de las dos credenciales coinciden con staging autorizado.');
    return;
  }
  if (mode === 'production-env') {
    validateSupabaseEnv(readFileSync('.vercel/.env.production.local', 'utf8'), PRODUCTION_REF);
    console.log('Production: URL y referencias de las dos credenciales coinciden con el proyecto autorizado.');
    return;
  }
  if (mode === 'baseline') {
    const project = await api(`/v9/projects/${PROJECT}`, env);
    const current = await api(`/v13/deployments/${DOMAIN}`, env);
    console.log(JSON.stringify(validateBaseline({ current: current.id, cron: project.crons?.deploymentId ?? null })));
    return;
  }
  if (!reference || !/^(dpl_[A-Za-z0-9]+|https:\/\/[a-z0-9-]+\.vercel\.app)$/.test(reference)) throw new Error('Referencia de deployment inválida');
  const key = reference.replace('https://', '');
  const target = mode === 'smoke-preview' ? 'preview' : 'production';
  const candidate = validateDeployment(await api(`/v13/deployments/${key}`, env), sha, target, reference.startsWith('dpl_') ? reference : undefined);
  if (mode === 'candidate') {
    const before = validateBaseline(JSON.parse(readFileSync(extra, 'utf8'))); // eslint-disable-line security/detect-non-literal-fs-filename -- ruta RUNNER_TEMP del workflow, no entrada HTTP.
    const project = await api(`/v9/projects/${PROJECT}`, env);
    validateCron(before.cron, project.crons?.deploymentId ?? null);
    const current = await api(`/v13/deployments/${DOMAIN}`, env);
    if (current.id !== before.current) throw new Error('El alias productivo cambió durante la creación del candidato');
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `id=${candidate.id}\nurl=${candidate.url}\nprevious=${before.current}\n`); // eslint-disable-line security/detect-non-literal-fs-filename -- archivo de outputs definido por GitHub Actions; sólo metadata pública.
    console.log(JSON.stringify(candidate));
    return;
  }
  if (mode === 'verify-alias' || mode === 'before-promote') {
    for (const domain of DOMAINS) {
      const current = await api(`/v13/deployments/${domain}`, env);
      if (current.id !== (mode === 'verify-alias' ? candidate.id : extra)) throw new Error('Alias productivo no coincide con ID esperado');
      console.log(JSON.stringify({ deployment: candidate.id, alias: domain, current: current.id }));
    }
    return;
  }
  if (!['smoke-preview', 'smoke-production'].includes(mode)) throw new Error('Modo inválido');
  const project = await api(`/v9/projects/${PROJECT}`, env);
  return withProtection(project, (options) => api(`/v1/projects/${PROJECT}/protection-bypass`, env, options), async (bypass) => {
    const response = await fetch(candidate.url, {
      method: 'GET', headers: { 'x-vercel-protection-bypass': bypass, 'x-vercel-set-bypass-cookie': 'true' },
      redirect: 'manual', signal: AbortSignal.timeout(30_000),
  });
  const cookie = parseCookie(response.headers.getSetCookie(), candidate.url);
  await response.body?.cancel();
  const dir = mkdtempSync(join(tmpdir(), 'likida-smoke-'));
  try {
    const file = join(dir, 'cookie.json');
    writeFileSync(file, JSON.stringify(cookie), { mode: 0o600 }); // eslint-disable-line security/detect-non-literal-fs-filename -- archivo propio en directorio único mkdtemp; finally lo elimina.
    const result = spawnSync(process.execPath, ['scripts/ci/playwright-smoke.mjs'], {
      env: { ...env, PLAYWRIGHT_BASE_URL: candidate.url, PLAYWRIGHT_PROTECTION_COOKIE: file },
      stdio: 'pipe', encoding: 'utf8', timeout: 180_000,
    });
    if (result.status !== 0) throw new Error('Smoke de navegador remoto falló (salida reservada para evitar secretos)');
    if (mode === 'smoke-production') {
      const health = await fetch(`${candidate.url}/api/health`, {
        headers: { Cookie: `${cookie.name}=${cookie.value}` }, redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
      const body = await health.json();
      if (!health.ok || body.ok !== true || body.version !== sha.slice(0, 7) || body.migracion?.atras !== 0) throw new Error('Health de Production no está sano/en el SHA esperado');
    }
    console.log(JSON.stringify({ smoke: 'PASS', ...candidate, sha, target, rutas: 3 }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(...process.argv.slice(2)).catch(() => { console.error('Gate del candidato Vercel falló; no promover.'); process.exitCode = 1; });
}
