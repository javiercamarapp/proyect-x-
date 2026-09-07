import { describe, it, expect, vi, beforeEach } from 'vitest';
import { margenUnidadAtomicaMs, TECHO_PASO_CONSULTA_MS, TECHO_ENVIO_WHATSAPP_MS } from '@/lib/likida/presupuesto';

// ═══════════════════════════════════════════════════════════════════════════
// EL CRON DE LA DESCARGA MASIVA OBEDECE LA PALANCA DESDE SU PRIMER DÍA.
//
// Misma lección que fijó el cron de asistencia (el PR #80: wa-outbox nació sin
// leer el interruptor y fue el único de 7 crons que seguía mandando con el
// sistema apagado). Éste habla con el buzón tributario y ESCRIBE
// comprobantes, así que además de la palanca global lleva la suya.
//
// Y lo que es propio de este cron: EL AVISO DE PEAJE NO DEPENDE DE QUE LA
// DESCARGA ESTÉ CONFIGURADA. Una flota sin e.firma ni contrato de PAC pierde
// el derecho a facturar sus casetas cada 30 días igual que las demás.
// ═══════════════════════════════════════════════════════════════════════════

const apagados = new Set<string>();
const ilegibles = new Set<string>();
vi.mock('@/lib/likida/interruptores', () => ({
  leerInterruptor: async (n: string) =>
    ilegibles.has(n) ? 'ilegible' : apagados.has(n) ? 'apagado' : 'encendido',
}));

const { logger } = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/logger', () => ({ logger }));

const registrarLatido = vi.fn(async () => {});
vi.mock('@/lib/admin/salud', () => ({
  registrarLatido: (...a: unknown[]) => registrarLatido(...(a as [])),
  puertaCron: async (_c: string, req: Request) =>
    req.headers.get('authorization') === 'Bearer secreto-de-prueba'
      ? null
      : new Response(null, { status: 401 }),
}));

const correrDescargaSat = vi.fn(async () => ({
  corrio: true,
  motivo: undefined as string | undefined,
  configurado: true,
  flotas: 1,
  resumenes: [{
    tenantId: 't1', verificadas: 1, descargadas: 1, solicitadas: 1,
    cfdisNuevos: 12, cfdisRepetidos: 3,
    casados: 9, ambiguos: 1, disponibles: 2, consolidados: 0, errores: [] as string[], sinTurno: 0,
  }],
  sinTurno: 0,
}));
vi.mock('@/lib/likida/sat_descarga/ciclo', () => ({
  correrDescargaSat: (...a: unknown[]) => correrDescargaSat(...(a as [])),
}));

const avisarCierrePeaje = vi.fn(async () => ({
  corrio: true, flotas: 1, avisadas: 1, sinDestinatario: 0, gastos: 4,
}));
vi.mock('@/lib/likida/sat_descarga/peaje_cierre', () => ({
  avisarCierrePeaje: (...a: unknown[]) => avisarCierrePeaje(...(a as [])),
}));

const alertarOperador = vi.fn(async () => {});
vi.mock('@/lib/observability/alerta', () => ({
  alertarOperador: (...a: unknown[]) => alertarOperador(...(a as [])),
}));
vi.mock('@/lib/observability/sentry', () => ({ codigoDeError: () => 'codigo-prueba' }));

import { GET, maxDuration } from './route';

const CON_SECRETO = { headers: { authorization: 'Bearer secreto-de-prueba' } };
const URL_CRON = 'https://likida.ai/api/cron/descarga-sat';

describe('cron descarga-sat — la puerta y la palanca', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apagados.clear();
    ilegibles.clear();
  });

  it('sin secreto no corre', async () => {
    const res = await GET(new Request(URL_CRON));
    expect(res.status).toBe(401);
    expect(correrDescargaSat).not.toHaveBeenCalled();
    expect(avisarCierrePeaje).not.toHaveBeenCalled();
  });

  it('con el bearer equivocado el interruptor NI SE LEE', async () => {
    apagados.add('global');
    const res = await GET(new Request(URL_CRON, { headers: { authorization: 'Bearer otro' } }));
    expect(res.status).toBe(401);
    expect(registrarLatido).not.toHaveBeenCalled();
  });

  it('APAGADO el global: no descarga ni avisa — 200 saltado y latido saltado', async () => {
    apagados.add('global');
    const res = await GET(new Request(URL_CRON, CON_SECRETO));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ corrio: false, saltado: 'interruptor global' });
    expect(correrDescargaSat).not.toHaveBeenCalled();
    expect(registrarLatido).toHaveBeenCalledWith('descarga-sat', 'saltado', expect.anything());
  });

  it('APAGADA su propia palanca: se apaga sin tumbar la facturación entera', async () => {
    apagados.add('agente:descarga_sat');
    const res = await GET(new Request(URL_CRON, CON_SECRETO));
    expect(await res.json()).toMatchObject({ saltado: 'interruptor agente:descarga_sat' });
    expect(correrDescargaSat).not.toHaveBeenCalled();
  });

  it('ILEGIBLE: 500 con código, y no descarga — "no sé si está apagado" no es permiso', async () => {
    ilegibles.add('agente:descarga_sat');
    const res = await GET(new Request(URL_CRON, CON_SECRETO));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      codigo: 'interruptor_ilegible', interruptor: 'agente:descarga_sat', corrio: false,
    });
    expect(correrDescargaSat).not.toHaveBeenCalled();
  });
});

describe('cron descarga-sat — la corrida', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apagados.clear();
    ilegibles.clear();
  });

  it('corrida limpia: reporta las cifras y late en ok', async () => {
    const res = await GET(new Request(URL_CRON, CON_SECRETO));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo).toMatchObject({ corrio: true, flotas: 1, cfdis: 12, casados: 9, errores: 0 });
    expect(cuerpo.peaje).toMatchObject({ avisadas: 1 });
    expect(registrarLatido).toHaveBeenCalledWith('descarga-sat', 'ok',
      expect.objectContaining({ configAusente: false }));
  });

  it('con errores de una flota el latido es PARCIAL — un verde con errores adentro es mentira', async () => {
    correrDescargaSat.mockResolvedValueOnce({
      corrio: true, motivo: undefined, configurado: true, flotas: 1,
      resumenes: [{
        tenantId: 't1', verificadas: 1, descargadas: 0, solicitadas: 0,
        cfdisNuevos: 0, cfdisRepetidos: 0, casados: 0, ambiguos: 0, disponibles: 0,
        consolidados: 0, errores: ['5002 - Se agotó el límite de solicitudes'], sinTurno: 0,
      }],
      sinTurno: 0,
    });
    const res = await GET(new Request(URL_CRON, CON_SECRETO));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ errores: 1 });
    expect(registrarLatido).toHaveBeenCalledWith('descarga-sat', 'parcial', expect.anything());
  });

  it('NO CONFIGURADO también es parcial: el circuito no está haciendo su trabajo', async () => {
    correrDescargaSat.mockResolvedValueOnce({
      corrio: false, motivo: 'La descarga masiva no está configurada…', configurado: false, flotas: 0, resumenes: [], sinTurno: 0,
    });
    const res = await GET(new Request(URL_CRON, CON_SECRETO));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ corrio: false });
    // AUDITORÍA 21: la señal estructurada que le permite a `/api/health`
    // clasificar esto como hueco de configuración, no como regresión, sin
    // depender de cómo esté redactado `motivo`.
    expect(registrarLatido).toHaveBeenCalledWith('descarga-sat', 'parcial',
      expect.objectContaining({ configAusente: true }));
  });

  // ── EL RELOJ ENTRA TAMBIÉN A LA DESCARGA (c7-1; deuda del fork del #160) ──
  //
  // Antes, `venceEn` se calculaba en esta ruta y SOLO se le pasaba a
  // `avisarCierrePeaje`. El barrido del SAT corría sin reloj propio, así que
  // cuando se comía la vuelta el síntoma era el aviso de peaje saliendo con
  // `sinTurno` alto: el problema era visible y no estaba arreglado, y quien
  // pagaba la factura era el trabajo que sí se había portado bien.

  it('la descarga RECIBE el reloj de la vuelta, el mismo instante que el aviso de peaje', async () => {
    await GET(new Request(URL_CRON, CON_SECRETO));
    const venceDescarga = (correrDescargaSat.mock.calls[0] as unknown[])[1] as { venceEn: number };
    const vencePeaje = (avisarCierrePeaje.mock.calls[0] as unknown[])[1] as { venceEn: number };
    expect(venceDescarga.venceEn).toEqual(expect.any(Number));
    // QUE SEA EL MISMO instante es lo que hace que el reparto del tiempo sea
    // una regla y no una carrera entre los dos trabajos.
    expect(venceDescarga.venceEn).toBe(vencePeaje.venceEn);
  });

  // AUDITORÍA 28, ALTO REINCIDENTE (REN-A5): el margen ya NO es el literal
  // `20_000` — se deriva de la cadena más cara entre `ingerir()` (camino
  // "casado": 4 consultas, 0 envíos) y `avisarCierrePeaje` (reservar +
  // telefonoParaDineroDe + sendText + soltarReserva: 3 consultas + 1 envío
  // SÍNCRONO — ver el comentario junto a `MARGEN_MS` en `route.ts`). Esta
  // prueba fija que el margen ALCANZA para esa cadena y que la ruta de verdad
  // lo usa, no un literal que por coincidencia se le pareciera.
  it('el margen derivado alcanza para la cadena más cara (avisarCierrePeaje) y la ruta lo usa', async () => {
    const PEOR_CASO_INGERIR_CASADO_MS = 4 * TECHO_PASO_CONSULTA_MS;
    const PEOR_CASO_PEAJE_CIERRE_MS = 3 * TECHO_PASO_CONSULTA_MS + TECHO_ENVIO_WHATSAPP_MS;
    const margen = margenUnidadAtomicaMs({ consultas: 3, envios: 1 });
    expect(margen, 'el margen tiene que cubrir el peor caso de ingerir/casado')
      .toBeGreaterThan(PEOR_CASO_INGERIR_CASADO_MS);
    expect(margen, 'el margen tiene que cubrir el peor caso de avisarCierrePeaje')
      .toBeGreaterThan(PEOR_CASO_PEAJE_CIERRE_MS);

    const antes = Date.now();
    await GET(new Request(URL_CRON, CON_SECRETO));
    const venceDescarga = (correrDescargaSat.mock.calls[0] as unknown[])[1] as { venceEn: number };
    expect(venceDescarga.venceEn).toBeGreaterThanOrEqual(antes + maxDuration * 1000 - margen);
    expect(venceDescarga.venceEn).toBeLessThanOrEqual(Date.now() + maxDuration * 1000 - margen);
  });

  it('un barrido del SAT cortado por reloj hace el latido PARCIAL — son CFDI que no entraron', async () => {
    correrDescargaSat.mockResolvedValueOnce({
      corrio: true, motivo: undefined, configurado: true, flotas: 1,
      resumenes: [{
        tenantId: 't1', verificadas: 1, descargadas: 0, solicitadas: 0,
        cfdisNuevos: 0, cfdisRepetidos: 0, casados: 0, ambiguos: 0, disponibles: 0,
        consolidados: 0, errores: [] as string[], sinTurno: 3,
      }],
      sinTurno: 3,
    });
    const res = await GET(new Request(URL_CRON, CON_SECRETO));
    expect(res.status).toBe(200);
    // Sin errores y con `corrio: true`, la versión vieja habría dicho 'ok'
    // sobre una pasada que dejó tres unidades de trabajo del SAT sin hacer.
    expect(await res.json()).toMatchObject({ errores: 0 });
    expect(registrarLatido).toHaveBeenCalledWith('descarga-sat', 'parcial',
      expect.objectContaining({ descargaSinTurno: 3 }));
  });

  it('sin descarga configurada, EL AVISO DE PEAJE CORRE IGUAL', async () => {
    // Es la distinción entera: el derecho a facturar caseta se vence aunque
    // la flota no tenga e.firma ni contrato de PAC.
    correrDescargaSat.mockResolvedValueOnce({
      corrio: false, motivo: 'no configurada', configurado: false, flotas: 0, resumenes: [], sinTurno: 0,
    });
    await GET(new Request(URL_CRON, CON_SECRETO));
    expect(avisarCierrePeaje).toHaveBeenCalledTimes(1);
  });

  it('si la descarga revienta, el aviso de peaje NO se pierde con ella', async () => {
    // Y al revés: si el aviso truena, la descarga ya hecha se reporta igual.
    avisarCierrePeaje.mockRejectedValueOnce(new Error('sin whatsapp'));
    const res = await GET(new Request(URL_CRON, CON_SECRETO));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.cfdis).toBe(12);
    expect(cuerpo.peaje).toMatchObject({ corrio: false, error: 'sin whatsapp' });
    expect(registrarLatido).toHaveBeenCalledWith('descarga-sat', 'parcial', expect.anything());
  });

  it('motor reventado → 500 y alerta, nunca un verde de mentira', async () => {
    correrDescargaSat.mockRejectedValueOnce(new Error('base caída'));
    const res = await GET(new Request(URL_CRON, CON_SECRETO));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'base caída' });
    expect(alertarOperador).toHaveBeenCalled();
    expect(registrarLatido).toHaveBeenCalledWith('descarga-sat', 'fallo', { codigo: 'codigo-prueba' });
  });
});
