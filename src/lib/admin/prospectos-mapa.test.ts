// EL CEREBRO DE VENTAS — el criterio de los dos porcentajes es determinista
// y estas pruebas lo FIJAN: si alguien mueve un peso, la prueba lo dice y el
// pie del mapa (que enseña CRITERIO_SCORES) se actualiza con él.
import { describe, expect, it } from 'vitest';
import {
  plazaDe, giroDe, scoreUrgencia, scoreCierre, tamanoDe, completitudDe, COLOR_EMBUDO, CRITERIO_SCORES,
  normalizarScian, esScianCarga,
  traerTodoEnParalelo, empacar, desempacar, type ProspectoMapa,
} from './prospectos-mapa';
import { PAGINA, LecturaIncompleta } from '@/lib/likida/pg';

describe('plazaDe — la plaza sin adivinar', () => {
  it('ciudad, entidad → separa y normaliza la entidad al nombre del geo', () => {
    expect(plazaDe('Escobedo, Nuevo León')).toEqual({ ciudad: 'Escobedo', entidad: 'Nuevo León' });
    expect(plazaDe('San Pedro Tlaquepaque, Jalisco')).toEqual({ ciudad: 'San Pedro Tlaquepaque', entidad: 'Jalisco' });
  });
  it('ciudad sola conocida → entidad por catálogo; desconocida → sin plaza declarada', () => {
    expect(plazaDe('Guadalajara')).toEqual({ ciudad: 'Guadalajara', entidad: 'Jalisco' });
    expect(plazaDe('Villa Inventada')).toEqual({ ciudad: 'Villa Inventada', entidad: null });
  });
  it('el ruido del censo (nacional/bolsas) NO es una plaza', () => {
    expect(plazaDe('Computrabajo (nacional)')).toEqual({ ciudad: null, entidad: null });
    expect(plazaDe(null)).toEqual({ ciudad: null, entidad: null });
  });
  it('CDMX en sus tres nombres cae a Ciudad de México', () => {
    expect(plazaDe('Azcapotzalco, CDMX').entidad).toBe('Ciudad de México');
    expect(plazaDe('Iztapalapa, Distrito Federal').entidad).toBe('Ciudad de México');
  });
});

describe('giroDe — transportista o qué', () => {
  it('el nombre confiesa el giro', () => {
    expect(giroDe('Transportes Castores', null, null)).toBe('transportista');
    expect(giroDe('KN Logistics', null, null)).toBe('logistica');
    expect(giroDe('Del Fruto Distribuidora', 'Cajero Liquidador', 'reparto y cedis')).toBe('flota_propia');
    expect(giroDe('Grupo Herdez', null, null)).toBe('otro');
  });
  it('la actividad DENUE en notas también clasifica', () => {
    expect(giroDe('AVE', null, 'DENUE: Autotransporte foráneo de carga general')).toBe('transportista');
  });

  describe('el SCIAN veta el nombre (18-ago) — no todo "transporte" es autotransporte de carga', () => {
    it('484 (carga) no cambia nada — el nombre sigue mandando', () => {
      expect(giroDe('AZ TRANSPORTES DE CARGA', null, null, '484222')).toBe('transportista');
    });
    it('485 (pasajeros): el nombre miente, el SCIAN gana — "AAZ TRANSPORTE" es un concesionario de autobuses', () => {
      expect(giroDe('AAZ TRANSPORTE', null, null, '485111')).not.toBe('transportista');
    });
    it('488 (aduanales/grúas) igual se veta, aunque el nombre diga "transportes internacionales"', () => {
      expect(giroDe('24-7 TRANSPORTES INTERNACIONALES', null, null, '488511')).not.toBe('transportista');
    });
    it('492 (paquetería) y 493 (almacenamiento) también quedan fuera de "transportista"', () => {
      expect(giroDe('EXPRESS TRANSPORTES', null, null, '492110')).not.toBe('transportista');
      expect(giroDe('BODEGAS TRANSPORTES DEL NORTE', null, null, '493110')).not.toBe('transportista');
    });
    it('sin SCIAN (la mayoría del censo hoy) el comportamiento no cambia — sigue siendo heurística de nombre', () => {
      expect(giroDe('Transportes Castores', null, null)).toBe('transportista');
      expect(giroDe('Transportes Castores', null, null, null)).toBe('transportista');
    });
  });
  it('las categorías del TAM del 17-ago: embotelladora y mayoreo', () => {
    expect(giroDe('Bebidas del Bajío', null, 'UNIVERSO DENUE: Elaboración de refrescos y otras bebidas')).toBe('embotelladora');
    expect(giroDe('Grupo Surtidor', null, 'UNIVERSO DENUE: Comercio al por mayor de abarrotes')).toBe('abarrotes_mayoreo');
    // La embotelladora gana al mayoreo cuando ambas señales aparecen: fabrica ella.
    expect(giroDe('Embotelladora X', null, 'comercio al por mayor de bebidas · elaboración de refrescos')).toBe('embotelladora');
  });
});

describe('SCIAN completo — el código de DENUE no se trunca', () => {
  it('normaliza seis dígitos y conserva el prefijo de sector', () => {
    expect(normalizarScian(' 484121 ')).toBe('484');
    expect(normalizarScian('SCIAN 484121')).toBe('484');
    expect(esScianCarga('484121')).toBe(true);
    expect(esScianCarga('485111')).toBe(false);
  });

  it('la flota investigada suma ajuste comercial sin contaminar urgencia', () => {
    const base = { telefono: '55', correo: 'a@b.mx', contacto_nombre: 'Ana', estado: 'nuevo', fuente: 'censo', empresa: 'X', vacante: null, notas: null };
    expect(scoreCierre({ ...base, numUnidades: 250 })).toBeGreaterThan(scoreCierre(base));
    expect(scoreUrgencia({ vacante: null, notas: null, urgenciaDeclarada: 'explorando' })).toBe(0);
  });
});

describe('scoreUrgencia — la conducta del prospecto, no un vibe', () => {
  it('dolor directo + anuncios + recencia suma más que señal suelta', () => {
    const caliente = scoreUrgencia({
      vacante: 'Auxiliar de Liquidaciones',
      notas: 'DOLOR DIRECTO: la vacante nombra la liquidación · 5 anuncios en el censo · último anuncio: Hace 8 hor',
    });
    const tibio = scoreUrgencia({ vacante: 'Mecánico diésel', notas: 'SEÑAL DEL GIRO: diésel · 1 anuncio en el censo' });
    expect(caliente).toBeGreaterThan(75);
    expect(tibio).toBeLessThan(40);
    expect(caliente).toBeLessThanOrEqual(100);
  });
  it('sin notas ni vacante → 0, no un número inventado', () => {
    expect(scoreUrgencia({ vacante: null, notas: null })).toBe(0);
  });
});

describe('scoreCierre — alcanzabilidad + fit + embudo', () => {
  const base = {
    telefono: null, correo: null, contacto_nombre: null,
    estado: 'nuevo', fuente: 'censo', empresa: 'Transportes X', vacante: null, notas: null,
  };
  it('cada dato de contacto sube; el decisor pesa como el teléfono', () => {
    const solo = scoreCierre(base);
    const conTel = scoreCierre({ ...base, telefono: '5512345678' });
    const completo = scoreCierre({ ...base, telefono: '55', correo: 'a@b.mx', contacto_nombre: 'Juan, DG' });
    expect(conTel).toBeGreaterThan(solo);
    expect(completo).toBeGreaterThan(conTel);
  });
  it('el embudo manda: cliente=100, perdido=0 — sin importar lo demás', () => {
    expect(scoreCierre({ ...base, estado: 'cerrado' })).toBe(100);
    expect(scoreCierre({ ...base, telefono: '55', correo: 'a@b.mx', estado: 'perdido' })).toBe(0);
  });
  it.each([
    ['negociacion', 'proposal'],
    ['cerrado', 'won'],
    ['perdido', 'lost'],
  ])('el alias %s puntúa exactamente igual que %s', (alias, canonico) => {
    expect(scoreCierre({ ...base, estado: alias }))
      .toBe(scoreCierre({ ...base, estado: canonico }));
  });
});

describe('la paleta del embudo cubre el dominio completo del CHECK 0105', () => {
  it('los 6 estados tienen color y nombre — un estado sin color sería un pin invisible', () => {
    for (const e of ['nuevo', 'contactado', 'demo', 'negociacion', 'cerrado', 'perdido']) {
      expect(COLOR_EMBUDO[e]?.color).toMatch(/^#/);
      expect(COLOR_EMBUDO[e]?.nombre.length).toBeGreaterThan(3);
    }
  });
  it('el criterio publicado dice "estimación", porque lo es', () => {
    expect(CRITERIO_SCORES.urgencia).toMatch(/[Ee]stimación/);
    expect(CRITERIO_SCORES.cierre).toMatch(/[Ee]stimación/);
  });
});

describe('tamaño y completitud — los filtros de la ronda 2 (17-ago)', () => {
  it('el estrato DENUE de las notas se vuelve etiqueta de tamaño', () => {
    expect(tamanoDe('UNIVERSO DENUE: Autotransporte · 11 a 30 personas')).toBe('11-30');
    expect(tamanoDe('algo · 101 a 250 personas · más')).toBe('101-250');
    expect(tamanoDe('gigante · 251 y más personas')).toBe('250+');
    expect(tamanoDe('DOLOR DIRECTO: sin estrato')).toBeNull();
  });
  it('la completitud suma solo lo que existe y llega a 100 con todo', () => {
    expect(completitudDe({ telefono: null, correo: null, contacto_nombre: null, lat: null, notas: null })).toBe(0);
    // Desde la 0139 el 100 exige el sitio VERIFICADO, no solo presente: ver
    // "tener un sitio no es tener el sitio correcto" más abajo.
    expect(completitudDe({ telefono: '55', correo: 'a@b.mx', contacto_nombre: 'Ana, DG', lat: 20, notas: 'sitio: x.mx', sitioVerificado: true })).toBe(100);
    expect(completitudDe({ telefono: '55', correo: 'a@b.mx', contacto_nombre: 'Ana, DG', lat: 20, notas: 'sitio: x.mx' })).toBe(90);
    expect(completitudDe({ telefono: '55', correo: null, contacto_nombre: null, lat: 20, notas: null })).toBe(45);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LO QUE EL PROSPECTO DICE DE SÍ MISMO (18-ago-2026)
// ═══════════════════════════════════════════════════════════════════════════
describe('la declaración del prospecto manda sobre la inferencia', () => {
  const vacanteQueGrita = { vacante: 'Cajero Liquidador de viajes', notas: 'DOLOR DIRECTO · 5 anuncios en el censo' };

  it('quien dijo "ya" queda en 100 aunque no tenga ni vacante', () => {
    expect(scoreUrgencia({ vacante: null, notas: null, urgenciaDeclarada: 'inmediata' })).toBe(100);
  });

  it('quien dijo "estoy explorando" NO se ordena arriba del que dijo "ya"', () => {
    // Es el punto entero: si la declaración solo sumara, este —que avisó que
    // no corre prisa— treparía por su vacante y desplazaría al que sí urge.
    const explorando = scoreUrgencia({ ...vacanteQueGrita, urgenciaDeclarada: 'explorando' });
    const inmediato = scoreUrgencia({ vacante: null, notas: null, urgenciaDeclarada: 'inmediata' });
    expect(explorando).toBeLessThan(inmediato);
  });

  it('sin declaración se sigue infiriendo de la vacante, como siempre', () => {
    expect(scoreUrgencia(vacanteQueGrita)).toBeGreaterThan(50);
  });
});

describe('quien llegó solo pesa más que uno scrapeado', () => {
  const base = {
    telefono: '8112345678', correo: 'a@b.mx', contacto_nombre: 'Ana',
    estado: 'nuevo', empresa: 'Autotransportes X', vacante: null, notas: null,
  };

  it('un lead de anuncio pagado supera al mismo prospecto sacado del censo', () => {
    expect(scoreCierre({ ...base, fuente: 'ads-meta' }))
      .toBeGreaterThan(scoreCierre({ ...base, fuente: 'censo' }));
  });

  it('un decisor con contacto verificado suma; el inferido no llega aquí', () => {
    // `personasVerificadas` cuenta SOLO lo no inferido (0138). Un correo
    // adivinado pintaría de verde un camino que rebota.
    expect(scoreCierre({ ...base, fuente: 'censo', personasVerificadas: 2 }))
      .toBeGreaterThan(scoreCierre({ ...base, fuente: 'censo', personasVerificadas: 0 }));
  });

  it('nunca se pasa de 100 por más señales que se acumulen', () => {
    expect(scoreCierre({ ...base, fuente: 'ads-meta', estado: 'negociacion', personasVerificadas: 9 }))
      .toBeLessThanOrEqual(100);
  });
});

describe('tener un sitio no es tener el sitio correcto', () => {
  const base = { telefono: null, correo: null, contacto_nombre: null, lat: null, notas: 'sitio: grupomodelo.com' };

  it('un sitio SIN verificar ya no regala puntos', () => {
    // Es el caso medido: 820 filas con el dominio del corporativo padre o de
    // un tercero. Antes puntuaban igual que una fila correcta y subían en el
    // tablero — el error de scraping se volvía prioridad de venta.
    expect(completitudDe(base)).toBe(0);
    expect(completitudDe({ ...base, sitioVerificado: false })).toBe(0);
  });

  it('verificado sí los da', () => {
    expect(completitudDe({ ...base, sitioVerificado: true })).toBe(10);
  });
});

describe('traerTodoEnParalelo — el Cerebro no espera 33 vueltas de red en fila', () => {
  it('cabe en la primera página: no pide una segunda', async () => {
    const universo = Array.from({ length: 3 }, (_, i) => ({ id: i }));
    let llamadas = 0;
    const filas = await traerTodoEnParalelo(async (d, h) => {
      llamadas++;
      return { data: universo.slice(d, h + 1), error: null, count: d === 0 ? universo.length : undefined };
    }, 'prueba');
    expect(filas).toEqual(universo);
    expect(llamadas).toBe(1);
  });

  it('varias páginas: las junta en orden aunque la red conteste fuera de orden', async () => {
    const total = PAGINA * 3 + 7; // 4 páginas
    const universo = Array.from({ length: total }, (_, i) => ({ id: i }));
    const filas = await traerTodoEnParalelo(async (d, h) => {
      // Las páginas de índice ALTO contestan primero — el resultado no se
      // debe desordenar por eso (se ensambla por posición, no por llegada).
      const pagina = Math.floor(d / PAGINA);
      await new Promise((r) => setTimeout(r, pagina === 0 ? 0 : (4 - pagina) * 5));
      return { data: universo.slice(d, h + 1), error: null, count: d === 0 ? total : undefined };
    }, 'prueba');
    expect(filas).toEqual(universo);
  });

  it('si al final falta una fila, LANZA — nunca enseña una cartera recortada', async () => {
    const total = PAGINA + 5;
    const universo = Array.from({ length: total }, (_, i) => ({ id: i }));
    await expect(traerTodoEnParalelo(async (d, h) => {
      // La segunda página pierde una fila (simula un fallo a medias).
      const pag = d === 0 ? universo.slice(0, PAGINA) : universo.slice(d, h + 1).slice(0, -1);
      return { data: pag, error: null, count: d === 0 ? total : undefined };
    }, 'prueba')).rejects.toThrow(LecturaIncompleta);
  });

  it('sin conteo exacto (Supabase no lo mandó), cae al camino secuencial y aun así trae todo', async () => {
    const universo = Array.from({ length: PAGINA + 3 }, (_, i) => ({ id: i }));
    const filas = await traerTodoEnParalelo(async (d, h) =>
      ({ data: universo.slice(d, h + 1), error: null }), 'prueba');
    expect(filas).toEqual(universo);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FE-16 — LA FILA VIAJA EN TUPLA.
//
// Los nombres de los 22 campos son ~260 bytes por fila; con 33 mil filas eso
// son 8.6 MB de payload que dicen veintidós veces "similitudIcpPct" y ni un
// dato. En tupla ese costo es cero, y el precio es que un campo movido de
// lugar pinta el teléfono en la columna del correo. Esta prueba es el
// candado: si `empacar` y `desempacar` dejan de ser inversas, falla.
// ═══════════════════════════════════════════════════════════════════════════
describe('empacar/desempacar — la fila compacta es reversible', () => {
  const p: ProspectoMapa = {
    id: 'a1', empresa: 'Fletes del Norte', ciudad: 'Escobedo', entidad: 'Nuevo León',
    lat: 25.8, lng: -100.3, telefono: '8112345678', correo: 'dg@fletes.mx',
    contacto: 'Ramón Treviño', vacante: 'Auxiliar de liquidaciones',
    estado: 'negociacion', fuente: 'manual', giro: 'transportista',
    urgencia: 85, cierre: 90, tamano: '51-100', completitud: 100,
    ultimoToque: '2026-08-19T08:00:00.000Z', mensajesGeneradosEn: '2026-08-20T10:00:00.000Z',
    numUnidades: 40, similitudIcpPct: 80, necesidadPct: 75,
  };

  it('ida y vuelta devuelve exactamente el mismo prospecto', () => {
    expect(desempacar(empacar(p))).toEqual(p);
  });

  it('los nulos sobreviven como nulos (no se vuelven undefined ni cadena vacía)', () => {
    const vacio: ProspectoMapa = {
      ...p, ciudad: null, entidad: null, lat: null, lng: null, telefono: null,
      correo: null, contacto: null, vacante: null, tamano: null,
      ultimoToque: null, mensajesGeneradosEn: null, numUnidades: null,
    };
    expect(desempacar(empacar(vacio))).toEqual(vacio);
  });

  it('quitarle los nombres a la fila ahorra ~238 bytes — por 33 mil filas, 7.8 MB', () => {
    const tupla = JSON.stringify(empacar(p)).length;
    const objeto = JSON.stringify(p).length;
    expect(objeto - tupla).toBeGreaterThan(230);
  });
});
