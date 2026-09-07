import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// Asignar unidad / reasignar chofer por WhatsApp: parser cerrado → todo
// resuelto contra la base → SÍ/NO → motor real. Lo más probado es lo que más
// cuesta si falla: que lo ambiguo PIDA aclaración en vez de adivinar, y que
// un "sí" viejo o un rol equivocado no muevan nada.
// ═══════════════════════════════════════════════════════════════════════════

let estadoGuardado: Record<string, unknown> | null = null;
let reclamoForzado: { data: { telefono: string }[] | null; error: { message: string } | null } | null = null;
let viajesPorFolio: Array<{ id: string; folio: string }> = [];
let errorFolio: { message: string } | null = null;

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      if (tabla === 'viaje') {
        const v = {
          select: () => v, eq: () => v, in: () => v, ilike: () => v,
          limit: async () => ({ data: errorFolio ? null : viajesPorFolio, error: errorFolio }),
        };
        return v;
      }
      if (tabla !== 'wa_conversacion') {
        throw new Error(`asignar_wa solo puede tocar wa_conversacion y viaje; pidió ${tabla}`);
      }
      let actualizando: { estado: Record<string, unknown> } | null = null;
      const b = {
        select: () => {
          if (!actualizando) return b;
          if (reclamoForzado) return Promise.resolve(reclamoForzado);
          const habia = Boolean((estadoGuardado as { asignacionPendiente?: unknown } | null)?.asignacionPendiente);
          if (habia) estadoGuardado = actualizando.estado;
          return Promise.resolve({ data: habia ? [{ telefono: '5215550000001' }] : [], error: null });
        },
        // AUDITORÍA 24, DAT-5: la lectura ahora va por `.in(variantesTelefono)`
        // con desempate, porque el mismo jefe entra como 521… y como 52…. El
        // arnés no filtra (nunca lo hizo): sólo tiene que dejar pasar la cadena.
        eq: () => b, not: () => b, in: () => b, order: () => b, limit: () => b,
        update: (fila: { estado: Record<string, unknown> }) => { actualizando = fila; return b; },
        maybeSingle: async () => ({ data: estadoGuardado ? { estado: estadoGuardado } : null, error: null }),
        upsert: (fila: { estado: Record<string, unknown> }) => {
          estadoGuardado = fila.estado;
          return Promise.resolve({ error: null });
        },
      };
      return b;
    },
  }),
}));
vi.mock('./presupuesto', async (orig) => ({
  ...(await orig() as object),
  acotada: (q: unknown) => q,
}));
const getOpenViaje = vi.fn();
vi.mock('./conv', async (orig) => ({
  ...(await orig() as object),
  getOpenViaje: (...a: unknown[]) => getOpenViaje(...a),
}));
const resolver = vi.fn();
const resolverUnidad = vi.fn();
vi.mock('./crear_viaje_wa', async (orig) => ({
  ...(await orig() as object),
  resolverOperadorPorNombre: (...a: unknown[]) => resolver(...a),
  resolverUnidadPorEconomico: (...a: unknown[]) => resolverUnidad(...a),
}));
const asignarUnidad = vi.fn();
const avisarAlChofer = vi.fn();
vi.mock('./operacion', () => ({
  asignarUnidad: (...a: unknown[]) => asignarUnidad(...a),
  avisarAlChofer: (...a: unknown[]) => avisarAlChofer(...a),
}));
const reasignarOperador = vi.fn();
vi.mock('./repo', () => ({ reasignarOperador: (...a: unknown[]) => reasignarOperador(...a) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { interpretarAsignacion, atenderAsignacionOficina } = await import('./asignar_wa');
const { interpretarPeticionViaje } = await import('./crear_viaje_wa');
const { ConsultaFallida } = await import('./conv');

const JEFE = { tenantId: 't1', rol: 'flota_admin' as const };
const TEL = '5215550000001';
const AHORA = new Date('2026-08-14T17:00:00Z');

beforeEach(() => {
  estadoGuardado = null;
  reclamoForzado = null;
  viajesPorFolio = [];
  errorFolio = null;
  getOpenViaje.mockReset();
  resolver.mockReset();
  resolverUnidad.mockReset();
  asignarUnidad.mockReset();
  avisarAlChofer.mockReset();
  reasignarOperador.mockReset();
});

// ── El parser ──────────────────────────────────────────────────────────────

describe('interpretarAsignacion', () => {
  it('unidad por folio y unidad por chofer', () => {
    expect(interpretarAsignacion('asígnale la unidad 12 al VJ-2026-0847')).toEqual({
      tipo: 'unidad', unidad: '12', ref: { por: 'folio', folio: 'vj-2026-0847' },
    });
    expect(interpretarAsignacion('ponle la unidad C2-08 al viaje de Juan Pérez')).toEqual({
      tipo: 'unidad', unidad: 'c2-08', ref: { por: 'operador', nombre: 'juan perez' },
    });
  });

  it('reasignar por folio y por chofer, con nombres de más de una palabra', () => {
    expect(interpretarAsignacion('reasigna el viaje VJ-2026-0847 a Pedro')).toEqual({
      tipo: 'chofer', nuevoOperador: 'pedro', ref: { por: 'folio', folio: 'vj-2026-0847' },
    });
    expect(interpretarAsignacion('pásale el viaje de Juan Carlos a Pedro López')).toEqual({
      tipo: 'chofer', nuevoOperador: 'pedro lopez', ref: { por: 'operador', nombre: 'juan carlos' },
    });
    expect(interpretarAsignacion('cámbiale el chofer al VJ-1 a María')).toEqual({
      tipo: 'chofer', nuevoOperador: 'maria', ref: { por: 'folio', folio: 'vj-1' },
    });
  });

  it('lo ambiguo es INCOMPLETO — pide el formato, no adivina', () => {
    // Verbo sin estructura: no se inventa a quién ni qué.
    expect(interpretarAsignacion('asígnale algo a alguien')).toEqual({ tipo: 'incompleto' });
    // Reasignar sin el " a " que separa: no hay forma de saber quién es quién.
    expect(interpretarAsignacion('reasigna el viaje de Juan')).toEqual({ tipo: 'incompleto' });
    // Un "nombre" con dígitos no es un nombre ni un folio reconocible.
    expect(interpretarAsignacion('reasigna el viaje de Juan a 44')).toEqual({ tipo: 'incompleto' });
  });

  it('lo que no es asignación devuelve null y sigue su camino', () => {
    expect(interpretarAsignacion('hola, ¿cómo van?')).toBeNull();
    expect(interpretarAsignacion('nuevo viaje para Juan, Puebla a Monterrey, anticipo 8000')).toBeNull();
    expect(interpretarAsignacion('sí')).toBeNull();
  });

  it('GUARDIA CRUZADA: el parser de CREAR no se traga una asignación (el orden del processor depende de esto)', () => {
    expect(interpretarPeticionViaje('asígnale la unidad 12 al viaje de Juan')).toBeNull();
    expect(interpretarPeticionViaje('reasigna el viaje de Juan a Pedro')).toBeNull();
  });
});

// ── El flujo con confirmación ──────────────────────────────────────────────

describe('asignar unidad', () => {
  it('propone con TODO resuelto contra la base y espera el SÍ', async () => {
    resolver.mockResolvedValue({ operadorId: 'op-9', nombre: 'Juan Pérez López' });
    getOpenViaje.mockResolvedValue('v1');
    resolverUnidad.mockResolvedValue({ unidadId: 'u-12', numeroEconomico: 'C2-12' });

    const r = await atenderAsignacionOficina(JEFE, TEL, 'asígnale la unidad 12 al viaje de Juan', AHORA);
    expect(r).toContain('C2-12');                      // el número CANÓNICO de la base
    expect(r).toContain('Juan Pérez López');           // el nombre RESUELTO
    expect(r).toContain('Responde *SÍ*');
    expect(asignarUnidad).not.toHaveBeenCalled();      // sin confirmación no se toca nada
    expect((estadoGuardado?.asignacionPendiente as { unidadId: string }).unidadId).toBe('u-12');
  });

  it('el SÍ ejecuta asignarUnidad con los ids ya resueltos', async () => {
    estadoGuardado = {
      asignacionPendiente: {
        accion: 'unidad', viajeId: 'v1', viajeEtiqueta: 'el viaje de *Juan*',
        unidadId: 'u-12', unidadEco: 'C2-12', en: AHORA.toISOString(),
      },
    };
    const r = await atenderAsignacionOficina(JEFE, TEL, 'sí', new Date(AHORA.getTime() + 60_000));
    expect(asignarUnidad).toHaveBeenCalledWith('t1', 'v1', 'u-12');
    expect(r).toContain('asignada');
    expect(r).toContain('✅');
  });

  it('el SÍ VIEJO no ejecuta nada: la vigencia expiró', async () => {
    estadoGuardado = {
      asignacionPendiente: {
        accion: 'unidad', viajeId: 'v1', viajeEtiqueta: 'el viaje de *Juan*',
        unidadId: 'u-12', unidadEco: 'C2-12', en: AHORA.toISOString(),
      },
    };
    const r = await atenderAsignacionOficina(JEFE, TEL, 'sí', new Date(AHORA.getTime() + 31 * 60_000));
    expect(asignarUnidad).not.toHaveBeenCalled();
    expect(r).toBeNull();   // cae al saludo: no hay nada pendiente que confirmar
  });

  it('el NO cancela sin tocar nada', async () => {
    estadoGuardado = {
      asignacionPendiente: {
        accion: 'unidad', viajeId: 'v1', viajeEtiqueta: 'el viaje de *Juan*',
        unidadId: 'u-12', unidadEco: 'C2-12', en: AHORA.toISOString(),
      },
    };
    const r = await atenderAsignacionOficina(JEFE, TEL, 'no', new Date(AHORA.getTime() + 60_000));
    expect(asignarUnidad).not.toHaveBeenCalled();
    expect(r).toContain('no cambié nada');
    expect(estadoGuardado).toEqual({});
  });

  it('la unidad que no existe se dice — no se asigna a ciegas', async () => {
    resolver.mockResolvedValue({ operadorId: 'op-9', nombre: 'Juan' });
    getOpenViaje.mockResolvedValue('v1');
    resolverUnidad.mockResolvedValue(null);
    const r = await atenderAsignacionOficina(JEFE, TEL, 'asígnale la unidad 99 al viaje de Juan', AHORA);
    expect(r).toContain('«99» no está dada de alta');
    expect(estadoGuardado).toBeNull();
  });

  it('folio: el viaje se busca abierto y en ESTA flota', async () => {
    viajesPorFolio = [{ id: 'v7', folio: 'VJ-2026-0847' }];
    resolverUnidad.mockResolvedValue({ unidadId: 'u-12', numeroEconomico: 'C2-12' });
    const r = await atenderAsignacionOficina(JEFE, TEL, 'asígnale la unidad 12 al VJ-2026-0847', AHORA);
    expect(r).toContain('VJ-2026-0847');
    expect((estadoGuardado?.asignacionPendiente as { viajeId: string }).viajeId).toBe('v7');
  });

  it('folio desconocido: se dice, sin proponer nada', async () => {
    viajesPorFolio = [];
    const r = await atenderAsignacionOficina(JEFE, TEL, 'asígnale la unidad 12 al VJ-9999', AHORA);
    expect(r).toContain('No encontré un viaje abierto con folio');
  });
});

describe('reasignar chofer', () => {
  it('propone y el SÍ ejecuta reasignarOperador + aviso al chofer nuevo', async () => {
    resolver.mockImplementation(async (_t: unknown, nombre: unknown) =>
      String(nombre).includes('juan')
        ? { operadorId: 'op-juan', nombre: 'Juan Pérez' }
        : { operadorId: 'op-pedro', nombre: 'Pedro López' });
    getOpenViaje.mockResolvedValue('v1');

    const r1 = await atenderAsignacionOficina(JEFE, TEL, 'reasigna el viaje de Juan a Pedro', AHORA);
    expect(r1).toContain('Pedro López');
    expect(reasignarOperador).not.toHaveBeenCalled();

    avisarAlChofer.mockResolvedValue(undefined);
    const r2 = await atenderAsignacionOficina(JEFE, TEL, 'sí', new Date(AHORA.getTime() + 60_000));
    expect(reasignarOperador).toHaveBeenCalledWith('t1', 'v1', 'op-pedro');
    expect(avisarAlChofer).toHaveBeenCalledWith('t1', 'op-pedro', 'v1');
    expect(r2).toContain('reasignado a *Pedro López*');
    // No se afirma la entrega del aviso: no hay dato que la sostenga.
    expect(r2).toContain('confirma en Despacho');
  });

  it('si el nuevo chofer ya trae viaje abierto (choque permanente), se dice y NO se reintenta', async () => {
    estadoGuardado = {
      asignacionPendiente: {
        accion: 'chofer', viajeId: 'v1', viajeEtiqueta: 'el viaje de *Juan*',
        nuevoOperadorId: 'op-pedro', nuevoOperadorNombre: 'Pedro López', en: AHORA.toISOString(),
      },
    };
    reasignarOperador.mockRejectedValue(new Error('duplicate key value violates unique constraint "uq_viaje_abierto_por_operador"'));
    const r = await atenderAsignacionOficina(JEFE, TEL, 'sí', new Date(AHORA.getTime() + 60_000));
    expect(r).toContain('ya trae un viaje abierto');
    expect(r).toContain('No cambié nada');
    expect(estadoGuardado).toEqual({});   // el claim lo limpió: otro "sí" no repite el choque
  });

  it('si el aviso al nuevo chofer truena, la reasignación queda y el jefe se entera', async () => {
    estadoGuardado = {
      asignacionPendiente: {
        accion: 'chofer', viajeId: 'v1', viajeEtiqueta: 'el viaje de *Juan*',
        nuevoOperadorId: 'op-pedro', nuevoOperadorNombre: 'Pedro López', en: AHORA.toISOString(),
      },
    };
    avisarAlChofer.mockRejectedValue(new Error('meta caído'));
    const r = await atenderAsignacionOficina(JEFE, TEL, 'sí', new Date(AHORA.getTime() + 60_000));
    expect(reasignarOperador).toHaveBeenCalled();
    expect(r).toContain('NO salió');
  });

  it('nombre ambiguo: enseña candidatos, no elige', async () => {
    const { OperadorNombreAmbiguo } = await import('./crear_viaje_wa');
    viajesPorFolio = [{ id: 'v7', folio: 'VJ-1' }];
    resolver.mockRejectedValue(new OperadorNombreAmbiguo('2', [
      { operadorId: 'a', nombre: 'José Martínez Ruiz' },
      { operadorId: 'b', nombre: 'José Martínez Cano' },
    ]));
    const r = await atenderAsignacionOficina(JEFE, TEL, 'reasigna el viaje VJ-1 a Martínez', AHORA);
    expect(r).toContain('José Martínez Ruiz');
    expect(r).toContain('José Martínez Cano');
    expect(estadoGuardado).toBeNull();
  });

  it('«Juan» sin viaje abierto: se dice', async () => {
    resolver.mockResolvedValue({ operadorId: 'op-juan', nombre: 'Juan Pérez' });
    getOpenViaje.mockResolvedValue(null);
    const r = await atenderAsignacionOficina(JEFE, TEL, 'reasigna el viaje de Juan a Pedro', AHORA);
    expect(r).toContain('no trae un viaje abierto');
  });
});

describe('la fusión de estado — no se pisa lo del dueño-que-maneja (auditoría 2, ronda 2)', () => {
  it('los turns del chofer SOBREVIVEN a un pendiente de asignación armado en la misma fila', async () => {
    // Mismo tenant+teléfono: la fila ya trae `turns` de `saveConversation`
    // para el lado de chofer del dueño-que-maneja. Antes el `upsert` de
    // `guardarPendiente` reemplazaba `estado` entero y se los comía.
    estadoGuardado = { turns: [{ role: 'user', content: 'ya casi llego' }] };
    viajesPorFolio = [{ id: 'v7', folio: 'VJ-2026-0847' }];
    resolverUnidad.mockResolvedValue({ unidadId: 'u-12', numeroEconomico: 'C2-12' });
    const r = await atenderAsignacionOficina(JEFE, TEL, 'asígnale la unidad 12 al VJ-2026-0847', AHORA);
    expect(r).toContain('Responde *SÍ*');
    expect(estadoGuardado?.turns).toEqual([{ role: 'user', content: 'ya casi llego' }]);
    expect((estadoGuardado?.asignacionPendiente as { viajeId: string }).viajeId).toBe('v7');
  });

  it('el claim del "sí" también preserva los turns ajenos al borrar asignacionPendiente', async () => {
    estadoGuardado = {
      turns: [{ role: 'user', content: 'voy llegando' }],
      asignacionPendiente: {
        accion: 'unidad', viajeId: 'v1', viajeEtiqueta: 'el viaje de *Juan*',
        unidadId: 'u-12', unidadEco: 'C2-12', en: AHORA.toISOString(),
      },
    };
    const r = await atenderAsignacionOficina(JEFE, TEL, 'sí', new Date(AHORA.getTime() + 60_000));
    expect(r).toContain('asignada');
    expect(estadoGuardado?.turns).toEqual([{ role: 'user', content: 'voy llegando' }]);
    expect(estadoGuardado?.asignacionPendiente).toBeUndefined();
  });
});

describe('los candados', () => {
  it('el contador no asigna, aunque la petición sea perfecta', async () => {
    const r = await atenderAsignacionOficina({ tenantId: 't1', rol: 'contador' }, TEL, 'asígnale la unidad 12 al viaje de Juan', AHORA);
    expect(r).toContain('tu rol');
    expect(resolver).not.toHaveBeenCalled();
  });

  it('base caída ≠ "no existe": se pide reintentar', async () => {
    resolver.mockRejectedValue(new ConsultaFallida('se cayó'));
    const r = await atenderAsignacionOficina(JEFE, TEL, 'asígnale la unidad 12 al viaje de Juan', AHORA);
    expect(r).toContain('inténtalo de nuevo');
  });

  it('dos SÍ en la misma ventana: gana exactamente uno', async () => {
    estadoGuardado = {
      asignacionPendiente: {
        accion: 'unidad', viajeId: 'v1', viajeEtiqueta: 'el viaje de *Juan*',
        unidadId: 'u-12', unidadEco: 'C2-12', en: AHORA.toISOString(),
      },
    };
    const t = new Date(AHORA.getTime() + 60_000);
    const r1 = await atenderAsignacionOficina(JEFE, TEL, 'sí', t);
    expect(r1).toContain('✅');
    // El segundo "sí" ya no encuentra pendiente (el claim lo borró).
    const r2 = await atenderAsignacionOficina(JEFE, TEL, 'sí', t);
    expect(r2).toBeNull();
    expect(asignarUnidad).toHaveBeenCalledTimes(1);
  });

  it('mensaje suelto con pendiente vivo: re-enseña lo que está en juego', async () => {
    estadoGuardado = {
      asignacionPendiente: {
        accion: 'unidad', viajeId: 'v1', viajeEtiqueta: 'el viaje de *Juan*',
        unidadId: 'u-12', unidadEco: 'C2-12', en: AHORA.toISOString(),
      },
    };
    const r = await atenderAsignacionOficina(JEFE, TEL, 'que onda', new Date(AHORA.getTime() + 60_000));
    expect(r).toContain('esperando tu confirmación');
    expect(r).toContain('C2-12');
  });

  it('la base caída al buscar el folio también pide reintentar — no "no encontré"', async () => {
    // La misma degradación que ya prueba `resolver.mockRejectedValue(ConsultaFallida)`
    // para la ruta por operador, pero por la ruta por folio: el `error` real
    // que devuelve el SELECT de `viaje` en `resolverViaje`.
    errorFolio = { message: 'boom' };
    const r = await atenderAsignacionOficina(JEFE, TEL, 'asígnale la unidad 12 al VJ-9999', AHORA);
    expect(r).toContain('inténtalo de nuevo');
  });

  it('el UPDATE del claim revienta con error: se pide reintentar, no se ejecuta a ciegas', async () => {
    estadoGuardado = {
      asignacionPendiente: {
        accion: 'unidad', viajeId: 'v1', viajeEtiqueta: 'el viaje de *Juan*',
        unidadId: 'u-12', unidadEco: 'C2-12', en: AHORA.toISOString(),
      },
    };
    // Fuerza el `error` en el SELECT que cierra el UPDATE atómico de
    // `reclamarPendiente` — algo que el flujo natural del mock nunca produce.
    reclamoForzado = { data: null, error: { message: 'boom' } };
    const r = await atenderAsignacionOficina(JEFE, TEL, 'sí', new Date(AHORA.getTime() + 60_000));
    expect(asignarUnidad).not.toHaveBeenCalled();
    expect(r).toContain('No pude tomar tu confirmación');
  });
});
