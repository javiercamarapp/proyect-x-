import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  validarFactura, validarPago, evaluarAbono, sumarDias, mensajeFolioRepetido,
  type FacturaCruda, type PagoCrudo,
} from './facturacion_escritura';
import { DatoInvalido } from './errores';

// ═══════════════════════════════════════════════════════════════════════════
// SOLO LO PURO, igual que `clientes.test.ts`: lo que se prueba es la parte que
// decide DINERO — qué factura es válida, cuánto abono cabe, cuándo se salda y
// cuándo vence. Las escrituras (`crearFactura`, `registrarPago`) no se prueban
// contra un mock de Supabase: eso demostraría que el mock funciona.
// ═══════════════════════════════════════════════════════════════════════════

const CLIENTE = '11111111-2222-3333-4444-555555555555';
const UUID_CFDI = 'ad662d33-6934-459c-a128-BDf0393f0f44'; // con mayúsculas a propósito

const FACTURA_OK: FacturaCruda = {
  clienteId: CLIENTE,
  fecha: '2026-08-14',
  subtotal: '10000',
  iva: '1600',
  serie: '',
  folio: '',
  cfdiUuid: '',
  viajeIds: [],
};

describe('validarFactura — el total no se teclea, se calcula', () => {
  it('total = subtotal + IVA, redondeado a centavos', () => {
    const f = validarFactura(FACTURA_OK);
    expect(f.subtotal).toBe(10000);
    expect(f.iva).toBe(1600);
    expect(f.total).toBe(11600);
  });

  it('la cola binaria de 0.1 + 0.2 no llega a la base', () => {
    const f = validarFactura({ ...FACTURA_OK, subtotal: '0.1', iva: '0.2' });
    expect(f.total).toBe(0.3);
  });

  it('FIS-M3: sin retención (el caso de hoy) el cálculo no cambia', () => {
    const f = validarFactura(FACTURA_OK);
    expect(f.retencion).toBe(0);
    expect(f.total).toBe(11600);
  });

  it('FIS-M3: con retención del 4%, el total la descuenta', () => {
    const f = validarFactura({ ...FACTURA_OK, retencion: '400' });
    expect(f.retencion).toBe(400);
    expect(f.total).toBe(11200);
  });

  it('acepta coma decimal y separador de millares, como se teclea en México', () => {
    const f = validarFactura({ ...FACTURA_OK, subtotal: '10,000.50', iva: '1,600.08' });
    expect(f.subtotal).toBe(10000.5);
    expect(f.iva).toBe(1600.08);
  });

  it('tres decimales se rechazan en vez de redondearse en silencio', () => {
    expect(() => validarFactura({ ...FACTURA_OK, subtotal: '100.505' })).toThrow(DatoInvalido);
  });

  it('el IVA vacío NO se inventa: se exige, aunque sea $0 tecleado', () => {
    expect(() => validarFactura({ ...FACTURA_OK, iva: '' })).toThrow(DatoInvalido);
    expect(validarFactura({ ...FACTURA_OK, iva: '0' }).iva).toBe(0);
  });
});

describe('validarFactura — borrador y emitida, el estatus no miente', () => {
  it('sin UUID nace en borrador: el SAT no la conoce todavía', () => {
    expect(validarFactura(FACTURA_OK).estatus).toBe('borrador');
    expect(validarFactura(FACTURA_OK).cfdiUuid).toBeNull();
  });

  it('con UUID nace emitida, y el UUID se normaliza a minúsculas', () => {
    const f = validarFactura({ ...FACTURA_OK, cfdiUuid: ` ${UUID_CFDI} ` });
    expect(f.estatus).toBe('emitida');
    expect(f.cfdiUuid).toBe(UUID_CFDI.toLowerCase());
  });

  it('un UUID con pinta de folio interno se rechaza con instrucción de dónde copiarlo', () => {
    expect(() => validarFactura({ ...FACTURA_OK, cfdiUuid: 'FAC-2026-001' })).toThrow(/XML|PDF/);
  });

  it('una fecha que no existe se rechaza', () => {
    expect(() => validarFactura({ ...FACTURA_OK, fecha: '2026-02-30' })).toThrow(DatoInvalido);
  });

  it('los viajes se deduplican y un id basura tira el alta completa', () => {
    const v = '99999999-8888-7777-6666-555555555555';
    expect(validarFactura({ ...FACTURA_OK, viajeIds: [v, v] }).viajeIds).toEqual([v]);
    expect(() => validarFactura({ ...FACTURA_OK, viajeIds: ['el-de-ayer'] })).toThrow(DatoInvalido);
  });
});

describe('validarPago', () => {
  const PAGO_OK: PagoCrudo = {
    facturaId: CLIENTE, fecha: '2026-08-14', monto: '5000', metodo: '', referencia: '',
  };

  it('un pago de cero no es un pago', () => {
    expect(() => validarPago({ ...PAGO_OK, monto: '0' })).toThrow(DatoInvalido);
  });

  it('método y referencia vacíos quedan en null, no en cadena vacía', () => {
    const p = validarPago(PAGO_OK);
    expect(p.metodo).toBeNull();
    expect(p.referencia).toBeNull();
  });
});

describe('evaluarAbono — a qué se le abona y cuánto cabe', () => {
  it('a un borrador NO se le abona: sería cobro contra un CFDI que el SAT no conoce', () => {
    const r = evaluarAbono({ estatus: 'borrador', total: 11600, pagado: 0 }, 5000);
    expect(r.rechazo).toContain('borrador');
  });

  it('a una cancelada tampoco', () => {
    expect(evaluarAbono({ estatus: 'cancelada', total: 11600, pagado: 0 }, 5000).rechazo).toContain('cancelada');
  });

  it('el sobrepago se rechaza CON el saldo exacto en el mensaje', () => {
    const r = evaluarAbono({ estatus: 'emitida', total: 11600, pagado: 10000 }, 2000);
    expect(r.rechazo).toContain('1,600');
  });

  it('un pago parcial pasa y NO salda', () => {
    const r = evaluarAbono({ estatus: 'emitida', total: 11600, pagado: 0 }, 5000);
    expect(r.rechazo).toBeNull();
    expect(r.quedaSaldada).toBe(false);
  });

  it('el pago que completa el total salda, con tolerancia de centavo por redondeo', () => {
    expect(evaluarAbono({ estatus: 'emitida', total: 11600, pagado: 5000 }, 6600).quedaSaldada).toBe(true);
    // 3 × $3,866.67 = $11,600.01 de suma tecleada contra $11,600.00: el último
    // abono real de una factura partida en tres no puede quedarse atorado por
    // un centavo de redondeo.
    expect(evaluarAbono({ estatus: 'emitida', total: 11600, pagado: 7733.34 }, 3866.66).quedaSaldada).toBe(true);
  });

  it('la cola binaria de la resta no fabrica saldo: 0.1+0.2 pagado contra 0.3', () => {
    const r = evaluarAbono({ estatus: 'emitida', total: 0.3, pagado: 0.1 + 0.2 }, 0.01);
    expect(r.saldo).toBe(0);
  });
});

describe('sumarDias — de aquí sale el vencimiento', () => {
  it('cruza el fin de mes y el fin de año', () => {
    expect(sumarDias('2026-08-14', 30)).toBe('2026-09-13');
    expect(sumarDias('2026-12-20', 15)).toBe('2027-01-04');
  });

  it('cero días de crédito vence el mismo día: contado', () => {
    expect(sumarDias('2026-08-14', 0)).toBe('2026-08-14');
  });

  it('el año bisiesto no lo corre un día', () => {
    expect(sumarDias('2028-02-28', 1)).toBe('2028-02-29');
    expect(sumarDias('2026-02-28', 1)).toBe('2026-03-01');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RES-22 (auditoría prod) — UNA FACTURA SE IDENTIFICA POR SERIE + FOLIO +
// EJERCICIO, y la migración 0166 lo puso en la base.
//
// Antes: `factura_folio_unico` (0049) = (tenant_id, folio) y
// `factura_emitida_folio_upper_uidx` (0158) = (tenant_id, upper(folio)).
// Ninguno miraba serie ni año, así que A-1 de 2025 y A-1 de 2026 chocaban
// siendo dos CFDI distintos y la flota que reinicia folios cada enero no
// podía capturar. La propuesta que este archivo tenía escrita dropeaba SÓLO
// el índice de la 0049 — el de la 0158 habría seguido rechazando igual.
//
// Lo que la BASE garantiza se prueba contra Postgres (bloque 138 de
// verificaciones.sql: A-1/2025 vs A-1/2026, A-1 vs B-1, la repetida que
// rebota, la normalización). Aquí se prueba lo que es de TypeScript: que la
// serie se normaliza antes de viajar, que el índice quedó como se documentó,
// y que el mensaje del choque dice CONTRA QUÉ se comparó.
// ═══════════════════════════════════════════════════════════════════════════

describe('la serie viaja con el folio y se normaliza (RES-22)', () => {
  it('una factura sin serie la manda en NULL, no en cadena vacía', () => {
    // El índice usa `coalesce(serie,'')`: un '' guardado y un NULL guardado
    // significarían lo mismo escritos de dos formas, y `factura_serie_btrim`
    // (0166) rechaza el ''. La normalización tiene que pasar aquí.
    expect(validarFactura(FACTURA_OK).serie).toBeNull();
    expect(validarFactura({ ...FACTURA_OK, serie: '   ' }).serie).toBeNull();
  });

  it('la serie tecleada con espacios se guarda como se compara', () => {
    expect(validarFactura({ ...FACTURA_OK, serie: '  A  ' }).serie).toBe('A');
    expect(validarFactura({ ...FACTURA_OK, serie: '\tFAC\n' }).serie).toBe('FAC');
  });

  it('la serie NO cambia de mayúsculas al guardarse: se guarda la del CFDI', () => {
    // El índice compara `upper(serie)`, así que «a» y «A» chocan de todas
    // formas. Guardar el texto en mayúsculas cambiaría lo que la flota ve
    // impreso en su papel, y eso es inventar un dato.
    expect(validarFactura({ ...FACTURA_OK, serie: 'a' }).serie).toBe('a');
  });

  it('una serie con espacio EN MEDIO se rechaza en vez de colarse', () => {
    // `factura_serie_btrim` sólo mira los extremos; un «A B» pasaría el CHECK
    // y sería una serie que ningún CFDI tiene.
    expect(() => validarFactura({ ...FACTURA_OK, serie: 'A B' })).toThrow(DatoInvalido);
  });

  it('la serie no pasa del tope del SAT (25 caracteres)', () => {
    expect(validarFactura({ ...FACTURA_OK, serie: 'A'.repeat(25) }).serie).toHaveLength(25);
    expect(() => validarFactura({ ...FACTURA_OK, serie: 'A'.repeat(26) })).toThrow(DatoInvalido);
  });
});

describe('el choque de folio dice CONTRA QUÉ se comparó (RES-22)', () => {
  const mig = readFileSync('supabase/migrations/0166_factura_serie.sql', 'utf8');

  it('el índice compara flota + serie + folio + ejercicio, sin mayúsculas', () => {
    expect(mig).toContain(
      "(tenant_id, upper(coalesce(serie, '')), upper(folio), extract(year from fecha))",
    );
    expect(mig).toMatch(/where folio is not null/);
  });

  it('y sustituye a LOS DOS índices viejos, no sólo al de la 0049', () => {
    // Éste es el error que traía la propuesta original: con el de la 0158 vivo,
    // la A-1 de 2026 seguía rebotando y el arreglo no arreglaba nada.
    expect(mig).toContain('drop index if exists public.factura_folio_unico');
    expect(mig).toContain('drop index if exists public.factura_emitida_folio_upper_uidx');
  });

  it('el índice conserva su nombre, que es por donde se reconoce el choque', () => {
    // `traducirChoque` discrimina el 23505 por el nombre del índice.
    expect(mig).toMatch(/create unique index if not exists factura_folio_unico/);
  });

  it('el mensaje nombra serie, folio y ejercicio', () => {
    const m = mensajeFolioRepetido({ serie: 'A', folio: '1', fecha: '2026-01-02' });
    expect(m).toContain('«1»');
    expect(m).toContain('serie «A»');
    expect(m).toContain('ejercicio 2026');
    expect(m).toContain('OTRA serie');
  });

  it('sin serie lo dice, en vez de fingir una', () => {
    const m = mensajeFolioRepetido({ serie: null, folio: 'SF-9', fecha: '2026-03-01' });
    expect(m).toContain('sin serie');
    expect(m).not.toContain('«null»');
  });

  it('sin fecha a la mano NO inventa el año', () => {
    // `marcarEmitida` sella una fila cuya fecha no viaja en el formulario.
    const m = mensajeFolioRepetido({ serie: 'A', folio: '1', fecha: null });
    expect(m).toContain('ese mismo ejercicio');
    expect(m).not.toMatch(/ejercicio \d{4}/);
  });

  it('avisa que la cancelada sigue ocupando su folio', () => {
    expect(mensajeFolioRepetido({ serie: null, folio: '1', fecha: '2026-01-01' }))
      .toContain('cancelada');
  });
});
