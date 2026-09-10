import { describe, it, expect, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// `traerTodo` TENÍA EL MISMO BUG QUE VINO A CURAR — con el techo más alto.
//
// Existe porque PostgREST recorta a `max_rows` en silencio. Pero al agotar sus
// 100 páginas hacía `return filas` normal: 100,000 filas, sin lanzar, sin
// loguear, sin marca de lectura incompleta. Con 240,000 gastos al año, la
// pantalla de valor-ahorro reportaba 100,000 y `detectarAnomalias` decía "0
// anomalías" sobre el 41% de los datos. Un recorte silencioso a 100,000 es el
// mismo error que uno a 1,000; solo tarda más en aparecer.
//
// Y cortaba con `pag.length < PAGINA`, que da por hecho que el servidor entrega
// todo lo que se le pide. `max_rows` es un ajuste de proyecto: bajarlo a 500 en
// el panel de Supabase hacía que TODA lectura paginada del repo se detuviera en
// la primera página y devolviera 500 filas como si fueran todas.
//
// Estos dos modos son los que se fijan aquí. `analytics_paginacion.test.ts` no
// los atrapaba porque su mock devuelve páginas completas siempre.
// ═══════════════════════════════════════════════════════════════════════════

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { traerTodo, traerTodoDesdeId, conteo, exigir, LecturaIncompleta, PAGINA, MAX_PAGINAS } = await import('./pg');
const { logger } = await import('@/lib/logger');

type Fila = { id: number };

/**
 * Una base de mentira que se comporta como PostgREST DE VERDAD:
 *
 *  · `range(desde, hasta)` rebana — y entrega como mucho `maxRows` filas,
 *    que es exactamente lo que hace el ajuste del proyecto;
 *  · `count` solo viene si la consulta lo pidió.
 *
 * Devolver siempre la tabla entera (lo que hacen los mocks viejos) describe una
 * base que no existe, y es esa ficción la que dejaba pasar el recorte.
 */
function baseFalsa(total: number, maxRows = PAGINA) {
  const rangos: Array<[number, number]> = [];
  const filas = Array.from({ length: total }, (_, i) => ({ id: i }));
  const consultar = (desde: number, hasta: number, opciones: { count?: 'exact' } = {}) => {
    rangos.push([desde, hasta]);
    const pedidas = hasta - desde + 1;
    return Promise.resolve({
      data: filas.slice(desde, desde + Math.min(pedidas, maxRows)),
      error: null,
      count: opciones.count === 'exact' ? total : null,
    });
  };
  return { rangos, consultar };
}

/** El error que lanzó la promesa. Si no lanzó, devuelve uno que no es
 *  `LecturaIncompleta`, y la aserción de tipo de abajo es la que se pone roja. */
async function atrapar(p: Promise<unknown>): Promise<InstanceType<typeof LecturaIncompleta>> {
  try {
    await p;
    return new Error('no lanzó') as InstanceType<typeof LecturaIncompleta>;
  } catch (e) {
    return e as InstanceType<typeof LecturaIncompleta>;
  }
}

describe('traerTodo — el techo de páginas ya no se recorta en silencio', () => {
  it('al agotar las 100 páginas LANZA, en vez de devolver 100,000 filas como si fueran todas', async () => {
    // 240,000 gastos al año es un tenant mediano de verdad. Antes esto devolvía
    // las primeras 100,000 y la pantalla las presentaba como el total.
    const base = baseFalsa(240_000);
    await expect(traerTodo<Fila>((d, h) => base.consultar(d, h), 'getKpis'))
      .rejects.toThrow(LecturaIncompleta);
    expect(base.rangos).toHaveLength(MAX_PAGINAS);
    expect(logger.error).toHaveBeenCalledWith('pg.lectura_incompleta',
      expect.objectContaining({ consulta: 'getKpis', leidas: 100_000 }));
  });

  it('el mensaje dice CUÁNTAS leyó de cuántas — sin eso no se sabe de qué tamaño es el hueco', async () => {
    const base = baseFalsa(240_000);
    const err = await atrapar(traerTodo<Fila>((d, h) => base.consultar(d, h, conteo(d)), 'detectarAnomalias'));
    expect(err).toBeInstanceOf(LecturaIncompleta);
    expect(err.message).toContain('detectarAnomalias');
    expect(err.message).toContain('100000');
    expect(err.message).toContain('240000');
    expect(err.leidas).toBe(100_000);
    expect(err.esperadas).toBe(240_000);
  });

  it('el recorte NO se cuela como dato: la promesa se rechaza, no resuelve con la mitad', async () => {
    const base = baseFalsa(150_000);
    let resolvio: unknown = 'no resolvió';
    await traerTodo<Fila>((d, h) => base.consultar(d, h), 'x').then((v) => { resolvio = v; }, () => {});
    expect(resolvio).toBe('no resolvió');
  });
});

describe('traerTodo — una página corta ya no significa "ya terminamos"', () => {
  it('con `max_rows` bajado a 500, trae las 1,200 filas y no las primeras 500', async () => {
    // ESTE es el bug con el que se podía apagar el repo entero desde el panel de
    // Supabase, sin tocar una línea de código. Con el corte por
    // `pag.length < PAGINA`, la página 1 traía 500 y ahí se acababa todo.
    const base = baseFalsa(1_200, 500);
    const filas = await traerTodo<Fila>((d, h) => base.consultar(d, h), 'getGastos');
    expect(filas).toHaveLength(1_200);
    expect(filas[1_199].id).toBe(1_199);
    // El cursor avanza por filas LEÍDAS, no por número de página: saltar de mil
    // en mil se habría brincado las filas 500-999.
    expect(base.rangos.slice(0, 3)).toEqual([[0, 999], [500, 1499], [1000, 1999]]);
  });

  it('sin `count`, la prueba del final es una página VACÍA (y cuesta una consulta más)', async () => {
    const base = baseFalsa(5);
    const filas = await traerTodo<Fila>((d, h) => base.consultar(d, h), 'getKpis');
    expect(filas).toHaveLength(5);
    expect(base.rangos).toEqual([[0, 999], [5, 1004]]);
  });

  it('sin filas no hay consulta de más: la página 0 vacía ya prueba el final', async () => {
    const base = baseFalsa(0);
    expect(await traerTodo<Fila>((d, h) => base.consultar(d, h), 'getKpis')).toEqual([]);
    expect(base.rangos).toHaveLength(1);
  });
});

describe('traerTodo — con `count` la lectura se comprueba, no se supone', () => {
  it('pide el total en la primera página y en ninguna otra', async () => {
    const base = baseFalsa(1_200, 500);
    const pedidos: Array<{ count?: 'exact' }> = [];
    await traerTodo<Fila>((d, h) => { pedidos.push(conteo(d)); return base.consultar(d, h, conteo(d)); }, 'x');
    expect(pedidos[0]).toEqual({ count: 'exact' });
    expect(pedidos.slice(1).every((p) => p.count === undefined)).toBe(true);
  });

  it('con el total conocido no hace falta la página vacía: se para en seco al completar', async () => {
    const base = baseFalsa(5);
    const filas = await traerTodo<Fila>((d, h) => base.consultar(d, h, conteo(d)), 'getKpis');
    expect(filas).toHaveLength(5);
    expect(base.rangos).toEqual([[0, 999]]);   // UNA consulta, no dos
  });

  it('si el servidor deja de entregar antes del total, LANZA con la cuenta a la vista', async () => {
    // Dice que hay 1,200 y entrega 700. Devolver 700 sumadas es afirmar una
    // cifra que no se midió, y a la baja es la dirección que nadie revisa.
    let entregadas = 0;
    const consultar = (desde: number, hasta: number, opciones: { count?: 'exact' } = {}) => {
      const quedan = Math.max(0, 700 - entregadas);
      const n = Math.min(quedan, hasta - desde + 1);
      entregadas += n;
      return Promise.resolve({
        data: Array.from({ length: n }, (_, i) => ({ id: desde + i })),
        error: null,
        count: opciones.count === 'exact' ? 1_200 : null,
      });
    };
    const err = await atrapar(traerTodo<Fila>((d, h) => consultar(d, h, conteo(d)), 'getAcumulado'));
    expect(err).toBeInstanceOf(LecturaIncompleta);
    expect(err.message).toContain('solo se leyeron 700 de 1200');
  });

  it('que entren filas nuevas mientras se pagina NO es el fallo que se persigue', async () => {
    // El `count` es de la primera página; si alguien inserta entre página y
    // página, se lee de más. Sobrar no miente sobre el periodo — faltar sí.
    const base = baseFalsa(1_500);
    const filas = await traerTodo<Fila>(
      (d, h) => base.consultar(d, h, d === 0 ? { count: 'exact' } : {}),
      'x',
    );
    expect(filas).toHaveLength(1_500);
  });
});

describe('los bordes que ya estaban y siguen', () => {
  it('un fallo de Supabase llega por valor y se traduce a excepción, con el nombre de la consulta', async () => {
    await expect(traerTodo<Fila>(() => Promise.resolve({ data: null, error: { message: 'fetch failed' } }), 'getKpis'))
      .rejects.toThrow('getKpis: fetch failed');
  });

  it('`exigir` deja pasar el `null` legítimo de un `maybeSingle` sin fila', () => {
    expect(exigir({ data: null, error: null }, 'x')).toBeNull();
  });

  it('`conteo` pide el total solo en la primera página', () => {
    expect(conteo(0)).toEqual({ count: 'exact' });
    expect(conteo(1_000)).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// `traerTodoDesdeId` — AUDITORÍA 24, MEDIO REINCIDENTE (candidatosDb de
// `intake/consolidado.ts`, REN-C1 auditoría 29).
//
// `traerTodo` pagina por POSICIÓN (`range`). Sobre una tabla VIVA, un INSERT
// que cae ANTES del cursor mientras se pagina desplaza todo un lugar: la fila
// que estaba justo en el borde de la página ya leída se vuelve a leer en la
// página siguiente. `leidas` termina igual a `esperadas` (una fila de más
// compensa la fila nueva que nunca se leyó), así que nada lo nota — y una
// fila contada dos veces en una suma fiscal es dinero de más sin aviso.
//
// `traerTodoDesdeId` no tiene ese modo de falla PORQUE su cursor es la fila
// («`id` mayor al último que vi»), no una posición: es verdad sin importar
// qué se insertó o borró en cualquier otra parte de la tabla mientras tanto.
// ═══════════════════════════════════════════════════════════════════════════

/** IDs ordenables de ancho fijo, para poder insertar un valor NUEVO en
 *  cualquier punto intermedio sin romper el orden lexicográfico. */
function idsOrdenados(n: number, paso = 10): string[] {
  return Array.from({ length: n }, (_, i) => String(i * paso).padStart(8, '0'));
}

/** Una tabla que de verdad vive: `mutar` se dispara la PRIMERA vez que se pide
 *  una página después de la primera — el mismo instante en el que, en
 *  producción, un chofer cierra un viaje por WhatsApp entre una página y la
 *  siguiente. */
function tablaViva(idsIniciales: string[], mutar: (ids: string[]) => void) {
  const ids = [...idsIniciales];
  let mutada = false;
  const disparar = () => { if (!mutada) { mutada = true; mutar(ids); } };
  return {
    porRango: (desde: number, hasta: number, opciones: { count?: 'exact' } = {}) => {
      if (desde > 0) disparar();
      const totalAlPedir = ids.length;
      const pedidas = hasta - desde + 1;
      return Promise.resolve({
        data: ids.slice(desde, desde + pedidas).map((id) => ({ id })),
        error: null,
        count: opciones.count === 'exact' ? totalAlPedir : null,
      });
    },
    porCursor: (despuesDe: string | null, limite: number, opciones: { count?: 'exact' } = {}) => {
      if (despuesDe !== null) disparar();
      const totalAlPedir = ids.length;
      const arr = despuesDe === null ? ids : ids.filter((id) => id > despuesDe);
      return Promise.resolve({
        data: arr.slice(0, limite).map((id) => ({ id })),
        error: null,
        count: opciones.count === 'exact' ? totalAlPedir : null,
      });
    },
  };
}

describe('traerTodoDesdeId vs. traerTodo — el mismo INSERT concurrente, dos resultados distintos', () => {
  it('range() por posición SÍ duplica una fila cuando algo se inserta antes del cursor entre página y página', async () => {
    const base = idsOrdenados(1_200); // '00000000', '00000010', … '00011990'
    // Se inserta '00005005' — cae entre la fila 500 (valor 5000) y la 501
    // (valor 5010): DENTRO de lo que la página 1 (posiciones 0-999) ya leyó.
    const tabla = tablaViva(base, (ids) => { ids.splice(501, 0, '00005005'); });

    const filas = await traerTodo<{ id: string }>(
      (d, h) => Promise.resolve(tabla.porRango(d, h, conteo(d))),
      'x',
    );

    // La fila que estaba en la posición 999 de la página 1 (valor '00009990')
    // vuelve a aparecer en la página 2, desplazada por el insert.
    const veces = filas.filter((f) => f.id === '00009990').length;
    expect(veces).toBe(2);
    // `leidas` (1,201: la duplicada de más) ya es `>= esperadas` (1,200) —
    // la prueba de "completa" se cumple CON una fila de más y otra que nunca
    // se leyó (la nueva), y nada distingue ese caso del correcto.
    expect(filas.length).toBe(1_201);
  });

  it('traerTodoDesdeId NO duplica ni pierde nada bajo el MISMO insert concurrente', async () => {
    const base = idsOrdenados(1_200);
    const tabla = tablaViva(base, (ids) => { ids.splice(501, 0, '00005005'); });

    const filas = await traerTodoDesdeId<{ id: string }>(
      (cursor) => Promise.resolve(tabla.porCursor(cursor, PAGINA, cursor === null ? { count: 'exact' } : {})),
      'x',
    );

    const veces = filas.filter((f) => f.id === '00009990').length;
    expect(veces).toBe(1);
    // Las 1,200 originales, cada una una sola vez. La fila nueva (llegó
    // DESPUÉS de que el `count` de la primera página la excluyera) no se
    // exige — mismo criterio que `traerTodo`: sobrar no es el fallo que se
    // persigue, faltar sí.
    expect(filas.map((f) => f.id).filter((id) => base.includes(id))).toEqual(base);
  });
});

describe('traerTodoDesdeId — mismo contrato que traerTodo: completo Y demostrado, o se lanza', () => {
  it('pide el total en la primera página y se para en seco al completarlo, sin página vacía de más', async () => {
    const base = idsOrdenados(5);
    const tabla = tablaViva(base, () => {});
    const pedidos: Array<string | null> = [];
    const filas = await traerTodoDesdeId<{ id: string }>(
      (cursor) => { pedidos.push(cursor); return Promise.resolve(tabla.porCursor(cursor, PAGINA, cursor === null ? { count: 'exact' } : {})); },
      'x',
    );
    expect(filas.map((f) => f.id)).toEqual(base);
    expect(pedidos).toEqual([null]); // UNA sola consulta
  });

  it('sin `count`, una página vacía SÍ demuestra el final (no hace falta una segunda consulta con cursor repetido)', async () => {
    const base = idsOrdenados(3);
    const tabla = tablaViva(base, () => {});
    const filas = await traerTodoDesdeId<{ id: string }>(
      (cursor) => Promise.resolve(tabla.porCursor(cursor, PAGINA)),
      'x',
    );
    expect(filas.map((f) => f.id)).toEqual(base);
  });

  it('si se agotan las páginas sin completar el total, LANZA — nunca una cifra parcial', async () => {
    // `porCursor` con `limite=1` fuerza muchas páginas; MAX_PAGINAS las agota
    // antes de llegar al total real.
    const base = idsOrdenados(MAX_PAGINAS + 5, 1);
    const tabla = tablaViva(base, () => {});
    await expect(traerTodoDesdeId<{ id: string }>(
      (cursor) => Promise.resolve(tabla.porCursor(cursor, 1, cursor === null ? { count: 'exact' } : {})),
      'candidatosDb',
    )).rejects.toThrow(LecturaIncompleta);
    expect(logger.error).toHaveBeenCalledWith('pg.lectura_incompleta',
      expect.objectContaining({ consulta: 'candidatosDb' }));
  });

  it('un fallo de Supabase llega por valor y se traduce a excepción, con el nombre de la consulta', async () => {
    await expect(traerTodoDesdeId<{ id: string }>(
      () => Promise.resolve({ data: null, error: { message: 'fetch failed' } }),
      'candidatosDb',
    )).rejects.toThrow('candidatosDb: fetch failed');
  });
});
