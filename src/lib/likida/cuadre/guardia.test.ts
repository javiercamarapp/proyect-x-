import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Liquidacion } from '@/types/likida';
import { logger } from '@/lib/logger';

// Se mockea el motor de cuadre desde DB para probar SOLO la lógica de la guardia
// (ramas de reemplazo / passthrough / fail-closed), sin tocar Supabase.
const LIQ: Omit<Liquidacion, 'id' | 'creadaEn'> = {
  viajeId: 'v1',
  totalComprobado: 10600,
  totalAnticipo: 10600,
  diferencia: 0,
  estatus: 'cuadrada',
  totalDeducible: 10600,
  totalNoDeducible: 0,
  totalPorConfirmar: 0,
  diferencias: [],
  gastos: [],
  iepsAcreditable: 0, litrosDieselAcreditables: 0,
  ivaAcreditable: 0,
  peajeAcreditable: 0,
};

const cuadrarDesdeDB = vi.fn();
vi.mock('./desde_db', () => ({ cuadrarDesdeDB: (...a: unknown[]) => cuadrarDesdeDB(...a) }));

const { guardiaCifras } = await import('./guardia');

const tc = (toolName: string, error?: unknown) => ({ toolName, error, args: {}, result: {} }) as never;

describe('guardiaCifras', () => {
  beforeEach(() => {
    cuadrarDesdeDB.mockReset();
    cuadrarDesdeDB.mockResolvedValue(LIQ);
  });

  it('sin cifras: deja el texto del modelo intacto', async () => {
    const r = await guardiaCifras('¿Ya mandaste todo?', [], 't', 'v');
    expect(r.forzado).toBe(false);
    expect(cuadrarDesdeDB).not.toHaveBeenCalled();
  });

  it('cifras sin cuadrar_viaje ni política: fuerza el cuadre real', async () => {
    const r = await guardiaCifras('Sobraron 500 pesos', [], 't', 'v');
    expect(r.forzado).toBe(true);
    expect(cuadrarDesdeDB).toHaveBeenCalledWith('t', 'v');
    expect(r.reply).toContain('Este es el cuadre'); // encabezado neutral (no cerró)
  });

  it('cuadrar_viaje llamada + cifras: reemplaza por el resumen autoritativo', async () => {
    const r = await guardiaCifras('sobró 999', [tc('cuadrar_viaje')], 't', 'v');
    expect(r.forzado).toBe(true);
    expect(cuadrarDesdeDB).toHaveBeenCalledWith('t', 'v');
  });

  // ── AUDITORÍA 7 · CRÍTICO del rubro agéntico ───────────────────────────────
  // `cuadro` responde "¿hay números que respaldar?" y se estaba usando para
  // responder otra pregunta distinta: "¿se CERRÓ?". Un turno que solo llama
  // `cuadrar_viaje` CALCULA pero no cierra —el viaje sigue `abierto` y la tabla
  // `liquidacion` está vacía—, y aun así el encabezado afirmaba "Listo, cuadré
  // tu viaje". El comentario de `resumen.ts:48-49` ya declaraba el contrato que
  // el código violaba: el encabezado neutral es para cuando la guardia sólo
  // muestra el cuadre sin cierre confirmado.
  //
  // La versión anterior de esta prueba fijaba el comportamiento MALO
  // ("afirma cierre porque sí cuadró"), así que la suite entera no podía verlo.
  it('cuadrar_viaje SIN guardar_liquidacion: NO afirma el cierre', async () => {
    const r = await guardiaCifras('sobró 999', [tc('cuadrar_viaje')], 't', 'v');
    expect(r.forzado).toBe(true);
    expect(r.reply).toContain('Este es el cuadre');
    expect(r.reply).not.toContain('Listo, cuadré');
  });

  it('guardar_liquidacion: ahí sí se afirma el cierre', async () => {
    // Con el snapshot que la tool SIEMPRE devuelve en producción (`result.liq`,
    // AG-3) — sin él, la guardia falla cerrado en vez de recalcular (ver el
    // describe de abajo, "sin snapshot de cierre").
    const r = await guardiaCifras('sobró 999', [tcRes('guardar_liquidacion', { liq: LIQ })], 't', 'v');
    expect(r.forzado).toBe(true);
    expect(r.reply).toContain('Listo, cuadré');
    expect(cuadrarDesdeDB).not.toHaveBeenCalled();
  });

  it('guardar_liquidacion CON error: no afirma el cierre', async () => {
    const r = await guardiaCifras('sobró 999', [tc('guardar_liquidacion', new Error('boom'))], 't', 'v');
    expect(r.reply).not.toContain('Listo, cuadré');
  });

  // ── AUDITORÍA 28, TC-A1 (ampliación de AG-3) ──────────────────────────────
  // `cerro` sin snapshot solía caer a `cuadrarDesdeDB` en `best_effort` — el
  // mismo bug que el bloque "AG-3" de abajo prueba para el camino con
  // snapshot. Aquí, sin snapshot, lo único correcto es fallar cerrado: nunca
  // inventar un cuadre nuevo sobre un cierre que el PDF ya archivó distinto.
  it('guardar_liquidacion SIN snapshot (liq ausente): fail-closed, no recalcula', async () => {
    const r = await guardiaCifras('sobró 999', [tc('guardar_liquidacion')], 't', 'v');
    expect(r.forzado).toBe(true);
    expect(cuadrarDesdeDB).not.toHaveBeenCalled();
    expect(r.reply).not.toContain('Listo, cuadré');
    expect(r.reply).not.toMatch(/\$|\d{2,}/);
  });

  it('solo consultar_politica + cifras (topes): respeta el texto', async () => {
    // El resultado de la tool tiene que TRAER el tope. Antes este caso pasaba
    // con `result: {}` —una tool que no devolvió nada— porque la guardia solo
    // miraba si la llamada existía. Con `{}` de resultado, "$2,000" es una
    // cifra que nadie calculó, y hoy la guardia lo dice.
    const r = await guardiaCifras(
      'El tope de efectivo es $2,000',
      [{ toolName: 'consultar_politica', args: {}, result: { topeEfectivo: 2000 } } as never],
      't', 'v',
    );
    expect(r.forzado).toBe(false);
    expect(cuadrarDesdeDB).not.toHaveBeenCalled();
  });

  it('cuadrar_viaje con error NO cuenta como cuadre válido', async () => {
    const r = await guardiaCifras('sobró 999', [tc('cuadrar_viaje', new Error('x'))], 't', 'v');
    expect(r.forzado).toBe(true);
    expect(r.reply).toContain('Este es el cuadre'); // neutral: no hubo cierre exitoso
  });

  it('FAIL-CLOSED: si el motor falla, no envía cifras', async () => {
    cuadrarDesdeDB.mockRejectedValue(new Error('db down'));
    const r = await guardiaCifras('Sobraron 500 pesos', [], 't', 'v');
    expect(r.forzado).toBe(true);
    expect(r.reply).not.toMatch(/\$|\d{2,}/);
  });
});

// La guardia responde AL OPERADOR por WhatsApp: es el camino feliz del demo
// (foto → "listo" → el agente narra → la guardia reemplaza con el cuadre real).
// Sin el destinatario, caía al default 'contralor' y le mandaba al chofer los
// veredictos fiscales reservados a la oficina —proveedor en lista 69-B, CFDI
// cancelado, RFC receptor— más el descargo legal completo, delante del comprador.
describe('guardiaCifras — el destinatario es el OPERADOR', () => {
  const conVeredictos: Omit<Liquidacion, 'id' | 'creadaEn'> = {
    ...LIQ,
    diferencias: [
      { tipo: 'cfdi_efos', concepto: 'diesel', monto: 0, nota: 'El emisor aparece en la lista 69-B del SAT.' },
      { tipo: 'sin_cfdi', concepto: 'diesel', monto: 0, nota: 'Diésel de $1,000 requiere factura CFDI.' },
    ],
  };

  it('no le manda al chofer el veredicto fiscal', async () => {
    cuadrarDesdeDB.mockResolvedValue(conVeredictos);
    const r = await guardiaCifras('Ya quedó, son $9,999.00', [tc('cuadrar_viaje')], 't', 'v');
    expect(r.reply).not.toMatch(/69-B/);
    expect(r.reply).not.toMatch(/no sustituye|dictamen/i); // ni el descargo legal
    expect(r.reply).toMatch(/requiere factura CFDI/);      // sí lo que puede arreglar
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B11 — LA PUERTA TRASERA DE `consultar_politica`.
//
// La guardia dejaba pasar el texto entero en cuanto hubiera una llamada exitosa
// a consultar_politica, razonando "entonces las cifras son topes". Pero la tool
// no ata al texto. El modelo podía consultar la política —barata, y siempre
// disponible— y en el mismo turno narrar un cuadre inventado. Una tool
// irrelevante desbloqueaba narrar dinero que nadie calculó.
// ═══════════════════════════════════════════════════════════════════════════
const tcRes = (toolName: string, result: unknown) => ({ toolName, args: {}, result }) as never;

describe('guardiaCifras — política consultada', () => {
  beforeEach(() => {
    cuadrarDesdeDB.mockReset();
    cuadrarDesdeDB.mockResolvedValue(LIQ);
  });

  it('deja pasar los topes que la política SÍ devolvió', async () => {
    const r = await guardiaCifras(
      'El tope de alimentación son $750 por día.',
      [tcRes('consultar_politica', { topeAlimentacionDia: 750 })],
      't', 'v',
    );
    expect(r.forzado).toBe(false);
    expect(r.reply).toContain('$750');
    expect(cuadrarDesdeDB).not.toHaveBeenCalled();
  });

  it('NO deja pasar un cuadre inventado colado junto a un tope real', async () => {
    const r = await guardiaCifras(
      'El tope son $750 por día. Por cierto, comprobaste $8,340 y sobró $500.',
      [tcRes('consultar_politica', { topeAlimentacionDia: 750 })],
      't', 'v',
    );
    expect(r.forzado).toBe(true);
    expect(r.reply).not.toContain('8,340');
    expect(cuadrarDesdeDB).toHaveBeenCalled();
  });

  it('si la política falla y aun así hay cifras, no se confía en ella', async () => {
    const r = await guardiaCifras(
      'El tope son $750.',
      [{ toolName: 'consultar_politica', args: {}, result: { topeAlimentacionDia: 750 }, error: 'timeout' } as never],
      't', 'v',
    );
    expect(r.forzado).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EL PORTÓN NO PUEDE DECIDIR SI SE REEMPLAZA UN CUADRE.
//
// `guardiaCifras` salía en la primera línea si `tieneCifrasDeDinero` decía que
// no. Eso ponía un regex —que por definición tiene falsos negativos— a decidir
// sobre el caso MÁS importante: el turno en que SÍ se llamó `cuadrar_viaje`.
//
// Si el modelo cuadró y luego narró el resultado de una forma que el detector no
// reconoce, el texto salía sin verificar. Y ese es justo el camino feliz de la
// demo: foto → "listo" → el agente narra.
//
// Cuando hubo cuadre, la respuesta ES sobre el cuadre: se sustituye por el
// resumen del motor SIEMPRE, sin preguntarle a un regex si le pareció ver dinero.
// ═══════════════════════════════════════════════════════════════════════════
describe('guardiaCifras — cuando SÍ se cuadró, no se consulta al detector', () => {
  beforeEach(() => {
    cuadrarDesdeDB.mockReset();
    cuadrarDesdeDB.mockResolvedValue(LIQ);
  });

  it('reemplaza aunque el texto no parezca traer cifras', async () => {
    const r = await guardiaCifras('Listo, ya cerré tu viaje 👍', [tc('cuadrar_viaje')], 't', 'v');
    expect(r.forzado).toBe(true);
    expect(r.reply).toContain('Comprobado');
  });

  it('reemplaza una narración con la cifra escondida en palabras', async () => {
    const r = await guardiaCifras('Te sobraron como ocho mil pesos', [tc('cuadrar_viaje')], 't', 'v');
    expect(r.forzado).toBe(true);
    expect(r.reply).not.toMatch(/ocho mil/i);
  });

  it('sin cuadre y sin cifras, el texto conversacional pasa intacto', async () => {
    // La guardia no debe secuestrar un "mándame la foto".
    const r = await guardiaCifras('Mándame la foto del ticket, porfa', [], 't', 'v');
    expect(r.forzado).toBe(false);
    expect(cuadrarDesdeDB).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// `guardar_liquidacion` TAMBIÉN ES UN CIERRE.
//
// La guardia solo miraba `cuadrar_viaje` para decidir el encabezado. Si el
// agente cerró de verdad —llamó `guardar_liquidacion`— pero llegó ahí por otro
// camino, el mensaje decía "Este es el cuadre de tu viaje" en vez de "Listo,
// cuadré tu viaje", justo cuando el PDF ya viene detrás.
//
// Las cifras salían bien: esto es el encabezado, no los números. Pero el
// operador lee "este es el cuadre" y luego le llega un PDF de cierre, y no sabe
// si su viaje quedó cerrado o no.
// ═══════════════════════════════════════════════════════════════════════════
describe('guardiaCifras — el encabezado afirma el cierre cuando de verdad se cerró', () => {
  beforeEach(() => {
    cuadrarDesdeDB.mockReset();
    cuadrarDesdeDB.mockResolvedValue(LIQ);
  });

  it('con guardar_liquidacion, afirma el cierre', async () => {
    const r = await guardiaCifras('Ya quedó, te paso el resumen: 8000', [tcRes('guardar_liquidacion', { liq: LIQ })], 't', 'v');
    expect(r.forzado).toBe(true);
    expect(r.reply).toMatch(/cuadré tu viaje/i);
  });

  it('sin cierre, encabezado neutral', async () => {
    const r = await guardiaCifras('Llevas 8000 comprobados', [tc('consultar_politica')], 't', 'v');
    expect(r.reply).toMatch(/Este es el cuadre/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 7 · CRÍTICO AG-3 — el texto y el PDF salían de dos fotografías
// distintas de la base.
//
// `guardar_liquidacion` calcula el cuadre y genera los DOS PDF en UN momento
// (T1, tools.ts). Hasta ahora, esta guardia volvía a llamar `cuadrarDesdeDB` en
// OTRO momento (T2) para armar el texto de WhatsApp. Entre T1 y T2 las fotos
// entrantes NO toman mutex (processor.ts) y pueden insertar un gasto nuevo: el
// PDF archivado (T1) y el WhatsApp (T2) terminan narrando DOS cuadres distintos
// del MISMO cierre — a veces de signo contrario ("sobró" vs "pusiste de tu
// bolsa").
//
// El fix: `guardar_liquidacion` devuelve el snapshot que ya calculó (el mismo
// que imprimió en el PDF) dentro del resultado de la tool call, y la guardia lo
// REUSA en vez de recalcular. Se prueba haciendo que `cuadrarDesdeDB` (el
// recálculo) devuelva un número DELIBERADAMENTE distinto: si el fix funciona,
// ese número nunca debe aparecer, y `cuadrarDesdeDB` no debe ni llamarse.
// ═══════════════════════════════════════════════════════════════════════════
describe('guardiaCifras — AG-3: el cierre usa el snapshot de guardar_liquidacion, no recalcula', () => {
  const LIQ_CIERRE: Omit<Liquidacion, 'id' | 'creadaEn'> = {
    ...LIQ,
    totalComprobado: 8000,
    totalAnticipo: 8000,
    diferencia: 0,
  };

  beforeEach(() => {
    cuadrarDesdeDB.mockReset();
    // Deliberadamente OTRO número: si la guardia recalcula (el bug), esta cifra
    // se filtra al operador aunque el PDF ya archivado diga otra cosa.
    cuadrarDesdeDB.mockResolvedValue({ ...LIQ, totalComprobado: 500000, totalAnticipo: 8000, diferencia: -492000 });
  });

  it('usa el snapshot de la tool call, NO el recálculo de la DB', async () => {
    const r = await guardiaCifras(
      'listo',
      [{ toolName: 'guardar_liquidacion', args: {}, result: { liquidacion_id: 'liq-1', estatus: 'cuadrada', diferencia: 0, pdf_generado: true, liq: LIQ_CIERRE } } as never],
      't', 'v',
    );
    expect(r.forzado).toBe(true);
    expect(cuadrarDesdeDB).not.toHaveBeenCalled();
    expect(r.reply).toContain('$8,000.00');
    expect(r.reply).not.toContain('500,000');
    expect(r.reply).not.toContain('492,000');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28, TC-M4 — `estado_viaje` ES INVISIBLE PARA LA GUARDIA.
//
// El prompt del ayudante ORDENA llamar `estado_viaje` ante cualquier mensaje
// abierto ("hola", "¿qué pasó?") y narrar esos números. Antes, si el modelo
// llamaba SOLO esa tool (sin `consultar_politica`), la guardia no la contaba
// como respaldo y sustituía la respuesta por un recálculo `best_effort` sin
// desglose — se pagaba la tool, el modelo la citaba bien, y la guardia la
// tiraba de todos modos por una tool que no tiene nada que ver.
// ═══════════════════════════════════════════════════════════════════════════
describe('guardiaCifras — TC-M4: estado_viaje respalda cifras igual que consultar_politica', () => {
  beforeEach(() => {
    cuadrarDesdeDB.mockReset();
    cuadrarDesdeDB.mockResolvedValue(LIQ);
  });

  const estadoViaje = {
    origen: 'CDMX', destino: 'Monterrey', estatus: 'abierto', anticipo: 12000,
    comprobado: 9681, comprobantes: 3, copias_excluidas: 1,
    por_concepto: [{ concepto: 'diesel', total: 6000, n: 2 }, { concepto: 'caseta', total: 3681, n: 1 }],
    litros_diesel_leidos: 120,
  };

  it('narra exactamente los números de estado_viaje (incluido un total de por_concepto): NO se fuerza', async () => {
    const r = await guardiaCifras(
      'Llevas comprobados $9,681 de tu anticipo de $12,000. En diésel van $6,000.',
      [tcRes('estado_viaje', estadoViaje)],
      't', 'v',
    );
    expect(r.forzado).toBe(false);
    expect(cuadrarDesdeDB).not.toHaveBeenCalled();
    expect(r.reply).toContain('$9,681');
  });

  it('estado_viaje + una cifra inventada: se fuerza al resumen de la base y se loguea sin respaldo', async () => {
    const spy = vi.spyOn(logger, 'warn');
    const r = await guardiaCifras(
      'Llevas comprobados $9,681. Y te sobran $500 extra que nadie calculó.',
      [tcRes('estado_viaje', estadoViaje)],
      't', 'v',
    );
    expect(r.forzado).toBe(true);
    expect(cuadrarDesdeDB).toHaveBeenCalledWith('t', 'v');
    expect(spy).toHaveBeenCalledWith('guardia_cifras_sin_respaldo', expect.objectContaining({ cifras: expect.arrayContaining([500]) }));
    spy.mockRestore();
  });

  it('los casos de T1-02 (cerró sin snapshot → texto neutro) siguen verdes', async () => {
    const r = await guardiaCifras('sobró 999', [tc('guardar_liquidacion')], 't', 'v');
    expect(r.forzado).toBe(true);
    expect(cuadrarDesdeDB).not.toHaveBeenCalled();
    expect(r.reply).toBe('Ya cerré tu liquidación ✅. Te mando el PDF.');
  });
});

describe('guardiaCifras — "no pude verificar" no es "está bien"', () => {
  beforeEach(() => {
    cuadrarDesdeDB.mockReset();
    cuadrarDesdeDB.mockResolvedValue(LIQ);
  });

  it('una cantidad en PALABRAS con la política consultada no pasa por respaldada', async () => {
    // El portón la detecta, pero el extractor no puede sacar un número que
    // cotejar contra el resultado de la tool. Lista vacía significaba "todo
    // respaldado", y eso es leer un fallo de verificación como una aprobación.
    const r = await guardiaCifras(
      'Te sobraron como ocho mil pesos',
      [{ toolName: 'consultar_politica', args: {}, result: { topeEfectivo: 2000 } } as never],
      't', 'v',
    );
    expect(r.forzado).toBe(true);
    expect(r.reply).not.toMatch(/ocho mil/i);
  });
});
