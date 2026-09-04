// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 5 · ALTO — la cadena entera nunca corría en ninguna prueba.
//
// `processor_cierre.test.ts` y `processor_lock.test.ts` hacían
// `vi.mock('@/lib/likida/tools', () => ({}))` y `vi.mock('@/lib/meta/client', …)`.
// Con eso, el camino que de verdad entrega el producto —
//
//     processor → agents/run → openrouter → tool-executor → tools →
//     desde_db → engine → pdf → storage → meta/client → Graph API
//
// — no se ejecutaba ENTERO ni una sola vez. Y las tres mutaciones más caras de la
// ronda viven justo en las costuras de esa cadena, no dentro de sus piezas:
//
//   M1b (`meta/client.ts:73,98`) el envío deja de normalizar el destinatario
//        mexicano → la respuesta rebota con TODO operador, en silencio.
//   M19 (`tools.ts:139`)        el PDF del chofer se genera con el ejemplar del
//        contralor → le llega el veredicto fiscal que `resumen.ts` le oculta.
//   M14 (`cuadre/resumen.ts:51`) el mensaje imprime el comprobado ×10.
//
// Aquí se mockean SOLO los bordes de I/O —el SDK de OpenAI, `fetch` hacia la
// Graph API, Supabase (datos y storage) y el registro de costos— y todo lo demás
// corre de verdad: el motor calcula, `pdf-lib` produce bytes reales que se leen,
// la guardia sustituye el texto y el cliente de Meta arma el sobre que sale.
//
// Nada sale de la máquina: `fetch` está interceptado y ninguna prueba toca la
// red, Supabase ni OpenRouter.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Gasto, Viaje, Operador } from '@/types/likida';
import { hoyMx } from '@/lib/formato';

// ── El estado que la BD tendría, sin BD ─────────────────────────────────────
//
// `cuadrarDesdeDB` inyecta el reloj del servidor como `fechaMax` y arranca la
// ventana en `viaje.fechaInicio`: con fechas fijas los comprobantes salen
// "fuera del rango esperado" y el mensaje se llena de ruido que no es el objeto
// de esta prueba. Se ancla el viaje a HOY, que es además el caso real.
//
// DAT-28: y ese HOY es el de MÉXICO. Era `new Date().toISOString().slice(0,10)`
// —el día UTC—, así que corriendo la prueba después de las 18:00 hora local los
// tres comprobantes quedaban fechados MAÑANA: `ventanaDelViaje` los marcaba
// como del futuro (que es justo lo que se arregló) y el veredicto fiscal del
// EFOS no llegaba al PDF del contralor. La prueba se caía a las 6 de la tarde
// por tener el mismo bug que vigila el código que ejercita.
const HOY = hoyMx();

const VIAJE: Viaje = { id: 'v1', folio: 'VJ-1', origen: 'Mérida', destino: 'Cancún', anticipo: 8000, fechaInicio: HOY };
const OPERADOR: Operador = { id: 'o1', nombre: 'Juan Pérez', telefono: '5219993700779', terminal: 'Mérida' };

/**
 * Tres comprobantes de un viaje real: la caseta y el diésel timbrados y limpios,
 * y un hospedaje cuyo emisor está en la lista negra del SAT.
 *
 * El EFOS es deliberado: es un veredicto de `SOLO_CONTRALOR`, así que tiene que
 * aparecer en el ejemplar del contralor y faltar en el del operador y en su
 * mensaje. Es el hallazgo ALTO de la ronda 4, y M19 lo resucita.
 */
const GASTOS: Gasto[] = [
  {
    id: 'g-caseta', concepto: 'caseta', monto: 800, fecha: HOY,
    folio: 'C-778', cfdiUuid: '22222222-2222-2222-2222-222222222222',
    rfcEmisor: 'CAP980713RG9', rfcReceptor: 'CCO8605231N4',
    claveProdServ: '95111602', tipoComprobante: 'I', xmlVerificado: true, formaPago: '03',
    subTotal: 689.66, ivaTraslado: 110.34, ocrConfianza: 0.95, estadoSat: 'vigente', efos: false,
  },
  {
    id: 'g-diesel', concepto: 'diesel', monto: 3500, fecha: HOY,
    folio: 'A-10231', cfdiUuid: '11111111-1111-1111-1111-111111111111',
    rfcEmisor: 'PEP970101P77', rfcReceptor: 'CCO8605231N4',
    claveProdServ: '15101505', claveUnidad: 'LTR', tipoComprobante: 'I',
    complementoHidrocarburos: true, xmlVerificado: true, formaPago: '03',
    subTotal: 2426.72, ivaTraslado: 388.28, iepsTraslado: 685,
    ocrExtra: { litros: 130 }, ocrConfianza: 0.96, estadoSat: 'vigente', efos: false,
  },
  {
    id: 'g-hospedaje', concepto: 'hospedaje', monto: 1200, fecha: HOY,
    folio: 'H-9', cfdiUuid: '33333333-3333-3333-3333-333333333333',
    rfcEmisor: 'HOT010101AB1', rfcReceptor: 'CCO8605231N4',
    tipoComprobante: 'I', xmlVerificado: true, formaPago: '03',
    subTotal: 1034.48, ivaTraslado: 165.52, ocrConfianza: 0.95, estadoSat: 'vigente',
    efos: true,   // ← lista negra 69-B: SOLO_CONTRALOR
  },
];

const TENANT = 't1';
/** El `from` tal cual lo entrega Meta: con el "1" mexicano que ella misma rechaza. */
const DESDE_META = '5219993700779';
const AL_QUE_META_ACEPTA = '529993700779';

// ── BORDE 1: el LLM ─────────────────────────────────────────────────────────
const create = vi.fn();
vi.mock('openai', () => ({
  default: class { chat = { completions: { create: (...a: unknown[]) => create(...a) } }; },
}));

// ── BORDE 2: Supabase (datos) ───────────────────────────────────────────────
const saveLiquidacion = vi.fn(async () => 'L1');
vi.mock('@/lib/likida/repo', () => ({
  ubicarGastoPorHash: vi.fn(async () => null),
  // Sala de espera de comprobantes sin viaje (mig. 0040). Sin estas cuatro,
  // `getHuerfanos` llega `undefined` y el processor truena en el `.length`.
  getHuerfanos: vi.fn(async () => []), guardarHuerfano: vi.fn(async () => true),
  resolverHuerfanos: vi.fn(), marcarHuerfanosOfrecidos: vi.fn(),
  getViaje: vi.fn(async () => VIAJE),
  getOperador: vi.fn(async () => OPERADOR),
  getGastos: vi.fn(async () => GASTOS),
  saveLiquidacion: (...a: unknown[]) => saveLiquidacion(...(a as [])),
  leerSnapshotInsumosCierre: vi.fn(async () => ({ version: 1, hash: 'a'.repeat(64) })),
  insumosDeCierreCambiaron: (e: unknown) => ['CU003', 'CU006'].includes(String((e as { code?: string } | null)?.code ?? '')),
  getAcumuladoCombustible: vi.fn(async () => ({ efectivo: 0, totalCombustible: 0 })),
  // FASE 3: perfil vacío = sin declarar; es una lectura válida, no un 503.
  getPerfilCrudo: vi.fn(async () => ({})),
  addGasto: vi.fn(), updateGastoCfdiXml: vi.fn(), saveCfdiXmlRaw: vi.fn(),
  gastoExistePorHash: vi.fn(async () => false), enriquecerGastoConCodigo: vi.fn(),
  guardarCodigoPendiente: vi.fn(), getCodigosPendientes: vi.fn(async () => []),
  reclamarCodigoPendiente: vi.fn(),
  // Con datos de responsable y el aviso YA puesto a disposición en un mensaje
  // anterior (`reclamarEnvioAviso` → false): sin esto el processor bloquea el
  // tratamiento —correctamente— y la cadena no llega a correr.
  getDatosResponsable: vi.fn(async () => ({
    razonSocial: 'TRANSPORTES DEL SURESTE SA DE CV',
    domicilio: 'Av. Itzáes 500, Mérida, Yucatán',
    urlAvisoIntegral: 'https://transportesdelsureste.mx/privacidad',
  })),
  reclamarEnvioAviso: vi.fn(async () => false), liberarEnvioAviso: vi.fn(),
}));
vi.mock('@/lib/likida/conv', async (original) => ({
  // `ConsultaFallida` y `OperadorAmbiguo` son clases que el processor usa en
  // `instanceof`: si el mock no las trae, el catch final cambia de rama.
  ...(await original<Record<string, unknown>>()),
  resolveOperador: vi.fn(async () => ({ tenantId: TENANT, operadorId: 'o1' })),
  getOpenViaje: vi.fn(async () => 'v1'),
  getTenantContext: vi.fn(async () => ({ nombre: 'Transportes del Sureste' })),
  loadConversation: vi.fn(async () => ({ id: 'c1', turns: [] })),
  saveConversation: vi.fn(),
  claimMessage: vi.fn(async () => 'nuevo'),
  acquireViajeLock: vi.fn(async () => true), intentarLockViaje: vi.fn(async () => 'obtenido' as const),
  releaseViajeLock: vi.fn(), releaseMessageClaim: vi.fn(),
  intakeDelta: vi.fn(async () => 0), esperarIntake: vi.fn(async () => true),
  fotoAnteriorSinProcesar: vi.fn(async () => false),
}));
const registrarCosto = vi.fn();
const registrarCostoWhatsApp = vi.fn();
vi.mock('@/lib/likida/costos', () => ({
  registrarCosto, registrarCostoWhatsApp,
  faseDeModelo: vi.fn(() => 'cuadre'), vincularCostosALiquidacion: vi.fn(),
}));

// ── BORDE 3: Supabase (storage) ─────────────────────────────────────────────
/** Lo que se subió a storage, por ruta. Son bytes de PDF de verdad. */
const subidos = new Map<string, Uint8Array>();
const URL_FIRMADA = 'https://sb.test/firmada/liq-operador.pdf?token=abc';
/** Simula un upload a medias: el ejemplar del operador rebota. */
const storage = { rechazaEjemplarDelOperador: false };
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    // `getConfig` lee `tenant.rfc`/`tenant.config` de aquí.
    //
    // AUDITORÍA 6: antes devolvía `data: null`, o sea "sin fila", y la config
    // caía a DEMO_CONFIG — cuyo RFC es el GENÉRICO del SAT. Con el genérico el
    // motor no validaba receptor, así que la cadena entera se medía sobre un
    // tenant que en realidad no puede deducir nada. Se le da el RFC de una flota
    // configurada, que es lo que la cadena pretende ejercitar.
    from: (tabla: string) => {
      // Cadena genérica: `desde_db` (RFA 2.9) consulta `gasto` del ejercicio con
      // .eq/.gte/.lte/.or/.range y `getConfig` lee `tenant`. Para tenant se
      // devuelve la config de prueba; para lo demás, vacío con error null.
      const b: Record<string, unknown> = {};
      const self = () => b;
      for (const m of ['select', 'eq', 'gte', 'lte', 'or', 'order', 'in', 'is', 'not', 'limit']) b[m] = self;
      b.range = async () => ({ data: [], error: null, count: 0 });
      b.maybeSingle = async () => (tabla === 'tenant'
        ? { data: { rfc: 'CCO8605231N4', config: null }, error: null }
        : { data: null, error: null });
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
      return b;
    },
    storage: {
      from: () => ({
        upload: async (path: string, buf: Buffer) => {
          if (storage.rechazaEjemplarDelOperador && path.endsWith('-operador.pdf')) {
            return { error: { message: 'storage lleno' } };
          }
          subidos.set(path, new Uint8Array(buf));
          return { error: null };
        },
        createSignedUrl: async (path: string) => (subidos.has(path)
          ? { data: { signedUrl: URL_FIRMADA }, error: null }
          : { data: null, error: { message: `no existe: ${path}` } }),
      }),
    },
  }),
}));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger }));

// ── BORDE 4: la Graph API de Meta ───────────────────────────────────────────
type Salida = { url: string; body: Record<string, unknown> };
const salientes: Salida[] = [];
const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
  salientes.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
  return new Response(JSON.stringify({ messages: [{ id: 'wamid.TEST' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
});

const textos = () => salientes.filter((s) => s.body.type === 'text');
const documentos = () => salientes.filter((s) => s.body.type === 'document');

// El módulo del processor se importa DESPUÉS de los mocks. Todo lo que no está
// arriba corre de verdad.
const { processInbound } = await import('./processor');

/** Texto imprimible de un PDF: infla los streams y junta lo que va a `Tj`. */
async function textoDelPdf(bytes: Uint8Array): Promise<string> {
  const { inflateSync } = await import('node:zlib');
  const buf = Buffer.from(bytes);
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x73 && buf.subarray(i, i + 6).toString('latin1') === 'stream') {
      let ini = i + 6;
      while (buf[ini] === 0x0d || buf[ini] === 0x0a) ini++;
      const fin = buf.indexOf(Buffer.from('endstream'), ini);
      if (fin < 0) continue;
      try { out += inflateSync(buf.subarray(ini, fin)).toString('latin1'); } catch { /* no comprimido */ }
      i = fin;
    }
  }
  return out.replace(/<([0-9A-Fa-f]+)>\s*Tj/g, (_m, hex: string) => Buffer.from(hex, 'hex').toString('latin1'));
}

/** Una respuesta del LLM con tool_calls, y otra final. */
const conTool = (nombre: string) => ({
  choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: nombre, arguments: '{}' } }] } }],
  usage: { prompt_tokens: 900, completion_tokens: 60 },
  model: 'anthropic/claude-sonnet-5',
});
const final = (texto: string) => ({
  choices: [{ finish_reason: 'stop', message: { content: texto, tool_calls: [] } }],
  usage: { prompt_tokens: 1200, completion_tokens: 90 },
  model: 'anthropic/claude-sonnet-5',
});

// EL MODELO NARRA UN NÚMERO INVENTADO. Es lo que la guardia determinística
// existe para atajar, y de paso obliga a que el texto que sale sea el del MOTOR
// —así el mensaje que se afirma abajo no es el del modelo, es el de `resumen.ts`
// alimentado por `engine.ts`.
const NARRACION_INVENTADA = 'Listo, cerré tu viaje. Comprobaste $9,999.00 y te sobraron $1.00.';

const listo = {
  from: DESDE_META, type: 'text' as const, text: 'listo', waMessageId: 'wa1',
  timestampMs: 1_756_000_001_100,
};

beforeEach(() => {
  subidos.clear(); salientes.length = 0;
  create.mockReset(); saveLiquidacion.mockClear(); registrarCosto.mockClear(); registrarCostoWhatsApp.mockClear();
  logger.info.mockReset(); logger.warn.mockReset(); logger.error.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
  fetchSpy.mockClear();
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.WHATSAPP_ACCESS_TOKEN = 'tok-de-prueba';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
  create.mockResolvedValueOnce(conTool('guardar_liquidacion')).mockResolvedValueOnce(final(NARRACION_INVENTADA));
});

describe('la cadena entera: "listo" → tools → PDF → WhatsApp (solo el I/O mockeado)', () => {
  it('CONTROL — la cadena corre completa: el LLM pidió la tool, el motor cuadró y salió mensaje', async () => {
    // Sin este control, todo lo de abajo podría pasar por vacío si el processor
    // abandonara el turno antes de llegar al agente.
    await processInbound(listo);
    expect(create, 'el ciclo de tools no corrió las dos rondas').toHaveBeenCalledTimes(2);
    expect(subidos.size, 'no se generó ningún PDF').toBe(2);
    expect(textos().length, 'no salió ningún mensaje').toBeGreaterThan(0);
  });

  // ── M1b ───────────────────────────────────────────────────────────────────
  it('el TEXTO sale al número que Meta acepta, no al que Meta entregó (M1b)', async () => {
    await processInbound(listo);
    for (const t of textos()) expect(t.body.to, 'un texto salió con el 1 mexicano').toBe(AL_QUE_META_ACEPTA);
    expect(textos().some((t) => t.body.to === DESDE_META)).toBe(false);
  });

  it('y el DOCUMENTO también: el PDF rebotaba igual que el texto (M1b)', async () => {
    await processInbound(listo);
    expect(documentos()).toHaveLength(1);
    expect(documentos()[0].body.to).toBe(AL_QUE_META_ACEPTA);
  });

  // ── M19 ───────────────────────────────────────────────────────────────────
  it('el PDF que se ENVÍA es el ejemplar del operador, y va firmado', async () => {
    await processInbound(listo);
    expect([...subidos.keys()].sort()).toEqual([`${TENANT}/v1-operador.pdf`, `${TENANT}/v1.pdf`]);
    expect(documentos()[0].body.document).toEqual({
      link: URL_FIRMADA, filename: 'liquidacion.pdf', caption: 'Aquí está tu liquidación 📄',
    });
  });

  it('CONTROL de M19 — el ejemplar del CONTRALOR sí trae el veredicto fiscal', async () => {
    await processInbound(listo);
    expect(await textoDelPdf(subidos.get(`${TENANT}/v1.pdf`)!)).toMatch(/lista negra|EFOS/);
  });

  it('el PDF que recibe el chofer NO trae lo que él no puede arreglar (M19)', async () => {
    await processInbound(listo);
    const t = await textoDelPdf(subidos.get(`${TENANT}/v1-operador.pdf`)!);
    expect(t, 'al chofer le llegó el ejemplar del contralor').not.toMatch(/lista negra|EFOS/);
    // Y sí trae su liquidación: "arreglar" M19 con un PDF vacío no vale.
    expect(t).toMatch(/Juan/);
    expect(t).toMatch(/Total comprobado/);
  });

  // ── M11 / M14 — las cifras que el comprador mira ──────────────────────────
  it('el mensaje lleva las cifras del MOTOR, no las que narró el modelo (M14)', async () => {
    await processInbound(listo);
    const dicho = textos().map((t) => (t.body.text as { body: string }).body).join('\n');
    // 800 + 3,500 + 1,200 = 5,500 comprobados contra 8,000 de anticipo → 2,500.
    expect(dicho).toContain('Comprobado: $5,500.00');
    expect(dicho).toContain('Anticipo: $8,000.00');
    // EL SIGNO. Invertirlo le dice al chofer que puso de su bolsa un dinero que
    // en realidad le debe a la empresa (M16).
    expect(dicho).toContain('Sobró $2,500.00 del anticipo (a favor de la empresa)');
    expect(dicho).not.toContain('de tu bolsa');
    // Y el número inventado por el modelo no llegó a nadie.
    expect(dicho, 'la cifra inventada por el LLM salió al operador').not.toContain('9,999');
    expect(logger.warn).toHaveBeenCalledWith('agent.cifras_forzadas', expect.anything());
  });

  it('el PDF imprime el mismo comprobado que el mensaje (M11)', async () => {
    await processInbound(listo);
    const pdf = await textoDelPdf(subidos.get(`${TENANT}/v1.pdf`)!);
    expect(pdf).toMatch(/\$5,500\.00/);
    expect(pdf, 'el PDF imprimió una cifra que no es la del motor').not.toMatch(/55,000\.00/);
  });

  it('el veredicto que el operador SÍ puede arreglar sí le llega por WhatsApp', async () => {
    await processInbound(listo);
    const dicho = textos().map((t) => (t.body.text as { body: string }).body).join('\n');
    expect(dicho, 'al operador se le enseñó el EFOS de su proveedor').not.toMatch(/lista negra|EFOS/);
    // Los litros son el beneficio más grande que Likida le enseña a una flota.
    expect(dicho).toMatch(/130 L/);
  });

  it('en `liquidacion.pdf_path` queda el ejemplar del CONTRALOR, que es el registro', async () => {
    await processInbound(listo);
    expect(saveLiquidacion).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ totalComprobado: 5500, totalDeducible: 4300, totalNoDeducible: 1200 }),
      `${TENANT}/v1.pdf`,
      // El conteo de comprobantes que la 0158 compara dentro del candado del
      // viaje (DAT-02): el papel archivado y la base cuentan lo mismo.
      expect.any(Number),
      { version: 1, hash: 'a'.repeat(64) },
    );
  });
});

describe('la cadena cuando el storage falla: ni se envía un PDF que no existe, ni se calla', () => {
  // El PDF del contralor sube y el del operador rebota. Es el caso real de un
  // upload a medias, y el que decide si el chofer se queda esperando. Lo cubría
  // `processor_cierre.test.ts` con `pdf_generado` INVENTADO por el test; aquí el
  // `false` lo produce `tools.ts` de verdad, al fallarle el upload.
  it('sin el ejemplar del operador en storage, no sale documento y queda el error', async () => {
    storage.rechazaEjemplarDelOperador = true;
    try {
      await processInbound(listo);
    } finally {
      storage.rechazaEjemplarDelOperador = false;
    }
    expect(subidos.has(`${TENANT}/v1.pdf`), 'el del contralor sí tenía que subir').toBe(true);
    expect(documentos(), 'se envió un PDF que no existe').toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith('pdf.no_entregado', expect.objectContaining({ viaje: 'v1', pdfGenerado: false }));
    const dicho = textos().map((t) => (t.body.text as { body: string }).body).join('\n');
    expect(dicho).toMatch(/no pude generarte el PDF|panel/i);
    // Y la liquidación SÍ quedó cerrada: el cierre es real, lo que falta es el papel.
    expect(saveLiquidacion).toHaveBeenCalled();
  });
});

// ── AUDITORÍA 10 · MEDIO REINCIDENTE: LA FILA DE COSTO, PARTIDA POR MODELO ──
// `0a199dc` hizo que `generateWithTools` devuelva `costoPorModelo` (un mapa por
// modelo real cuando el ciclo cruza de proveedor), y `processor.ts` la consume
// para registrar UNA fila de `llm_costo` POR MODELO en vez de una sola con la
// etiqueta de la última ronda. El desglose ya lo cubre
// `openrouter_fallback_costo.test.ts`; esto cubre el lado del CONSUMIDOR: que
// `processInbound` parta la fila. Sin el cableado, `res.model` (el de la última
// ronda) atribuía TODO el gasto a un modelo que solo respondió una parte.
//
// Slugs del camino vivo (`models.ts` + `FALLBACK` en `openrouter.ts`):
// `cuadre` → `anthropic/claude-sonnet-5`, fallback → `openai/gpt-5.6-terra`.
describe('AUDITORÍA 10 — registrarCosto escribe UNA fila por modelo real del ciclo', () => {
  it('ciclo mixto (primario + fallback): dos filas, cada una con SU modelo', async () => {
    // Ronda 1: el primario responde y pide cuadrar. Ronda 2: el primario cae
    // (el mismo patrón de `caido()` de openrouter_fallback_costo.test.ts) y
    // `complete` mueve `activeModel` al fallback antes de reintentar. Ronda 3
    // (ya en fallback): pide cerrar. Ronda 4: termina.
    create.mockReset();
    create
      .mockResolvedValueOnce(conTool('cuadrar_viaje'))
      .mockRejectedValueOnce(new Error('503 Service Unavailable: provider caído'))
      .mockResolvedValueOnce(conTool('guardar_liquidacion'))
      .mockResolvedValueOnce(final(NARRACION_INVENTADA));

    await processInbound(listo);

    // El ciclo cruzó de proveedor a medio camino: `res.model` es el de la
    // última ronda y solo esa etiqueta mentiría. Lo que el hallazgo exigía:
    // dos filas, cada una con el modelo que de verdad la respondió.
    expect(registrarCosto).toHaveBeenCalledTimes(2);
    expect(registrarCosto).toHaveBeenCalledWith(expect.objectContaining({ modelo: 'anthropic/claude-sonnet-5' }));
    expect(registrarCosto).toHaveBeenCalledWith(expect.objectContaining({ modelo: 'openai/gpt-5.6-terra' }));
    // Y la cadena no se descarriló por la caída: cerró y salió el PDF.
    expect(saveLiquidacion).toHaveBeenCalled();
  });

  it('ciclo en un solo modelo: conserva la fila única (no-regresión)', async () => {
    // El beforeEach ya deja `create` con dos rondas, ambas del primario.
    await processInbound(listo);

    expect(registrarCosto).toHaveBeenCalledTimes(1);
    expect(registrarCosto).toHaveBeenCalledWith(expect.objectContaining({ modelo: 'anthropic/claude-sonnet-5' }));
  });
});

// ── AUDITORÍA 12 · ALTO BACKEND: UN PDF QUE META RECHAZA NO PUEDE SER SILENCIO ──
// `sendDocument` NO lanza: devuelve { ok: false, error } cuando Meta rechaza
// el documento. Antes, `await sendDocument(...)` a secas leía el rechazo como
// entrega — el chofer se quedaba esperando su liquidación sin una línea de
// log. Esta prueba rompe la Graph API para los documents y exige el error
// ruidoso (`pdf.no_entregado`), el mismo criterio que `pdf.contralor_no_generado`.
describe('AUDITORÍA 12 — el PDF del operador rechazado por Meta deja rastro', () => {
  it('un 400 de Meta para el documento registra pdf.no_entregado', async () => {
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.type === 'document') {
        return new Response(JSON.stringify({ error: { message: 'documento rechazado por la plataforma' } }),
          { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.TEST' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      await processInbound(listo);
      expect(logger.error).toHaveBeenCalledWith('pdf.no_entregado', expect.objectContaining({ viaje: 'v1' }));
    } finally {
      fetchSpy.mockReset();
    }
  });
});
