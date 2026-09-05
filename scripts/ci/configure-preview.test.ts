import { describe, it, expect, vi } from 'vitest';
import { configurePreview, KEYS } from './configure-preview.mjs';
import { PRODUCTION_REF, STAGING_REF } from './production-candidate.mjs';

const jwt = (ref: string, role: string) => `header.${Buffer.from(JSON.stringify({ ref, role })).toString('base64url')}.signature`;
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', CONFIGURE_PREVIEW: 'ISOLATE_EXISTING_STAGING', VERCEL_TOKEN: 'synthetic-v', SUPABASE_ACCESS_TOKEN: 'synthetic-s' };
function fixture() {
  const oldValues = [`https://${PRODUCTION_REF}.supabase.co`, jwt(PRODUCTION_REF, 'anon'), jwt(PRODUCTION_REF, 'service_role')];
  const rows = KEYS.map((key: string, index: number) => ({ id: `id${index}`, key, target: ['preview', 'production'], value: oldValues[index] }));
  let loseCreate = false;
  const vercel = vi.fn(async (path: string, options?: { method: string; body: string }) => {
    if (!options) return path.endsWith('/env') ? { envs: structuredClone(rows) } : { ...rows.find((item) => path.endsWith(`/${item.id}`)) };
    const body = JSON.parse(options.body);
    if (options.method === 'PATCH') {
      const row = rows.find((item) => path.endsWith(`/${item.id}`))!;
      Object.assign(row, body);
      return structuredClone(row);
    }
    expect(body.target).toEqual(['preview']);
    rows.push({ ...body, id: `new${rows.length}` });
    if (loseCreate) { loseCreate = false; throw new Error('transport lost after mutation'); }
    return { failed: [], created: body };
  });
  const fetch = vi.fn(async () => ({ ok: true, json: async () => [
    { name: 'anon', api_key: jwt(STAGING_REF, 'anon') },
    { name: 'service_role', api_key: jwt(STAGING_REF, 'service_role') },
  ] }));
  return { rows, oldValues, vercel, fetch, lose: () => { loseCreate = true; } };
}

describe('aislar la Preview existente conservando Production', () => {
  it('separa registros compartidos sin escribir valores productivos y verifica ambos destinos', async () => {
    const f = fixture();
    expect(await configurePreview(env, f)).toEqual({ preview_ref: STAGING_REF, production_preserved: true, variables: 3 });
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
