import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { acotada } from './presupuesto';
import { traerTodo } from './pg';
import { elegirOperadorPorNombre, OperadorNombreAmbiguo } from './crear_viaje_wa';
import { validarIngreso } from './ingreso_viaje';
import { numero } from '@/lib/formato';
import { DatoInvalido } from './errores';

// ═══════════════════════════════════════════════════════════════════════════
// IMPORTADOR DE VIAJES (kit del PoC, 14-ago-2026) — el export del TMS del
// prospecto entra al Registro para que el conciliador tenga contra qué
// cruzar. Un PoC de peajes sin los viajes del periodo no cruza nada.
//
// ── LO QUE ESTE CAMINO NO HACE, A PROPÓSITO ────────────────────────────────
// NO manda WhatsApp. `crearViaje()` avisa al chofer en cuanto inserta — eso
// es correcto al despachar y sería un desastre al importar 200 viajes
// históricos de un TMS ajeno. Aquí se inserta directo, con `avisado_en`
// nulo: la escalación (que exige aviso previo) tampoco se dispara.
//
// ── EL DEDUP ES POR FOLIO, Y VIVE EN LA BASE ───────────────────────────────
// El candado real es `viaje_folio_unico (tenant_id, folio)` (0092): dos
// submits CONCURRENTES del mismo archivo (doble click, dos pestañas) chocan
// ahí — la lectura previa de folios existentes es solo para REPORTAR los
// saltados con nombre; el insert es un upsert que ignora duplicados y cuenta
// únicamente lo que de verdad entró, así que el perdedor de la carrera dice
// "creados: 0", no un segundo "creados: 200" (auditoría 3, BE-A3). Un folio
// vacío no se puede dedupear — se rechaza la fila, no se adivina.
// ═══════════════════════════════════════════════════════════════════════════

export interface FilaViajeImportada {
  folio: string;
  origen: string | null;
  destino: string | null;
  /** ISO AAAA-MM-DD, ya normalizada por `interpretarFilasViajes`. */
  fechaInicio: string | null;
  anticipo: number | null;
  /** El texto del TMS — se resuelve contra `operador` al importar. */
  operadorNombre: string | null;
  /** El número económico tal cual viene — se resuelve contra `unidad`. */
  unidadEco: string | null;
  /** El nombre del cliente tal cual viene — se resuelve contra `cliente`. */
  clienteNombre: string | null;
  /** `null` = la celda venía VACÍA (no capturado); `0` = un cero tecleado.
   *  La distinción es la que sostiene toda la medición de margen. */
  ingresoFlete: number | null;
  kmRecorridos: number | null;
}

export interface LecturaImportacion {
  viajes: FilaViajeImportada[];
  /** Filas que no se pudieron leer (sin folio, cifra ilegible) — se dicen. */
  descartadas: Array<{ fila: number; motivo: string }>;
  error?: string;
}

/** Encabezados que el mundo real usa. Minúsculas, sin acentos. */
const COLUMNAS: Record<
  'folio' | 'origen' | 'destino' | 'fecha' | 'anticipo' | 'operadorNombre'
  | 'unidad' | 'cliente' | 'ingreso' | 'km',
  string[]
> = {
  folio: ['folio', 'viaje', 'no viaje', 'no. viaje', 'numero de viaje', 'id viaje', 'referencia'],
  origen: ['origen', 'de', 'sale de', 'ciudad origen'],
  destino: ['destino', 'a', 'hasta', 'llega a', 'ciudad destino'],
  fecha: ['fecha', 'fecha inicio', 'fecha de inicio', 'salida', 'fecha salida', 'inicio'],
  anticipo: ['anticipo', 'anticipo mxn', 'monto anticipo'],
  operadorNombre: ['operador', 'chofer', 'conductor', 'nombre operador', 'nombre del operador'],
  unidad: ['unidad', 'numero economico', 'no economico', 'no. economico', 'economico', 'camion'],
  cliente: ['cliente', 'nombre cliente', 'razon social'],
  ingreso: ['ingreso', 'flete', 'ingreso flete', 'precio flete', 'monto flete'],
  km: ['km', 'kilometros', 'km recorridos', 'distancia'],
};

function normalizarEncabezado(v: unknown): string {
  return String(v ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "$8,000.50" / "8000,50" / 8000 → número, o null si no se puede leer con
 *  seguridad. La regla de siempre: una cifra dudosa no se adivina. */
export function leerCifraImportada(v: unknown): number | null | 'ilegible' {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : 'ilegible';
  const limpio = String(v).replace(/[$\s]/g, '');
  if (!limpio) return null;
  // "1.234,56" europeo vs "1,234.56": si hay coma Y punto, el ÚLTIMO es el decimal.
  // Con coma SOLA se aplica la regla de `ingreso_viaje.ts`: la coma seguida de
  // exactamente tres dígitos es separador de MILLARES ("1,240" son mil
  // doscientos cuarenta km, no 1.24) y cualquier otra es decimal ("8000,50").
  // Antes una coma sola siempre era decimal, y "1,240" entraba como 1.24 — una
  // cifra plausible que nadie cuestionaría, que es el peor tipo de error.
  const normal = limpio.includes(',') && limpio.includes('.')
    ? (limpio.lastIndexOf(',') > limpio.lastIndexOf('.')
      ? limpio.replace(/\./g, '').replace(',', '.')
      : limpio.replace(/,/g, ''))
    : limpio.replace(/,(?=\d{3}\b)/g, '').replace(',', '.');
  const n = Number(normal);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 'ilegible';
}

/** dd/mm/aaaa, aaaa-mm-dd o serial de Excel → ISO. null = vacía; 'ilegible'
 *  cuando trae algo que no se entiende. */
export function leerFechaImportada(v: unknown): string | null | 'ilegible' {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    // Serial de Excel (días desde 1899-12-30). Rango sano: 2000–2100.
    if (v < 36526 || v > 73415) return 'ilegible';
    const ms = Math.round((v - 25569) * 86_400_000);
    return new Date(ms).toISOString().slice(0, 10);
  }
  const t = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t);
  if (m) {
    const dia = Number(m[1]), mes = Number(m[2]);
    if (mes > 12 || dia > 31 || mes < 1 || dia < 1) return 'ilegible';
    return `${m[3]}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
  }
  return 'ilegible';
}

/**
 * Cuántas filas de datos se leen de un archivo, COMO MÁXIMO.
 *
 * El tope existía desde siempre (`f <= 2000` incrustado en el bucle) y era
 * MUDO: un export de 8 MB con 60,000 viajes importaba los primeros 2,000 y el
 * acuse decía "creados: 2,000" sin una palabra de los 58,000 que se quedaron
 * fuera. El contralor no tenía cómo enterarse de que su archivo entró a
 * medias — que es la forma más cara de este bug, porque los viajes que faltan
 * no se ven (FE-15).
 *
 * Ahora es una constante con nombre y, cuando el archivo la rebasa, la
 * lectura lo DICE en la lista de descartadas, con la cifra.
 */
export const TOPE_FILAS_IMPORT = 2_000;

/**
 * La matriz cruda del archivo (fila 0 = encabezados) → filas listas para
 * importar. PURA: la detección de columnas es por nombre de encabezado, y
 * sin columna de folio no hay importación — el dedup depende de él.
 */
export function interpretarFilasViajes(
  matriz: unknown[][],
  opciones: { permitirFinanzas?: boolean } = {},
): LecturaImportacion {
  if (!matriz.length) return { viajes: [], descartadas: [], error: 'El archivo está vacío.' };

  const encabezados = matriz[0].map(normalizarEncabezado);
  // El mismo catálogo que interpreta el archivo determina qué campos requieren
  // dinero. Se rechaza el archivo entero antes de descartar filas o importar,
  // incluso con celdas vacías o columnas repetidas.
  if (opciones.permitirFinanzas === false
    && encabezados.some((e) => [...COLUMNAS.anticipo, ...COLUMNAS.cliente, ...COLUMNAS.ingreso].includes(e))) {
    return {
      viajes: [], descartadas: [],
      error: 'Tu rol sólo puede importar datos operativos. Quita las columnas de anticipo, cliente e ingreso del archivo y vuelve a subirlo.',
    };
  }
  const indice: Partial<Record<keyof typeof COLUMNAS, number>> = {};
  for (const clave of Object.keys(COLUMNAS) as Array<keyof typeof COLUMNAS>) {
    const i = encabezados.findIndex((e) => COLUMNAS[clave].includes(e));
    if (i >= 0) indice[clave] = i;
  }
  if (indice.folio === undefined) {
    return {
      viajes: [], descartadas: [],
      error: `No encontré la columna del folio. Encabezados leídos: ${matriz[0].map((c) => `«${String(c ?? '')}»`).join(', ')}. Renombra la columna a «folio» (o «viaje») y vuelve a subirlo.`,
    };
  }

  const viajes: FilaViajeImportada[] = [];
  const descartadas: Array<{ fila: number; motivo: string }> = [];
  const vistos = new Set<string>();

  for (let f = 1; f < matriz.length && f <= TOPE_FILAS_IMPORT; f++) {
    const fila = matriz[f];
    if (!fila || fila.every((c) => c === null || c === undefined || String(c).trim() === '')) continue;

    const celda = (clave: keyof typeof COLUMNAS): unknown =>
      indice[clave] === undefined ? null : fila[indice[clave] as number];

    const folio = String(celda('folio') ?? '').trim().slice(0, 40);
    if (!folio) { descartadas.push({ fila: f + 1, motivo: 'sin folio' }); continue; }
    if (vistos.has(folio)) { descartadas.push({ fila: f + 1, motivo: `folio repetido en el archivo (${folio})` }); continue; }
    vistos.add(folio);

    const anticipo = leerCifraImportada(celda('anticipo'));
    if (anticipo === 'ilegible') { descartadas.push({ fila: f + 1, motivo: `anticipo ilegible (${folio})` }); continue; }
    const fecha = leerFechaImportada(celda('fecha'));
    if (fecha === 'ilegible') { descartadas.push({ fila: f + 1, motivo: `fecha ilegible (${folio})` }); continue; }

    const ingreso = leerCifraImportada(celda('ingreso'));
    if (ingreso === 'ilegible') { descartadas.push({ fila: f + 1, motivo: `ingreso ilegible (${folio})` }); continue; }
    const km = leerCifraImportada(celda('km'));
    if (km === 'ilegible') { descartadas.push({ fila: f + 1, motivo: `km ilegibles (${folio})` }); continue; }

    // Los topes de cordura son los MISMOS que el formulario ($5,000,000 / 20,000
    // km): `validarIngreso` es el dueño de la regla vacío ≠ cero y de los topes,
    // y reimplementarlos aquí sería la segunda oportunidad de escribir
    // `Number('')` y colar un 0 donde no hay dato. `leerCifraImportada` ya
    // tradujo los formatos del TMS ("1.234,56"); esto solo aplica la regla.
    let ingresoFlete: number | null;
    let kmRecorridos: number | null;
    try {
      const medido = validarIngreso({
        clienteId: '',
        ingresoFlete: ingreso === null ? '' : String(ingreso),
        kmRecorridos: km === null ? '' : String(km),
      });
      ingresoFlete = medido.ingresoFlete;
      kmRecorridos = medido.kmRecorridos;
    } catch (e) {
      if (e instanceof DatoInvalido) { descartadas.push({ fila: f + 1, motivo: `${e.message} (${folio})` }); continue; }
      throw e;
    }

    viajes.push({
      folio,
      origen: String(celda('origen') ?? '').trim().slice(0, 80) || null,
      destino: String(celda('destino') ?? '').trim().slice(0, 80) || null,
      fechaInicio: fecha,
      anticipo,
      operadorNombre: String(celda('operadorNombre') ?? '').trim().slice(0, 120) || null,
      unidadEco: String(celda('unidad') ?? '').trim().slice(0, 40) || null,
      clienteNombre: String(celda('cliente') ?? '').trim().slice(0, 120) || null,
      ingresoFlete,
      kmRecorridos,
    });
  }

  const filasDeDatos = matriz.length - 1;
  if (filasDeDatos > TOPE_FILAS_IMPORT) {
    // EL AVISO VA EN `descartadas`, NO SOLO EN `error`, y ahí está el arreglo
    // (FE-15). `error` solo llega a la pantalla cuando NO se importó nada
    // (`page.tsx`: `if (lectura.error && lectura.viajes.length === 0)`), que es
    // justo el caso que aquí NO ocurre: se importaron 2,000. El aviso viajaba
    // en el campo que nadie iba a leer, y el acuse decía "creados: 2,000" sin
    // mencionar las 58,000 filas que se quedaron fuera.
    //
    // Va PRIMERO en la lista porque la vista enseña las cinco primeras
    // descartadas: si fuera al final, lo taparían cinco folios ilegibles.
    // `numero()` y no `toLocaleString`: el formato de cifras vive en un solo
    // archivo, y hay una prueba que falla si aparece una segunda copia.
    const tope = numero(TOPE_FILAS_IMPORT);
    const aviso = `El archivo trae ${numero(filasDeDatos)} filas y el tope es ${tope}: `
      + `se leyeron las primeras ${tope}. Pártelo y sube el resto aparte.`;
    descartadas.unshift({ fila: TOPE_FILAS_IMPORT + 1, motivo: aviso });
    return { viajes, descartadas, error: aviso };
  }
  return { viajes, descartadas };
}

export interface ResultadoImportacion {
  creados: number;
  /** Folios que YA existían en la flota — el mismo archivo dos veces no duplica. */
  saltados: string[];
  /** Operadores del archivo que no se pudieron amarrar (no existe / ambiguo).
   *  Sus viajes NO se crean: `viaje.operador_id` es NOT NULL desde la 0001 —
   *  la versión que los mandaba "sin asignar" tumbaba el lote entero con
   *  23502 (lateral AUD3). */
  operadoresSinAmarrar: string[];
  /** Folios cuya fila no trae operador amarrable — se saltan y se dicen. */
  sinOperador: string[];
  /** Folios saltados porque su operador ya trae un viaje abierto (0029) —
   *  en la base o más arriba en el mismo archivo. */
  operadorOcupado: string[];
  /** Números económicos del archivo que no existen en `unidad` (o que el
   *  catálogo no distingue). Sus filas NO se crean: importar un viaje con la
   *  unidad descartada en silencio dejaría el archivo diciendo una cosa y el
   *  Registro otra. */
  unidadesSinAmarrar: string[];
  /** Folios descartados porque su unidad no se pudo amarrar. */
  sinUnidad: string[];
  /** Nombres de cliente del archivo que no existen en `cliente`. */
  clientesSinAmarrar: string[];
  /** Folios descartados porque su cliente no se pudo amarrar. */
  sinCliente: string[];
  error?: string;
}

/** Nombre a llave de catálogo: minúsculas, sin acentos, espacios colapsados.
 *  El mismo aplanado con el que el jefe teclea desde un teléfono. */
function llaveCatalogo(t: string): string {
  return t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Carga un catálogo (id por nombre) para amarrar UNA VEZ por corrida, no por
 * fila. Dos filas del catálogo que colisionen en la misma llave (dos clientes
 * "ACME" con acentos distintos) se marcan ambiguas — amarrar a ciegas a
 * cualquiera de las dos es peor que descartar la fila y decirlo.
 */
async function cargarCatalogo(
  tabla: 'unidad' | 'cliente', columna: 'numero_economico' | 'nombre', tenantId: string,
): Promise<Map<string, string | null>> {
  const filas = await traerTodo<Record<string, unknown>>(
    (d, h) => acotada(supabaseAdmin().from(tabla).select(`id, ${columna}`)
      .eq('tenant_id', tenantId).eq('activo', true).order('id').range(d, h), `importarViajes.${tabla}`),
    `importarViajes.${tabla}`,
  );
  const porLlave = new Map<string, string | null>();
  for (const f of filas) {
    const nombre = typeof f[columna] === 'string' ? (f[columna] as string) : '';
    const id = typeof f.id === 'string' ? f.id : '';
    if (!nombre || !id) continue;
    const k = llaveCatalogo(nombre);
    porLlave.set(k, porLlave.has(k) ? null : id);   // null = ambiguo
  }
  return porLlave;
}

/** Filas creadas en UN import a partir de las cuales se pide ANALYZE (ESC-18). */
export const UMBRAL_ANALYZE = 1_000;

async function analizarTrasImport(tenantId: string, creados: number): Promise<void> {
  try {
    const { error } = await acotada(supabaseAdmin().rpc('analizar_tablas_operacion'), 'importarViajes.analyze');
    if (error) logger.warn('importar_viajes.analyze_fallo', { tenantId, creados, err: error.message });
    else logger.info('importar_viajes.analyze', { tenantId, creados });
  } catch (e) {
    logger.warn('importar_viajes.analyze_fallo', { tenantId, creados, err: e instanceof Error ? e.message : String(e) });
  }
}

/** Inserta los viajes SIN avisar a nadie (ver encabezado). Anclado al tenant. */
export async function importarViajes(tenantId: string, filas: FilaViajeImportada[]): Promise<ResultadoImportacion> {
  if (!tenantId) throw new Error('importarViajes: falta tenantId');
  const vacio = (): ResultadoImportacion => ({
    creados: 0, saltados: [], operadoresSinAmarrar: [], sinOperador: [], operadorOcupado: [],
    unidadesSinAmarrar: [], sinUnidad: [], clientesSinAmarrar: [], sinCliente: [],
  });
  if (!filas.length) return vacio();

  const existentes = new Set(
    (await traerTodo<{ folio: unknown }>(
      (d, h) => acotada(supabaseAdmin().from('viaje').select('folio')
        .eq('tenant_id', tenantId).not('folio', 'is', null).order('id').range(d, h), 'importarViajes.folios'),
      'importarViajes.folios',
    )).map((v) => String(v.folio)),
  );

  const saltados = filas.filter((f) => existentes.has(f.folio)).map((f) => f.folio);
  const nuevas = filas.filter((f) => !existentes.has(f.folio));

  // ── EL AMARRE DE OPERADOR: UN CATÁLOGO POR CORRIDA, NO UNO POR NOMBRE ────
  //
  // Esto llamaba a `resolverOperadorPorNombre(tenantId, nombre)` una vez por
  // nombre DISTINTO del archivo, y esa función se trae con `traerTodo` el
  // catálogo ENTERO de operadores activos de la flota en CADA llamada (por
  // qué se compara en memoria y no con `ilike`, lo explica su cabecera:
  // Postgres es sensible a acentos y "Ramirez" no encontraría a "Ramírez").
  //
  // Con 2,000 filas y mil choferes distintos eran mil lecturas SECUENCIALES
  // del mismo catálogo de 7,500 filas — ocho páginas de PostgREST cada una.
  // El import se moría por reloj a media tanda y dejaba unos viajes creados y
  // otros no, sin decir cuáles (FE-15).
  //
  // Ahora el catálogo se lee UNA vez y la MISMA regla de coincidencia se
  // aplica en memoria (`elegirOperadorPorNombre`, extraída de aquella para no
  // tener dos motores de amarre que se puedan separar sin que nadie lo note).
  //
  // FALLA CERRADO, como el catálogo de unidades y clientes: si la lectura no
  // se puede completar, NO se importa nada. Amarrar "a lo que se alcanzó a
  // leer" repartiría viajes —y anticipos— por una página perdida.
  const operadorPorNombre = new Map<string, string | null>();
  const operadoresSinAmarrar = new Set<string>();
  const necesitaOperadores = nuevas.some((f) => f.operadorNombre);
  if (necesitaOperadores) {
    let catalogoOperadores: Array<{ id: unknown; nombre: unknown }>;
    try {
      catalogoOperadores = await traerTodo<{ id: unknown; nombre: unknown }>(
        (d, h) => acotada(supabaseAdmin().from('operador').select('id, nombre')
          .eq('tenant_id', tenantId).eq('activo', true).order('id').range(d, h),
        'importarViajes.operador'),
        'importarViajes.operador',
      );
    } catch (e) {
      logger.error('importar_viajes.operadores_ilegible', { tenantId, err: e instanceof Error ? e.message : String(e) });
      return {
        ...vacio(), saltados,
        error: 'No pude leer el catálogo de operadores — no importé nada. Vuelve a intentar.',
      };
    }
    for (const f of nuevas) {
      if (!f.operadorNombre || operadorPorNombre.has(f.operadorNombre)) continue;
      try {
        const c = elegirOperadorPorNombre(catalogoOperadores, f.operadorNombre);
        operadorPorNombre.set(f.operadorNombre, c?.operadorId ?? null);
        if (!c) operadoresSinAmarrar.add(f.operadorNombre);
      } catch (e) {
        // Lo ambiguo queda sin asignar y se reporta con su nombre: importar no
        // es el momento de adivinar a quién se le carga un viaje.
        if (e instanceof OperadorNombreAmbiguo) {
          operadorPorNombre.set(f.operadorNombre, null);
          operadoresSinAmarrar.add(f.operadorNombre);
        } else throw e;
      }
    }
  }

  // ── LOS DOS CANDADOS DE LA BASE, RESPETADOS ANTES DEL INSERT (AUD3) ──────
  // 1. `viaje.operador_id` es NOT NULL (0001): la fila sin operador amarrado
  //    no puede crearse "sin asignar" — antes iba con null y el 23502 tumbaba
  //    el LOTE ENTERO, y "vuelve a subir el archivo" repetía el mismo choque
  //    para siempre. Se salta y se dice, con su folio.
  // 2. `uq_viaje_abierto_por_operador` (0029): un operador, UN viaje abierto.
  //    Se respeta antes de chocar: la primera fila del archivo gana; las
  //    demás (y las de operadores con viaje vivo en la base) se saltan con
  //    su folio. Si un histórico debe entrar como `liquidado` es una decisión
  //    de producto que este módulo no adivina.
  const sinOperador: string[] = [];
  const conOperador: FilaViajeImportada[] = [];
  for (const f of nuevas) {
    const id = f.operadorNombre ? operadorPorNombre.get(f.operadorNombre) ?? null : null;
    if (id) conOperador.push(f); else sinOperador.push(f.folio);
  }

  // ── UNIDAD Y CLIENTE: UN QUERY DE CATÁLOGO POR CORRIDA, NO POR FILA ──────
  // Amarrar por nombre exacto (aplanado); lo que no exista se DESCARTA con su
  // folio — la fila no se importa "a medias" con la unidad o el cliente que
  // el archivo sí decía. Vacío ≠ desconocido: una celda vacía importa normal
  // con `null`, que es la verdad ("no viene en el archivo").
  const necesitaUnidades = conOperador.some((f) => f.unidadEco);
  const necesitaClientes = conOperador.some((f) => f.clienteNombre);
  let unidadPorEco = new Map<string, string | null>();
  let clientePorNombre = new Map<string, string | null>();
  try {
    [unidadPorEco, clientePorNombre] = await Promise.all([
      necesitaUnidades ? cargarCatalogo('unidad', 'numero_economico', tenantId) : Promise.resolve(unidadPorEco),
      necesitaClientes ? cargarCatalogo('cliente', 'nombre', tenantId) : Promise.resolve(clientePorNombre),
    ]);
  } catch (e) {
    // Fallar CERRADO, como la lectura de ocupados: importar sin poder amarrar
    // descartaría con "no existe" a unidades y clientes que sí existen.
    logger.error('importar_viajes.catalogo_ilegible', { tenantId, err: e instanceof Error ? e.message : String(e) });
    return {
      ...vacio(), saltados, operadoresSinAmarrar: [...operadoresSinAmarrar], sinOperador,
      error: 'No pude leer el catálogo de unidades o clientes — no importé nada. Vuelve a intentar.',
    };
  }

  const unidadesSinAmarrar = new Set<string>();
  const clientesSinAmarrar = new Set<string>();
  const sinUnidad: string[] = [];
  const sinCliente: string[] = [];
  const amarradas: Array<FilaViajeImportada & { unidadId: string | null; clienteId: string | null }> = [];
  for (const f of conOperador) {
    const unidadId = f.unidadEco ? unidadPorEco.get(llaveCatalogo(f.unidadEco)) ?? null : null;
    if (f.unidadEco && !unidadId) {
      unidadesSinAmarrar.add(f.unidadEco);
      sinUnidad.push(f.folio);
      continue;
    }
    const clienteId = f.clienteNombre ? clientePorNombre.get(llaveCatalogo(f.clienteNombre)) ?? null : null;
    if (f.clienteNombre && !clienteId) {
      clientesSinAmarrar.add(f.clienteNombre);
      sinCliente.push(f.folio);
      continue;
    }
    amarradas.push({ ...f, unidadId, clienteId });
  }

  const idsAmarrados = [...new Set(amarradas.map((f) => operadorPorNombre.get(f.operadorNombre!)!))];
  const ocupados = new Set<string>();
  // Segmentos de 200: `.in()` con miles de ids es una URL que PostgREST corta.
  for (let i = 0; i < idsAmarrados.length; i += 200) {
    const { data, error } = await acotada(supabaseAdmin().from('viaje')
      .select('operador_id')
      .eq('tenant_id', tenantId)
      .in('estatus', ['abierto', 'en_cuadre'])
      .in('operador_id', idsAmarrados.slice(i, i + 200)), 'importarViajes.ocupados');
    if (error) {
      // Fallar CERRADO: insertar sin saber quién está ocupado es apostar el
      // lote entero al 23505 del 0029.
      logger.error('importar_viajes.ocupados_ilegible', { tenantId, err: error.message });
      return {
        ...vacio(), saltados, operadoresSinAmarrar: [...operadoresSinAmarrar], sinOperador,
        unidadesSinAmarrar: [...unidadesSinAmarrar], sinUnidad,
        clientesSinAmarrar: [...clientesSinAmarrar], sinCliente,
        error: 'No pude verificar qué operadores ya traen un viaje abierto — no importé nada. Vuelve a intentar.',
      };
    }
    for (const r of data ?? []) ocupados.add(String(r.operador_id));
  }

  const operadorOcupado: string[] = [];
  const listas: Array<FilaViajeImportada & { unidadId: string | null; clienteId: string | null }> = [];
  for (const f of amarradas) {
    const id = operadorPorNombre.get(f.operadorNombre!)!;
    if (ocupados.has(id)) { operadorOcupado.push(f.folio); continue; }
    ocupados.add(id); // la primera fila del archivo gana — como haría el 0029
    listas.push(f);
  }

  let creados = 0;
  // Lotes de 100: un INSERT de 2,000 filas en una pasada es donde un timeout
  // deja mitad y mitad sin decir cuál mitad.
  for (let i = 0; i < listas.length; i += 100) {
    const lote = listas.slice(i, i + 100).map((f) => ({
      tenant_id: tenantId,
      folio: f.folio,
      origen: f.origen,
      destino: f.destino,
      fecha_inicio: f.fechaInicio,
      anticipo: f.anticipo ?? 0,
      operador_id: operadorPorNombre.get(f.operadorNombre!)!,
      unidad_id: f.unidadId,
      cliente_id: f.clienteId,
      // `?? null` y NO `|| null` — igual que crearViaje: un ingreso de 0 del
      // TMS es un cero MEDIDO y tiene que entrar a la medición como tal.
      ingreso_flete: f.ingresoFlete ?? null,
      km_recorridos: f.kmRecorridos ?? null,
      estatus: 'abierto',
    }));
    // Upsert que IGNORA duplicados contra `viaje_folio_unico` (0092): el que
    // pierde la carrera de dos submits concurrentes no truena ni duplica —
    // sus folios chocan en la base, vuelven sin insertar, y se reportan como
    // saltados. `creados` cuenta SOLO las filas que el insert devolvió: la
    // cifra del acuse es lo que de verdad entró, nunca el tamaño del lote.
    const { data, error } = await acotada(
      supabaseAdmin().from('viaje')
        .upsert(lote, { onConflict: 'tenant_id,folio', ignoreDuplicates: true })
        .select('folio'), 'importarViajes.insert',
    );
    if (error) {
      logger.error('importar_viajes.lote_fallo', { tenantId, desde: i, err: error.message });
      return {
        creados, saltados, operadoresSinAmarrar: [...operadoresSinAmarrar],
        sinOperador, operadorOcupado,
        unidadesSinAmarrar: [...unidadesSinAmarrar], sinUnidad,
        clientesSinAmarrar: [...clientesSinAmarrar], sinCliente,
        error: `Se crearon ${creados} y el lote que empieza en la fila ${i + 1} falló — revisa y vuelve a subir el archivo: los ya creados se saltan solos.`,
      };
    }
    const insertados = new Set((data ?? []).map((v) => String(v.folio)));
    creados += insertados.size;
    for (const fila of lote) {
      if (!insertados.has(fila.folio)) saltados.push(fila.folio);
    }
  }

  logger.info('importar_viajes.ok', {
    tenantId, creados, saltados: saltados.length,
    sinOperador: sinOperador.length, operadorOcupado: operadorOcupado.length,
    sinUnidad: sinUnidad.length, sinCliente: sinCliente.length,
  });

  // ESC-18 (escala 50k): un archivo mete hasta 2,000 viajes de golpe y
  // autovacuum no analiza hasta que cambia el 10 % de la tabla — a 50k viajes
  // son 5,000 filas, o sea varias importaciones planificando con estadísticas
  // de cuando la flota tenía 300 viajes. Pasado el umbral se pide ANALYZE por
  // la RPC de la 0157 (solo service_role). Best-effort y DESPUÉS del acuse:
  // los viajes ya están; un ANALYZE que no corre se loguea, no tumba el import.
  if (creados > UMBRAL_ANALYZE) await analizarTrasImport(tenantId, creados);

  return {
    creados, saltados, operadoresSinAmarrar: [...operadoresSinAmarrar], sinOperador, operadorOcupado,
    unidadesSinAmarrar: [...unidadesSinAmarrar], sinUnidad,
    clientesSinAmarrar: [...clientesSinAmarrar], sinCliente,
  };
}
