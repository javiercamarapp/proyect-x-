// ═══════════════════════════════════════════════════════════════════════════
// CRÍTICO — TRES RAMAS MANDABAN UN WHATSAPP **POR FOTO**.
//
// `avisar_falla`, `pedir_reenvio` y la de fecha dudosa contestaban cada una por
// su cuenta, y los tres disparadores son SISTÉMICOS: un 429 del proveedor de
// visión tumba las 22 fotos de la ráfaga a la vez, y una gasolinera mal
// iluminada de noche también. O sea que el caso normal no es «una de 22 falló»,
// es «fallaron las 22» — y el chofer recibía veintidós mensajes idénticos
// seguidos. Este repo ya arregló ese antipatrón tres veces (el acuse de ráfaga,
// el aviso de acercamiento, los avisos de fecha) y el mecanismo estaba puesto:
// el contador de ráfaga y el resumen del `finally`.
//
// Aquí se ejercita `processInbound` DE VERDAD con una ráfaga simultánea, como
// la entrega Meta, contra un contador de intake que se comporta como el real
// (atómico, +1 al entrar y -1 al salir). Lo que se mide es lo único que le
// importa al chofer: CUÁNTOS mensajes recibió.
//
// Cubre además, del mismo hallazgo:
//   · el fallo técnico de OCR ya no pierde el comprobante (guarda huérfano), y
//   · `MAX_CONFIRMACIONES_SEGUIDAS`, que estaba escrito y sin cablear.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { olvidarRafagas } from './intake/rafaga';

const salientes: string[] = [];
const botones: string[] = [];
const guardarHuerfano = vi.fn(async () => true);
const subirComprobante = vi.fn(async () => 't1/v1/foto.jpg');
const extraerComprobante = vi.fn();
const getGastos = vi.fn(async () => [] as unknown[]);
const addGasto = vi.fn(async () => {});
const ventanaDesdeDB = vi.fn();
/** AUDITORÍA 24 · AGEN-11: la foto repetida dentro de la ráfaga. */
const gastoExistePorHash = vi.fn(async () => false);
const gastoPorHash = vi.fn(async () => null as unknown);

/** El contador de intake REAL: atómico, compartido por las fotos del viaje. */
let contador = 0;
const intakeDelta = vi.fn(async (_v: string, d: number) => {
  contador = Math.max(0, contador + d);
  return contador;
});

vi.mock('@/lib/likida/tools', () => ({}));
vi.mock('@/lib/meta/client', () => ({
  MAX_CUERPO_BOTONES: 1024,
  sendText: vi.fn(async (_to: string, t: string) => { salientes.push(t); return 'wamid.1'; }),
  sendButtons: vi.fn(async (_to: string, cuerpo: string) => { botones.push(cuerpo); return 'wamid.b'; }),
  sendDocument: vi.fn(),
  downloadMediaAsDataUrl: vi.fn(async () => 'data:image/jpeg;base64,AAAA'),
  downloadMediaAsText: vi.fn(),
}));
vi.mock('@/lib/likida/intake/ocr', () => ({ extraerComprobante: (...a: unknown[]) => extraerComprobante(...a) }));
vi.mock('@/lib/likida/intake/almacen', () => ({ subirComprobante: (...a: unknown[]) => subirComprobante(...(a as [])) }));
vi.mock('@/lib/likida/repo', () => ({
  addGasto: (...a: unknown[]) => addGasto(...(a as [])),
  getGastos: (...a: unknown[]) => getGastos(...(a as [])),
  guardarHuerfano: (...a: unknown[]) => guardarHuerfano(...(a as [])),
  ubicarGastoPorHash: vi.fn(async () => null),
  getHuerfanos: vi.fn(async () => []), resolverHuerfanos: vi.fn(), marcarHuerfanosOfrecidos: vi.fn(),
  updateGastoCfdiXml: vi.fn(), saveCfdiXmlRaw: vi.fn(),
  gastoExistePorHash: (...a: unknown[]) => gastoExistePorHash(...(a as [])),
  gastoPorHash: (...a: unknown[]) => gastoPorHash(...(a as [])),
  corregirFechaGasto: vi.fn(), enriquecerGastoConCodigo: vi.fn(),
  guardarCodigoPendiente: vi.fn(), getCodigosPendientes: vi.fn(async () => []),
  reclamarCodigoPendiente: vi.fn(), getViaje: vi.fn(async () => null),
  getDatosResponsable: vi.fn(async () => ({
    razonSocial: 'FLOTA SA DE CV', domicilio: 'Calle 1, Mérida',
    urlAvisoIntegral: 'https://flota.mx/privacidad',
  })),
  reclamarEnvioAviso: vi.fn(async () => false),   // ya se le puso a disposición
  confirmarEnvioAviso: vi.fn(), liberarEnvioAviso: vi.fn(),
}));
vi.mock('@/lib/likida/conv', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveOperador: vi.fn(async () => ({ tenantId: 't1', operadorId: 'o1', nombre: 'Chuy', telefono: '52999' })),
  getOpenViaje: vi.fn(async () => 'v1'),
  getTenantContext: vi.fn(async () => ({ nombreFlota: 'Flota', agentName: 'Likida' })),
  loadConversation: vi.fn(async () => ({ id: 'c1', turns: [] })),
  saveConversation: vi.fn(), claimMessage: vi.fn(async () => 'nuevo'),
  acquireViajeLock: vi.fn(async () => true), intentarLockViaje: vi.fn(async () => 'obtenido' as const), releaseViajeLock: vi.fn(),
  releaseMessageClaim: vi.fn(),
  intakeDelta: (...a: unknown[]) => intakeDelta(...(a as [string, number])),
  esperarIntake: vi.fn(async () => true),
}));
vi.mock('@/lib/likida/cuadre/desde_db', () => ({
  ventanaDesdeDB: (...a: unknown[]) => ventanaDesdeDB(...a),
  cuadrarDesdeDB: vi.fn(),
}));
vi.mock('@/lib/likida/confirmar_viaje', () => ({
  aceptarPorActividad: vi.fn(), atenderConfirmacion: vi.fn(async () => ({ mensaje: null })),
}));
vi.mock('@/lib/likida/consulta_chofer', () => ({
  estadoDelViaje: vi.fn(async () => ({ anticipo: 6000, comprobado: 100, comprobantes: 1 })),
  responderConsulta: vi.fn(async () => null),
}));
const registrarCostoWhatsApp = vi.fn();
vi.mock('@/lib/likida/costos', () => ({
  registrarCosto: vi.fn(), registrarCostoWhatsApp: (...a: unknown[]) => registrarCostoWhatsApp(...a),
  faseDeModelo: vi.fn(() => 'cuadre'), vincularCostosALiquidacion: vi.fn(),
}));
vi.mock('@/lib/agents/run', () => ({ runAgent: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { processInbound } = await import('./processor');

const FALLO_TECNICO = {
  gasto: { id: 'g0', concepto: 'otro', monto: 0, ocrConfianza: 0 },
  legible: false, motivo: 'fallo_tecnico',
  costo: { modelo: 'ocr', tokensIn: 0, tokensOut: 0, costoUsd: 0 },
};
const ILEGIBLE = {
  gasto: { id: 'g0', concepto: 'otro', monto: 0, ocrConfianza: 0.2 },
  legible: false, motivo: 'ilegible',
  costo: { modelo: 'ocr', tokensIn: 1, tokensOut: 1, costoUsd: 0 },
};
/** AUDITORÍA 28, REN-A2 — el techo diario de IA de la flota se agotó ANTES de
 *  llamar al proveedor. Es GEMELA de `FALLO_TECNICO` para efectos de ráfaga
 *  (también sistémico: si se agotó, se agotó para las 22), pero el mensaje NO
 *  puede ser el mismo. */
const SIN_PRESUPUESTO = {
  gasto: { id: 'g0', concepto: 'otro', monto: 0, ocrConfianza: 0 },
  legible: false, motivo: 'sin_presupuesto',
  costo: { modelo: 'ocr:sin_presupuesto', tokensIn: 0, tokensOut: 0, costoUsd: 0 },
};
const bueno = (monto: number, confianza = 0.99) => ({
  gasto: { id: `g${monto}`, concepto: 'diesel', monto, fecha: '2026-08-03', ocrConfianza: confianza, ocrExtra: {} },
  legible: true,
  costo: { modelo: 'ocr', tokensIn: 1, tokensOut: 1, costoUsd: 0 },
});

/** Una ráfaga de `n` fotos como la entrega Meta: todas a la vez, en un after(). */
const rafaga = (n: number) => Promise.all(
  Array.from({ length: n }, (_, i) =>
    processInbound({ from: '5219993700779', type: 'image' as const, mediaId: `m${i}`, waMessageId: `wa${i}` })),
);

/**
 * Una ráfaga de `n` fotos como route.ts las procesa DE VERDAD desde el
 * 23-ago-2026: una cadena por chofer, en SERIE dentro de la cadena, con
 * `hayFotoAntesEnCadena`/`hayFotoDespuesEnCadena` — nunca `Promise.all`.
 * `rafaga()` de arriba simula el modelo VIEJO (concurrente), que ya no es
 * cómo corre production; esta es la que reproduce el bug real de
 * AUDITORÍA 19 (AGEN-19C2-1).
 */
const rafagaSerial = async (n: number) => {
  for (let i = 0; i < n; i++) {
    await processInbound(
      { from: '5219993700779', type: 'image' as const, mediaId: `m${i}`, waMessageId: `wa${i}` },
      { hayFotoAntesEnCadena: i > 0, hayFotoDespuesEnCadena: i < n - 1 },
    );
  }
};

/**
 * Una cadena MIXTA (fotos + un mensaje que no es foto), tal como route.ts la
 * manda de verdad: las dos señales se calculan sobre la cadena completa,
 * contando SOLO mensajes `type: 'image'` — no cualquier mensaje. Reproduce
 * el hallazgo de la auditoría Fable-5 posterior al merge del PR #72:
 * `[foto, foto, "listo"]` dejaba la libreta de la última foto abierta para
 * siempre, porque un "listo" (o cualquier mensaje que no sea foto) nunca
 * pasa por el camino que la cierra (`msg.type === 'image'`, processor.ts).
 *
 * El mensaje no-foto usa `type: 'other'` (no `'listo'` de verdad) a
 * propósito: lo que este test verifica es que el CONTEO de la cadena ignore
 * su tipo al calcular `hayFoto…EnCadena` — el camino real que sigue ese
 * mensaje (agente de texto, cuadre) es otro archivo y no hace falta
 * levantarlo aquí para probar esta parte.
 */
const cadenaMixta = async (tipos: Array<'image' | 'other'>) => {
  for (let i = 0; i < tipos.length; i++) {
    const antes = tipos.slice(0, i);
    const despues = tipos.slice(i + 1);
    const msg = tipos[i] === 'image'
      ? { from: '5219993700779', type: 'image' as const, mediaId: `m${i}`, waMessageId: `wa${i}` }
      : { from: '5219993700779', type: 'other' as const, waMessageId: `wa${i}` };
    await processInbound(msg, {
      hayFotoAntesEnCadena: antes.includes('image'),
      hayFotoDespuesEnCadena: despues.includes('image'),
    });
  }
};

beforeEach(() => {
  salientes.length = 0; botones.length = 0; contador = 0;
  olvidarRafagas();
  registrarCostoWhatsApp.mockClear();
  extraerComprobante.mockReset(); getGastos.mockReset(); addGasto.mockReset();
  guardarHuerfano.mockClear(); subirComprobante.mockClear();
  ventanaDesdeDB.mockReset(); ventanaDesdeDB.mockResolvedValue(undefined);
  gastoExistePorHash.mockReset(); gastoExistePorHash.mockResolvedValue(false);
  gastoPorHash.mockReset(); gastoPorHash.mockResolvedValue(null);
  getGastos.mockResolvedValue([]);
  process.env.WHATSAPP_ACCESS_TOKEN = 'tok';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
});

describe('22 fotos que fallan NO son 22 mensajes', () => {
  it('fallo técnico en toda la ráfaga: se resume, no se repite', async () => {
    extraerComprobante.mockResolvedValue(FALLO_TECNICO);
    await rafaga(22);

    // El número es el hallazgo entero. Antes: 22. Y después de esta ronda, UNO:
    // el `≤ 2` de la primera versión dejaba pasar justo el mensaje de más que
    // se midió el 20-ago (ver el describe de abajo).
    expect(salientes.length, `el chofer recibió ${salientes.length} mensajes: ${JSON.stringify(salientes)}`).toBe(1);
    const todo = salientes.join('\n');
    expect(todo, 'AGEN-8: no se afirma un total que solo vale dentro de esta invocación').toContain('De las fotos que me mandaste,');
    expect(todo).toMatch(/\*22\*/);
    expect(todo).toMatch(/de mi lado/i);
  });

  it('foto ilegible en toda la ráfaga (la gasolinera de noche): un solo aviso', async () => {
    extraerComprobante.mockResolvedValue(ILEGIBLE);
    await rafaga(22);

    expect(salientes.length, JSON.stringify(salientes)).toBe(1);
    expect(salientes.join('\n')).toMatch(/no las pude leer/i);
  });

  it('fechas dudosas en ráfaga: se listan los montos, no se manda un mensaje por ticket', async () => {
    ventanaDesdeDB.mockResolvedValue({ inicio: '2026-08-01', fin: '2026-08-05', hoy: '2026-08-04' });
    // Fecha de 2019: fuera de la ventana por cualquier criterio.
    let n = 0;
    extraerComprobante.mockImplementation(async () => {
      n += 1;
      return { ...bueno(100 * n), gasto: { ...bueno(100 * n).gasto, fecha: '2019-03-02' } };
    });
    await rafaga(3);

    expect(salientes.length, JSON.stringify(salientes)).toBe(1);
    const todo = salientes.join('\n');
    expect(todo).toMatch(/fecha dudosa/i);
    expect(todo).toContain('$100.00');
    // Y NO el mensaje largo de UN ticket concreto: en ráfaga ese detalle vive
    // en la lista de montos, no en un mensaje aparte por el primero del fajo.
    expect(todo).not.toMatch(/• Comercio:/);
  });

  it('CONTROL — una foto sola SIGUE recibiendo su mensaje individual', async () => {
    extraerComprobante.mockResolvedValue(ILEGIBLE);
    await processInbound({ from: '5219993700779', type: 'image', mediaId: 'm1', waMessageId: 'wa1' });

    expect(salientes).toHaveLength(1);
    expect(salientes[0]).toMatch(/difícil de leer/i);
    // Y NO se le manda además el resumen: sería decirle lo mismo dos veces.
    expect(salientes.join('\n')).not.toContain('Ya revisé tus fotos');
  });

  // ── LO MEDIDO EL 20-AGO-2026, EN UNA SALA, CON SEIS FOTOS ───────────────
  //
  // El chofer mandó seis y recibió esto, en este orden:
  //
  //   1. «Se me trabó a mí al leer ese comprobante ⚙️ — no es tu foto…»
  //   2. «Ya revisé tus fotos… De las fotos que me mandaste, *6* se me trabaron…»
  //
  // El mismo trabón, dos veces, y la segunda con un número que parecía
  // desmentir a la primera. La causa: `llegoSola` se calculaba como «el
  // contador de intake pasó de 0 a 1», y toda ráfaga tiene una primera foto que
  // ve el 1. O sea que NO era el caso raro — pasaba en cada fajo.
  it('la primera foto del fajo ya no contesta por su cuenta antes del resumen', async () => {
    extraerComprobante.mockResolvedValue(FALLO_TECNICO);
    await rafaga(6);

    expect(salientes, 'un fajo es UN mensaje, no uno suelto más el resumen').toHaveLength(1);
    expect(salientes[0]).toContain('De las fotos que me mandaste,');
    // El texto individual es correcto para una foto sola; suelto DELANTE del
    // resumen es la repetición que se midió.
    expect(salientes[0]).not.toMatch(/al leer ese comprobante/i);
  });

  // ── Y LA SEGUNDA MITAD DEL MISMO MENSAJE ────────────────────────────────
  //
  // El resumen cerraba SIEMPRE con «Reenvíame esas fotos —tomadas otra vez, con
  // buena luz—», también cuando lo único que falló fue NUESTRO OCR. En el mismo
  // párrafo le decía «no son tus fotos» y acto seguido lo mandaba a repetirlas
  // por la luz: la contradicción es visible a simple vista, y obedecerla no
  // arregla nada — un 429 vuelve a fallar con la mejor luz del mundo.
  it('un fallo NUESTRO no le manda repetir la foto por la luz', async () => {
    extraerComprobante.mockResolvedValue(FALLO_TECNICO);
    await rafaga(6);

    const todo = salientes.join('\n');
    expect(todo, 'la luz nunca fue el problema').not.toMatch(/luz/i);
    expect(todo, 'sigue teniendo que pedir el reenvío: es lo único que recupera el monto').toMatch(/reenv/i);
    expect(todo).toMatch(/no son tus fotos/i);
  });

  it('pero a la foto que de verdad salió oscura SÍ le pide luz', async () => {
    extraerComprobante.mockResolvedValue(ILEGIBLE);
    await rafaga(6);

    expect(salientes.join('\n')).toMatch(/buena luz/i);
  });

  // ── EL OTRO LADO DE CONSOLIDAR: UNA SOLA COSA SE DICE ENTERA ────────────
  //
  // Consolidar existe porque veintidós mensajes son ruido. Pero cuando en todo
  // el fajo falló UNA, consolidarla pierde: «*1* trae fecha dudosa: la de
  // $600.00» no le deja encontrar ese papel entre los otros cinco, que es justo
  // para lo que existe `pedir_fecha.ts`. El umbral no es «llegó sola», es «hay
  // una sola cosa que decir».
  it('seis fotos y una con la fecha mala: el resumen trae las señas del ticket', async () => {
    ventanaDesdeDB.mockResolvedValue({ inicio: '2026-08-01', fin: '2026-08-05', hoy: '2026-08-04' });
    let n = 0;
    extraerComprobante.mockImplementation(async () => {
      n += 1;
      if (n !== 3) return bueno(100 * n);
      const g = bueno(600).gasto;
      return { ...bueno(600), gasto: { ...g, fecha: '2019-03-02', folio: '05461', ocrExtra: { emisor: 'NUEVA WAL MART DE MEXICO' } } };
    });
    await rafaga(6);

    const todo = salientes.join('\n');
    expect(todo, 'sin las señas no sabe cuál de los seis papeles es').toContain('NUEVA WAL MART');
    expect(todo).toContain('05461');
    // Y sigue siendo UN mensaje: el detalle va DENTRO del resumen, no aparte.
    expect(salientes.length, JSON.stringify(salientes)).toBe(1);
  });

  it('AUDITORÍA 28, REN-A2: el techo de IA agotado en toda la ráfaga se resume, no se repite, y no es "se me trabó"', async () => {
    extraerComprobante.mockResolvedValue(SIN_PRESUPUESTO);
    await rafaga(22);

    expect(salientes.length, `el chofer recibió ${salientes.length} mensajes: ${JSON.stringify(salientes)}`).toBe(1);
    const todo = salientes.join('\n');
    expect(todo).toContain('De las fotos que me mandaste,');
    expect(todo).toMatch(/\*22\*/);
    expect(todo).toMatch(/cupo de ia/i);
    expect(todo).not.toMatch(/de mi lado/i);
    expect(todo).not.toMatch(/buena luz|en un rato/i);
    expect(todo).toMatch(/mañana/i);
  });

  it('CONTROL — una ráfaga que sale bien no inventa incidencias', async () => {
    let n = 0;
    extraerComprobante.mockImplementation(async () => bueno(100 * (n += 1)));
    await rafaga(5);

    const todo = salientes.join('\n');
    expect(todo).not.toMatch(/no las pude leer|de mi lado|fecha dudosa/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 19 (agéntico AGEN-19C2-1) — el 23-ago-2026 route.ts pasó a
// procesar las fotos de UN chofer en SERIE (antes paralelizaba por mensaje,
// y un "listo" podía cerrar la liquidación antes de que terminaran las
// fotos). Bajo esa serialización, el contador de intake vuelve a 0 después
// de CADA foto —nunca hay dos en vuelo—, así que la libreta de la ráfaga se
// abría y cerraba en cada una: 22 comprobantes volvían a ser 22 mensajes,
// exactamente el antipatrón que este archivo entero existe para evitar.
//
// Las pruebas de arriba (`rafaga()`) usan `Promise.all` y por eso NO
// reproducen el bug: siguen viendo concurrencia real. Estas usan
// `rafagaSerial()`/`cadenaMixta()`, que procesan uno por uno CON
// `hayFotoAntesEnCadena`/`hayFotoDespuesEnCadena` — la señal que route.ts
// manda de verdad desde el 23-ago (corregida tras la auditoría Fable-5
// posterior al merge del PR #72: contar SOLO fotos, no cualquier mensaje).
// ═══════════════════════════════════════════════════════════════════════════
describe('AUDITORÍA 19 — la misma ráfaga, pero procesada EN SERIE (route.ts real desde el 23-ago)', () => {
  it('22 fotos en serie con fallo técnico: SIGUE siendo un solo mensaje, no 22', async () => {
    extraerComprobante.mockResolvedValue(FALLO_TECNICO);
    await rafagaSerial(22);

    expect(salientes.length, `el chofer recibió ${salientes.length} mensajes: ${JSON.stringify(salientes)}`).toBe(1);
    const todo = salientes.join('\n');
    expect(todo, 'AGEN-8: no se afirma un total que solo vale dentro de esta invocación').toContain('De las fotos que me mandaste,');
    expect(todo).toMatch(/\*22\*/);
  });

  it('6 fotos buenas en serie: un solo acuse consolidado, no 6 acuses sueltos', async () => {
    let n = 0;
    extraerComprobante.mockImplementation(async () => bueno(100 * (n += 1)));
    await rafagaSerial(6);

    // AUDITORÍA FABLE-5 (post-merge PR #72): `toBeLessThanOrEqual(1)` dejaba
    // pasar el CERO — silencio total — como si fuera un éxito. Sin el fix,
    // cada foto habría cerrado su propia libreta de tamaño 1 y el peldaño
    // `acusar` (silencio en ráfaga, "Anotado" si viene sola) las habría
    // contestado las 6 por separado; con la libreta huérfana del bug que
    // rompía cadenas mixtas, habría contestado CERO veces. Solo `toBe(1)` +
    // contenido descarta las dos formas de fallar.
    expect(salientes.length, `el chofer recibió ${salientes.length} mensajes: ${JSON.stringify(salientes)}`).toBe(1);
    expect(salientes[0]).toContain('Ya revisé tus fotos');
    expect(salientes[0]).not.toMatch(/no las pude leer|de mi lado|fecha dudosa/i);
  });

  it('AUDITORÍA FABLE-5: [foto, foto, "listo"] — la ÚLTIMA foto sí cierra la libreta y manda el resumen', async () => {
    // El bug real post-merge del PR #72: contar CUALQUIER mensaje de la
    // cadena (no solo fotos) hacía que la segunda foto —la última FOTO,
    // pero no el último MENSAJE— se creyera "vienen más" porque el "listo"
    // la sigue. El resumen (y con él, cualquier aviso de que algo no se
    // pudo leer) se perdía en silencio para siempre.
    let n = 0;
    extraerComprobante.mockImplementation(async () => bueno(100 * (n += 1)));
    await cadenaMixta(['image', 'image', 'other']);

    // El mensaje `other` de la cola tiene su propia respuesta genérica —
    // ajena a la ráfaga—, así que lo que importa no es el total, es que el
    // resumen de las fotos SÍ salió (antes del fix: nunca salía).
    const resumenes = salientes.filter((s) => s.includes('Ya revisé tus fotos'));
    expect(resumenes, JSON.stringify(salientes)).toHaveLength(1);
  });

  it('AUDITORÍA FABLE-5: ["listo", foto, foto] — la PRIMERA foto de la cadena no pierde la libreta de una ráfaga previa', async () => {
    // Simétrico al anterior: `siguienteDeLaMismaCadena` (que evita que
    // `anotarFoto` borre lo anotado) también contaba CUALQUIER mensaje
    // anterior. Un texto antes de la primera foto hacía que esa foto se
    // creyera "no soy la primera de mi cadena" y NO reseteara la libreta —
    // aquí no hay ráfaga previa que perder, así que el resultado observable
    // sigue siendo un resumen correcto de las 2 fotos que sí llegaron.
    let n = 0;
    extraerComprobante.mockImplementation(async () => bueno(100 * (n += 1)));
    await cadenaMixta(['other', 'image', 'image']);

    const resumenes = salientes.filter((s) => s.includes('Ya revisé tus fotos'));
    expect(resumenes, JSON.stringify(salientes)).toHaveLength(1);
    expect(resumenes[0]).toContain('Ya revisé tus fotos');
  });

  it('sin hayFotoAntesEnCadena/hayFotoDespuesEnCadena (caller que no sabe de la cadena): sigue como una foto suelta, sin romperse', async () => {
    // Control de compatibilidad: un llamador viejo (pruebas, el simulador
    // del demo) que no manda las opciones nuevas se comporta EXACTAMENTE
    // como antes de esta ronda — la ausencia de las dos banderas es un no-op.
    extraerComprobante.mockResolvedValue(ILEGIBLE);
    await processInbound({ from: '5219993700779', type: 'image', mediaId: 'm1', waMessageId: 'wa1' });

    expect(salientes).toHaveLength(1);
    expect(salientes[0]).toMatch(/difícil de leer/i);
  });

  it('CONTROL — una ráfaga serial que sale bien no manda nada de más', async () => {
    let n = 0;
    extraerComprobante.mockImplementation(async () => bueno(100 * (n += 1)));
    await rafagaSerial(5);

    const todo = salientes.join('\n');
    expect(todo).not.toMatch(/no las pude leer|de mi lado|fecha dudosa/i);
  });
});

describe('un fallo técnico de OCR ya no pierde el comprobante', () => {
  it('guarda huérfano CON la foto, esperando la subida', async () => {
    extraerComprobante.mockResolvedValue(FALLO_TECNICO);
    await processInbound({ from: '5219993700779', type: 'image', mediaId: 'm1', waMessageId: 'wa1' });

    expect(guardarHuerfano).toHaveBeenCalledTimes(1);
    const [, , h] = guardarHuerfano.mock.calls[0] as unknown as [string, string, { rutaImagen?: string; motivo: string; gasto: { imagenUrl?: string } }];
    expect(h.rutaImagen, 'la subida se descartaba sin esperarla').toBe('t1/v1/foto.jpg');
    expect(h.gasto.imagenUrl).toBe('t1/v1/foto.jpg');
    // El motivo dice la CAUSA, no el efecto: escribía `sin_viaje` habiendo
    // viaje abierto, que es exactamente lo que no pasó (4-ago-2026).
    expect(h.motivo).toBe('fallo_ocr');
  });

  it('y el texto ya NO lo manda a un trámite que no existe', async () => {
    extraerComprobante.mockResolvedValue(FALLO_TECNICO);
    await processInbound({ from: '5219993700779', type: 'image', mediaId: 'm1', waMessageId: 'wa1' });

    const dicho = salientes.join('\n');
    // No hay alta manual de gastos en NINGÚN lado: `addGasto` es el único
    // insert sobre `gasto` del repo y sus tres llamadores viven en el camino de
    // WhatsApp. Prometerle "captúralo aparte" era mandarlo a hacer nada.
    expect(dicho).not.toMatch(/capturarlo aparte|NO quedó registrado/i);
    expect(dicho).toMatch(/no se pierde/i);
  });

  it('AUDITORÍA 24 · AGEN-12: NO le promete que se lo ofreceremos en el siguiente viaje', async () => {
    // Un huérfano de `fallo_ocr` nace con `monto: 0` y la oferta solo saca los
    // que tienen monto: «te lo ofrezco en el siguiente» era una promesa que el
    // código no podía cumplir. Lo que de verdad lo recupera es el reenvío, y
    // eso es lo único que ahora se le pide.
    extraerComprobante.mockResolvedValue(FALLO_TECNICO);
    await processInbound({ from: '5219993700779', type: 'image', mediaId: 'm1', waMessageId: 'wa1' });

    const dicho = salientes.join('\n');
    expect(dicho).not.toMatch(/ofrezco en el siguiente|en el siguiente viaje/i);
    expect(dicho, 'lo que sí depende de él').toMatch(/reenv/i);
  });

  it('si tampoco se puede guardar, se le dice la verdad', async () => {
    extraerComprobante.mockResolvedValue(FALLO_TECNICO);
    guardarHuerfano.mockResolvedValueOnce(false);
    await processInbound({ from: '5219993700779', type: 'image', mediaId: 'm1', waMessageId: 'wa1' });

    expect(salientes.join('\n')).toMatch(/tampoco lo pude guardar/i);
  });
});

describe('AUDITORÍA 28, REN-A2: el techo de IA agotado tampoco pierde el comprobante', () => {
  it('guarda huérfano fallo_ocr CON la marca sinPresupuesto, esperando la subida', async () => {
    extraerComprobante.mockResolvedValue(SIN_PRESUPUESTO);
    await processInbound({ from: '5219993700779', type: 'image', mediaId: 'm1', waMessageId: 'wa1' });

    expect(guardarHuerfano).toHaveBeenCalledTimes(1);
    const [, , h] = guardarHuerfano.mock.calls[0] as unknown as [string, string, {
      rutaImagen?: string; motivo: string; gasto: { imagenUrl?: string; ocrExtra?: Record<string, unknown> };
    }];
    expect(h.rutaImagen).toBe('t1/v1/foto.jpg');
    expect(h.gasto.imagenUrl).toBe('t1/v1/foto.jpg');
    // `fallo_ocr` porque el CHECK 0073 no admite otro motivo: la marca de POR
    // QUÉ vive en `ocrExtra`, no en `motivo`.
    expect(h.motivo).toBe('fallo_ocr');
    expect(h.gasto.ocrExtra?.sinPresupuesto).toBe(true);
  });

  it('el mensaje dice cupo de IA y "mañana", no "se me trabó" ni "en un rato"', async () => {
    extraerComprobante.mockResolvedValue(SIN_PRESUPUESTO);
    await processInbound({ from: '5219993700779', type: 'image', mediaId: 'm1', waMessageId: 'wa1' });

    const dicho = salientes.join('\n');
    expect(dicho).toMatch(/cupo de ia/i);
    expect(dicho).toMatch(/mañana/i);
    expect(dicho).not.toMatch(/se me trabó/i);
    expect(dicho).not.toMatch(/en un rato/i);
    expect(dicho).toMatch(/no se pierde/i);
  });

  it('si tampoco se puede guardar, se le dice la verdad', async () => {
    extraerComprobante.mockResolvedValue(SIN_PRESUPUESTO);
    guardarHuerfano.mockResolvedValueOnce(false);
    await processInbound({ from: '5219993700779', type: 'image', mediaId: 'm1', waMessageId: 'wa1' });

    expect(salientes.join('\n')).toMatch(/tampoco lo pude guardar/i);
  });
});

describe('MAX_CONFIRMACIONES_SEGUIDAS: el tope estaba escrito y sin cablear', () => {
  it('doce tickets dudosos NO son doce mensajes con botones', async () => {
    // Confianza entre los dos umbrales: se lee, pero no se puede probar → el
    // peldaño `confirmar`, que es el que gasta un mensaje interactivo por foto.
    let n = 0;
    extraerComprobante.mockImplementation(async () => bueno(100 * (n += 1), 0.8));
    await rafaga(12);

    expect(botones.length, `salieron ${botones.length} mensajes con botones`).toBeLessThanOrEqual(4);
  });

  it('y las que se pasaron del tope se DICEN, no se callan', async () => {
    let n = 0;
    extraerComprobante.mockImplementation(async () => bueno(100 * (n += 1), 0.8));
    await rafaga(12);

    // `mensajeDemasiadasDudas` existía en `acuse_ticket.ts` y no la llamaba
    // nadie. Un tope que no se anuncia se lee como "todo salió bien".
    expect(salientes.join('\n')).toMatch(/no pude leer con seguridad/i);
  });

  it('CONTROL — cuatro dudosos siguen recibiendo sus cuatro botones', async () => {
    let n = 0;
    extraerComprobante.mockImplementation(async () => bueno(100 * (n += 1), 0.8));
    await rafaga(4);

    expect(botones).toHaveLength(4);
    expect(salientes.join('\n')).not.toMatch(/no pude leer con seguridad/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24 · AGEN-11 (BAJO) — la foto repetida dentro de la ráfaga era
// muda: `anotarFoto` ya la había contado en «de tus N fotos», el dedup por
// hash hacía `return` sin anotar nada, y el resumen decía «llevo N-1
// comprobantes» sin explicar la resta. El chofer la reenviaba y volvía el
// mismo silencio.
// ═══════════════════════════════════════════════════════════════════════════
describe('AGEN-11 · la foto repetida se cuenta y se dice', () => {
  it('en una ráfaga, el resumen la nombra en vez de callarla', async () => {
    extraerComprobante.mockResolvedValue(bueno(1000));
    // La 3ª de 5 es la misma que ya estaba en el viaje.
    let i = 0;
    gastoExistePorHash.mockImplementation(async () => (i += 1) === 3);
    gastoPorHash.mockResolvedValue({ id: 'g3', monto: 1000, fecha: '2026-08-02' });
    getGastos.mockResolvedValue([{ id: 'a', concepto: 'diesel', monto: 1000 }]);

    await rafagaSerial(5);

    const todo = salientes.join('\n');
    expect(todo).toContain('De las fotos que me mandaste,');
    expect(todo, 'la resta entre «5 fotos» y los comprobantes tiene que estar explicada').toMatch(/repetida/i);
    expect(todo, 'no se le pide nada: no hay nada que hacer con ella').not.toMatch(/buena luz/i);
  });

  it('una foto repetida que llegó SOLA sigue en silencio (un doble toque no es una noticia)', async () => {
    extraerComprobante.mockResolvedValue(bueno(1000));
    gastoExistePorHash.mockResolvedValue(true);
    gastoPorHash.mockResolvedValue({ id: 'g1', monto: 1000, fecha: '2026-08-02' });

    await processInbound({ from: '5219993700779', type: 'image', mediaId: 'm1', waMessageId: 'wa1' });

    expect(salientes, `recibió: ${JSON.stringify(salientes)}`).toEqual([]);
  });

  it('si además trae fecha dudosa, gana el aviso entero de la fecha y NO se cuenta dos veces', async () => {
    extraerComprobante.mockResolvedValue(bueno(1000));
    gastoExistePorHash.mockResolvedValue(true);
    gastoPorHash.mockResolvedValue({ id: 'g1', monto: 45, fecha: '2019-03-02' });
    ventanaDesdeDB.mockResolvedValue({ inicio: '2026-08-01', fin: '2026-08-05', hoy: '2026-08-04' });

    await processInbound({ from: '5219993700779', type: 'image', mediaId: 'm1', waMessageId: 'wa1' });

    const todo = salientes.join('\n');
    expect(todo).toMatch(/misma foto/i);
    expect(todo).not.toMatch(/repetida \(ya la tenía\)/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 25 · [ALTO] agentico.md:426 — el resumen consolidado de la ráfaga
// sumaba TODAS las filas de `gasto` sin pasar por `copiasDeComprobante`, la
// MISMA regla que ya usan el motor y el PDF. El protocolo normal de dos fotos
// por ticket (el completo + el acercamiento al QR) deja dos filas con el mismo
// `cfdi_uuid`; el motor las cuenta una vez y el resumen de la ráfaga las
// contaba dos — el chofer leía un total que el «listo» del mismo hilo
// desmentía minutos después.
// ═══════════════════════════════════════════════════════════════════════════
describe('AUDITORÍA 25 · el resumen de la ráfaga no cuenta las copias dos veces', () => {
  it('dos fotos del MISMO comprobante (mismo cfdi_uuid) cuentan como uno solo', async () => {
    let n = 0;
    extraerComprobante.mockImplementation(async () => bueno(100 * (n += 1)));
    getGastos.mockResolvedValue([
      { id: 'a', concepto: 'diesel', monto: 8340.50, cfdiUuid: 'ABC-123' },
      { id: 'b', concepto: 'diesel', monto: 8340.50, cfdiUuid: 'ABC-123' },
    ]);

    await rafaga(2);

    const todo = salientes.join('\n');
    expect(todo, `salió: ${JSON.stringify(salientes)}`).toMatch(/\*1 comprobante\*/);
    expect(todo).toContain('$8,340.50');
    expect(todo).not.toMatch(/\*2 comprobantes\*/);
    expect(todo).not.toContain('$16,681.00');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28 · AG-B1 (BAJO, 5ª ronda, agentico.md:38) — el resumen «Ya
// revisé tus fotos» mandaba el WhatsApp con `sendText` directo en vez del
// wrapper `say` (definido más arriba en `processInbound`, ya con
// `registrarCostoWhatsApp`), así que ese mensaje nunca entraba al costo por
// flota/viaje que ve /admin: el costo real por liquidación salía subestimado.
// ═══════════════════════════════════════════════════════════════════════════
describe('AG-B1 · el resumen consolidado de la ráfaga SÍ registra su costo de WhatsApp', () => {
  it('el «Ya revisé tus fotos» de una ráfaga registra registrarCostoWhatsApp una vez', async () => {
    let n = 0;
    extraerComprobante.mockImplementation(async () => bueno(100 * (n += 1)));

    await rafaga(3);

    const todo = salientes.join('\n');
    expect(todo).toContain('Ya revisé tus fotos');
    expect(registrarCostoWhatsApp).toHaveBeenCalledTimes(1);
    expect(registrarCostoWhatsApp).toHaveBeenCalledWith('t1', 'v1');
  });
});
