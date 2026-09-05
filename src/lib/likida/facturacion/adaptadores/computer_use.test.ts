// ═══════════════════════════════════════════════════════════════════════════
// LOS CANDADOS DEL ADAPTADOR QUE OPERA PORTALES NO ESCRITOS.
//
// Un modelo conduciendo el formulario de un portal fiscal puede hacer tres
// daños irreversibles, y los tres se prueban aquí SIN red, SIN portal y SIN
// llamar a ningún modelo: el ciclo del LLM se sustituye por un guion de tool
// calls, que es exactamente lo que un modelo devolvería.
//
// Se prueba lo que el código GARANTIZA, no lo que el prompt PIDE. Un candado
// que depende de que el modelo obedezca no es un candado, y una prueba que
// verifica el texto del prompt no prueba nada.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type OpenAI from 'openai';
import type { ToolExecutor } from '@/lib/llm/openrouter';
import type { MutationClaim } from '@/lib/llm/tool-idempotency';

/** Lo que el adaptador le pasó al ciclo del LLM en la última corrida. */
let capturadoTools: OpenAI.Chat.ChatCompletionTool[] = [];
let capturadoExecutor: ToolExecutor | null = null;
/** El guion: lo que el "modelo" decide llamar, en orden. */
let guion: Array<{ tool: string; args: Record<string, unknown> }> = [];
let textoFinal = '';

vi.mock('@/lib/llm/openrouter', () => ({
  generateWithTools: vi.fn(async (opts: {
    tools: OpenAI.Chat.ChatCompletionTool[]; toolExecutor: ToolExecutor;
  }) => {
    capturadoTools = opts.tools;
    capturadoExecutor = opts.toolExecutor;
    for (const paso of guion) await opts.toolExecutor(paso.tool, paso.args);
    return {
      finalText: textoFinal, toolCalls: guion.map((g) => ({ toolName: g.tool })),
      model: 'x', tokensIn: 0, tokensOut: 0, cost: 0, costoPorModelo: {},
    };
  }),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// AUDITORÍA 25 (BAJO, tool-calling.md:209): el candado durable de `emitir` —
// se mockea para controlar sus tres salidas (execute/cached/busy) sin montar
// Postgres, igual que el resto de este archivo no monta un portal real.
const { claimMutation, completeMutation, failMutation } = vi.hoisted(() => ({
  claimMutation: vi.fn<(tenantId: string, effectKey: string, toolName: string) => Promise<MutationClaim>>(
    async () => ({ kind: 'execute', token: 'tok-1' }),
  ),
  completeMutation: vi.fn(async (_t: string, _k: string, _tok: string, _r: unknown) => {}),
  failMutation: vi.fn(async (_t: string, _k: string, _tok: string, _err: string) => {}),
}));
vi.mock('@/lib/llm/tool-idempotency', () => ({ claimMutation, completeMutation, failMutation }));

const { AdaptadorComputerUse, extraerUuid } = await import('./computer_use');

/**
 * Las tools de tipo `function`, ya estrechadas.
 *
 * `ChatCompletionTool` es una UNIÓN en el SDK que fija el lockfile
 * (`function` | `custom`), así que `.function` no existe sobre la unión. Se
 * estrecha por el discriminante en vez de castear: un cast habría compilado y
 * reventado en tiempo de ejecución el día que llegue una tool `custom`.
 */
type ToolFuncion = Extract<OpenAI.Chat.ChatCompletionTool, { type: 'function' }>;
const funciones = (ts: OpenAI.Chat.ChatCompletionTool[]): ToolFuncion[] =>
  ts.filter((t): t is ToolFuncion => t.type === 'function');
const nombresDeTools = () => funciones(capturadoTools).map((t) => t.function.name);

/** Lo que el adaptador de verdad le hizo a la página. */
const escrito: Array<[string, string]> = [];
const clicado: string[] = [];

/** Una página falsa con las mismas manos que la real. */
const paginaFalsa = () => ({
  abrir: vi.fn(async () => {}),
  escribir: vi.fn(async (s: string, v: string) => { escrito.push([s, v]); }),
  seleccionar: vi.fn(async (s: string, v: string) => { escrito.push([s, v]); }),
  hacerClic: vi.fn(async (s: string) => { clicado.push(s); }),
  captura: vi.fn(async () => 'captura.jpg'),
  cerrar: vi.fn(async () => {}),
  pagina: { evaluate: vi.fn(async () => ({ campos: [], botones: [], texto: '' })) },
});

const RECEPTOR = {
  rfc: 'GMX0902279I1', nombre: 'G3M', codigoPostal: '97000',
  regimenFiscal: '601', usoCfdi: 'G03', correo: 'a@b.mx',
};
const CAMPOS = [{ clave: 'webId' as const, etiqueta: 'WebID', valor: '5498441008183', requerido: true }];

const armar = () => new AdaptadorComputerUse({
  tenantId: 't-1',
  comercio: 'megasur', portal: 'http://portal.example/',
  receptor: RECEPTOR,
  abrirPagina: async () => paginaFalsa() as never,
});

beforeEach(() => {
  escrito.length = 0; clicado.length = 0;
  guion = []; textoFinal = ''; capturadoTools = []; capturadoExecutor = null;
  claimMutation.mockReset().mockResolvedValue({ kind: 'execute', token: 'tok-1' });
  completeMutation.mockReset().mockResolvedValue(undefined);
  failMutation.mockReset().mockResolvedValue(undefined);
});

describe('el modelo NO puede inventar un dato fiscal', () => {
  it('una clave que no existe se rechaza y NO llega a la página', async () => {
    // Un modelo alucinando un RFC es el peor error posible de este producto:
    // acaba impreso en un CFDI irreversible.
    guion = [{ tool: 'escribir', args: { selector: '#rfc', clave: 'rfcDelCliente' } }];
    await armar().facturar(CAMPOS, 'ensayo');

    expect(escrito, 'nada debió escribirse').toHaveLength(0);
  });

  it('`escribir` solo acepta CLAVES, y el valor lo pone el sistema', async () => {
    guion = [{ tool: 'escribir', args: { selector: '#rfc', clave: 'rfc' } }];
    await armar().facturar(CAMPOS, 'ensayo');

    expect(escrito).toEqual([['#rfc', 'GMX0902279I1']]);
    // Y el esquema de la tool lo fija: `clave` es un enum cerrado, así que un
    // valor libre ni siquiera se puede expresar en la llamada.
    const escribir = funciones(capturadoTools).find((t) => t.function.name === 'escribir');
    const clave = (escribir?.function.parameters as { properties: { clave: { enum: string[] } } }).properties.clave;
    expect(clave.enum).toContain('webId');
    expect(clave.enum).not.toContain('monto'); // no se ofreció, no existe
  });
});

describe('el botón de emitir', () => {
  it('en ENSAYO la herramienta ni siquiera se le ofrece al modelo', async () => {
    await armar().facturar(CAMPOS, 'ensayo');
    // No es que se le pida que no la use: no está en su lista.
    expect(nombresDeTools()).not.toContain('emitir');
  });

  it('en EMITIR sí existe', async () => {
    await armar().facturar(CAMPOS, 'emitir');
    expect(nombresDeTools()).toContain('emitir');
  });

  it('si se emitió y no hay UUID, se declara `emisionSinConfirmar`', async () => {
    // La señal más cara: sin ella el ticket vuelve a la cola y se emite un
    // SEGUNDO CFDI por el mismo consumo.
    guion = [{ tool: 'emitir', args: { selector: '#facturar' } }];
    const r = await armar().facturar(CAMPOS, 'emitir');

    expect(r.ok).toBe(false);
    expect(r.emisionSinConfirmar).toBe(true);
  });

  it('con UUID en la pantalla, se cobra como emitido', async () => {
    guion = [{ tool: 'emitir', args: { selector: '#facturar' } }];
    textoFinal = 'Listo, UUID B0800A68-8565-47D9-90E0-CDA7803C50E4';
    const r = await armar().facturar(CAMPOS, 'emitir');

    expect(r.ok).toBe(true);
    // ARQ-19C2-5: normalizado a minúsculas, igual que `repo.ts`.
    expect(r.cfdiUuid).toBe('b0800a68-8565-47d9-90e0-cda7803c50e4');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 25 (BAJO, tool-calling.md:209) — `emitir` corre fuera del
// executor normal, así que este es el ÚNICO sitio del repo donde el candado
// de una-sola-vez de una mutación se prueba sin `tool-executor.test.ts`.
// ═══════════════════════════════════════════════════════════════════════════
describe('emitir lleva el mismo candado de una-sola-vez que las demás tools de escritura', () => {
  it('reclama el candado ANTES del clic, con la llave scoped al tenant, y lo sella al terminar', async () => {
    guion = [{ tool: 'emitir', args: { selector: '#facturar' } }];
    await armar().facturar(CAMPOS, 'emitir');

    expect(claimMutation).toHaveBeenCalledTimes(1);
    const [tenantId, llave, nombreTool] = claimMutation.mock.calls[0] as [string, string, string];
    expect(tenantId).toBe('t-1');
    expect(llave).toContain('megasur');
    expect(nombreTool).toBe('facturacion.computer_use.emitir');
    expect(clicado).toEqual(['#facturar']);
    expect(completeMutation).toHaveBeenCalledTimes(1);
    expect(completeMutation).toHaveBeenCalledWith('t-1', llave, 'tok-1', { clicado: true });
    expect(failMutation).not.toHaveBeenCalled();
  });

  it('un SEGUNDO emitir del MISMO ticket en la misma corrida (botón que sigue en el inventario) no vuelve a apretarlo: la RPC ya lo tiene "cached"', async () => {
    // Esto es exactamente lo que la RPC real devolvería tras el `completeMutation`
    // del primer intento: se mockea la secuencia, no se reinventa su SQL.
    claimMutation
      .mockResolvedValueOnce({ kind: 'execute', token: 'tok-1' })
      .mockResolvedValueOnce({ kind: 'cached', result: { clicado: true } });
    guion = [
      { tool: 'emitir', args: { selector: '#facturar' } },
      // El modelo insiste con OTRO selector del mismo botón — el caso que el
      // hallazgo describe como el más probable de los dos.
      { tool: 'emitir', args: { selector: '#facturar-reintento' } },
    ];
    await armar().facturar(CAMPOS, 'emitir');

    expect(clicado).toEqual(['#facturar']);   // nunca el segundo selector
    expect(completeMutation).toHaveBeenCalledTimes(1);   // no se vuelve a sellar
  });

  it('si la RPC dice "busy" (otra corrida está emitiendo este mismo ticket ahora), no se aprieta el botón', async () => {
    claimMutation.mockResolvedValueOnce({ kind: 'busy' });
    guion = [{ tool: 'emitir', args: { selector: '#facturar' } }];
    const r = await armar().facturar(CAMPOS, 'emitir');

    expect(clicado).toHaveLength(0);
    expect(r.ok).toBe(false);
  });

  it('si el clic falla, se sella como FALLO (no éxito) — no bloquea un reintento legítimo de este ticket', async () => {
    const pagina = paginaFalsa();
    pagina.hacerClic = vi.fn(async () => { throw new Error('timeout de red'); });
    guion = [{ tool: 'emitir', args: { selector: '#facturar' } }];

    await new AdaptadorComputerUse({
      tenantId: 't-1', comercio: 'megasur', portal: 'http://portal.example/',
      receptor: RECEPTOR, abrirPagina: async () => pagina as never,
    }).facturar(CAMPOS, 'emitir');

    expect(failMutation).toHaveBeenCalledTimes(1);
    expect(failMutation).toHaveBeenCalledWith('t-1', expect.any(String), 'tok-1', expect.stringContaining('timeout de red'));
    expect(completeMutation).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED: si Postgres no puede confirmar el candado fuera de pruebas, NO se aprieta el botón', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      claimMutation.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      guion = [{ tool: 'emitir', args: { selector: '#facturar' } }];
      const r = await armar().facturar(CAMPOS, 'emitir');

      expect(clicado).toHaveLength(0);
      expect(r.ok).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('en pruebas, si la RPC no está disponible, se degrada a SIN protección (para no exigir Postgres en cada prueba) — pero eso no es lo que corre en producción', async () => {
    claimMutation.mockRejectedValueOnce(new Error('supabaseAdmin no configurado'));
    guion = [{ tool: 'emitir', args: { selector: '#facturar' } }];
    await armar().facturar(CAMPOS, 'emitir');

    // Sin protección real, el clic SÍ ocurre — es la degradación de pruebas,
    // no la de producción (probada arriba).
    expect(clicado).toEqual(['#facturar']);
    // Y no se intenta sellar un candado que nunca se reclamó de verdad.
    expect(completeMutation).not.toHaveBeenCalled();
  });

  it('dos tickets DISTINTOS arman llaves de candado DISTINTAS (el candado es por ticket, no por comercio)', async () => {
    const camposB = [{ clave: 'webId' as const, etiqueta: 'WebID', valor: 'OTRO-TICKET-999', requerido: true }];
    guion = [{ tool: 'emitir', args: { selector: '#facturar' } }];

    await armar().facturar(CAMPOS, 'emitir');
    const llaveA = claimMutation.mock.calls[0][1] as string;

    claimMutation.mockClear();
    await armar().facturar(camposB, 'emitir');
    const llaveB = claimMutation.mock.calls[0][1] as string;

    expect(llaveA).not.toBe(llaveB);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RE-AUDITORÍA 25, FASE 3 (TC-CANDADO-CLIC-BYPASS, MEDIO) — el candado de
// arriba solo envolvía `case 'emitir'`. La tool hermana `clic` podía apretar
// EL MISMO botón físico sin pasar por `reclamarEmision`/`sellarEmision`.
// ═══════════════════════════════════════════════════════════════════════════
describe('TC-CANDADO-CLIC-BYPASS: `clic` sobre el botón de emisión lleva el MISMO candado que `emitir`', () => {
  it('un solo `clic` en el botón de emisión reclama y sella el candado — exactamente como `emitir`', async () => {
    guion = [{ tool: 'clic', args: { selector: '#facturar' } }];
    await armar().facturar(CAMPOS, 'emitir');

    expect(claimMutation).toHaveBeenCalledTimes(1);
    const [tenantId, llave, nombreTool] = claimMutation.mock.calls[0] as [string, string, string];
    expect(tenantId).toBe('t-1');
    expect(nombreTool).toBe('facturacion.computer_use.emitir');
    expect(clicado).toEqual(['#facturar']);
    expect(completeMutation).toHaveBeenCalledTimes(1);
    expect(completeMutation).toHaveBeenCalledWith('t-1', llave, 'tok-1', { clicado: true });
  });

  it('el bypass exacto del hallazgo: `emitir` primero y luego `clic` sobre el MISMO botón NO lo vuelve a apretar', async () => {
    claimMutation
      .mockResolvedValueOnce({ kind: 'execute', token: 'tok-1' })
      .mockResolvedValueOnce({ kind: 'cached', result: { clicado: true } });
    guion = [
      { tool: 'emitir', args: { selector: '#facturar' } },
      // El modelo, en vez de reintentar con `emitir`, usa `clic` sobre el
      // botón que sigue en el inventario — la ruta que antes NO pasaba por
      // el candado.
      { tool: 'clic', args: { selector: '#facturar' } },
    ];
    await armar().facturar(CAMPOS, 'emitir');

    expect(clicado).toEqual(['#facturar']);              // un solo clic físico
    expect(completeMutation).toHaveBeenCalledTimes(1);    // no se vuelve a sellar
  });

  it('si la llave de emisión coincide con "busy", `clic` tampoco aprieta el botón', async () => {
    claimMutation.mockResolvedValueOnce({ kind: 'busy' });
    guion = [{ tool: 'clic', args: { selector: '#facturar' } }];
    await armar().facturar(CAMPOS, 'emitir');

    expect(clicado).toHaveLength(0);
  });

  it('CONTROL — `clic` en un botón que NO es el de emisión sigue sin candado (no rompe el uso normal de `clic`)', async () => {
    guion = [{ tool: 'clic', args: { selector: '#validar' } }];
    await armar().facturar(CAMPOS, 'emitir');

    expect(clicado).toEqual(['#validar']);
    expect(claimMutation).not.toHaveBeenCalled();
  });

  it('CONTROL — "ver factura"/"descargar factura" no disparan el candado: solo la ACCIÓN de emitir, no la palabra "factura"', async () => {
    guion = [{ tool: 'clic', args: { selector: 'a:has-text("Descargar factura")' } }];
    await armar().facturar(CAMPOS, 'emitir');

    expect(clicado).toEqual(['a:has-text("Descargar factura")']);
    expect(claimMutation).not.toHaveBeenCalled();
  });
});

describe('lo que no se toca nunca', () => {
  it('el checkbox de partidos políticos se niega, aunque el modelo insista', async () => {
    // Marcarlo convierte el CFDI en un donativo a un partido. Ya estaba
    // prohibido por nombre en el adaptador de CAPUFE; aquí se generaliza.
    guion = [{ tool: 'clic', args: { selector: '#checkPartidoPolitico' } }];
    await armar().facturar(CAMPOS, 'emitir');

    expect(clicado).toHaveLength(0);
  });

  it('CONTROL — un botón normal sí se aprieta', async () => {
    guion = [{ tool: 'clic', args: { selector: '#validar' } }];
    await armar().facturar(CAMPOS, 'ensayo');

    expect(clicado).toEqual(['#validar']);
  });
});

describe('rendirse dice POR QUÉ, y el captcha se declara aparte', () => {
  it('un captcha no es "no pude": es "no se puede", y sale marcado', async () => {
    // `requiereCaptcha` es lo que separa reintentar cada hora contra el mismo
    // muro, de mandarlo con una persona. Ver `pideCaptcha()` en agente.ts.
    guion = [{ tool: 'rendirse', args: { motivo: 'el portal pide CAPTCHA' } }];
    const r = await armar().facturar(CAMPOS, 'ensayo');

    expect(r.ok).toBe(false);
    expect(r.requiereCaptcha).toBe(true);
    expect(r.error).toMatch(/captcha/i);
  });

  it('rendirse por otra razón NO se marca como captcha', async () => {
    guion = [{ tool: 'rendirse', args: { motivo: 'el portal pide un dato que no tengo' } }];
    const r = await armar().facturar(CAMPOS, 'ensayo');

    expect(r.ok).toBe(false);
    expect(r.requiereCaptcha).toBeUndefined();
    expect(r.error).toContain('no tengo');
  });
});

describe('los <select> del portal', () => {
  it('se eligen por valor y quedan en `capturado`, que es lo que hace auditable el ensayo', async () => {
    guion = [{ tool: 'seleccionar', args: { selector: '#regimen', valor: '601' } }];
    const r = await armar().facturar(CAMPOS, 'ensayo');

    expect(escrito).toEqual([['#regimen', '601']]);
    expect(r.capturado['#regimen']).toBe('601');
  });
});

describe('un fallo del portal no revienta el ciclo', () => {
  it('vuelve como texto para que el modelo corrija, no como excepción', async () => {
    guion = [];
    await armar().facturar(CAMPOS, 'ensayo');
    const ejecutor = capturadoExecutor!;
    // Selector inexistente: la página real lanza. El ciclo tiene que sobrevivir.
    const r = await ejecutor('escribir', { selector: '#noExiste', clave: 'rfc' });
    expect(r).toHaveProperty('durationMs');
  });
});

describe('extraerUuid', () => {
  // ARQ-19C2-5: `repo.ts` normaliza a MINÚSCULAS antes de comparar/guardar
  // (`.toLowerCase()`) — este adaptador debe entregar el mismo formato.
  it('lo encuentra donde sea y lo normaliza a minúsculas', () => {
    expect(extraerUuid('folio B0800A68-8565-47D9-90E0-CDA7803C50E4 ok'))
      .toBe('b0800a68-8565-47d9-90e0-cda7803c50e4');
  });
  it('sin UUID devuelve null en vez de inventar uno', () => {
    expect(extraerUuid('se emitió correctamente')).toBeNull();
  });
});
