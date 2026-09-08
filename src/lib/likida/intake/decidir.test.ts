import { describe, it, expect } from 'vitest';
import { decidirFoto } from './decidir';
import type { ExtraerResultado } from './ocr';
import type { Gasto } from '@/types/likida';

// Qué hacer con una foto ya extraída. Se saca del processor a propósito: ahí
// dentro está pegado a Supabase, WhatsApp y Redis, y esta es justo la parte que
// decide si el dinero entra una vez, dos, o ninguna.
const gasto = (id: string, monto: number, extra?: Record<string, unknown>): Gasto => ({
  id, concepto: 'otro', monto, ...(extra ? { ocrExtra: extra } : {}),
});

const resultado = (over: Partial<ExtraerResultado> & { monto?: number } = {}): ExtraerResultado => ({
  gasto: gasto('nuevo', over.monto ?? 4027.1),
  legible: true,
  costo: { modelo: 'x', tokensIn: 0, tokensOut: 0, costoUsd: 0 },
  ...over,
});

describe('decidirFoto', () => {
  it('un comprobante legible se da de alta', () => {
    expect(decidirFoto(resultado(), []).accion).toBe('alta');
  });

  it('un acercamiento que casa con un gasto lo ENRIQUECE, no lo da de alta', () => {
    // El punto entero: si esto devolviera 'alta', el mismo gasto entraría dos
    // veces —una por la foto del ticket y otra por el acercamiento— y la
    // liquidación saldría inflada.
    const r = resultado({ legible: false, motivo: 'solo_codigo', monto: 4027.1 });
    const d = decidirFoto(r, [gasto('viejo', 4027.1)]);
    expect(d).toEqual({ accion: 'enriquecer', gastoId: 'viejo' });
  });

  it('un acercamiento sin comprobante al cual pegarse pide la foto del ticket', () => {
    const r = resultado({ legible: false, motivo: 'solo_codigo', monto: 4027.1 });
    expect(decidirFoto(r, [gasto('otro', 999)]).accion).toBe('pedir_ticket');
  });

  it('un acercamiento con emparejamiento ambiguo NO se da de alta ni adivina', () => {
    const r = resultado({ legible: false, motivo: 'solo_codigo', monto: 300 });
    const d = decidirFoto(r, [gasto('a', 300), gasto('b', 300)]);
    expect(d.accion).toBe('pedir_ticket');
  });

  it('una foto de verdad ilegible pide reenvío', () => {
    const r = resultado({ legible: false, motivo: 'ilegible' });
    expect(decidirFoto(r, []).accion).toBe('pedir_reenvio');
  });

  it('un fallo nuestro NO le pide nada al operador', () => {
    // Reenviar la misma foto vuelve a fallar igual: pedirle reenvío es echarle
    // la culpa de un bug nuestro.
    const r = resultado({ legible: false, motivo: 'fallo_tecnico' });
    expect(decidirFoto(r, []).accion).toBe('avisar_falla');
  });

  // AUDITORÍA 28, REN-A2: el techo diario de IA agotado NO es lo mismo que un
  // fallo técnico —reenviar HOY falla igual, mañana entra— así que necesita su
  // propia acción y no puede caer al `pedir_reenvio` genérico (:83), que le
  // diría "con buena luz" a una foto que nunca tuvo problema de luz.
  it('el techo de IA agotado avisa "sin presupuesto", no "falla" ni "reenvío"', () => {
    const r = resultado({ legible: false, motivo: 'sin_presupuesto' });
    expect(decidirFoto(r, []).accion).toBe('avisar_sin_presupuesto');
  });

  it('"fallo_tecnico" sigue yendo a "avisar_falla" (no se movió al agregar sin_presupuesto)', () => {
    const r = resultado({ legible: false, motivo: 'fallo_tecnico' });
    expect(decidirFoto(r, []).accion).toBe('avisar_falla');
  });
});
