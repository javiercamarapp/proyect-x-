import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// LA PUERTA HTTP DE /api/mcp — los tres fallos que el encargo exige probar,
// probados: SIN autorización (401 + WWW-Authenticate con la liga al
// descubrimiento), con TOKEN VENCIDO (401 que lo dice, sin filtrar nada) y
// con CREDENCIAL de flota inexistente (la llave no resuelve → 401 con texto
// único). Y el contrato JSON-RPC: initialize negocia, tools/list declara
// solo lectura, una notificación es 202, un lote se niega, GET es 405.
// ═══════════════════════════════════════════════════════════════════════════

const sbMock = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => sbMock() }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
// La tasa no es lo que se prueba aquí; se deja pasar siempre.
vi.mock('@/lib/ratelimit', () => ({
  rateLimit: vi.fn().mockResolvedValue(true),
  clientIp: () => '203.0.113.7',
}));

import { hashDeLlave } from '@/lib/auth/llave-api';
import { POST, GET, DELETE } from './route';

type Resultado = { data: unknown; error: { message: string } | null; count?: number | null };
const OK = (data: unknown): Resultado => ({ data, error: null });

function cadena(resultado: Resultado): unknown {
  const p = Promise.resolve(resultado);
  const proxy: unknown = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'then') return p.then.bind(p);
      if (prop === 'catch') return p.catch.bind(p);
      if (prop === 'finally') return p.finally.bind(p);
      return () => proxy;
    },
  });
  return proxy;
}

function conTablas(porTabla: Record<string, Resultado[]>) {
  const usados: Record<string, number> = {};
  sbMock.mockReturnValue({
    from(tabla: string) {
      const r = porTabla[tabla];
      if (!r) return cadena(OK([]));
      const i = usados[tabla] ?? 0;
      usados[tabla] = i + 1;
      return cadena(r[Math.min(i, r.length - 1)]);
    },
  });
}

const LLAVE = 'lk_live_abcdefghijklmnopqrstuvwxyz012345';
const FILA_LLAVE = {
  id: 'k-1', tenant_id: 'flota-A', area: 'operacion', hash: hashDeLlave(LLAVE),
};

function peticion(cuerpo: unknown, token: string | null = LLAVE): Request {
  return new Request('https://app.likida.ai/api/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo),
  });
}

// `id: null` = notificación (sin campo id). Un default de `undefined` no
// serviría: pasar undefined explícito activa el default en JS.
const RPC = (method: string, params: unknown = {}, id: number | null = 1) =>
  ({ jsonrpc: '2.0', ...(id !== null ? { id } : {}), method, params });

beforeEach(() => {
  sbMock.mockReset();
});

describe('sin autorización', () => {
  it('401 con WWW-Authenticate apuntando al descubrimiento (RFC 9728)', async () => {
    const res = await POST(peticion(RPC('initialize'), null));
    expect(res.status).toBe(401);
    const www = res.headers.get('WWW-Authenticate');
    expect(www).toContain('Bearer');
    expect(www).toContain('/.well-known/oauth-protected-resource/api/mcp');
    const cuerpo = await res.json();
    expect(String(cuerpo.error)).not.toContain('Supabase');
  });
});

describe('token vencido', () => {
  it('401 que dice que expiró, sin decir nada más', async () => {
    conTablas({
      mcp_oauth_token: [OK({
        id: 'tk', tipo: 'acceso', user_id: 'u', user_email: null,
        tenant_id: 'flota-A', rol: 'contador',
        expira_en: new Date(Date.now() - 1000).toISOString(), revocado_en: null,
      })],
    });
    const res = await POST(peticion(RPC('tools/list'), 'lk_mcp_at_vencido'));
    expect(res.status).toBe(401);
    const cuerpo = await res.json();
    expect(cuerpo.error).toBe('Token inválido o expirado.');
  });
});

describe('credencial de flota inexistente', () => {
  it('una llave que no está en ninguna flota → 401 con el texto único', async () => {
    conTablas({ tenant_api_key: [OK([])] });
    const res = await POST(peticion(RPC('tools/list'), LLAVE));
    expect(res.status).toBe(401);
    const cuerpo = await res.json();
    expect(cuerpo.error).toBe('Llave inválida.');
  });
});

describe('el contrato JSON-RPC con una llave viva', () => {
  beforeEach(() => {
    conTablas({ tenant_api_key: [OK([FILA_LLAVE])] });
  });

  it('initialize negocia la versión pedida y se declara solo-tools', async () => {
    const res = await POST(peticion(RPC('initialize', { protocolVersion: '2025-06-18' })));
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.result.protocolVersion).toBe('2025-06-18');
    expect(r.result.capabilities).toEqual({ tools: {} });
    expect(r.result.resultType).toBe('complete');
    // Sin estado: la respuesta NO trae Mcp-Session-Id.
    expect(res.headers.get('Mcp-Session-Id')).toBeNull();
  });

  it('una credencial válida no permite materializar un body chunked excesivo', async () => {
    let pedidos = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controlador) {
        pedidos += 1;
        if (pedidos > 30) { controlador.close(); return; }
        controlador.enqueue(new Uint8Array(8 * 1024).fill(120));
      },
    });
    const req = new Request('https://app.likida.ai/api/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${LLAVE}`, accept: 'application/json' },
      body,
      // @ts-expect-error Node exige duplex para construir Request con stream.
      duplex: 'half',
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain('excede');
    expect(pedidos).toBeLessThanOrEqual(10);
  });

  it('una versión desconocida en initialize recibe la más nueva de su generación', async () => {
    const res = await POST(peticion(RPC('initialize', { protocolVersion: '2019-01-01' })));
    const r = await res.json();
    expect(r.result.protocolVersion).toBe('2025-11-25');
  });

  it('server/discover (2026-07-28) enumera versiones e identidad', async () => {
    const res = await POST(peticion(RPC('server/discover')));
    const r = await res.json();
    expect(r.result.protocolVersions).toContain('2026-07-28');
    expect(r.result.serverInfo.name).toBe('likida');
  });

  it('una versión declarada en _meta que no atendemos → error -32022', async () => {
    const res = await POST(peticion(RPC('tools/list', {
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2031-01-01' },
    })));
    const r = await res.json();
    expect(r.error.code).toBe(-32022);
  });

  it('tools/list trae las ocho, todas de solo lectura, con caché privado', async () => {
    const res = await POST(peticion(RPC('tools/list')));
    const r = await res.json();
    expect(r.result.tools).toHaveLength(8);
    for (const t of r.result.tools) {
      expect(t.annotations.readOnlyHint, t.name).toBe(true);
    }
    expect(r.result.cacheScope).toBe('private');
    expect(r.result.ttlMs).toBeGreaterThan(0);
  });

  it('tools/call de dinero con llave de operación → isError que lo dice, sin ejecutar', async () => {
    const res = await POST(peticion(RPC('tools/call', { name: 'metricas_flota', arguments: {} })));
    const r = await res.json();
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain('dinero');
  });

  it('una herramienta desconocida es -32602, no un isError', async () => {
    const res = await POST(peticion(RPC('tools/call', { name: 'no_existe', arguments: {} })));
    const r = await res.json();
    expect(r.error.code).toBe(-32602);
  });

  it('ping contesta, una notificación es 202 sin cuerpo, un lote se niega', async () => {
    const ping = await POST(peticion(RPC('ping')));
    expect((await ping.json()).result.resultType).toBe('complete');

    const notif = await POST(peticion(RPC('notifications/initialized', {}, null)));
    expect(notif.status).toBe(202);

    const lote = await POST(peticion([RPC('ping'), RPC('ping')]));
    expect(lote.status).toBe(400);
  });

  it('JSON roto es -32700 y un método inventado -32601', async () => {
    const roto = await POST(peticion('esto no es json {'));
    expect((await roto.json()).error.code).toBe(-32700);

    const raro = await POST(peticion(RPC('resources/list')));
    expect((await raro.json()).error.code).toBe(-32601);
  });
});

describe('los verbos que no existen', () => {
  it('GET y DELETE son 405 con Allow: POST (sin streams, sin sesiones)', () => {
    expect(GET().status).toBe(405);
    expect(GET().headers.get('Allow')).toBe('POST');
    expect(DELETE().status).toBe(405);
  });
});
