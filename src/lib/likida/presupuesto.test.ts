import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  crearPresupuesto, MARGEN_CIERRE_MS, PRESUPUESTO_WEBHOOK_MS,
  PASOS_CIERRE, COSTO_CIERRE_MS, TOPE_CONSULTA_MS,
  TECHO_ENVIO_WHATSAPP_MS, TECHO_PASO_CONSULTA_MS, TECHO_CIERRE_MS,
  margenUnidadAtomicaMs, COLCHON_LATIDO_CRON_MS,
} from './presupuesto';

// ═══════════════════════════════════════════════════════════════════════════
// EL PRESUPUESTO DE TIEMPO DE UNA INVOCACIÓN.
//
// El webhook responde 200 de inmediato y procesa en after(). Meta ya no
// reintenta nunca. Así que si Vercel mata la función al llegar a maxDuration,
// el trabajo se pierde EN SILENCIO: el operador no recibe nada y nadie se
// entera.
//
// Y las etapas se comían el presupuesto a ciegas: la barrera de intake espera
// hasta 20s y el mutex hasta 12s, cada una con su tope fijo, sin saber que
// comparten 60s con el agente —que es lo caro—. 32s consumidos antes de
// empezar a pensar.
//
// Aquí no se acorta ningún timeout: se les da a todos el mismo reloj.
// ═══════════════════════════════════════════════════════════════════════════
describe('crearPresupuesto', () => {
  it('al empezar, queda casi todo el presupuesto', () => {
    const ahora = 1000;
    const p = crearPresupuesto(60_000, () => ahora);
    expect(p.restante()).toBe(60_000 - MARGEN_CIERRE_MS);
  });

  it('descuenta lo que ya se gastó', () => {
    let ahora = 1000;
    const p = crearPresupuesto(60_000, () => ahora);
    ahora += 20_000;
    expect(p.restante()).toBe(40_000 - MARGEN_CIERRE_MS);
  });

  // AUDITORÍA 18, CRÍTICO (C4): el presupuesto era por mensaje y el
  // `maxDuration` es por invocación. El reloj tiene que poder arrancar en el
  // inicio de la INVOCACIÓN, aunque este mensaje empiece 62s después.
  it('arranca en el inicio de la INVOCACIÓN cuando se le pasa, no en "ahora"', () => {
    const ahora = 1000 + 62_300;
    const p = crearPresupuesto(120_000, () => ahora, 1000);
    expect(p.gastado()).toBe(62_300);
    expect(p.restante()).toBe(120_000 - MARGEN_CIERRE_MS - 62_300);
    // Contraste: sin inicio, cree que los 120s son suyos.
    expect(crearPresupuesto(120_000, () => ahora).restante()).toBe(120_000 - MARGEN_CIERRE_MS);
  });

  it('reserva un margen para poder RESPONDER antes de que maten la función', () => {
    // Sin margen, se gasta hasta el último milisegundo y no queda tiempo ni de
    // mandar el mensaje: el operador se queda sin nada, que es el fallo que
    // esto viene a evitar.
    expect(MARGEN_CIERRE_MS).toBeGreaterThanOrEqual(5_000);
    let ahora = 0;
    const p = crearPresupuesto(60_000, () => ahora);
    ahora = 60_000 - MARGEN_CIERRE_MS;
    expect(p.restante()).toBe(0);
    expect(p.agotado()).toBe(true);
  });

  it('nunca devuelve negativo', () => {
    let ahora = 0;
    const p = crearPresupuesto(60_000, () => ahora);
    ahora = 999_999;
    expect(p.restante()).toBe(0);
  });

  it('acota el tope que pide una etapa a lo que de verdad queda', () => {
    // La barrera pide 20s; si solo quedan menos, se le dan los que hay. Sin
    // esto se pasa del presupuesto y se lleva por delante al agente.
    // (Los totales usan el presupuesto REAL del webhook desde la auditoría 21:
    // con el margen derivado de techos, 60s de juguete ya no dejan resto.)
    let ahora = 0;
    const p = crearPresupuesto(120_000, () => ahora);
    ahora = 70_000;
    const quedan = 120_000 - MARGEN_CIERRE_MS - 70_000;
    expect(quedan, 'control: con este margen tiene que quedar algo').toBeGreaterThan(1_000);
    expect(p.acotar(20_000)).toBe(quedan);       // pide 20s, se le dan los que hay
    expect(p.acotar(quedan - 1_000)).toBe(quedan - 1_000);  // si pide menos, se respeta
  });

  it('alcanza() responde si cabe una etapa que se sabe cara', () => {
    let ahora = 0;
    const p = crearPresupuesto(120_000, () => ahora);
    expect(p.alcanza(30_000)).toBe(true);
    ahora = 60_000;
    const quedan = 120_000 - MARGEN_CIERRE_MS - 60_000;
    expect(quedan, 'control: queda menos que la etapa cara').toBeLessThan(30_000);
    expect(p.alcanza(30_000)).toBe(false);
    expect(p.alcanza(quedan)).toBe(true);
    expect(p.alcanza(quedan + 1)).toBe(false);
  });
});

describe('PRESUPUESTO_WEBHOOK_MS', () => {
  it('coincide con el maxDuration de la ruta del webhook', () => {
    // Next exige que `maxDuration` sea un literal estático en la ruta, así que no
    // se puede importar de aquí. Si los dos se desincronizan —alguien sube el de
    // la ruta y olvida este— el presupuesto miente y vuelve el fallo silencioso:
    // Vercel mata la función creyendo nosotros que aún quedaba tiempo.
    const ruta = readFileSync(new URL('../../app/api/webhook/whatsapp/route.ts', import.meta.url), 'utf8');
    const m = /export const maxDuration = (\d+)/.exec(ruta);
    expect(m, 'no se encontró maxDuration en la ruta del webhook').not.toBeNull();
    expect(Number(m![1]) * 1000).toBe(PRESUPUESTO_WEBHOOK_MS);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EL MARGEN DE CIERRE ERA UNA CUENTA EN PROSA, Y LA PROSA MENTÍA.
//
// El comentario enumeraba SEIS pasos de red y los sumaba en "~7s en un día
// malo". Contados contra `processor.ts` después de que `runAgent` devuelve son
// TRECE y suman 8.9s. Seguía cabiendo en 12s, pero con 3.1s de holgura en vez de
// los ~5s que sugería — y nadie podía notarlo porque una lista en un comentario
// no la verifica nada.
//
// Es el mismo mecanismo que produjo el bug original de `maxDuration`: el número
// escrito al lado del código dejó de coincidir con el código. Aquí se cierra
// igual que allá, con una prueba.
// ═══════════════════════════════════════════════════════════════════════════
describe('la contabilidad del cierre', () => {
  it('el margen reservado alcanza para los pasos que de verdad hay', () => {
    expect(COSTO_CIERRE_MS).toBe(PASOS_CIERRE.reduce((s, p) => s + p.ms, 0));
    expect(MARGEN_CIERRE_MS).toBeGreaterThanOrEqual(COSTO_CIERRE_MS);
  });

  // AUDITORÍA 18, ALTO (A24): la tabla tenía 13 pasos y el cierre real 17 —
  // `avisarCierreAlJefe` se añadió sin su renglón, y esta prueba comparaba la
  // tabla consigo misma. Ahora se cuentan los envíos en el FUENTE de
  // `avisar_cierre.ts`: un `sendText`/`sendDocument` nuevo ahí sin renglón
  // aquí es una prueba en rojo.
  it('cada envío de avisar_cierre.ts tiene su renglón en la tabla', () => {
    const fuente = readFileSync('src/lib/likida/avisar_cierre.ts', 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    // AUDITORÍA 24 · AGEN-5/WA-4: el texto al jefe ya no sale por `sendText`
    // crudo sino por `avisarOficina`, que además cae a plantilla ante el
    // 131047 de Meta. Se cuenta igual — es el mismo envío y el mismo costo de
    // pared— para que el control siga contando dos.
    const envios = (fuente.match(/\b(sendText|sendDocument|avisarOficina)\(/g) ?? []).length;
    expect(envios, 'control: avisar_cierre.ts manda al menos texto y PDF').toBeGreaterThanOrEqual(2);
    const renglones = PASOS_CIERRE.filter((p) => p.donde.includes('avisar_cierre.ts') && /send(Text|Document)/.test(p.paso));
    expect(renglones.length, 'envíos en avisar_cierre.ts sin renglón en PASOS_CIERRE').toBeGreaterThanOrEqual(envios);
  });

  it('la tabla trae los veinte pasos, con dónde vive cada uno', () => {
    // El `donde` no es adorno: sin él, revisar si la lista sigue completa exige
    // releer `processor.ts` entero, que es exactamente lo que nadie hizo en tres
    // rondas. Si añades un paso de red al cierre, añádelo aquí o sube el margen.
    // AUDITORÍA 25, REND-A2 (REINCIDENTE): eran 18 mientras `processor.ts` ya
    // hacía 20 (los dos `sellarEntregaLiquidacion` de AGEN-4/auditoría 24).
    expect(PASOS_CIERRE).toHaveLength(20);
    for (const p of PASOS_CIERRE) {
      expect(p.ms, `${p.paso} sin costo`).toBeGreaterThan(0);
      expect(p.donde, `${p.paso} sin ubicación`).toMatch(/\.ts/);
    }
  });

  // AUDITORÍA 25, REND-A2: el guardarraíl de arriba (avisar_cierre.ts) no veía
  // los sellos de `processor.ts` — vigilaba UN archivo y el cierre vive en dos.
  // Esta prueba cuenta los sellos del cierre PRINCIPAL en el fuente (se
  // distinguen de los de `entregarCierrePendiente`, la ruta de reentrega, por
  // el argumento `liqIdCerrada`) y exige su renglón en la tabla.
  it('REND-A2: cada sellarEntregaLiquidacion del cierre principal tiene su renglón en la tabla', () => {
    const fuente = readFileSync('src/lib/likida/processor.ts', 'utf8');
    const sellos = (fuente.match(/sellarEntregaLiquidacion\(op\.tenantId,\s*liqIdCerrada,/g) ?? []).length;
    expect(sellos, 'control: el cierre principal sella PDF y aviso').toBeGreaterThanOrEqual(2);
    const renglones = PASOS_CIERRE.filter((p) => p.donde.startsWith('processor.ts') && /sellarEntregaLiquidacion/.test(p.paso));
    expect(renglones.length, 'sellos del cierre principal sin renglón en PASOS_CIERRE').toBeGreaterThanOrEqual(sellos);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // AUDITORÍA 21, CRÍTICO (C2): el margen se dimensionaba contra costos
  // TÍPICOS (17s vs 14s nominales) mientras los techos duros del propio
  // sistema —`SEND_TIMEOUT_MS` = 10s por envío, `TOPE_CONSULTA_MS` + gracia =
  // 9.5s por consulta— sumaban 70-90s en el camino normal del cierre. Estas
  // pruebas atan el margen a los TECHOS, y los techos al FUENTE que los impone.
  // ═════════════════════════════════════════════════════════════════════════
  it('C2: el techo de envío de la tabla ES el SEND_TIMEOUT_MS real de meta/client.ts', () => {
    const cliente = readFileSync('src/lib/meta/client.ts', 'utf8');
    const m = /const SEND_TIMEOUT_MS = ([\d_]+)/.exec(cliente);
    expect(m, 'no se encontró SEND_TIMEOUT_MS en meta/client.ts').not.toBeNull();
    expect(TECHO_ENVIO_WHATSAPP_MS).toBe(Number(m![1].replace(/_/g, '')));
  });

  it('C2: cada paso de la tabla lleva un techo que es un techo de verdad', () => {
    for (const p of PASOS_CIERRE) {
      expect(p.techoMs, `${p.paso} sin techo`).toBeGreaterThanOrEqual(p.ms);
      // Solo hay dos clases de paso, y cada una con el techo que le corresponde:
      expect([TECHO_ENVIO_WHATSAPP_MS, TECHO_PASO_CONSULTA_MS], `${p.paso} con un techo inventado`).toContain(p.techoMs);
      const esEnvio = /send(Text|Document)/.test(p.paso);
      expect(p.techoMs, `${p.paso}: clase de techo equivocada`).toBe(esEnvio ? TECHO_ENVIO_WHATSAPP_MS : TECHO_PASO_CONSULTA_MS);
    }
  });

  it('C2: el margen cubre A TECHO los pasos que le entregan la verdad al chofer', () => {
    const criticos = PASOS_CIERRE.filter((p) => p.critico);
    const nombres = criticos.map((p) => p.paso);
    // Los irrenunciables: la respuesta, la URL firmada y el PDF del chofer.
    expect(nombres).toContain('sendText de la respuesta');
    expect(nombres).toContain('createSignedUrl del PDF');
    expect(nombres).toContain('sendDocument del PDF');
    const minimo = criticos.reduce((s, p) => s + p.techoMs, 0)
      + PASOS_CIERRE.filter((p) => !p.critico).reduce((s, p) => s + p.ms, 0);
    expect(MARGEN_CIERRE_MS).toBeGreaterThanOrEqual(minimo);
  });

  it('C2: el peor caso absoluto NO cabe — y por eso existe el re-chequeo del reloj', () => {
    // Si esto algún día CUPIERA (presupuesto gigante o techos diminutos), el
    // recorte de pasos accesorios dejaría de ser necesario y habría que
    // reconsiderarlo. Mientras no quepa, correr la cola a ciegas es apostar.
    expect(TECHO_CIERRE_MS).toBe(PASOS_CIERRE.reduce((s, p) => s + p.techoMs, 0));
    expect(TECHO_CIERRE_MS).toBeGreaterThan(PRESUPUESTO_WEBHOOK_MS);
  });

  it('C2: margenDuro() mide hasta maxDuration, sin descontar el margen', () => {
    let ahora = 0;
    const p = crearPresupuesto(120_000, () => ahora);
    expect(p.margenDuro()).toBe(120_000);
    ahora = 108_000;
    expect(p.margenDuro()).toBe(12_000);
    expect(p.restante(), 'restante sí descuenta el margen').toBe(0);
    ahora = 130_000;
    expect(p.margenDuro()).toBe(0);
  });

  it('queda holgura para que un solo paso salga lento', () => {
    // `sendDocument` es el más caro (2.5s presupuestados). Si se va al doble, el
    // cierre todavía tiene que caber; si no, el operador se queda sin PDF y sin
    // log, porque Vercel mata la función antes del `catch`.
    const masCaro = Math.max(...PASOS_CIERRE.map((p) => p.ms));
    expect(MARGEN_CIERRE_MS).toBeGreaterThanOrEqual(COSTO_CIERRE_MS + masCaro * 0.5);
  });
});

describe('TOPE_CONSULTA_MS', () => {
  it('es muchísimo menor que el presupuesto de la invocación', () => {
    // La razón de existir del tope: el default de undici son 300 000 ms contra un
    // `maxDuration` de 120 000. Un techo que no quepa varias veces en el
    // presupuesto no es un techo, es el mismo problema con otro número.
    expect(TOPE_CONSULTA_MS).toBeLessThan(PRESUPUESTO_WEBHOOK_MS / 10);
  });

  it('deja pasar una consulta sana con holgura de sobra', () => {
    // Una consulta de este sistema cuesta ~0.3s en la contabilidad de arriba.
    // Un tope por debajo de 3s empezaría a cortar consultas buenas en un mal
    // día, y cortar una buena es peor que esperar una mala.
    expect(TOPE_CONSULTA_MS).toBeGreaterThanOrEqual(3_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28, ALTO + ALTO REINCIDENTE (REN-A4 + REN-A5): `MARGEN_RELOJ_MS`
// (cron/gps) y `MARGEN_MS` (cron/descarga-sat) eran un mismo literal
// (`20_000`) copiado de uno a otro sin derivarlo de nada. Este helper es el
// arreglo común: el margen de un cron ITERATIVO se deriva de los TECHOS duros
// de su unidad atómica más cara, así que subir `TOPE_CONSULTA_MS` (o su
// override por entorno) mueve el margen de los dos crons sin tocar código.
// ═══════════════════════════════════════════════════════════════════════════
describe('margenUnidadAtomicaMs', () => {
  it('consultas × TECHO_PASO_CONSULTA_MS + envios × TECHO_ENVIO_WHATSAPP_MS + el colchón, con los valores por defecto', () => {
    // REN-A4: la cadena de `dispararAsistenciaPorEventoCamara` (11 consultas, 0 envíos).
    expect(margenUnidadAtomicaMs({ consultas: 11, envios: 0 }))
      .toBe(11 * TECHO_PASO_CONSULTA_MS + COLCHON_LATIDO_CRON_MS);
    // REN-A5: la cadena de `avisarCierrePeaje` (3 consultas + 1 envío).
    expect(margenUnidadAtomicaMs({ consultas: 3, envios: 1 }))
      .toBe(3 * TECHO_PASO_CONSULTA_MS + TECHO_ENVIO_WHATSAPP_MS + COLCHON_LATIDO_CRON_MS);
  });

  it('acepta un extraMs adicional para lo que no es ni consulta ni envío', () => {
    expect(margenUnidadAtomicaMs({ consultas: 1, envios: 0, extraMs: 2_000 }))
      .toBe(TECHO_PASO_CONSULTA_MS + 2_000 + COLCHON_LATIDO_CRON_MS);
  });

  it('el colchón por sí solo no basta para latir Y responder con margen de sobra', () => {
    // Sin colchón el margen cubriría justo el trabajo y no la prueba de que
    // el trabajo se hizo (registrar el latido, devolver la respuesta HTTP).
    expect(COLCHON_LATIDO_CRON_MS).toBeGreaterThanOrEqual(1_000);
    expect(margenUnidadAtomicaMs({ consultas: 0, envios: 0 })).toBe(COLCHON_LATIDO_CRON_MS);
  });

  // El tope de consulta es configurable por entorno (`LIKIDA_TOPE_CONSULTA_MS`)
  // precisamente para poder aflojarlo sin desplegar si la latencia real
  // Vercel↔Supabase resulta peor que la documentada — y el margen de estos
  // crons tiene que MOVERSE con él, o un ajuste de emergencia del tope dejaría
  // el margen de gps/descarga-sat mintiendo otra vez.
  it('sigue a LIKIDA_TOPE_CONSULTA_MS: subir o bajar el tope mueve el margen sin tocar código', async () => {
    const ENV_ORIGINAL = process.env.LIKIDA_TOPE_CONSULTA_MS;
    try {
      process.env.LIKIDA_TOPE_CONSULTA_MS = '1500';
      vi.resetModules();
      const fresco = await import('./presupuesto');
      expect(fresco.TOPE_CONSULTA_MS).toBe(1_500);
      // Con un tope más bajo, el techo por paso baja, y con él el margen —
      // MENOS que el margen calculado arriba con el tope de producción.
      expect(fresco.TECHO_PASO_CONSULTA_MS).toBeLessThan(TECHO_PASO_CONSULTA_MS);
      expect(fresco.margenUnidadAtomicaMs({ consultas: 11, envios: 0 }))
        .toBe(11 * fresco.TECHO_PASO_CONSULTA_MS + fresco.COLCHON_LATIDO_CRON_MS);
      expect(fresco.margenUnidadAtomicaMs({ consultas: 11, envios: 0 }))
        .toBeLessThan(margenUnidadAtomicaMs({ consultas: 11, envios: 0 }));
    } finally {
      if (ENV_ORIGINAL === undefined) delete process.env.LIKIDA_TOPE_CONSULTA_MS;
      else process.env.LIKIDA_TOPE_CONSULTA_MS = ENV_ORIGINAL;
      vi.resetModules();
    }
  });
});

describe('presupuesto.senal', () => {
  it('devuelve una señal YA abortada cuando no queda nada', () => {
    // `AbortSignal.timeout(0)` no aborta de inmediato: lo agenda. Si se usara
    // eso, la llamada saldría igual y se pagaría una respuesta que nadie va a
    // leer porque Vercel ya mató la función.
    let ahora = 0;
    const p = crearPresupuesto(60_000, () => ahora);
    ahora = 99_000;
    expect(p.senal().aborted).toBe(true);
  });

  it('con presupuesto de sobra, la señal empieza viva', () => {
    const p = crearPresupuesto(60_000, () => 0);
    expect(p.senal(25_000).aborted).toBe(false);
  });

  it('respeta el tope propio de la etapa cuando es menor que el restante', () => {
    // Una foto no debe poder comerse todo lo disponible: tiene su propio techo.
    const p = crearPresupuesto(120_000, () => 0);
    expect(p.senal(25_000).aborted).toBe(false);
    expect(p.restante()).toBeGreaterThan(25_000);
  });
});
