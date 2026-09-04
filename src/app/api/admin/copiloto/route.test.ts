import { peticionStream } from '@/lib/pruebas/peticion_stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// LA PUERTA DE /api/admin/copiloto — lo que se fija:
//  1. Sin sesión 401, con sesión de otro rol 403, y en ninguno se dice qué
//     hay detrás (una ruta /api no pasa por el layout: es su propia puerta).
//  2. EJECUTAR exige el AdminActionIntent que el SERVIDOR creó al proponer
//     (copiloto-intents.ts): sin intent —el viejo `confirmado: true`
//     incluido—, expirado, ajeno, reusado o con args cambiados → 409/400,
//     sin tocar el ejecutor. El booleano del cliente dejó de ser autoridad.
//  3. La acción corre con el userId DE LA SESIÓN, jamás del cuerpo.
//  4. `gateo: 'doble'` = motivo obligatorio + DOS POSTs con el mismo intent.
// El módulo de intents NO se mockea: estas pruebas ejercitan el ciclo real
// proponer → intent → ejecutar a través del route.
// ═══════════════════════════════════════════════════════════════════════════

let sesion: { userId: string; tenantId: string | null; rol: string } | null = null;
vi.mock('@/lib/auth/session', () => ({ getSessionTenant: async () => sesion }));
// La palanca del copiloto (0250): encendida por default en toda la suite —
// sin este mock, `estaApagado` truena contra el supabase de mentiras y el
// fail-closed contesta 503 a todas las pruebas.
const palancaCopilotoApagada = vi.fn(async () => false);
vi.mock('@/lib/likida/interruptores', () => ({ estaApagado: () => palancaCopilotoApagada() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// El step-up (fase 7): por default pasa (usuario sin factor); cada prueba
// que lo necesite lo aprieta.
const stepUp = vi.fn(async (): Promise<{ ok: true } | { ok: false; motivo: 'verificar' }> => ({ ok: true }));
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: async () => ({}) }));
vi.mock('@/lib/auth/mfa', () => ({
  exigirAal2SiHayFactor: () => stepUp(),
  MSG_STEP_UP: 'Esta acción exige tu segundo factor',
  MSG_MFA_NO_VERIFICABLE: 'No pude comprobar tu segundo factor',
  // SEG-3 (auditoría 24) vía `@/lib/auth/api-superadmin` (auditoría 25, línea
  // 166): apagada por default, igual que en el resto de la suite — estas
  // pruebas no ejercitan esa palanca, solo el step-up de la acción.
  mfaSuperadminObligatorio: () => false,
  veredictoMfaSuperadmin: async () => 'ok',
}));

const ejecutarAccionCopiloto = vi.fn(async (..._a: unknown[]) => ({ ok: true, mensaje: 'hecho' }));
vi.mock('@/lib/agents/copiloto-acciones', () => ({
  ejecutarAccionCopiloto: (...a: unknown[]) => ejecutarAccionCopiloto(...a),
  // El catálogo REAL no se mockea en espíritu: el route solo lee `gateo`
  // para el step-up. Se declara chico y fiel a los ids que estas pruebas usan.
  CATALOGO_ACCIONES: [
    { id: 'apagar_agente', gateo: 'confirma', implementada: true },
    // ADM-13 (auditoría 24, MEDIO): `correr_runner` puede disparar al
    // `enviador` (correo real por su cuenta, sin borrador que revisar) —
    // exigía la MISMA confirmación de un solo POST que "apagar una
    // palanca". Pasa a 'doble' (motivo + dos POSTs + step-up MFA), mismo
    // nivel que las acciones con efecto legal/de dinero.
    { id: 'correr_runner', gateo: 'doble', implementada: true },
    { id: 'encender_agente', gateo: 'doble', implementada: false },
  ],
}));
interface RespuestaMock {
  bloques: Array<Record<string, unknown>>;
  toolsUsadas: string[]; costoUsd: number; tokensIn: number; tokensOut: number; modelo: string;
}
const ejecutarCopiloto = vi.fn(async (..._a: unknown[]): Promise<RespuestaMock> => ({
  bloques: [{ tipo: 'texto', texto: 'hola' }], toolsUsadas: [], costoUsd: 0, tokensIn: 0, tokensOut: 0, modelo: 'prueba',
}));
vi.mock('@/lib/agents/copiloto', () => ({
  ejecutarCopiloto: (...a: unknown[]) => ejecutarCopiloto(...a),
}));
const guardarIntercambioCopiloto = vi.fn(async (..._a: unknown[]) => 'conv-guardada');
vi.mock('@/lib/agents/copiloto-historial', () => ({
  guardarIntercambioCopiloto: (...a: unknown[]) => guardarIntercambioCopiloto(...a),
}));

// El freno de turnos (16-ago): mockeado con permiso por default para que la
// puerta y las acciones se prueben sin tropezarse con el limiter local; los
// casos del tope lo ponen en false a propósito.
const rateLimit = vi.fn(async (_k: string, _l: number, _w: number) => true);
vi.mock('@/lib/ratelimit', () => ({ rateLimit: (...a: [string, number, number]) => rateLimit(...a) }));

const { POST } = await import('./route');
// El MISMO módulo de intents que usa el route (sin mock): crear aquí un
// intent es exactamente lo que hace el camino de proponer.
const { crearIntent, INTENT_TTL_MS, _vaciarIntentsParaPruebas } = await import('@/lib/agents/copiloto-intents');

const pedir = (cuerpo: unknown) => new Request('https://app.likida.ai/api/admin/copiloto', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
});

/** El bloque `accion` que el copiloto (mockeado) propone en estas pruebas. */
const BLOQUE_ACCION = {
  tipo: 'accion', accion: 'apagar_agente', gateo: 'confirma', implementada: true,
  objetivo: 'agente:cobranza', efecto: 'corta la corrida', revertir: 'encender', motivoSugerido: null,
};

/** Corre el camino de PROPONER (el chat) y devuelve el bloque accion del
 *  'fin' — con el intentId que el servidor le acaba de crear. */
async function proponer(): Promise<Record<string, unknown>> {
  ejecutarCopiloto.mockResolvedValueOnce({
    bloques: [{ tipo: 'texto', texto: 'previsualización lista' }, BLOQUE_ACCION],
    toolsUsadas: ['proponer_accion'], costoUsd: 0, tokensIn: 0, tokensOut: 0, modelo: 'prueba',
  });
  const r = await POST(pedir({ mensajes: [{ rol: 'usuario', texto: 'apaga cobranza' }] }));
  const eventos = (await r.text()).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const fin = eventos[eventos.length - 1] as { bloques: Array<Record<string, unknown>> };
  return fin.bloques.find((b) => b.tipo === 'accion')!;
}

beforeEach(() => {
  sesion = { userId: 'u-javier', tenantId: 'tenant-plataforma', rol: 'superadmin' };
  ejecutarAccionCopiloto.mockClear();
  ejecutarCopiloto.mockClear();
  guardarIntercambioCopiloto.mockClear();
  guardarIntercambioCopiloto.mockResolvedValue('conv-guardada');
  _vaciarIntentsParaPruebas();
  stepUp.mockClear();
  stepUp.mockImplementation(async () => ({ ok: true }));
  rateLimit.mockReset();
  rateLimit.mockImplementation(async () => true);
  palancaCopilotoApagada.mockReset();
  palancaCopilotoApagada.mockResolvedValue(false);
});

describe('la puerta', () => {
  it('sin sesión: 401 sin cuerpo', async () => {
    sesion = null;
    const r = await POST(pedir({ mensajes: [{ rol: 'usuario', texto: 'hola' }] }));
    expect(r.status).toBe(401);
    expect(ejecutarCopiloto).not.toHaveBeenCalled();
  });

  it('con sesión de flota_admin: 403 — el copiloto es SOLO del superadmin', async () => {
    sesion = { userId: 'u-cliente', tenantId: 'tenant-cliente', rol: 'flota_admin' };
    const r = await POST(pedir({ mensajes: [{ rol: 'usuario', texto: 'hola' }] }));
    expect(r.status).toBe(403);
    expect(ejecutarCopiloto).not.toHaveBeenCalled();
  });

  it('la palanca agente:copiloto apagada: 503 con la puerta dicha, sin modelo NI acciones', async () => {
    // 0250: la interfaz de mando también se calla con un click. El 503 corta
    // los DOS caminos (chat y acción con intent) antes de gastar nada.
    palancaCopilotoApagada.mockResolvedValue(true);
    const chat = await POST(pedir({ mensajes: [{ rol: 'usuario', texto: 'hola' }] }));
    expect(chat.status).toBe(503);
    expect(((await chat.json()) as { error: string }).error).toContain('apagado');
    const accion = await POST(pedir({ intentId: 'x', accion: { id: 'apagar_agente', objetivo: 'agente:cobranza' } }));
    expect(accion.status).toBe(503);
    expect(ejecutarCopiloto).not.toHaveBeenCalled();
    expect(ejecutarAccionCopiloto).not.toHaveBeenCalled();
  });
});

describe('la puerta de origen (auditoría 21, BAJO-MEDIO — mismo patrón que /api/admin/palette)', () => {
  it('desde otro sitio: 403 y NI el chat NI una acción con intent se tocan', async () => {
    const cabeceras = { 'Content-Type': 'application/json', 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' };
    const chat = await POST(new Request('https://app.likida.ai/api/admin/copiloto', {
      method: 'POST', headers: cabeceras, body: JSON.stringify({ mensajes: [{ rol: 'usuario', texto: 'hola' }] }),
    }));
    expect(chat.status).toBe(403);
    expect(ejecutarCopiloto).not.toHaveBeenCalled();

    const accion = await POST(new Request('https://app.likida.ai/api/admin/copiloto', {
      method: 'POST', headers: cabeceras, body: JSON.stringify({ intentId: 'x', accion: { id: 'apagar_agente', objetivo: 'agente:cobranza' } }),
    }));
    expect(accion.status).toBe(403);
    expect(ejecutarAccionCopiloto).not.toHaveBeenCalled();
  });

  it('se contesta 403 sin mirar siquiera si el usuario es superadmin', async () => {
    const cruzada = () => POST(new Request('https://app.likida.ai/api/admin/copiloto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ mensajes: [{ rol: 'usuario', texto: 'hola' }] }),
    }));
    sesion = null;
    const sinSesion = await cruzada();
    sesion = { userId: 'u-javier', tenantId: 'tenant-plataforma', rol: 'superadmin' };
    const conSesion = await cruzada();
    expect(sinSesion.status).toBe(conSesion.status);
    expect(conSesion.status).toBe(403);
  });
});

describe('la acción con intent (AdminActionIntent)', () => {
  const ACCION = { id: 'apagar_agente', objetivo: 'agente:cobranza', motivo: 'manda de más' };

  it('al PROPONER, el servidor crea el intent: el bloque accion del fin trae intentId', async () => {
    const bloque = await proponer();
    expect(typeof bloque.intentId).toBe('string');
    expect((bloque.intentId as string).length).toBeGreaterThan(0);
  });

  it('el viejo `confirmado: true` sin intent ya NO ejecuta — 409 sin tocar el ejecutor', async () => {
    const r = await POST(pedir({ accion: ACCION, confirmado: true, userId: 'u-atacante' }));
    expect(r.status).toBe(409);
    expect(ejecutarAccionCopiloto).not.toHaveBeenCalled();
  });

  it('con el intent de la propuesta: ejecuta UNA vez, con el userId DE LA SESIÓN', async () => {
    const bloque = await proponer();
    const r = await POST(pedir({ intentId: bloque.intentId, accion: ACCION, userId: 'u-atacante' }));
    expect(r.status).toBe(200);
    expect(ejecutarAccionCopiloto).toHaveBeenCalledTimes(1);
    expect(ejecutarAccionCopiloto).toHaveBeenCalledWith(
      'apagar_agente',
      { id: 'agente:cobranza', motivo: 'manda de más' },
      'u-javier',
    );
  });

  it('REPLAY: el mismo intent dos veces → 409 y una sola ejecución', async () => {
    const bloque = await proponer();
    const r1 = await POST(pedir({ intentId: bloque.intentId, accion: ACCION }));
    expect(r1.status).toBe(200);
    const r2 = await POST(pedir({ intentId: bloque.intentId, accion: ACCION }));
    expect(r2.status).toBe(409);
    const cuerpo = await r2.json() as { error: string };
    expect(cuerpo.error).toContain('pide la acción de nuevo');
    expect(ejecutarAccionCopiloto).toHaveBeenCalledTimes(1);
  });

  it('intent EXPIRADO (2 min) → 409 con instrucción de re-proponer', async () => {
    // Nacido hace TTL+1 ms: el mismo Map real, sin reloj falso.
    const viejo = await crearIntent({
      actorId: 'u-javier', accion: 'apagar_agente', objetivo: 'agente:cobranza',
      gateo: 'confirma', ahoraMs: Date.now() - INTENT_TTL_MS - 1,
    });
    const r = await POST(pedir({ intentId: viejo.id, accion: ACCION }));
    expect(r.status).toBe(409);
    expect(ejecutarAccionCopiloto).not.toHaveBeenCalled();
  });

  it('intent de OTRO actor → 409: la sesión que confirma es la que lo pidió', async () => {
    const ajeno = await crearIntent({
      actorId: 'u-otro-superadmin', accion: 'apagar_agente', objetivo: 'agente:cobranza', gateo: 'confirma',
    });
    const r = await POST(pedir({ intentId: ajeno.id, accion: ACCION }));
    expect(r.status).toBe(409);
    expect(ejecutarAccionCopiloto).not.toHaveBeenCalled();
  });

  it('args CAMBIADOS respecto de la previsualización → 409 sin ejecutar', async () => {
    const bloque = await proponer(); // propuso agente:cobranza
    const r = await POST(pedir({
      intentId: bloque.intentId,
      accion: { id: 'apagar_agente', objetivo: 'agente:proveedores', motivo: 'x' },
    }));
    expect(r.status).toBe(409);
    const cuerpo = await r.json() as { error: string };
    expect(cuerpo.error).toContain('no coincide');
    expect(ejecutarAccionCopiloto).not.toHaveBeenCalled();
  });
});

describe("step-up (fase 7): el 'doble' con factor inscrito exige AAL2", () => {
  it('sesión en AAL1 → 403 con instrucción, SIN gastar el intent', async () => {
    stepUp.mockImplementation(async () => ({ ok: false, motivo: 'verificar' }));
    const i = await crearIntent({ actorId: 'u-javier', accion: 'encender_agente', objetivo: 'agente:cobranza', gateo: 'doble' });
    const r = await POST(pedir({ intentId: i.id, accion: { id: 'encender_agente', objetivo: 'agente:cobranza', motivo: 'x' } }));
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toContain('segundo factor');
    expect(ejecutarAccionCopiloto).not.toHaveBeenCalled();
    // El intent NO se quemó: verificado el factor, el MISMO intent arma.
    stepUp.mockImplementation(async () => ({ ok: true }));
    const r2 = await POST(pedir({ intentId: i.id, accion: { id: 'encender_agente', objetivo: 'agente:cobranza', motivo: 'x' } }));
    expect(r2.status).toBe(200);
  });
});

describe("gateo 'doble' — dos POSTs con el mismo intent, motivo obligatorio", () => {
  const DOBLE = { id: 'encender_agente', objetivo: 'agente:cobranza' };
  const intentDoble = async () => crearIntent({
    actorId: 'u-javier', accion: 'encender_agente', objetivo: 'agente:cobranza', gateo: 'doble',
  });

  it('sin motivo NO se arma: 400 y el ejecutor ni se toca', async () => {
    const i = await intentDoble();
    const r = await POST(pedir({ intentId: i.id, accion: { ...DOBLE, motivo: '  ' } }));
    expect(r.status).toBe(400);
    const cuerpo = await r.json() as { error: string };
    expect(cuerpo.error).toContain('motivo');
    expect(ejecutarAccionCopiloto).not.toHaveBeenCalled();
  });

  it('primer POST ARMA sin ejecutar; el segundo ejecuta con el motivo del armado', async () => {
    const i = await intentDoble();
    const r1 = await POST(pedir({ intentId: i.id, accion: { ...DOBLE, motivo: 'lo pidió el cliente' } }));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ ok: true, armado: true });
    expect(ejecutarAccionCopiloto).not.toHaveBeenCalled();

    const r2 = await POST(pedir({ intentId: i.id, accion: { ...DOBLE, motivo: 'texto cambiado' } }));
    expect(r2.status).toBe(200);
    expect(ejecutarAccionCopiloto).toHaveBeenCalledTimes(1);
    expect(ejecutarAccionCopiloto).toHaveBeenCalledWith(
      'encender_agente',
      { id: 'agente:cobranza', motivo: 'lo pidió el cliente' },
      'u-javier',
    );
  });

  it("'apagar_agente' ('confirma') sigue ejecutando con UN solo intent", async () => {
    // La declaración del catálogo real: apagar_agente es 'confirma' — el
    // flujo de un POST le basta (el de arriba lo prueba vía proponer();
    // ver el describe de ADM-13 más abajo para correr_runner, que ahora
    // es 'doble').
    const i = await crearIntent({ actorId: 'u-javier', accion: 'apagar_agente', objetivo: 'agente:cobranza', gateo: 'confirma' });
    const r = await POST(pedir({ intentId: i.id, accion: { id: 'apagar_agente', objetivo: 'agente:cobranza', motivo: 'manda de más' } }));
    expect(r.status).toBe(200);
    expect(ejecutarAccionCopiloto).toHaveBeenCalledTimes(1);
    expect(ejecutarAccionCopiloto).toHaveBeenCalledWith(
      'apagar_agente',
      { id: 'agente:cobranza', motivo: 'manda de más' },
      'u-javier',
    );
  });
});

// ADM-13 (auditoría 24, MEDIO) — `correr_runner` puede disparar al
// `enviador` (correo real, sin borrador que revisar) y hasta esta ronda
// exigía la misma confirmación de un clic que apagar una palanca. Ahora
// exige lo mismo que `encender_agente`: motivo + DOS POSTs + step-up MFA.
describe("ADM-13 — correr_runner ahora es 'doble': un solo POST NO ejecuta", () => {
  it('un solo POST con motivo ARMA (no ejecuta); el segundo POST ejecuta', async () => {
    const i = await crearIntent({ actorId: 'u-javier', accion: 'correr_runner', objetivo: 'runner', gateo: 'doble' });
    const r1 = await POST(pedir({ intentId: i.id, accion: { id: 'correr_runner', objetivo: 'runner', motivo: 'adelantar el cron' } }));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ ok: true, armado: true });
    expect(ejecutarAccionCopiloto).not.toHaveBeenCalled();

    const r2 = await POST(pedir({ intentId: i.id, accion: { id: 'correr_runner', objetivo: 'runner', motivo: 'texto cambiado' } }));
    expect(r2.status).toBe(200);
    expect(ejecutarAccionCopiloto).toHaveBeenCalledTimes(1);
    expect(ejecutarAccionCopiloto).toHaveBeenCalledWith(
      'correr_runner',
      { id: 'runner', motivo: 'adelantar el cron' },
      'u-javier',
    );
  });

  it('sin motivo NO arma: 400, el ejecutor ni se toca', async () => {
    const i = await crearIntent({ actorId: 'u-javier', accion: 'correr_runner', objetivo: 'runner', gateo: 'doble' });
    const r = await POST(pedir({ intentId: i.id, accion: { id: 'correr_runner', objetivo: 'runner', motivo: '  ' } }));
    expect(r.status).toBe(400);
    expect(ejecutarAccionCopiloto).not.toHaveBeenCalled();
  });

  it('con AAL1 (segundo factor inscrito, sin verificar) → 403, SIN gastar el intent', async () => {
    stepUp.mockImplementation(async () => ({ ok: false, motivo: 'verificar' }));
    const i = await crearIntent({ actorId: 'u-javier', accion: 'correr_runner', objetivo: 'runner', gateo: 'doble' });
    const r = await POST(pedir({ intentId: i.id, accion: { id: 'correr_runner', objetivo: 'runner', motivo: 'x' } }));
    expect(r.status).toBe(403);
    expect(ejecutarAccionCopiloto).not.toHaveBeenCalled();
    stepUp.mockImplementation(async () => ({ ok: true }));
  });
});

describe('el chat', () => {
  it('mensajes válidos: corre el copiloto y el stream termina con los bloques', async () => {
    const r = await POST(pedir({ mensajes: [{ rol: 'usuario', texto: '¿qué espera decisión hoy?' }] }));
    expect(r.status).toBe(200);
    const texto = await r.text();
    const eventos = texto.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(eventos[eventos.length - 1]).toMatchObject({ t: 'fin' });
    expect(ejecutarCopiloto).toHaveBeenCalledTimes(1);
  });

  it('mensajes malformados: 400 sin gastar en el modelo', async () => {
    const r = await POST(pedir({ mensajes: [{ rol: 'asistente', texto: 'yo primero' }] }));
    expect(r.status).toBe(400);
    expect(ejecutarCopiloto).not.toHaveBeenCalled();
  });
});

describe('el historial (0121)', () => {
  const UUID = '11111111-2222-3333-4444-555555555555';

  it('el intercambio se persiste con el userId DE LA SESIÓN y el fin trae el id', async () => {
    const r = await POST(pedir({
      mensajes: [{ rol: 'usuario', texto: '¿qué espera decisión hoy?' }],
      conversacionId: UUID,
    }));
    const eventos = (await r.text()).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(eventos[eventos.length - 1]).toMatchObject({ t: 'fin', conversacionId: 'conv-guardada' });
    expect(guardarIntercambioCopiloto).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u-javier',
      conversacionId: UUID,
      pregunta: '¿qué espera decisión hoy?',
    }));
  });

  it('un conversacionId basura viaja como null (conversación nueva), no a la base', async () => {
    // El cuerpo se CONSUME (como en los demás casos): la respuesta es un
    // stream y el guardado corre dentro de él — sin leerlo, el aserto
    // llegaría antes que el trabajo.
    const r = await POST(pedir({
      mensajes: [{ rol: 'usuario', texto: 'hola' }],
      conversacionId: "'; drop table copiloto_conversacion; --",
    }));
    await r.text();
    expect(guardarIntercambioCopiloto).toHaveBeenCalledWith(expect.objectContaining({ conversacionId: null }));
  });

  it('si guardar revienta, la respuesta IGUAL sale — el historial es comodidad', async () => {
    guardarIntercambioCopiloto.mockRejectedValueOnce(new Error('base caída'));
    const r = await POST(pedir({ mensajes: [{ rol: 'usuario', texto: 'hola' }] }));
    const eventos = (await r.text()).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const fin = eventos[eventos.length - 1];
    expect(fin.t).toBe('fin');
    expect(fin.bloques).toEqual([{ tipo: 'texto', texto: 'hola' }]);
    expect(fin.conversacionId).toBeNull();
  });
});

describe('el freno de gasto (16-ago) — el único camino LLM que no tenía techo', () => {
  it('superadmin sin tenant de presupuesto: 503 sin modelo ni turno diario, conserva cuota corta', async () => {
    sesion = { userId: 'u-javier', tenantId: null, rol: 'superadmin' };
    const res = await POST(pedir({ mensajes: [{ rol: 'usuario', texto: 'hola' }] }));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ codigo: 'copiloto_presupuesto_sin_tenant' });
    expect(rateLimit).toHaveBeenCalledTimes(1);
    expect(rateLimit).toHaveBeenCalledWith('copiloto:min:u-javier', 20, 60_000);
    expect(ejecutarCopiloto).not.toHaveBeenCalled();
  });

  it('tope por minuto: 429 y se DICE cuál tope pegó, sin ejecutar el modelo', async () => {
    rateLimit.mockImplementationOnce(async () => false); // el de :min es la primera llamada
    const res = await POST(pedir({ mensajes: [{ rol: 'usuario', texto: 'hola' }] }));
    expect(res.status).toBe(429);
    const cuerpo = await res.json() as { error: string };
    expect(cuerpo.error).toContain('minuto');
    expect(ejecutarCopiloto).not.toHaveBeenCalled();
  });

  it('tope diario de turnos: 429 nombrando el override, sin gastar', async () => {
    rateLimit
      .mockImplementationOnce(async () => true)   // :min pasa
      .mockImplementationOnce(async () => false); // :dia frena
    const res = await POST(pedir({ mensajes: [{ rol: 'usuario', texto: 'hola' }] }));
    expect(res.status).toBe(429);
    const cuerpo = await res.json() as { error: string };
    expect(cuerpo.error).toContain('LIKIDA_COPILOTO_TOPE_TURNOS_DIA');
    expect(ejecutarCopiloto).not.toHaveBeenCalled();
  });

  it('el freno cuenta por userId de SESIÓN — la llave no sale del cuerpo', async () => {
    rateLimit.mockClear();
    await POST(pedir({ mensajes: [{ rol: 'usuario', texto: 'hola' }] }));
    const llaves = rateLimit.mock.calls.map((c) => c[0]);
    expect(llaves).toContain('copiloto:min:u-javier');
    expect(llaves).toContain('copiloto:dia:u-javier');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 18 · M29 y M23 — el gasto del turno que truena se anota, y el
// borde del POST tiene reloj: ni un historial colgado ni un intent lento
// dejan el stream sin 'fin'.
// ═══════════════════════════════════════════════════════════════════════════
const { logger: logMock } = await import('@/lib/logger');
const { PartialExecutionError } = await import('@/lib/llm/openrouter');

describe('M29 — el turno que truena también se contabiliza', () => {
  it('PartialExecutionError con tokens → copiloto.costo modelo "parcial" con lo pagado, y el stream termina en error', async () => {
    (logMock.info as ReturnType<typeof vi.fn>).mockClear();
    ejecutarCopiloto.mockRejectedValueOnce(new PartialExecutionError('Ciclo de tools excedió 5 rondas', null, [
      { toolName: 'metrica_negocio', args: {}, result: {}, durationMs: 1 },
    ], 38_000, 700, 0.0123));
    const r = await POST(pedir({ mensajes: [{ rol: 'usuario', texto: '¿cómo va el negocio?' }] }));
    const eventos = (await r.text()).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(eventos[eventos.length - 1]).toMatchObject({ t: 'error' });
    expect(logMock.info).toHaveBeenCalledWith('copiloto.costo', expect.objectContaining({
      costoUsd: 0.0123, tokensIn: 38_000, tokensOut: 700, modelo: 'parcial', tools: 1, fallo: true,
    }));
  });

  it('un error SIN consumo (abort antes de la primera completion) no inventa una línea de costo', async () => {
    (logMock.info as ReturnType<typeof vi.fn>).mockClear();
    ejecutarCopiloto.mockRejectedValueOnce(new PartialExecutionError('abort', null, [], 0, 0, 0));
    const r = await POST(pedir({ mensajes: [{ rol: 'usuario', texto: 'hola' }] }));
    await r.text();
    expect(logMock.info).not.toHaveBeenCalledWith('copiloto.costo', expect.anything());
  });
});

describe('M23 — el borde del POST tiene reloj propio', () => {
  it('un historial que se CUELGA no detiene el fin: sale con conversacionId null dentro del plazo', async () => {
    vi.stubEnv('LIKIDA_COPILOTO_PLAZO_HISTORIAL_MS', '30');
    guardarIntercambioCopiloto.mockImplementationOnce(() => new Promise(() => { /* nunca resuelve */ }));
    const inicio = Date.now();
    const r = await POST(pedir({ mensajes: [{ rol: 'usuario', texto: 'hola' }] }));
    const eventos = (await r.text()).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    vi.unstubAllEnvs();
    expect(Date.now() - inicio).toBeLessThan(2_000);
    const fin = eventos[eventos.length - 1];
    expect(fin.t).toBe('fin');
    expect(fin.conversacionId).toBeNull();
    expect(fin.bloques).toEqual([{ tipo: 'texto', texto: 'hola' }]);
    expect(logMock.error).toHaveBeenCalledWith('copiloto.guardar_fallo', expect.objectContaining({ err: expect.stringContaining('plazo') }));
  });

  it('el costo se anota ANTES del historial: aunque guardar reviente, copiloto.costo ya quedó', async () => {
    (logMock.info as ReturnType<typeof vi.fn>).mockClear();
    guardarIntercambioCopiloto.mockRejectedValueOnce(new Error('base caída'));
    const r = await POST(pedir({ mensajes: [{ rol: 'usuario', texto: 'hola' }] }));
    await r.text();
    expect(logMock.info).toHaveBeenCalledWith('copiloto.costo', expect.objectContaining({ modelo: 'prueba' }));
  });
});

describe('cuerpo acotado durante lectura', () => {
 it('cancela el exceso sin efectos', async()=>{
  const p=peticionStream('https://app.likida.ai/api/admin/copiloto',JSON.stringify({...{ mensajes:[{rol:'usuario',texto:'hola'}] },ignorado:'x'.repeat(700000)}),8192);
  expect((await POST(p.req)).status).toBe(413);
  expect(p.estado().cancelado).toBe(true);expect(p.estado().leidos).toBeLessThan(p.estado().total);
  expect(ejecutarCopiloto).not.toHaveBeenCalled();expect(ejecutarAccionCopiloto).not.toHaveBeenCalled();
 });
 it.each([null, [], 'texto', 42].map((valor) => [valor]))('rechaza cuerpo no objeto %j antes de efectos', async(cuerpo)=>{
  const p=peticionStream('https://app.likida.ai/api/admin/copiloto',JSON.stringify(cuerpo));
  expect((await POST(p.req)).status).toBe(400);expect(ejecutarCopiloto).not.toHaveBeenCalled();expect(ejecutarAccionCopiloto).not.toHaveBeenCalled();
 });
});

it.each(['chat','accion'])('cuota agotada %s no lee cuerpo ni cuota diaria',async(camino)=>{
 rateLimit.mockResolvedValue(false);
 const cuerpo=camino==='chat'?{mensajes:[{rol:'usuario',texto:'hola'}]}:{accion:{id:'apagar_agente'},intentId:'x'};
 const p=peticionStream('https://app.likida.ai/api/admin/copiloto',JSON.stringify(cuerpo));
 expect((await POST(p.req)).status).toBe(429);expect(p.estado().leidos).toBe(0);
 expect(rateLimit).toHaveBeenCalledTimes(1);expect(ejecutarCopiloto).not.toHaveBeenCalled();expect(ejecutarAccionCopiloto).not.toHaveBeenCalled();
});
it('24 turnos máximos con Unicode escapado siguen entrando',async()=>{
 const mensajes=Array.from({length:24},()=>({rol:'usuario',texto:'漢'.repeat(2000)}));
 const p=peticionStream('https://app.likida.ai/api/admin/copiloto',JSON.stringify({mensajes}).replace(/漢/g,'\\u6f22'));
 const res=await POST(p.req);expect(res.status).toBe(200);await res.text();expect(ejecutarCopiloto).toHaveBeenCalled();expect(p.estado().cancelado).toBe(false);
});

it.each(['sin sesion','apagado'])('%s no lee cuerpo ni consume cuotas',async(motivo)=>{
 if(motivo==='sin sesion')sesion=null;else palancaCopilotoApagada.mockResolvedValue(true);
 const p=peticionStream('https://app.likida.ai/api/admin/copiloto','{}');
 expect((await POST(p.req)).status).toBe(motivo==='sin sesion'?401:503);
 expect(p.estado().leidos).toBe(0);expect(rateLimit).not.toHaveBeenCalled();
});
