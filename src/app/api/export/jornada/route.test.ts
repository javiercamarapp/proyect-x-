import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LEYENDA_NO_ES_BITACORA_83, LEYENDA_NOM_087, CONSERVACION_LFT_804, FRASE_SIN_REGISTRO,
} from '@/lib/likida/jornada/topes';
import { LEYENDA_VEREDICTOS } from '@/lib/likida/jornada/riesgo';
import type { Asiento } from '@/lib/likida/jornada/modelo';

// ═══════════════════════════════════════════════════════════════════════════
// EL CSV QUE LA FLOTA ENSEÑA EN UNA INSPECCIÓN — su contrato.
//
// Este archivo viaja solo: se manda por correo, se imprime, se abre en la
// computadora de un abogado tres años después. Lo que el documento no afirma
// tiene que viajar CON ÉL o deja de estar dicho. De ahí las dos mitades de
// esta suite:
//
//   · LAS PUERTAS, con los módulos REALES de permisos y visibilidad (mismo
//     criterio que `carta-porte-xml/route.test.ts` tras la auditoría 18): la
//     del DATO (`puedeVerArea`) y la del VERBO (`puedeExportar`), más la
//     validación del rango.
//   · LO QUE EL ARCHIVO DICE: las cuatro leyendas legales pegadas al
//     encabezado, la truncación declarada DENTRO del archivo, y —lo más
//     importante de la ruta— que un día sin marcas sale con la frase de «sin
//     registro declarado» y con el total EN BLANCO. Nunca con un cero: en un
//     juicio, «cero horas» es una afirmación del patrón sobre la jornada del
//     trabajador, y si es falsa, la firmó él.
// ═══════════════════════════════════════════════════════════════════════════

let limitePasa = true;
vi.mock('@/lib/ratelimit', () => ({
  rateLimit: async () => limitePasa,
  clientIp: () => '1.2.3.4',
}));

let tenant: { ok: true; tenantId: string; rol: string } | { ok: false; status: 401 | 403 | 503; motivo: string } =
  { ok: true, tenantId: 't-1', rol: 'flota_admin' };
vi.mock('@/lib/auth/tenant-api', () => ({ resolverTenantApi: async () => tenant }));

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/likida/presupuesto', () => ({ acotada: async (p: unknown) => p }));

// El nombre de la flota es adorno del encabezado: se dobla la base solo para eso.
let nombreTenant: { data: { nombre: string } | null; error: { message: string } | null } =
  { data: { nombre: 'Transportes del Bajío' }, error: null };
function builder() {
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: () => b, eq: () => b, maybeSingle: () => b,
    then: (res: (x: unknown) => unknown, rej: (x: unknown) => unknown) =>
      Promise.resolve(nombreTenant).then(res, rej),
  });
  return b;
}
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: () => builder() }) }));

// El lector se dobla; el ARMADOR del reporte (`reporte.ts`, `modelo.ts`,
// `riesgo.ts`, `topes.ts`) queda REAL a propósito: las frases que este archivo
// afirma son justo lo que se está probando, y doblarlas sería probar el doble.
interface DiaLeido {
  id: string;
  operadorId: string;
  dia: string;
  estado: 'abierto' | 'cerrado';
  cerradoEn: string | null;
  cerradoPorEmail: string | null;
  conformeOperadorEn: string | null;
  conformeWaMessageId: string | null;
  asientos: Asiento[];
}
let lectura: { dias: DiaLeido[]; truncada: boolean } = { dias: [], truncada: false };
let errorLectura: Error | null = null;
const leerJornadas = vi.fn(async () => {
  if (errorLectura) throw errorLectura;
  return lectura;
});
vi.mock('@/lib/likida/jornada/repo', () => ({
  leerJornadas: () => leerJornadas(),
  leerPolitica: async () => null,
  nombresDeOperadores: async () =>
    new Map([['op-1', { nombre: 'Juan Pérez Ramírez', numeroEmpleado: 'E-7' }]]),
}));

const { GET } = await import('./route');

const BASE = 'https://likida.ai/api/export/jornada';
const RANGO = `${BASE}?desde=2026-08-20&hasta=2026-08-20`;

/** Un asiento vivo mínimo, con la procedencia que se le indique. */
function asiento(over: Partial<Asiento> & Pick<Asiento, 'tipo' | 'momento'>): Asiento {
  return {
    id: `a-${over.tipo}-${over.momento}`,
    procedencia: 'declarado_operador',
    origenRef: null, waMessageId: null, viajeId: null, registradoPorEmail: null,
    nota: null, corrigeA: null, anuladoEn: null, anuladoPorEmail: null, anuladoMotivo: null,
    ...over,
  };
}

function diaLeido(asientos: Asiento[]): DiaLeido {
  return {
    id: 'j-1', operadorId: 'op-1', dia: '2026-08-20', estado: 'abierto',
    cerradoEn: null, cerradoPorEmail: null, conformeOperadorEn: null,
    conformeWaMessageId: null, asientos,
  };
}

/** Parte una línea de CSV respetando las comillas de `toCsv`. */
function celdas(linea: string): string[] {
  const out: string[] = [];
  let cur = '';
  let dentro = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (dentro) {
      if (c === '"') {
        if (linea[i + 1] === '"') { cur += '"'; i++; } else dentro = false;
      } else cur += c;
    } else if (c === '"') dentro = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** La primera fila de datos del CSV, como objeto columna → valor. */
function primeraFila(csv: string): Record<string, string> {
  const lineas = csv.split('\n');
  const iEncabezado = lineas.findIndex((l) => l.startsWith('operador,'));
  expect(iEncabezado).toBeGreaterThanOrEqual(0);
  const cols = celdas(lineas[iEncabezado]);
  const vals = celdas(lineas[iEncabezado + 1]);
  return Object.fromEntries(cols.map((c, i) => [c, vals[i] ?? '']));
}

beforeEach(() => {
  vi.clearAllMocks();
  limitePasa = true;
  tenant = { ok: true, tenantId: 't-1', rol: 'flota_admin' };
  nombreTenant = { data: { nombre: 'Transportes del Bajío' }, error: null };
  lectura = { dias: [], truncada: false };
  errorLectura = null;
});

describe('GET /api/export/jornada — las dos puertas', () => {
  it('el chofer NO baja el registro: `operador` no ve el área operación', async () => {
    tenant = { ok: true, tenantId: 't-1', rol: 'operador' };
    const res = await GET(new Request(RANGO));
    expect(res.status).toBe(403);
    expect(leerJornadas).not.toHaveBeenCalled();
  });

  it('el contador tampoco: exporta, pero su área es `dinero` y aquí no hay un peso', async () => {
    // La puerta que lo detiene es la del DATO, no la del VERBO. Con la matriz
    // de roles vigente `puedeExportar` no rechaza a nadie que ya haya pasado
    // `puedeVerArea('operacion')` — es una segunda cerradura sobre la misma
    // puerta, deliberada, para que un rol nuevo con `operacion` no herede la
    // descarga por omisión.
    tenant = { ok: true, tenantId: 't-1', rol: 'contador' };
    expect((await GET(new Request(RANGO))).status).toBe(403);
  });

  it('un rol desconocido no baja nada — falla cerrado, no abierto', async () => {
    tenant = { ok: true, tenantId: 't-1', rol: 'vendedor' };
    expect((await GET(new Request(RANGO))).status).toBe(403);
  });

  it('el jefe de tráfico (encargado) SÍ lo baja: es el usuario natural del documento', async () => {
    tenant = { ok: true, tenantId: 't-1', rol: 'encargado' };
    const res = await GET(new Request(RANGO));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toContain('registro_jornada_2026-08-20_a_2026-08-20.csv');
    // Un caché intermedio que reutilice esta respuesta la serviría a otro
    // usuario/sesión: el registro de jornada es de la flota, no público.
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sin sesión válida se devuelve el estatus que dijo el resolvedor, sin leer nada', async () => {
    tenant = { ok: false, status: 401, motivo: 'Sin sesión.' };
    const res = await GET(new Request(RANGO));
    expect(res.status).toBe(401);
    expect(leerJornadas).not.toHaveBeenCalled();
  });

  it('pasado el tope de peticiones es 429 y no se toca la base', async () => {
    limitePasa = false;
    expect((await GET(new Request(RANGO))).status).toBe(429);
    expect(leerJornadas).not.toHaveBeenCalled();
  });
});

describe('GET /api/export/jornada — el rango', () => {
  it('una fecha que no es AAAA-MM-DD es 400', async () => {
    expect((await GET(new Request(`${BASE}?desde=20-08-2026&hasta=2026-08-20`))).status).toBe(400);
    expect((await GET(new Request(`${BASE}?desde=2026-08-20&hasta=ayer`))).status).toBe(400);
    expect(leerJornadas).not.toHaveBeenCalled();
  });

  it('`desde` posterior a `hasta` es 400 — no se adivina que iban al revés', async () => {
    const res = await GET(new Request(`${BASE}?desde=2026-08-21&hasta=2026-08-20`));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('La fecha inicial va antes que la final.');
  });

  it('un periodo de más de 400 días es 400, y lo dice con el número', async () => {
    // El tope existe para que la lectura no crezca sin límite; el mensaje pide
    // el rango en partes en vez de entregar media lista.
    const res = await GET(new Request(`${BASE}?desde=2025-01-01&hasta=2026-08-20`));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('400');
    expect(leerJornadas).not.toHaveBeenCalled();
  });

  it('exactamente 400 días SÍ pasa: el tope es inclusivo', async () => {
    const desde = '2026-01-01';
    const hasta = new Date(Date.parse(`${desde}T00:00:00Z`) + 399 * 86_400_000).toISOString().slice(0, 10);
    const res = await GET(new Request(`${BASE}?desde=${desde}&hasta=${hasta}`));
    expect(res.status).toBe(200);
  });
});

describe('GET /api/export/jornada — lo que el archivo dice', () => {
  it('las cuatro leyendas legales viajan DENTRO del CSV, no en la pantalla', async () => {
    // Un CSV se manda por correo y se abre tres años después. Lo que el
    // documento NO afirma tiene que ir pegado a él o deja de estar dicho.
    const csv = await (await GET(new Request(RANGO))).text();
    expect(csv).toContain(LEYENDA_NO_ES_BITACORA_83);   // no es la bitácora del art. 83
    expect(csv).toContain(LEYENDA_NOM_087);             // no se evalúa conducción efectiva
    expect(csv).toContain(LEYENDA_VEREDICTOS);          // Likida no dictamina cumplimiento
    expect(csv).toContain(CONSERVACION_LFT_804);        // los dos plazos de conservación
    expect(csv).toContain('artículo 132 fracción XXXIV');
  });

  it('UN DÍA SIN MARCAS sale con «sin registro declarado» y el total EN BLANCO, jamás con un 0', async () => {
    // Es lo más importante de esta ruta. Un cero en la columna de horas es una
    // afirmación del patrón sobre la jornada del trabajador; el blanco junto a
    // la frase es el hueco, declarado.
    lectura = { dias: [diaLeido([])], truncada: false };
    const csv = await (await GET(new Request(RANGO))).text();
    const fila = primeraFila(csv);

    expect(fila.total_horas).toBe('');
    expect(fila.total_horas).not.toBe('0');
    expect(fila.observaciones).toContain(FRASE_SIN_REGISTRO);
    expect(fila.veredicto).toBe('Sin registro declarado');
    // Y las puntas tampoco se inventan.
    expect(fila.inicio).toBe('');
    expect(fila.fin).toBe('');
    // «No reportó descanso» tampoco es «descansó cero minutos».
    expect(fila.minutos_descanso).toBe('sin descanso reportado');
  });

  it('un día CON las dos marcas sí trae su total y el origen de cada hora', async () => {
    lectura = {
      dias: [diaLeido([
        asiento({ tipo: 'inicio_jornada', momento: '2026-08-20T13:00:00.000Z' }),
        asiento({ tipo: 'fin_jornada', momento: '2026-08-20T21:00:00.000Z' }),
      ])],
      truncada: false,
    };
    const csv = await (await GET(new Request(RANGO))).text();
    const fila = primeraFila(csv);

    expect(fila.total_horas).toBe('8');
    expect(fila.operador).toBe('Juan Pérez Ramírez');
    expect(fila.numero_empleado).toBe('E-7');
    expect(fila.origen_inicio).toBe('Declarado por el operador');
    // La conformidad del art. 132-XXXIV párrafo tercero se dice cuando falta.
    expect(fila.conformidad_del_operador).toBe('Sin conformidad del operador');
  });

  it('un periodo vacío NO se presenta como «nadie trabajó»', async () => {
    const csv = await (await GET(new Request(RANGO))).text();
    expect(csv).toContain('No hay expedientes de jornada en este periodo');
    expect(csv).toContain('no hay registro');
  });

  it('LA TRUNCACIÓN SE DECLARA DENTRO DEL ARCHIVO, arriba de todo', async () => {
    // Un CSV recortado en silencio es el peor de los documentos: parece
    // completo y le falta gente.
    lectura = { dias: [diaLeido([])], truncada: true };
    const csv = await (await GET(new Request(RANGO))).text();
    expect(csv).toContain('ESTE REPORTE ESTÁ INCOMPLETO');
    expect(csv).toContain('Pide el rango en partes más cortas');
    // Va como PRIMERA leyenda: quien abre el archivo la lee antes que nada.
    expect(csv.split('\n')[0]).toContain('ESTE REPORTE ESTÁ INCOMPLETO');
  });

  it('el nombre de la flota ilegible no impide el reporte: es adorno del encabezado', async () => {
    nombreTenant = { data: null, error: { message: 'se cayó' } };
    const res = await GET(new Request(RANGO));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('sin nombre registrado');
  });

  it('la lectura caída es 500 y NO medio CSV', async () => {
    // Fallar cerrado: un registro de jornada incompleto que PARECE completo es
    // peor que no tener ninguno.
    errorLectura = new Error('No se pudo leer el registro de jornada: la base no contestó');
    const res = await GET(new Request(RANGO));
    expect(res.status).toBe(500);
    const cuerpo = await res.text();
    expect(cuerpo).toContain('No se entrega uno incompleto');
    // Ni encabezado de tabla, ni leyendas, ni una sola fila: nada que se pueda
    // confundir con un documento.
    expect(cuerpo).not.toContain('total_horas');
    expect(cuerpo).not.toContain(LEYENDA_NO_ES_BITACORA_83);
    expect(res.headers.get('Content-Type')).not.toContain('text/csv');
  });
});
