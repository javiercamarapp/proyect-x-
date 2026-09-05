import { describe, it, expect } from 'vitest';
import { cuadrarViaje } from './engine';
import type { Gasto } from '@/types/likida';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 26 · CONTINUACIÓN, FIS-C2c (CRÍTICO). EL GASTO SIN FECHA ENTRA AL
// NUMERADOR DEL 15 % Y NO AL DENOMINADOR.
//
// La RFA 2026 regla 2.9 (`normas/rfa-2026-2.9.yaml`, verificado_fuente_primaria)
// condiciona la facilidad a que los pagos con medio no admitido «no excedan el
// 15 por ciento del total de los pagos efectuados por consumo de combustible».
// El numerador y el denominador de ese porcentaje son EL MISMO UNIVERSO: un
// peso que se cuenta arriba tiene que contarse abajo.
//
// La RPC de la 0305 acota su `where` con
//     fecha >= make_date(p_anio,1,1) and fecha <= make_date(p_anio,12,31)
// y una `fecha` NULL falla las DOS comparaciones: el gasto sin fecha queda
// fuera de `total` (denominador) Y de `efectivo` (numerador). Coherente.
//
// El motor hacía lo contrario con el MISMO gasto:
//     const mismoEjercicio = !anioComprobante || anioComprobante === anio
// «sin año» se leía como «de este año», así que el comprobante pasaba el
// portón y `efectivoAcumuladoEjercicio += g.monto` lo sumaba al numerador —
// contra un denominador de la RPC que no lo contiene.
//
// El resultado impreso delataba la aritmética: «el ejercicio lleva $261,000.00
// … contra un tope de $150,000.00 (15% de $1,000,000.00)», y $1,000,000 no
// contiene esos $116,000. 261,000/1,000,000 = 26.1 %, una razón que no se puede
// reconstruir con el total que el propio renglón declara.
//
// No es un caso de laboratorio: el prompt del OCR ORDENA producir este estado
// («Si no puedes leer el año con seguridad, devuelve null en vez de adivinar»,
// `intake/ocr.ts:171`), se persiste tal cual (`repo.ts:353`) sobre una columna
// nullable, y ni `pedir_fecha` ni las banderas de calidad del motor lo marcan.
//
// Lo perverso: el comprobante de OTRO ejercicio —del que se sabe MÁS— ya se
// abstenía. El que no trae año, del que se sabe MENOS, recibía el veredicto más
// tajante. Esta prueba fija que los dos se abstengan.
// ═══════════════════════════════════════════════════════════════════════════

const estimulos = {
  peajeFactor: 0.5, viaticosTopeFiscalDiarioMxn: 750,
  efectivoTopeMxn: 2000, clavesDieselIeps: [],
};

/** Un CFDI de diésel de $116,000 pagado en EFECTIVO ('01'), IVA desglosado. */
function diesel(fecha: string | undefined): Gasto {
  return {
    id: 'g1', concepto: 'diesel', monto: 116000, subTotal: 100000, folio: 'F1',
    fecha, ocrConfianza: 0.6, cfdiUuid: 'uuid-1', xmlVerificado: true,
    rfcReceptor: 'REC010101AA1', tipoComprobante: 'I',
    ivaTraslado: 16000, formaPago: '01',
  };
}

/** Ejercicio 2026 con $145,000 de efectivo previo sobre $1,000,000 de total. */
function correr(g: Gasto) {
  return cuadrarViaje({
    viajeId: 'v1', anticipo: 116000,
    politica: [{ concepto: 'diesel', topeMonto: 200000 }],
    estimulos, gastos: [g],
    facilidad15: true,
    totalCombustibleEjercicio: 1_000_000,
    efectivoPrevEjercicio: 145_000,
    anioEjercicio: '2026',
  });
}

describe('FIS-C2c · el 15 % no se juzga contra una base que no contiene al comprobante', () => {
  it('un comprobante SIN fecha no se juzga: se abstiene, como ya hacía el de otro ejercicio', () => {
    const r = correr(diesel(undefined));

    // Nada se afirma: ni deducible, ni no deducible, ni IVA. Antes del arreglo
    // esto era { deducible: 5,000 · noDeducible: 111,000 · iva: 689.66 }.
    expect(r.totalNoDeducible).toBe(0);
    expect(r.ivaAcreditable).toBe(0);

    // Y se dice por qué, en la misma rama de abstención que ya existía.
    const d = r.diferencias.find((x) => x.tipo === 'combustible_efectivo');
    expect(d, 'el comprobante sin fecha tiene que ir a revisión con nota').toBeTruthy();
    expect(d!.monto).toBe(0);
    expect(d!.nota).toContain('No se afirma deducible ni no deducible');
    // El rótulo tiene que ser verdad: no puede decir «es de null».
    expect(d!.nota).not.toContain('null');
  });

  it('el de OTRO ejercicio se sigue abstiniendo igual — el arreglo no afloja ese lado', () => {
    const r = correr(diesel('2025-05-01'));
    expect(r.totalNoDeducible).toBe(0);
    expect(r.ivaAcreditable).toBe(0);
    expect(r.diferencias.find((x) => x.tipo === 'combustible_efectivo')?.nota).toContain('2025');
  });

  it('CON fecha del ejercicio SÍ se juzga: el arreglo no apaga la regla', () => {
    const r = correr(diesel('2026-07-15'));
    // $145,000 previos sobre un tope de $150,000: quedan $5,000 de cupo, y el
    // resto del comprobante excede. Es el caso que la RFA 2.9 sí mide.
    expect(r.totalNoDeducible).toBeCloseTo(111_000, 2);
    expect(r.ivaAcreditable).toBeCloseTo(689.66, 1);
  });
});
