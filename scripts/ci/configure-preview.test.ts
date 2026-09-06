import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { configurePreview, KEYS } from './configure-preview.mjs';
import { PRODUCTION_REF, STAGING_REF } from './production-candidate.mjs';

const jwt = (ref: string, role: string) => `header.${Buffer.from(JSON.stringify({ ref, role })).toString('base64url')}.signature`;
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', CONFIGURE_PREVIEW: 'ISOLATE_EXISTING_STAGING', VERCEL_TOKEN: 'synthetic-v', SUPABASE_ACCESS_TOKEN: 'synthetic-s' };
function fixture(sensitive = false) {
  const oldValues = [`https://${PRODUCTION_REF}.supabase.co`, jwt(PRODUCTION_REF, 'anon'), jwt(PRODUCTION_REF, 'service_role')];
  const rows = KEYS.map((key: string, index: number) => ({ id: `id${index}`, key, type: sensitive ? 'sensitive' : 'encrypted', target: ['preview', 'production'], value: oldValues[index] }));
  const visible = (row: typeof rows[number]) => sensitive ? { ...row, value: undefined } : structuredClone(row);
  let loseCreate = false;
  const vercel = vi.fn(async (path: string, options?: { method: string; body: string }) => {
    if (!options) return path.endsWith('/env') ? { envs: rows.map(visible) } : visible(rows.find((item) => path.endsWith(`/${item.id}`))!);
    const body = JSON.parse(options.body);
    if (options.method === 'PATCH') {
      const row = rows.find((item) => path.endsWith(`/${item.id}`))!;
      Object.assign(row, body);
      return visible(row);
    }
    expect(body.target).toEqual(['preview']);
    rows.push({ ...body, id: `new${rows.length}` });
    if (loseCreate) { loseCreate = false; throw new Error('transport lost after mutation'); }
    return { failed: [], created: visible(rows[rows.length - 1]) };
  });
  const fetch = vi.fn(async () => ({ ok: true, json: async () => [
    { name: 'anon', api_key: jwt(STAGING_REF, 'anon') },
    { name: 'service_role', api_key: jwt(STAGING_REF, 'service_role') },
  ] }));
  return { rows, oldValues, vercel, fetch, lose: () => { loseCreate = true; } };
}

describe('aislar la Preview existente conservando Production', () => {
  it('separa sensitive sin leer valores y conserva tipo, identidad y Production', async () => {
    const f = fixture(true);
    const result = await configurePreview(env, f);
    expect(result).toMatchObject({ production_verification: 'metadata_only', preview_verification: 'write_ack_and_metadata' });
    expect(result).not.toHaveProperty('production_preserved');
    expect(f.vercel.mock.calls.filter(([path, options]) => !options && !path.endsWith('/env'))).toHaveLength(0);
    expect(f.rows.filter(row => row.target.includes('production')).map(row => row.value)).toEqual(f.oldValues);
    for (const [path, options] of f.vercel.mock.calls.filter(([, options]) => options)) {
      const body = JSON.parse(options!.body);
      if (path.includes('/env/id')) expect(body).toEqual({ target: ['production'] });
      else expect(body).toMatchObject({ type: 'sensitive', target: ['preview'] });
    }
  });
  it('reintenta sensitive tras POST confirmado por servidor pero respuesta perdida sin duplicar', async () => {
    const f = fixture(true); f.lose();
    await expect(configurePreview(env, f)).rejects.toMatchObject({ diagnostic: { stage: 'VERCEL_PREVIEW_CREATE' } });
    await expect(configurePreview(env, f)).resolves.toMatchObject({ production_verification: 'metadata_only' });
    expect(f.rows).toHaveLength(6);
    expect(f.rows.filter(row => row.target.includes('production')).map(row => row.value)).toEqual(f.oldValues);
    expect(f.rows.every(row => row.type === 'sensitive')).toBe(true);
  });
  it.each(['missing_id', 'wrong_type', 'wrong_target', 'missing_failed'])('rechaza ACK POST sensitive inválido: %s', async fault => {
    const f = fixture(true); const original = f.vercel.getMockImplementation()!;
    f.vercel.mockImplementation(async (path, options) => {
      const result = await original(path, options);
      if (options?.method !== 'POST') return result;
      const invalid = structuredClone(result) as { failed?: unknown[]; created: { id?: string; type: string; target: string[] } };
      if (fault === 'missing_id') delete invalid.created.id;
      if (fault === 'wrong_type') invalid.created.type = 'encrypted';
      if (fault === 'wrong_target') invalid.created.target = ['production'];
      if (fault === 'missing_failed') delete invalid.failed;
      return invalid as typeof result;
    });
    await expect(configurePreview(env, f)).rejects.toMatchObject({ diagnostic: { stage: 'VERCEL_PREVIEW_CREATE', reason: 'WRITE_REJECTED' } });
  });
  it('rechaza sustitución posterior del ID productivo aunque se oculten los valores', async () => {
    const f = fixture(true); const original = f.vercel.getMockImplementation()!;
    let reads = 0;
    f.vercel.mockImplementation(async (path, options) => {
      if (!options && path.endsWith('/env') && ++reads === 2) f.rows[0].id = 'replacement';
      return original(path, options);
    });
    await expect(configurePreview(env, f)).rejects.toMatchObject({ diagnostic: { stage: 'VERCEL_PRODUCTION_COMPARE', reason: 'PRODUCTION_CHANGED' } });
  });
  it.each([401, 403, 429, 500])('diagnostica HTTP Supabase %s sin consumir/publicar su cuerpo', async status => {
    const f = fixture(); const json = vi.fn(async () => ({ secret: 'synthetic-private-response' }));
    const fetch = vi.fn(async () => ({ ok: false, status, json }));
    await expect(configurePreview(env, { ...f, fetch })).rejects.toMatchObject({ diagnostic: { stage: 'SUPABASE_KEYS_HTTP', reason: 'HTTP', http_status: status } });
    expect(json).not.toHaveBeenCalled();
    expect(f.vercel).not.toHaveBeenCalled();
  });
  it('pide valores revelados por contrato y detecta api_key ausente antes de Vercel', async () => {
    const f = fixture();
    const fetch = vi.fn(async () => ({ ok: true, json: async () => [{ name: 'anon', api_key: null }, { name: 'service_role' }] }));
    await expect(configurePreview(env, { ...f, fetch })).rejects.toMatchObject({ diagnostic: { stage: 'SUPABASE_KEYS_SELECT', reason: 'KEY_VALUE_MISSING' } });
    expect(fetch).toHaveBeenCalledWith(`https://api.supabase.com/v1/projects/${STAGING_REF}/api-keys?reveal=true`, expect.objectContaining({ method: 'GET', redirect: 'error' }));
    expect(f.vercel).not.toHaveBeenCalled();
  });
  it('distingue etapa HTTP Vercel y nunca interpola un error arbitrario', async () => {
    const f = fixture(); f.vercel.mockRejectedValueOnce(new Error('Vercel API HTTP 403'));
    await expect(configurePreview(env, f)).rejects.toMatchObject({ diagnostic: { stage: 'VERCEL_LIST_BEFORE', reason: 'HTTP', http_status: 403 } });
    f.vercel.mockRejectedValueOnce(new Error('synthetic-private-token https://user:password@private.invalid'));
    const failed = configurePreview(env, f);
    await expect(failed).rejects.toMatchObject({ diagnostic: { stage: 'VERCEL_LIST_BEFORE', reason: 'TRANSPORT_OR_UNEXPECTED' } });
    await expect(failed).rejects.not.toThrow(/synthetic-private|password|https:/);
  });
  it('CLI real imprime sólo enums/status ante un HTTP403 simulado sin red', () => {
    const result = spawnSync(process.execPath, ['--import', 'data:text/javascript,globalThis.fetch=async()=>({ok:false,status:403})', resolve('scripts/ci/configure-preview.mjs')], { env, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({ stage: 'SUPABASE_KEYS_HTTP', reason: 'HTTP', http_status: 403 });
    expect(result.stdout).toBe('');
  });
  it('separa registros compartidos sin escribir valores productivos y verifica ambos destinos', async () => {
    const f = fixture();
    expect(await configurePreview(env, f)).toEqual({ preview_ref: STAGING_REF, production_verification: 'values_and_metadata', preview_verification: 'values_and_metadata', variables: 3 });
    expect(f.rows.filter((row) => row.target.includes('production')).map((row) => row.value)).toEqual(f.oldValues);
    const oldPatches = f.vercel.mock.calls.filter(([path, options]) => path.includes('/env/id') && options);
    expect(oldPatches).toHaveLength(3);
    for (const [, options] of oldPatches) expect(JSON.parse(options!.body)).toEqual({ target: ['production'] });
  });
  it('reintentar una respuesta POST perdida converge sin duplicar ni tocar Production', async () => {
    const f = fixture(); f.lose();
    await expect(configurePreview(env, f)).rejects.toThrow('transport');
    await configurePreview(env, f);
    expect(f.rows).toHaveLength(6);
    expect(f.rows.filter((row) => row.target.includes('production')).map((row) => row.value)).toEqual(f.oldValues);
  });
  it('credenciales de otro proyecto abortan antes de cualquier escritura', async () => {
    const f = fixture();
    f.fetch.mockResolvedValue({ ok: true, json: async () => [{ name: 'anon', api_key: jwt(PRODUCTION_REF, 'anon') }, { name: 'service_role', api_key: jwt(STAGING_REF, 'service_role') }] });
    await expect(configurePreview(env, f)).rejects.toThrow('otro proyecto');
    expect(f.vercel).not.toHaveBeenCalled();
  });
  it('un override por rama requiere revisión y no se sobrescribe', async () => {
    const f = fixture(); Object.assign(f.rows[0], { gitBranch: 'special' });
    await expect(configurePreview(env, f)).rejects.toThrow('overrides');
    expect(f.vercel.mock.calls.every(([, options]) => !options)).toBe(true);
  });
  it('sin intención explícita no consulta siquiera las credenciales', async () => {
    const f = fixture();
    await expect(configurePreview({ ...env, CONFIGURE_PREVIEW: '' }, f)).rejects.toThrow('intención');
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

describe('preparación manual sin migraciones ni despliegue', () => {
  const workflow = readFileSync(resolve('.github/workflows/deploy-preview-promote.yml'), 'utf8');
  const job = (name: string) => workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z_-]+:\n/)[0] ?? '';
  const intent = job('preflight').split('- name: Validar intención de producción')[1]
    .split('        run: |\n')[1].trimEnd().split('\n').map(line => line.slice(10)).join('\n');
  const mode = { PREPARE_ONLY: 'true', CONFIGURE: 'true', PROMOTE: 'false', CONFIRM: '', DIAGNOSE: 'none', REPAIR: 'none' };
  const executeGuard = (changes: Partial<typeof mode> = {}) => spawnSync('/bin/bash', ['-c', intent], {
    env: { NODE_ENV: 'test', ...mode, ...changes }, encoding: 'utf8',
  });

  it('ejecuta el guard real y permite sólo la combinación de preparación aislada', () => {
    expect(executeGuard().status).toBe(0);
    for (const changes of [{ CONFIGURE: 'false' }, { PROMOTE: 'true' }, { DIAGNOSE: 'staging' }, { REPAIR: 'production' }]) {
      const result = executeGuard(changes);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('prepare_preview_only exige');
    }
    expect(executeGuard({ PREPARE_ONLY: 'false', PROMOTE: 'true' }).status).toBe(1);
    expect(executeGuard({ PREPARE_ONLY: 'false', PROMOTE: 'true', CONFIRM: 'APPLY_MIGRATIONS_AND_PROMOTE' }).status).toBe(0);
  });
  it('configura sobre el SHA resuelto sin acceder a pasos SQL, build o deploy', () => {
    const prepare = job('prepare_preview');
    expect(prepare).toContain('needs: preflight');
    expect(prepare).toContain('if: inputs.prepare_preview_only == true');
    expect(prepare).toContain('ref: ${{ needs.preflight.outputs.sha }}');
    expect(prepare).toContain('CONFIGURE_PREVIEW: ISOLATE_EXISTING_STAGING');
    expect(prepare.match(/\brun:/g)).toHaveLength(1);
    expect(prepare).toContain('run: node scripts/ci/configure-preview.mjs');
    expect(prepare).not.toMatch(/db push|db reset|deploy|npm ci|npm run build|SUPABASE_DB_PASSWORD/);
    expect(job('quality')).toContain('if: inputs.prepare_preview_only != true');
    for (const name of ['diagnose_migrations', 'repair_migrations']) {
      expect(job(name)).toContain('&& inputs.prepare_preview_only != true');
    }
    expect(job('supabase-dry-run')).toContain('needs: [preflight, quality]');
    expect(job('preview')).toContain('needs: [preflight, quality, supabase-dry-run, preview_configuration]');
    for (const name of ['production_migrations', 'production_candidate', 'production_smoke', 'promote']) {
      expect(job(name)).toContain('inputs.promote == true');
    }
    expect(workflow).not.toContain('always()');
    expect(workflow).toContain('group: vercel-release-likida\n  cancel-in-progress: false');
    expect(workflow).toMatch(/prepare_preview_only:\n(?:[^\n]*\n){2}        default: false/);
  });
});
