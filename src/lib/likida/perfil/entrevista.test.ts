import { describe, it, expect } from 'vitest';
import { interpretarTurno, estadoEntrevista, mensajeBienvenida, CATALOGO, CATALOGO_POR_ID } from './entrevista';
import { declararHechos, declararAusente, onboardingFiscalListo, calificaEstimuloPeaje, declararUmbralPeaje } from './preguntas';

describe('entrevista — no inventa fiscal', () => {
  it('cada pregunta del catálogo trae cita de sustento', () => {
    expect(CATALOGO.length).toBeGreaterThan(8);
    for (const p of CATALOGO) {
      expect(p.sustento.cita.length).toBeGreaterThan(3);
      expect(p.pregunta.length).toBeGreaterThan(10);
    }
  });

  // AUDITORÍA 28, FIS-M1 (MEDIO): la RFA 2026 regla 2.9 (verificado_fuente_
  // primaria) dice SOLO "carga federal". Esta pregunta decía "carga federal,
  // pasaje o turismo" y abría la misma facilidad del 15% para una flota que
  // la regla no cubre. Pasaje/turismo foráneo es la RFA 3.12, sin ficha.
  it('dedicacionExclusivaCarga NO menciona pasaje ni turismo (fail-closed hasta que exista ficha 3.12)', () => {
    const p = CATALOGO_POR_ID.dedicacionExclusivaCarga.pregunta.toLowerCase();
    expect(p).not.toMatch(/pasaje|turismo/);
    expect(p).toMatch(/carga federal/);
  });

  it('perfil vacío: la primera pregunta es el umbral de $300M, requerida', () => {
    const e = estadoEntrevista({});
    expect(e.perfilListo).toBe(false);
    expect(e.siguiente?.id).toBe('ingresosMenoresA300M');
    expect(e.siguiente?.requeridaParaPanel).toBe(true);
  });

  it('un "sí" suelto NO declara el umbral de $300M (los chips son menor/mayor)', () => {
    const r = interpretarTurno({}, 'sí');
    expect(r.hechos.ingresosMenoresA300M).toBeUndefined();
    expect(r.hechos.parteRelacionada).toBeUndefined();
    expect(r.ambiguo).toBeTruthy();
  });

  it('"no sé" en el umbral NO declara un no', () => {
    const r = interpretarTurno({}, 'no sé');
    expect(r.hechos).toEqual({});
    expect(r.noSe).toContain('ingresosMenoresA300M');
  });

  it('en un solo mensaje: menores a 300 y no parte relacionada', () => {
    const r = interpretarTurno({}, 'fuimos menores a 300 millones y no somos parte relacionada');
    expect(r.hechos.ingresosMenoresA300M).toBe(true);
    expect(r.hechos.parteRelacionada).toBe(false);
  });

  it('un RFC o un monto inventado no se parsea como ingresos', () => {
    const r = interpretarTurno({}, 'como $80 millones más o menos yo creo');
    expect(r.hechos.ingresosMenoresA300M).toBeUndefined();
    expect(r.ambiguo).toBeTruthy();
  });

  it('declararHechos sin umbral no escribe un no inventado', () => {
    const p = declararHechos({ gps: 'wialon' });
    expect(p).toEqual({ gps: { valor: 'wialon', procedencia: 'declarado' } });
    expect(onboardingFiscalListo(p)).toBe(false);
  });

  it('ausente no abre el estímulo', () => {
    const p = { ...declararAusente(['dedicacionExclusivaCarga']), ...declararUmbralPeaje(true, false) };
    expect(calificaEstimuloPeaje(p).elegible).toBe(true);
    expect(onboardingFiscalListo(p)).toBe(true);
  });

  it('la bienvenida cita LIF 20-A y no supone', () => {
    const b = mensajeBienvenida(estadoEntrevista({}));
    expect(b.texto).toMatch(/LIF 2026 art\. 20-A/);
    expect(b.texto).toMatch(/no supongo|No supongo/i);
    expect(b.chips.some((c) => c.valor === 'menor')).toBe(true);
  });

  it('el catálogo cubre identidad fiscal, stack y operación WhatsApp, sin ids repetidos', () => {
    const ids = CATALOGO.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      'rfcEmpresa', 'regimenSat', 'pagoEnBomba', 'tarjetasANombreEmpresa',
      'operadoresAlta', 'topesPolitica', 'monedero', 'hazmat',
    ]));
    expect(ids).not.toContain('regimenElegible');
  });

  it('de un extracto de constancia toma el RFC, no la razón social entera', () => {
    const blob = `Documento «csf.pdf»:
CONSTANCIA DE SITUACIÓN FISCAL
RFC: XAXX010101000
Nombre, denominación o razón social: TRANSPORTES EJEMPLO SA DE CV
Correo de contacto:  operaciones@ejemplo.mx`;
    const r = interpretarTurno({}, blob);
    expect(r.hechos.rfcEmpresa).toBe('XAXX010101000');
    expect(r.hechos.emailFacturacion).toBe('operaciones@ejemplo.mx');
    expect(r.hechos.razonSocial).toBeUndefined();
    expect(r.hechos.ingresosMenoresA300M).toBeUndefined();
  });

  it('un ticket con RFC emisor de estación NO se declara como RFC de la flota', () => {
    const blob = `Documento «ticket.jpg»:
RFC emisor: PSE950905D84
Monto: $2,450.00`;
    const r = interpretarTurno({}, blob);
    expect(r.hechos.rfcEmpresa).toBeUndefined();
  });

  it('RFC se parsea y no se inventa uno corto', () => {
    const r = interpretarTurno(
      { ...declararUmbralPeaje(true, false) },
      'el RFC es XAXX010101000',
    );
    // siguiente es rfcEmpresa
    expect(estadoEntrevista(declararUmbralPeaje(true, false)).siguiente?.id).toBe('rfcEmpresa');
    expect(r.hechos.rfcEmpresa).toBe('XAXX010101000');
    const malo = interpretarTurno(declararUmbralPeaje(true, false), 'ABC');
    expect(malo.hechos.rfcEmpresa).toBeUndefined();
  });

  it('régimen 601 deriva que el 15% NO aplica; 612 y 624 sí', () => {
    const base = { ...declararUmbralPeaje(true, false), rfcEmpresa: { valor: 'XAXX010101000', procedencia: 'declarado' }, razonSocial: { valor: 'FLOTA SA', procedencia: 'declarado' } };
    expect(interpretarTurno(base, '601').hechos).toMatchObject({ regimenSat: '601', regimenElegible: false });
    expect(interpretarTurno(base, '612').hechos).toMatchObject({ regimenSat: '612', regimenElegible: true });
    expect(interpretarTurno(base, '624').hechos).toMatchObject({ regimenSat: '624', regimenElegible: true });
  });

  it('operadores: nombre + 10 dígitos; un teléfono solo no inventa el nombre', () => {
    const cubierto = perfilHasta('operadoresAlta');
    const r = interpretarTurno(cubierto, 'Juan Pérez 5512345678, María López 5587654321');
    expect(r.hechos.operadoresAlta).toEqual([
      { nombre: 'Juan Pérez', telefono: '5512345678' },
      { nombre: 'María López', telefono: '5587654321' },
    ]);
    const soloTel = interpretarTurno(cubierto, '5512345678');
    expect(soloTel.hechos.operadoresAlta).toBeUndefined();
  });
});

function decl(v: unknown) { return { valor: v, procedencia: 'declarado' as const }; }

function perfilHasta(hasta: string) {
  const todo: Record<string, unknown> = { ...declararUmbralPeaje(true, false) };
  for (const p of CATALOGO) {
    if (p.id === hasta) break;
    todo[p.id] = decl(p.id === 'pagoEnBomba' ? 'empresa' : p.id === 'pagoOperador' ? 'viaje' : p.id === 'regimenSat' ? '612' : true);
  }
  return todo;
}
