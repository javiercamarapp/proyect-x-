import { peticionStream } from '@/lib/pruebas/peticion_stream';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FotoBanco, VerdadTerreno } from '@/lib/admin/qa-tipos';
import type { RespuestaOcrBanco } from '@/lib/admin/qa-verdad';

// ═══════════════════════════════════════════════════════════════════════════
// CORRER EL OCR REAL CONTRA EL BANCO — lo que se fija:
//
//  1. La misma puerta que las rutas hermanas: sin sesión 401, otro rol 403,
//     y NADA se consulta ni se gasta detrás.
//  2. EL RELOJ. El bucle consulta `venceEn` ANTES de cada foto: lo que no
//     alcanza turno se reporta POR SU NOMBRE en `sinTurno` y NO se corre. El
//     runner de producción murió mudo dos veces por iterar sin mirar el reloj.
//  3. Una foto SIN verdad-de-terreno sale `no_medida` con motivo, no se corre
//     el OCR contra ella (no se gasta en un resultado que no se puede juzgar)
//     y JAMÁS cuenta como acierto.
//  4. Un fallo técnico del OCR no cuenta 7 errores: cuenta 7 sin medir.
//  5. El tope diario suma corridas + lecturas, y si NO se puede leer no se
//     gasta (fallar cerrado).
// ═══════════════════════════════════════════════════════════════════════════

let sesion: { userId: string | null; rol: string } | null = null;
vi.mock('@/lib/auth/session', () => ({ getSessionTenant: async () => sesion }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({}) }));

const VERDAD: VerdadTerreno = {
  comercioClave: 'capufe',
  emisor: 'Caminos y Puentes Federales',
  rfcEmisor: 'CPF890101AAA',
  folio: '000123',
  monto: 1234.5,
  fecha: '2026-07-31',
  sucursal: 'Caseta Palmillas',
  dominioFacturacion: 'facturacioncapufe.com.mx',
  ilegibles: [],
  noAplica: [],
  clase: 'ticket',
  notas: null,
};

const ID_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const ID_B = 'aaaaaaaa-0000-4000-8000-00000000000b';
const ID_C = 'aaaaaaaa-0000-4000-8000-00000000000c';

const foto = (id: string, verdad: VerdadTerreno | null): FotoBanco => ({
  id, hash: `h-${id}`, path: `banco/${id}.jpg`, mime: 'image/jpeg',
  etiqueta: `${id}.jpg`, bytes: 10, subidoEn: '2026-08-16T12:00:00Z',
  ocrEsperado: verdad, confirmadoEn: verdad ? '2026-08-20T10:00:00Z' : null,
});

let banco: FotoBanco[] = [];
let gastoCorridas: { ok: true; datos: number } | { ok: false; error: string } = { ok: true, datos: 0 };
let gastoLecturas: { ok: true; datos: number } | { ok: false; error: string } = { ok: true, datos: 0 };
const guardarLectura = vi.fn(async (_db: unknown, l: { fotoId: string }) => (
  { ok: true as const, datos: { id: `lec-${l.fotoId}` } }
));

vi.mock('@/lib/admin/qa-storage', () => ({
  leerManifiesto: async () => ({ ok: true as const, datos: banco }),
  dataUrlDeFoto: async () => ({ dataUrl: 'data:image/jpeg;base64,AAAA', reintentos: 0 }),
  guardarLectura: (...a: unknown[]) => guardarLectura(...(a as [unknown, { fotoId: string }])),
  gastoHoyUsd: async () => gastoCorridas,
  gastoLecturasHoyUsd: async () => gastoLecturas,
}));

/** Lo que la visión devuelve en cada llamada, en orden. */
let respuestasOcr: Array<unknown>;
/** Cuánto avanza el reloj FALSO cada vez que se llama al OCR. */
let msPorFoto = 0;
let ahora = 0;
const extraerComprobante = vi.fn(async () => {
  ahora += msPorFoto;
  const r = respuestasOcr.shift();
  if (r instanceof Error) throw r;
  return r;
});
vi.mock('@/lib/likida/intake/ocr', () => ({
  extraerComprobante: () => extraerComprobante(),
}));

const { POST } = await import('./route');

const lecturaBuena = {
  gasto: {
    monto: 1234.5, fecha: '2026-07-31', folio: '000123', rfcEmisor: 'CPF890101AAA',
    ocrExtra: {
      emisor: 'Caminos y Puentes Federales',
      estacion: 'Caseta Palmillas',
      urlFacturacion: 'https://facturacioncapufe.com.mx/Capufe/',
    },
  },
  legible: true,
  costo: { modelo: 'google/gemini-flash', tokensIn: 100, tokensOut: 50, costoUsd: 0.0031 },
};

const pedir = (body: unknown) => POST(new Request('http://x/api/admin/qa/fotos/ocr', {
  method: 'POST', body: JSON.stringify(body),
}));

beforeEach(() => {
  sesion = { userId: 'u-javier', rol: 'superadmin' };
  banco = [foto(ID_A, VERDAD), foto(ID_B, VERDAD), foto(ID_C, VERDAD)];
  gastoCorridas = { ok: true, datos: 0 };
  gastoLecturas = { ok: true, datos: 0 };
  respuestasOcr = [];
  msPorFoto = 0;
  guardarLectura.mockClear();
  extraerComprobante.mockClear();

  // Reloj FALSO y determinista: `Date.now` sólo avanza cuando el OCR corre, así
  // que la prueba del corte por reloj no depende de esperar de verdad.
  ahora = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => ahora);
});

afterEach(() => { vi.restoreAllMocks(); });

describe('la puerta', () => {
  it('sin sesión: 401, y no se toca ni el banco ni el modelo', async () => {
    sesion = null;
    const r = await pedir({ fotoIds: [ID_A] });
    expect(r.status).toBe(401);
    expect(extraerComprobante).not.toHaveBeenCalled();
  });

  it('con otro rol: 403 y tampoco se gasta', async () => {
    sesion = { userId: 'u-cliente', rol: 'flota_admin' };
    const r = await pedir({ fotoIds: [ID_A] });
    expect(r.status).toBe(403);
    expect(extraerComprobante).not.toHaveBeenCalled();
  });
});

// AUDITORÍA 24, BE-26: sus hermanos (`qa/lanzar`, `qa/fotos` POST/PATCH) ya
// comprobaban el origen; esta no. Autenticada solo por cookie de sesión, un
// sitio ajeno con el superadmin logueado podía disparar el gasto de visión.
describe('BE-26 — la puerta de origen', () => {
  it('REPRO: desde otro sitio es 403 y no se gasta un centavo', async () => {
    const r = await POST(new Request('http://x/api/admin/qa/fotos/ocr', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
      body: JSON.stringify({ fotoIds: [ID_A] }),
    }));
    expect(r.status).toBe(403);
    expect(extraerComprobante).not.toHaveBeenCalled();
  });

  it('desde el panel (same-origin) pasa', async () => {
    respuestasOcr = [lecturaBuena];
    const r = await POST(new Request('http://x/api/admin/qa/fotos/ocr', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ fotoIds: [ID_A] }),
    }));
    expect(r.status).toBe(200);
    expect(extraerComprobante).toHaveBeenCalledTimes(1);
  });
});

describe('el body', () => {
  it('JSON roto: 400', async () => {
    const r = await POST(new Request('http://x', { method: 'POST', body: '{no' }));
    expect(r.status).toBe(400);
  });

  it('sin fotos, o con ids que no son uuid: 400 con motivo', async () => {
    for (const body of [{ fotoIds: [] }, { fotoIds: ['x'] }, {}]) {
      const r = await pedir(body);
      expect(r.status).toBe(400);
      expect((await r.json() as { error: string }).error).toBeTruthy();
    }
    expect(extraerComprobante).not.toHaveBeenCalled();
  });

  it('una foto fuera del banco se rechaza ANTES de gastar', async () => {
    const r = await pedir({ fotoIds: ['aaaaaaaa-0000-4000-8000-0000000000ff'] });
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toMatch(/fuera del banco/);
    expect(extraerComprobante).not.toHaveBeenCalled();
  });
});

describe('el tope diario — fallar cerrado', () => {
  it('suma corridas + lecturas: pasado el tope, 429 y ni una llamada', async () => {
    gastoCorridas = { ok: true, datos: 3 };
    gastoLecturas = { ok: true, datos: 2.5 };
    const r = await pedir({ fotoIds: [ID_A] });
    expect(r.status).toBe(429);
    expect(extraerComprobante).not.toHaveBeenCalled();
  });

  it('si el gasto de LECTURAS no se puede leer, no se gasta a ciegas: 502', async () => {
    gastoLecturas = { ok: false, error: 'base caída' };
    const r = await pedir({ fotoIds: [ID_A] });
    expect(r.status).toBe(502);
    expect((await r.json() as { error: string }).error).toMatch(/a ciegas/);
    expect(extraerComprobante).not.toHaveBeenCalled();
  });

  it('si el gasto de CORRIDAS no se puede leer, tampoco: 502', async () => {
    gastoCorridas = { ok: false, error: 'base caída' };
    const r = await pedir({ fotoIds: [ID_A] });
    expect(r.status).toBe(502);
    expect(extraerComprobante).not.toHaveBeenCalled();
  });
});

describe('la medición', () => {
  it('una lectura perfecta: 7 aciertos, fila escrita y exactitud 1', async () => {
    respuestasOcr = [lecturaBuena];
    const r = await pedir({ fotoIds: [ID_A] });
    expect(r.status).toBe(200);
    const d = await r.json() as RespuestaOcrBanco;
    expect(d.resultados).toHaveLength(1);
    expect(d.resultados[0].estado).toBe('medida');
    expect(d.resultados[0].medicion!.camposOk).toBe(7);
    expect(d.resultados[0].lecturaId).toBe(`lec-${ID_A}`);
    expect(d.resumen.exactitud).toBe(1);
    expect(d.costoUsdTotal).toBeCloseTo(0.0031, 6);
    expect(guardarLectura).toHaveBeenCalledTimes(1);
  });

  it('una foto SIN verdad-de-terreno: no_medida, con motivo, sin gastar y fuera del denominador', async () => {
    banco = [foto(ID_A, null)];
    const r = await pedir({ fotoIds: [ID_A] });
    const d = await r.json() as RespuestaOcrBanco;
    expect(d.resultados[0].estado).toBe('no_medida');
    expect(d.resultados[0].motivo).toMatch(/verdad-de-terreno/);
    expect(d.resultados[0].costoUsd).toBe(0);
    // Ni se llamó al modelo ni se escribió fila: no hay nada que medir.
    expect(extraerComprobante).not.toHaveBeenCalled();
    expect(guardarLectura).not.toHaveBeenCalled();
    // Y el agregado dice "sin medir", NUNCA 0% ni 100%.
    expect(d.resumen.exactitud).toBeNull();
    expect(d.resumen.medidos).toBe(0);
  });

  it('un fallo TÉCNICO del OCR cuenta 7 sin medir, no 7 errores, y deja fila con motivo', async () => {
    respuestasOcr = [{
      gasto: { monto: 0 },
      legible: false,
      motivo: 'fallo_tecnico',
      costo: { modelo: 'ocr', tokensIn: 0, tokensOut: 0, costoUsd: 0 },
    }];
    const r = await pedir({ fotoIds: [ID_A] });
    const d = await r.json() as RespuestaOcrBanco;
    expect(d.resultados[0].estado).toBe('fallo');
    expect(d.resultados[0].medicion!.camposMal).toBe(0);
    expect(d.resultados[0].medicion!.camposNoMedidos).toBe(7);
    expect(d.resultados[0].motivo).toMatch(/falló técnicamente/);
    expect(guardarLectura).toHaveBeenCalledTimes(1);
    // No entra al denominador: la exactitud sigue sin existir.
    expect(d.resumen.exactitud).toBeNull();
  });

  it('una foto ILEGIBLE para el OCR SÍ se mide: es justo lo que se quiere saber', async () => {
    respuestasOcr = [{
      gasto: { monto: 0 },
      legible: false,
      motivo: 'ilegible',
      costo: { modelo: 'google/gemini-flash', tokensIn: 10, tokensOut: 5, costoUsd: 0.0001 },
    }];
    const r = await pedir({ fotoIds: [ID_A] });
    const d = await r.json() as RespuestaOcrBanco;
    expect(d.resultados[0].estado).toBe('medida');
    // El papel imprime los 7 y el OCR no leyó ninguno: 7 errores de lectura.
    expect(d.resultados[0].medicion!.camposMal).toBe(7);
    expect(d.resultados[0].motivo).toMatch(/no legible/);
  });

  it('un costo NO MEDIDO se dice: el 0 no significa gratis', async () => {
    respuestasOcr = [{
      ...lecturaBuena,
      costo: { modelo: 'ocr:no_medido', tokensIn: 0, tokensOut: 0, costoUsd: 0, noMedido: true },
    }];
    const r = await pedir({ fotoIds: [ID_A] });
    const d = await r.json() as RespuestaOcrBanco;
    expect(d.resultados[0].motivo).toMatch(/no significa gratis/);
  });

  it('si la fila NO se puede guardar, la respuesta lo DICE en vez de callarlo', async () => {
    respuestasOcr = [lecturaBuena];
    guardarLectura.mockResolvedValueOnce({ ok: false, error: 'falta la 0239' } as never);
    const r = await pedir({ fotoIds: [ID_A] });
    const d = await r.json() as RespuestaOcrBanco;
    expect(d.resultados[0].lecturaId).toBeNull();
    expect(d.resultados[0].motivo).toMatch(/NO se pudo guardar/);
  });

  it('una excepción de la visión no se traga: fallo con motivo y fila escrita', async () => {
    respuestasOcr = [new Error('boom')];
    const r = await pedir({ fotoIds: [ID_A] });
    const d = await r.json() as RespuestaOcrBanco;
    expect(d.resultados[0].estado).toBe('fallo');
    expect(d.resultados[0].motivo).toMatch(/boom/);
    expect(guardarLectura).toHaveBeenCalledTimes(1);
  });
});

describe('EL RELOJ — nada de cortes mudos', () => {
  it('lo que no alcanza turno sale POR SU NOMBRE en sinTurno y NO se corre', async () => {
    // AUDITORÍA 25 (REND-A6, REINCIDENTE): el presupuesto subió de 105s a
    // 170s (maxDuration 120→300, con margen real para el peor caso de UNA
    // foto en vuelo — 120s de escalera de reintentos, `openrouter.ts:699-725`
    // — más el colchón de escritura). Cada foto quema 150 s: con el
    // presupuesto VIEJO (105s) solo la primera habría arrancado; con el
    // NUEVO (170s) arrancan la primera Y la segunda (0<170, 150<170), y la
    // tercera ya no (300≥170). Este valor DISTINGUE el arreglo: con la
    // constante vieja esta prueba habría fallado en rojo.
    msPorFoto = 150_000;
    respuestasOcr = [lecturaBuena, lecturaBuena, lecturaBuena];
    const r = await pedir({ fotoIds: [ID_A, ID_B, ID_C] });
    const d = await r.json() as RespuestaOcrBanco;

    expect(extraerComprobante).toHaveBeenCalledTimes(2);
    expect(d.resultados.map((x) => x.fotoId)).toEqual([ID_A, ID_B]);
    expect(d.sinTurno).toEqual([ID_C]);
    // La que no arrancó NO deja fila y NO cuesta nada.
    expect(guardarLectura).toHaveBeenCalledTimes(2);
    expect(d.costoUsdTotal).toBeCloseTo(0.0062, 6);
  });

  it('con tiempo de sobra nadie se queda sin turno', async () => {
    msPorFoto = 10;
    respuestasOcr = [lecturaBuena, lecturaBuena, lecturaBuena];
    const r = await pedir({ fotoIds: [ID_A, ID_B, ID_C] });
    const d = await r.json() as RespuestaOcrBanco;
    expect(d.sinTurno).toEqual([]);
    expect(d.resultados).toHaveLength(3);
    expect(d.resumen.medidos).toBe(21);
  });
});

describe('cuerpo acotado durante lectura', () => {
 it('cancela el exceso sin efectos', async()=>{
  const p=peticionStream('https://app.likida.ai/api/admin/qa/fotos/ocr',JSON.stringify({...{fotoIds:[ID_A]},ignorado:'x'.repeat(20000)}),8192);
  expect((await POST(p.req)).status).toBe(413);
  expect(p.estado().cancelado).toBe(true);expect(p.estado().leidos).toBeLessThan(p.estado().total);
  expect(extraerComprobante).not.toHaveBeenCalled();expect(guardarLectura).not.toHaveBeenCalled();
 });
 it.each([null, [], 'texto', 42].map((valor) => [valor]))('rechaza cuerpo no objeto %j antes de efectos', async(cuerpo)=>{
  const p=peticionStream('https://app.likida.ai/api/admin/qa/fotos/ocr',JSON.stringify(cuerpo));
  expect((await POST(p.req)).status).toBe(400);expect(extraerComprobante).not.toHaveBeenCalled();expect(guardarLectura).not.toHaveBeenCalled();
 });
});
