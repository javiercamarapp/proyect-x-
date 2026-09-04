// ═══════════════════════════════════════════════════════════════════════════
// LO COMPARTIDO DE TODA ESCRITURA DE /v1 — cuerpo, idempotencia y acuse.
//
// `_comun.ts` es la puerta: decide DE QUÉ FLOTA habla una petición. Este
// archivo es el segundo tramo, el que solo existe cuando la petición además
// ESCRIBE, y responde a tres preguntas que una lectura no tiene que hacerse:
//
//   1. ¿el cuerpo trae lo que dice traer? (un formulario del panel garantiza
//      la forma; un `POST` de un TMS ajeno no garantiza nada);
//   2. ¿esta petición ya se ejecutó antes? (la idempotencia);
//   3. ¿qué se le contesta a quien acaba de crear algo?
//
// ── EL MODO DE FALLA QUE ESTE ARCHIVO EXISTE PARA EVITAR ─────────────────
//
// Un TMS reintenta ante un timeout. Siempre. Es lo correcto de su lado: no
// sabe si el viaje se creó o si el POST murió en el camino. Sin idempotencia,
// UN SOLO timeout crea el viaje DOS VECES, y un viaje duplicado no es una fila
// de más: es un anticipo contado dos veces en el Registro del contralor, una
// población doble en la cola de cobranza y un margen de flota que se hunde con
// un viaje que nunca existió. Es exactamente el daño que la mig. 0092 ya
// describe para el importador de archivos, con otra puerta de entrada.
//
// ── LA IDEMPOTENCIA AQUÍ TIENE TRES CAPAS, Y DOS SON DURABLES ────────────
//
// CAPA 1 — EL RECUERDO EN MEMORIA (`recuerdos`, abajo). Guarda la respuesta
// exacta de cada `Idempotency-Key` y la vuelve a servir tal cual, sin tocar la
// base. NO SOBREVIVE a un reinicio ni cruza entre instancias: en Vercel cada
// instancia arranca con su Map vacío, igual que `rateLimit`. Sigue siendo la
// primera que se consulta porque es gratis, pero ya no es la que sostiene la
// promesa — desde la mig. 0098 es solo la caché de la capa 3.
//
// CAPA 2 — LA LLAVE NATURAL EN LA BASE: `viaje_folio_unico` (tenant_id, folio)
// de la mig. 0092 y `unidad_economico_unico` (tenant_id, numero_economico) de
// la 0047. Antes de insertar se BUSCA por esa llave, y si el insert choca igual
// (dos peticiones en paralelo) se relee y se devuelve la fila que ya existe.
// Es la que sostiene lo que de verdad importa, y NO depende de las otras dos:
// **por más veces que el TMS reintente, no puede haber dos viajes con el mismo
// folio ni dos unidades con el mismo número económico en la misma flota.**
//
// CAPA 3 — LA TABLA `api_idempotencia` (mig. 0098), durable y compartida entre
// instancias. Cierra el hueco que estuvo declarado aquí desde que se escribió
// este archivo: dos peticiones con la MISMA llave y CUERPOS DISTINTOS solo se
// detectaban si caían en la misma instancia. Cruzando instancias, la segunda
// encontraba la fila por su llave natural y recibía un 200 con `idempotente:
// true` y la fila vieja — la respuesta correcta para un reintento, y una
// respuesta que manda al integrador convencido de que su corrección se guardó
// cuando el cuerpo era genuinamente otro. Ahora eso es un 400 que lo dice.
//
// LO QUE ESTA CAPA NO PROMETE: no es un candado de "en vuelo". Dos peticiones
// simultáneas con la misma llave pueden pasar las dos por la lectura antes de
// que ninguna escriba, y el árbitro de ese caso es —y sigue siendo— el unique
// de la capa 2. Por eso las tres conviven en vez de sustituirse.
// ═══════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { acotada } from '@/lib/likida/presupuesto';
import { DatoInvalido } from '@/lib/likida/errores';
import { errorApi, fallo, type CuerpoError } from './_comun';
import { leerTextoAcotado } from '@/lib/http/cuerpo_acotado';

// ── El cuerpo ──────────────────────────────────────────────────────────────

/**
 * Tope del cuerpo de una escritura.
 *
 * 16 KB contra los ~500 bytes que pesa el viaje más cargado. No es un límite
 * de negocio: es para que un cuerpo absurdo se corte ANTES de parsearlo, sin
 * gastar CPU en el JSON.parse de un megabyte.
 *
 * Se contesta 400 y no 413 porque `CodigoError` (en `_comun.ts`) es un dominio
 * CERRADO sobre el que el integrador ramifica, y agregarle un código toca un
 * archivo que esta entrega no puede tocar. El mensaje sí dice el tope exacto.
 */
export const MAX_CUERPO_BYTES = 16_000;

export type LecturaCuerpo =
  | { ok: true; cuerpo: Record<string, unknown> }
  | { ok: false; respuesta: NextResponse<CuerpoError> };

/**
 * Lee el cuerpo como objeto JSON, o explica por qué no.
 *
 * El tope se aplica mientras se lee. `Content-Length` permite rechazar antes;
 * sin esa cabecera, el contador de bytes corta el stream antes de materializar
 * un cuerpo chunked completo.
 */
export async function leerCuerpo(req: Request): Promise<LecturaCuerpo> {
  const lectura = await leerTextoAcotado(req, MAX_CUERPO_BYTES);
  if (!lectura.ok && lectura.motivo === 'demasiado_grande') {
    return { ok: false, respuesta: errorApi('parametro_invalido', `El cuerpo no puede pasar de ${MAX_CUERPO_BYTES} bytes.`) };
  }
  if (!lectura.ok) {
    return { ok: false, respuesta: errorApi('parametro_invalido', 'No se pudo leer el cuerpo de la petición.') };
  }
  const texto = lectura.texto;

  let crudo: unknown;
  try {
    crudo = JSON.parse(texto);
  } catch {
    // El mensaje del parser NO cruza: dice offsets del texto que mandaron y no
    // ayuda a nadie a corregir el campo. Se dice qué se esperaba.
    return { ok: false, respuesta: errorApi('parametro_invalido', 'El cuerpo tiene que ser un objeto JSON.') };
  }
  if (crudo === null || typeof crudo !== 'object' || Array.isArray(crudo)) {
    return { ok: false, respuesta: errorApi('parametro_invalido', 'El cuerpo tiene que ser un objeto JSON (no una lista ni un valor suelto).') };
  }

  return { ok: true, cuerpo: crudo as Record<string, unknown> };
}

// ── Validación en el borde ─────────────────────────────────────────────────
//
// `crearViaje` y `crearUnidad` esperan una forma que hoy garantiza un
// formulario del panel: un `<select>` no manda un objeto donde va un uuid, ni
// `true` donde va un monto. Un cuerpo de API puede traer cualquier cosa, y sin
// esta capa esa cualquier-cosa llega hasta el INSERT — donde el que contesta
// es Postgres, con un mensaje que ni se le puede enseñar al integrador ni le
// dice QUÉ campo corregir.

/** Un campo del cuerpo que no cumple. `campo` viaja para poder nombrarlo. */
export class CampoInvalido extends Error {
  constructor(readonly campo: string, mensaje: string) {
    super(mensaje);
    this.name = 'CampoInvalido';
  }
}

/**
 * ¿El campo viene o no viene?
 *
 * `undefined` y `null` son AUSENCIA; `''` también, porque un TMS que no tiene
 * el dato manda la cadena vacía tan seguido como la omite. La distinción que
 * importa —y que sostiene todo lo demás— es que ausencia NUNCA se convierte en
 * 0 ni en cadena vacía guardada: se convierte en `null`.
 */
function ausente(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/**
 * Un texto.
 *
 * Acepta también un número porque un folio de TMS viaja tan seguido como
 * `12345` que como `"12345"`, y rechazarlo obligaría al integrador a
 * convertirlo del otro lado. Los dos se normalizan al MISMO texto, que además
 * es lo que hace que la deduplicación por folio funcione entre las dos formas.
 * Lo que no se acepta es un booleano, un objeto o una lista: eso no es un
 * folio escrito de otra manera, es un error de quien armó el cuerpo.
 */
export function texto(
  cuerpo: Record<string, unknown>, campo: string,
  opciones: { obligatorio?: boolean; max: number },
): string | null {
  const v = cuerpo[campo];
  if (ausente(v)) {
    if (opciones.obligatorio) throw new CampoInvalido(campo, `\`${campo}\` es obligatorio.`);
    return null;
  }
  if (typeof v !== 'string' && typeof v !== 'number') {
    throw new CampoInvalido(campo, `\`${campo}\` tiene que ser texto.`);
  }
  if (typeof v === 'number' && !Number.isFinite(v)) {
    throw new CampoInvalido(campo, `\`${campo}\` tiene que ser texto.`);
  }
  const t = String(v).trim();
  if (t.length > opciones.max) {
    // NO se recorta en silencio: un folio truncado dedupea contra el folio
    // equivocado, que es peor que un 400. Mismo criterio que `leerPagina`.
    throw new CampoInvalido(campo, `\`${campo}\` no puede pasar de ${opciones.max} caracteres.`);
  }
  return t;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Un uuid.
 *
 * Se valida la FORMA aquí para que un `"el-de-siempre"` no llegue a Postgres
 * como un 22P02 que hay que traducir a ciegas. Que el id sea DE ESTA FLOTA no
 * se comprueba aquí: eso lo hacen los candados anti-IDOR de `operacion.ts`
 * (`operadorPropio`, `unidadPropia`, `clientePropioLocal`), que son los que
 * tienen la base enfrente. Duplicar esa comprobación aquí sería una segunda
 * versión de la regla de seguridad más cara del repo.
 */
export function uuid(
  cuerpo: Record<string, unknown>, campo: string,
  opciones: { obligatorio?: boolean } = {},
): string | null {
  const v = cuerpo[campo];
  if (ausente(v)) {
    if (opciones.obligatorio) throw new CampoInvalido(campo, `\`${campo}\` es obligatorio.`);
    return null;
  }
  if (typeof v !== 'string' || !UUID.test(v.trim())) {
    throw new CampoInvalido(campo, `\`${campo}\` tiene que ser un uuid.`);
  }
  return v.trim();
}

/**
 * Una fecha de calendario, `YYYY-MM-DD`.
 *
 * La columna es `date` (0001), no `timestamptz`. Aceptar un ISO con hora
 * dejaría caer la hora EN SILENCIO y con ella la zona horaria: un viaje de las
 * 23:00 en Ciudad de México mandado como `...T23:00:00Z` se guardaría en el
 * día siguiente. Se rechaza y se dice el formato.
 *
 * Se comprueba además que la fecha EXISTA: `2026-02-30` cumple el regex y no
 * es un día. Postgres lo rechazaría, pero con un mensaje suyo.
 */
export function fecha(cuerpo: Record<string, unknown>, campo: string): string | null {
  const v = cuerpo[campo];
  if (ausente(v)) return null;
  if (typeof v !== 'string') throw new CampoInvalido(campo, `\`${campo}\` tiene que ser una fecha \`AAAA-MM-DD\`.`);
  const t = v.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) throw new CampoInvalido(campo, `\`${campo}\` tiene que ser una fecha \`AAAA-MM-DD\` (sin hora).`);
  const [a, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(a, mes - 1, dia));
  if (d.getUTCFullYear() !== a || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) {
    throw new CampoInvalido(campo, `\`${campo}\` no es una fecha que exista.`);
  }
  return t;
}

/**
 * Un entero dentro de un rango.
 *
 * Acepta el número y también su forma de texto (`"2018"`), porque un CSV
 * exportado por un TMS manda todo como texto. `"2018.5"` NO pasa: un año con
 * decimales es un dato equivocado, no un entero escrito distinto.
 */
export function entero(
  cuerpo: Record<string, unknown>, campo: string,
  opciones: { min: number; max: number },
): number | null {
  const v = cuerpo[campo];
  if (ausente(v)) return null;
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) n = Number(v.trim());
  else throw new CampoInvalido(campo, `\`${campo}\` tiene que ser un número entero.`);
  if (!Number.isSafeInteger(n)) throw new CampoInvalido(campo, `\`${campo}\` tiene que ser un número entero.`);
  if (n < opciones.min || n > opciones.max) {
    throw new CampoInvalido(campo, `\`${campo}\` tiene que estar entre ${opciones.min} y ${opciones.max}.`);
  }
  return n;
}

/**
 * Un monto en pesos, con hasta dos decimales.
 *
 * ── POR QUÉ EXISTE ESTO SI YA HAY `validarIngreso` ───────────────────────
 *
 * Sirve para `viaje.anticipo` y SOLO para él, que es el único monto de estas
 * rutas cuya columna es `NOT NULL DEFAULT 0` (0001): ahí ausente y cero
 * significan lo mismo porque la base no puede guardar otra cosa. Todo monto
 * cuya ausencia SÍ cambia una medición —el ingreso del flete, los kilómetros—
 * pasa por `validarIngreso`, que es donde vive la regla de VACÍO ≠ CERO. Este
 * validador no la reimplementa: no la necesita.
 *
 * MÁS DE DOS DECIMALES SE RECHAZAN en vez de redondearse. `numeric(12,2)`
 * redondearía en silencio, y un anticipo que se guarda distinto del que se
 * mandó es exactamente el descuadre de centavos que el contralor persigue
 * durante media tarde.
 */
export function monto(
  cuerpo: Record<string, unknown>, campo: string,
  opciones: { min: number; max: number },
): number | null {
  const v = cuerpo[campo];
  if (ausente(v)) return null;

  let n: number;
  if (typeof v === 'number') {
    n = v;
  } else if (typeof v === 'string') {
    // Mismo saneado que `ingreso_viaje.ts`: la coma decimal es como se teclea
    // en México y el separador de millares se pega desde un Excel.
    const limpio = v.trim().replace(/\s/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(limpio)) throw new CampoInvalido(campo, `\`${campo}\` tiene que ser un número.`);
    n = Number(limpio);
  } else {
    throw new CampoInvalido(campo, `\`${campo}\` tiene que ser un número.`);
  }

  if (!Number.isFinite(n)) throw new CampoInvalido(campo, `\`${campo}\` tiene que ser un número.`);
  // Con TOLERANCIA y no con un `!==` pelado: `1234.56 * 100` es
  // 123455.99999999999 en binario, así que la comparación exacta rechazaría un
  // monto perfectamente válido. La tolerancia es mil veces más chica que el
  // centavo que se está midiendo, así que 1234.567 sigue sin pasar.
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
    throw new CampoInvalido(campo, `\`${campo}\` no puede traer más de dos decimales.`);
  }
  if (n < opciones.min || n > opciones.max) {
    throw new CampoInvalido(campo, `\`${campo}\` tiene que estar entre ${opciones.min} y ${opciones.max}.`);
  }
  return n;
}

/**
 * Lo que se le pasa a `validarIngreso` (`lib/likida/ingreso_viaje.ts`): el
 * campo tal cual lo teclearía una persona, en TEXTO.
 *
 * ── POR QUÉ SE DELEGA EN VEZ DE VALIDAR AQUÍ ─────────────────────────────
 *
 * Porque la regla que distingue VACÍO de CERO ya está escrita, probada y es la
 * que sostiene toda la medición de margen. Una segunda implementación en el
 * borde de la API sería una segunda oportunidad de escribir `Number('')` y
 * meter un 0 donde no hay dato: el viaje sin ingreso capturado se contaría como
 * un viaje que no produjo nada, su margen saldría -100%, y las tres cifras se
 * verían plausibles. Aquí solo se comprueba el TIPO —lo único que un formulario
 * garantizaba y un JSON no— y el resto lo decide el motor.
 *
 * `null` y ausente salen como `''`, que es lo que `validarIngreso` lee como
 * "no capturado" y convierte en `null`. Un `0` sale como `'0'`, que ese mismo
 * motor lee como un cero MEDIDO.
 */
export function crudoNumerico(cuerpo: Record<string, unknown>, campo: string): string {
  const v = cuerpo[campo];
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new CampoInvalido(campo, `\`${campo}\` tiene que ser un número.`);
    return String(v);
  }
  if (typeof v === 'string') return v;
  throw new CampoInvalido(campo, `\`${campo}\` tiene que ser un número.`);
}

export type Validado<T> =
  | { ok: true; valor: T }
  | { ok: false; respuesta: NextResponse<CuerpoError> };

/**
 * Corre la validación de una ruta y traduce lo que lance.
 *
 * Los dos errores que SÍ se le enseñan al integrador son los que se
 * escribieron para que alguien los lea: `CampoInvalido` (nombra el campo) y
 * `DatoInvalido` (los topes de cordura de `ingreso_viaje.ts`, ya redactados
 * para una persona). Cualquier otra excepción es una falla nuestra y se va por
 * `fallo()`, que corta el mensaje entero.
 */
export function validar<T>(evento: string, f: () => T): Validado<T> {
  try {
    return { ok: true, valor: f() };
  } catch (e) {
    if (e instanceof CampoInvalido || e instanceof DatoInvalido) {
      return { ok: false, respuesta: errorApi('parametro_invalido', e.message) };
    }
    return { ok: false, respuesta: fallo(evento, e) };
  }
}

// ── La llave de idempotencia ───────────────────────────────────────────────

export const CABECERA_IDEMPOTENCIA = 'Idempotency-Key';
/** Corta lo que no es una llave: `"1"` colisiona entre peticiones distintas. */
export const LARGO_MIN_LLAVE = 8;
export const LARGO_MAX_LLAVE = 200;

/** El año más viejo que admite una unidad.
 *
 *  Vive aquí y no en la ruta porque el OpenAPI lo cita, y un `route.ts` de
 *  Next.js no puede exportar nada que no sea un handler. Que el spec lea ESTA
 *  constante y no una copia suya es el punto: un límite documentado que no es
 *  el que valida enseña a mandar peticiones que rebotan. */
export const ANIO_MIN_UNIDAD = 1950;

export type LecturaLlave =
  | { ok: true; llave: string }
  | { ok: false; respuesta: NextResponse<CuerpoError> };

/**
 * Exige `Idempotency-Key` y comprueba que tenga forma de llave.
 *
 * SE EXIGE, no se acepta opcionalmente. Una escritura sin llave no se puede
 * reintentar sin riesgo, y dejarla pasar significaría que la primera
 * integración que se escriba sin leer la documentación es también la primera
 * que duplique viajes. Es más barato un 400 el primer día que un anticipo
 * duplicado el día 30.
 */
export function leerLlaveIdempotencia(req: Request): LecturaLlave {
  const crudo = req.headers.get(CABECERA_IDEMPOTENCIA);
  if (!crudo || crudo.trim() === '') {
    return {
      ok: false,
      respuesta: errorApi(
        'parametro_invalido',
        `Falta la cabecera \`${CABECERA_IDEMPOTENCIA}\`. Manda un identificador único por operación (un uuid sirve) y repítelo EXACTO si reintentas: es lo que impide que un timeout cree el registro dos veces.`,
      ),
    };
  }
  const llave = crudo.trim();
  // ASCII imprimible: una cabecera con saltos de línea o bytes de control es la
  // forma de un intento de inyección en cabeceras, no la de un uuid.
  if (!/^[\x21-\x7E]+$/.test(llave)) {
    return { ok: false, respuesta: errorApi('parametro_invalido', `\`${CABECERA_IDEMPOTENCIA}\` solo admite caracteres ASCII imprimibles.`) };
  }
  if (llave.length < LARGO_MIN_LLAVE || llave.length > LARGO_MAX_LLAVE) {
    return {
      ok: false,
      respuesta: errorApi('parametro_invalido', `\`${CABECERA_IDEMPOTENCIA}\` tiene que medir entre ${LARGO_MIN_LLAVE} y ${LARGO_MAX_LLAVE} caracteres.`),
    };
  }
  return { ok: true, llave };
}

/**
 * La huella del cuerpo YA VALIDADO Y NORMALIZADO.
 *
 * Se calcula sobre lo normalizado y no sobre el texto crudo por dos razones que
 * importan las dos: un reintento que reserialice el JSON con las llaves en otro
 * orden o con otro espaciado sigue siendo la MISMA operación, y —esto es lo que
 * lo vuelve una prueba— un `tenant_id` colado en el cuerpo NO cambia la huella,
 * porque nunca entra al objeto normalizado. Un campo que no existe en la
 * normalización no puede influir en nada de lo que pasa después.
 */
export function huella(payload: Record<string, string | number | boolean | null>): string {
  const ordenado = Object.keys(payload).sort().map((k) => [k, payload[k]] as const);
  return createHash('sha256').update(JSON.stringify(ordenado), 'utf8').digest('hex');
}

/** Lo que se recuerda de una escritura ya contestada. */
type Recuerdo = { huella: string; status: number; cuerpo: unknown; expiraEn: number };

const recuerdos = new Map<string, Recuerdo>();
/** Backstop de memoria, igual que `ratelimit.ts`. */
const MAX_RECUERDOS = 2_000;
/** Cuánto vale un recuerdo. 24 h cubre de sobra el reintento de un TMS, que
 *  ocurre en segundos; más allá de eso el que manda es el unique de la base. */
export const VIDA_RECUERDO_MS = 86_400_000;

function podar(ahora: number): void {
  for (const [k, r] of recuerdos) if (r.expiraEn <= ahora) recuerdos.delete(k);
  if (recuerdos.size <= MAX_RECUERDOS) return;
  const porCaducidad = [...recuerdos.entries()].sort((a, b) => a[1].expiraEn - b[1].expiraEn);
  const sobran = recuerdos.size - Math.floor(MAX_RECUERDOS * 0.75);
  for (let i = 0; i < sobran; i++) recuerdos.delete(porCaducidad[i][0]);
}

/** Solo para pruebas: el Map es de módulo y se comparte entre casos. */
export function reiniciarIdempotencia(): void {
  recuerdos.clear();
}

// ── CAPA 3: EL RECUERDO DURABLE (mig. 0098) ────────────────────────────────
//
// Lo que el Map no puede: cruzar instancias y sobrevivir a un reinicio. Las dos
// funciones de abajo comparten una regla que es lo más importante de todo este
// tramo — NINGUNA LANZA. Ver el porqué en cada una.

/** Lo que se recordó de una llave, o `null` si no hay nada (o no se pudo leer). */
async function leerRecuerdoDurable(
  e: { evento: string; tenantId: string; llave: string },
): Promise<{ huella: string; status: number; cuerpo: unknown } | null> {
  try {
    const { data, error } = await acotada(
      supabaseAdmin().from('api_idempotencia')
        .select('huella, status, cuerpo')
        .eq('tenant_id', e.tenantId).eq('ruta', e.evento).eq('llave', e.llave)
        .maybeSingle(),
      'v1.leerRecuerdoDurable',
    );
    // UN ERROR DE LECTURA NO ES "NO HAY NADA", pero aquí se tratan igual A
    // PROPÓSITO, y es la única vez en el repo que se hace: esta capa es de
    // conveniencia. Si no responde, la petición sigue al paso de la llave
    // natural —la conducta exacta que había antes de que existiera esta
    // tabla—, y ésa no puede duplicar nada porque el unique de la base sigue
    // en pie. Fallar cerrado aquí cambiaría un reintento que funciona por uno
    // que devuelve 500.
    if (error) {
      logger.warn(`${e.evento}.idempotencia_ilegible`, { tenant: e.tenantId, err: error.message });
      return null;
    }
    if (!data) return null;
    return {
      huella: data.huella as string,
      status: data.status as number,
      cuerpo: data.cuerpo as unknown,
    };
  } catch (err) {
    logger.warn(`${e.evento}.idempotencia_ilegible`, {
      tenant: e.tenantId, err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Guarda la respuesta servida.
 *
 * `ignoreDuplicates` porque dos peticiones en paralelo con la misma llave
 * llegan aquí las dos: la primera escribe y la segunda no tiene nada que
 * corregir — su respuesta es equivalente y la fila que ya está es la que se va
 * a servir de aquí en adelante. Sobrescribir sería peor: cambiaría la respuesta
 * canónica a mitad de camino.
 *
 * NO LANZA, y ésta es la razón concreta: cuando esto corre, el viaje YA SE
 * CREÓ. Dejar que un fallo al anotar el recibo tumbe la respuesta convertiría
 * una creación exitosa en un 500 — y el TMS, obediente, reintentaría una
 * escritura que ya ocurrió. El peor caso al callar es que el reintento no
 * encuentre el recuerdo y caiga en la llave natural, que contesta bien.
 */
async function guardarRecuerdoDurable(
  e: { evento: string; tenantId: string; llave: string; huella: string },
  status: number,
  cuerpo: unknown,
): Promise<void> {
  try {
    const { error } = await acotada(
      supabaseAdmin().from('api_idempotencia').upsert({
        tenant_id: e.tenantId,
        ruta: e.evento,
        llave: e.llave,
        huella: e.huella,
        status,
        cuerpo: cuerpo as Record<string, unknown>,
      }, { onConflict: 'tenant_id,ruta,llave', ignoreDuplicates: true }),
      'v1.guardarRecuerdoDurable',
    );
    if (error) logger.warn(`${e.evento}.idempotencia_no_guardada`, { tenant: e.tenantId, err: error.message });
  } catch (err) {
    logger.warn(`${e.evento}.idempotencia_no_guardada`, {
      tenant: e.tenantId, err: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── El acuse ───────────────────────────────────────────────────────────────

export interface SobreEscritura<T> {
  dato: T;
  /**
   * `true` = esto YA EXISTÍA y esta petición no creó nada. Viaja en el cuerpo
   * además de en el status (201 vs 200) porque un cliente generado a partir del
   * OpenAPI ramifica sobre el cuerpo mucho más seguido que sobre el status.
   */
  idempotente: boolean;
}

export function creado<T>(dato: T): NextResponse<SobreEscritura<T>> {
  return NextResponse.json({ dato, idempotente: false }, { status: 201 });
}

export function yaExistia<T>(dato: T): NextResponse<SobreEscritura<T>> {
  return NextResponse.json({ dato, idempotente: true }, { status: 200 });
}

// ── Traducir lo que truena ─────────────────────────────────────────────────

/**
 * Los mensajes de `operacion.ts` que describen un error DEL QUE LLAMA, no
 * nuestro.
 *
 * Se reconocen por su texto y eso es frágil: si alguien reescribe la frase en
 * `crearViaje`, este mapeo deja de acertar. El modo de falla de esa fragilidad
 * es FALLAR CERRADO —cae al `fallo()` de abajo, o sea un 500 genérico sin una
 * letra del mensaje interno—, nunca fallar abierto. Se acepta ese riesgo
 * porque la alternativa era peor: sin esto, un TMS que manda el uuid de un
 * operador dado de baja recibe un 500 y REINTENTA para siempre, cuando lo que
 * necesita es que le digan cuál de sus tres referencias no existe.
 *
 * El mensaje que sale al integrador se ESCRIBE aquí; el interno no se copia.
 */
const REFERENCIAS: ReadonlyArray<{ patron: RegExp; campo: string; que: string }> = [
  { patron: /el operador no pertenece a esta flota/i, campo: 'operadorId', que: 'operador' },
  { patron: /la unidad no pertenece a esta flota/i, campo: 'unidadId', que: 'unidad' },
  { patron: /el cliente no pertenece a esta flota/i, campo: 'clienteId', que: 'cliente' },
];

/** El índice parcial de la 0029: un operador, UN viaje abierto. */
const OPERADOR_OCUPADO = 'uq_viaje_abierto_por_operador';

/**
 * Traduce una excepción de escritura a la respuesta que le sirve al integrador.
 *
 * Tres familias, y el default importa tanto como las tres:
 *  · una referencia que no es de su flota → 404, diciendo QUÉ campo;
 *  · el choque con el invariante de la 0029 → 400, explicando la regla (que es
 *    de negocio y no un accidente: con dos viajes abiertos del mismo operador,
 *    TODAS sus fotos se cuelgan del más nuevo y el viejo cierra con el anticipo
 *    entero en contra de la persona — está escrito en la migración);
 *  · TODO LO DEMÁS → `fallo()`, que corta el mensaje interno completo. Ni un
 *    error de Postgres ni un mensaje de negocio cruzan al cuerpo: en una API se
 *    ramifica por `codigo`, no por texto.
 */
export function traducirFalla(evento: string, tenantId: string, e: unknown): NextResponse<CuerpoError> {
  const crudo = e instanceof Error ? e.message : String(e);

  for (const r of REFERENCIAS) {
    if (r.patron.test(crudo)) {
      logger.warn(`${evento}.referencia_ajena`, { tenant: tenantId, campo: r.campo });
      return errorApi('no_encontrado', `El \`${r.campo}\` que mandaste no existe en tu flota. Revisa que sea el id que te devolvió Likida para ese ${r.que}.`);
    }
  }

  if (crudo.includes(OPERADOR_OCUPADO)) {
    logger.warn(`${evento}.operador_ocupado`, { tenant: tenantId });
    return errorApi(
      'parametro_invalido',
      'Ese operador ya trae un viaje abierto. En Likida un operador tiene a lo más un viaje sin liquidar a la vez: con dos, todos sus comprobantes se cuelgan del más reciente y el otro cierra con el anticipo completo en contra suya. Liquida el que trae o mándale este viaje a otro operador.',
    );
  }

  // AUDITORÍA 24, BE-13: `DatoInvalido` es un mensaje YA redactado para una
  // persona («ese operador está dado de baja»), no una falla nuestra. Salía
  // como 500 `error_interno` con «vuelve a intentar en un momento»: el TMS del
  // cliente reintentaba un error determinista —el chofer no se va a reactivar
  // solo— y nuestro log se llenaba de «errores» que son validación. Mismo
  // criterio que `validar()` arriba, que ya lo trata como 400.
  if (e instanceof DatoInvalido) {
    logger.warn(`${evento}.dato_invalido`, { tenant: tenantId });
    return errorApi('parametro_invalido', e.message);
  }

  return fallo(evento, e, { tenant: tenantId });
}

/**
 * ¿Esta excepción es el choque contra ESTE unique de la base?
 *
 * Se exigen las DOS señales —el vocabulario del 23505 y el nombre exacto de la
 * restricción— para no confundir un choque de folio con cualquier otro error
 * que mencione la palabra. Si PostgREST cambiara el texto, esto deja de
 * reconocerlo y la petición sale como 500: ruidoso y sin duplicar, que es el
 * lado correcto en el que equivocarse.
 */
export function chocoContra(e: unknown, restriccion: string): boolean {
  const crudo = e instanceof Error ? e.message : String(e);
  return crudo.includes(restriccion) && /duplicate key|already exists|23505/i.test(crudo);
}

// ── El único camino de una escritura ───────────────────────────────────────

/** Lo que `buscar` devuelve cuando la llave natural YA tiene fila. */
export interface Hallazgo<T> {
  /** Lo que se le acusa al integrador si esta fila responde por él. */
  dato: T;
  /**
   * ¿El CONTENIDO de esta petición coincide con la fila que ya existe?
   *
   * `true`  → es un reintento honesto (u otro camino creó lo mismo): 200.
   * `false` → mismo folio, OTRO contenido: 409, porque contestar el 200
   *           idempotente descartaría los montos del integrador EN SILENCIO
   *           y lo mandaría convencido de que se guardaron (hallazgo A8,
   *           auditoría 4).
   * `null`  → la ruta no sabe comparar; se responde 200 como siempre.
   */
  coincide: boolean | null;
}

export interface Escritura<T> {
  /** Para el log y para separar recuerdos de rutas distintas. */
  evento: string;
  tenantId: string;
  llave: string;
  huella: string;
  /** El unique de la base que dedupea esta entidad por su llave natural. */
  restriccion: string;
  /** Busca la fila que ya existe con esa MISMA llave natural — y en la MISMA
   *  consulta trae lo necesario para decidir si el contenido coincide. Lanza
   *  si no pudo leer: un fallo de lectura no puede leerse como "no existe". */
  buscar: () => Promise<Hallazgo<T> | null>;
  crear: () => Promise<T>;
  /** El mensaje del 409 cuando la fila existe con OTRO contenido. Lo escribe
   *  la ruta porque es quien sabe nombrar su llave natural y decir dónde se
   *  corrige (el panel, no esta API). */
  mensajeConflicto: string;
}

/**
 * Ejecuta una escritura idempotente y devuelve su acuse.
 *
 * El orden es el que hace la promesa, y es éste:
 *   1. RECUERDO en memoria — misma llave y mismo cuerpo: se devuelve la
 *      respuesta EXACTA de la primera vez, sin tocar la base;
 *   2. misma llave con OTRO cuerpo → 400. Reusar una llave con otro contenido
 *      es un error del cliente, y contestar la respuesta vieja a un cuerpo
 *      nuevo sería peor que rechazarlo;
 *   3. LLAVE NATURAL en la base — la capa durable. Si ya existe CON EL MISMO
 *      contenido, se devuelve lo que hay con `idempotente: true` (aquí se
 *      atrapa el reintento que cayó en otra instancia, que es EL caso del
 *      timeout). Si existe con OTRO contenido, es un 409 que lo dice: el 200
 *      idempotente de antes descartaba los montos del integrador en silencio;
 *   4. se crea. Si el insert choca igual contra el unique (dos peticiones en
 *      paralelo, la carrera que la mig. 0092 describe), se relee y se contesta
 *      la fila que ganó. Nadie recibe un 500 por una carrera que la base ya
 *      resolvió bien.
 *
 * No se marca "en vuelo" ninguna llave: sería una promesa de una sola
 * instancia, y el único árbitro que ven todas las instancias es el unique de
 * la base. El paso 4 ES ese árbitro.
 */
export async function escribir<T>(e: Escritura<T>): Promise<NextResponse> {
  const clave = `${e.evento}|${e.tenantId}|${e.llave}`;
  const ahora = Date.now();

  const llaveReusada = () => {
    logger.warn(`${e.evento}.llave_reusada`, { tenant: e.tenantId });
    return errorApi(
      'parametro_invalido',
      `Esa \`${CABECERA_IDEMPOTENCIA}\` ya se usó para una operación con otro contenido. Usa una llave nueva por operación y repite la misma solo al reintentar la misma.`,
    );
  };
  const eco = (status: number, cuerpo: unknown) =>
    // LA MISMA RESPUESTA, literal: mismo cuerpo y mismo status que la primera
    // vez. La cabecera avisa que fue un eco para que un cliente que quiera
    // distinguirlo pueda, sin que el cuerpo cambie.
    NextResponse.json(cuerpo, { status, headers: { 'Idempotent-Replayed': 'true' } });

  const previo = recuerdos.get(clave);
  if (previo && previo.expiraEn > ahora) {
    if (previo.huella !== e.huella) return llaveReusada();
    return eco(previo.status, previo.cuerpo);
  }

  // ── CAPA DURABLE (mig. 0098) ────────────────────────────────────────────
  //
  // Aquí es donde se atrapa lo que el Map no podía: el reintento que cayó en
  // OTRA instancia. Va después de la memoria porque la memoria es gratis y
  // esto es una consulta.
  //
  // SI ESTA LECTURA FALLA NO SE ABORTA: se sigue de largo al paso de la llave
  // natural. Degradar así es exactamente la conducta que había antes de esta
  // tabla, y esa conducta no puede duplicar nada —el unique de la base sigue
  // ahí—. Devolver 500 porque la capa de conveniencia no respondió sería
  // cambiar un reintento que funciona por uno que falla.
  const durable = await leerRecuerdoDurable(e);
  if (durable) {
    if (durable.huella !== e.huella) return llaveReusada();
    return eco(durable.status, durable.cuerpo);
  }

  const recordar = async (status: number, cuerpo: unknown) => {
    recuerdos.set(clave, { huella: e.huella, status, cuerpo, expiraEn: Date.now() + VIDA_RECUERDO_MS });
    if (recuerdos.size > MAX_RECUERDOS) podar(Date.now());
    await guardarRecuerdoDurable(e, status, cuerpo);
  };

  // El 409 NO se recuerda: la tabla 0098 solo admite 200/201 a propósito (un
  // error no es una respuesta canónica que replayar), y recalcularlo en cada
  // intento es lo correcto — si alguien corrige la fila desde el panel, el
  // siguiente POST idéntico del TMS deja de chocar.
  const conflicto = () => {
    logger.warn(`${e.evento}.conflicto_contenido`, { tenant: e.tenantId });
    return errorApi('conflicto', e.mensajeConflicto);
  };

  try {
    const existente = await e.buscar();
    if (existente) {
      if (existente.coincide === false) return conflicto();
      const cuerpo: SobreEscritura<T> = { dato: existente.dato, idempotente: true };
      await recordar(200, cuerpo);
      logger.info(`${e.evento}.ya_existia`, { tenant: e.tenantId });
      return NextResponse.json(cuerpo, { status: 200 });
    }

    let dato: T;
    try {
      dato = await e.crear();
    } catch (err) {
      if (!chocoContra(err, e.restriccion)) throw err;
      // La carrera: otra petición insertó entre el `buscar` y el `crear`.
      const gano = await e.buscar();
      if (!gano) throw err;   // chocó contra el unique y no está: no se inventa nada
      if (gano.coincide === false) return conflicto();
      const cuerpo: SobreEscritura<T> = { dato: gano.dato, idempotente: true };
      await recordar(200, cuerpo);
      logger.info(`${e.evento}.carrera_resuelta`, { tenant: e.tenantId });
      return NextResponse.json(cuerpo, { status: 200 });
    }

    const cuerpo: SobreEscritura<T> = { dato, idempotente: false };
    await recordar(201, cuerpo);
    return NextResponse.json(cuerpo, { status: 201 });
  } catch (err) {
    return traducirFalla(e.evento, e.tenantId, err);
  }
}

// ── Las llaves naturales, que son lo que vuelve durable la idempotencia ────
//
// Viven aquí y no en cada ruta porque NO son una consulta cualquiera: son la
// mitad de la mecánica de arriba. Cada una lee por el mismo par de columnas
// que su unique, así que devuelve a lo más una fila.

/** Lo que /v1 acusa de un viaje recién creado (o del que ya estaba). */
export interface ViajeCreado {
  id: string;
  folio: string;
  /** `abierto | en_cuadre | liquidado`. En un viaje que YA existía puede no ser
   *  `abierto`: es el estado real, y es justo lo que el TMS necesita ver. */
  estatus: string;
}

/** El CONTENIDO de un viaje que decide si dos peticiones son la misma
 *  operación. Es la misma lista de campos que entra a la `huella` del POST,
 *  sin el folio (por el folio se buscó). */
export interface ContenidoViaje {
  operadorId: string | null;
  origen: string | null;
  destino: string | null;
  fechaInicio: string | null;
  unidadId: string | null;
  clienteId: string | null;
  ingresoFlete: number | null;
  kmRecorridos: number | null;
  anticipo: number;
}

/** Texto contra texto, con AUSENTE (`null`) como valor propio: un origen que
 *  no se mandó no es igual a un origen guardado. */
function textoIgual(a: string | null, b: string | null): boolean {
  return (a ?? null) === (b ?? null);
}

/** Los uuid de Postgres salen SIEMPRE en minúsculas; el del cuerpo llega como
 *  lo escribió el TMS. Sin esto, el mismo operador en mayúsculas sería un
 *  conflicto falso. */
function uuidIgual(a: string | null, b: string | null): boolean {
  return textoIgual(a === null ? null : a.toLowerCase(), b === null ? null : b.toLowerCase());
}

/** Dinero a dos decimales: la tolerancia es diez veces más chica que el
 *  centavo, así que $500 y $500.00 coinciden y $500.01 no. */
function montoIgual(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < 0.005;
}

export function viajeCoincide(fila: ContenidoViaje, pedido: ContenidoViaje): boolean {
  return uuidIgual(fila.operadorId, pedido.operadorId)
    && textoIgual(fila.origen, pedido.origen)
    && textoIgual(fila.destino, pedido.destino)
    && textoIgual(fila.fechaInicio, pedido.fechaInicio)
    && uuidIgual(fila.unidadId, pedido.unidadId)
    && uuidIgual(fila.clienteId, pedido.clienteId)
    && montoIgual(fila.ingresoFlete, pedido.ingresoFlete)
    && montoIgual(fila.kmRecorridos, pedido.kmRecorridos)
    && montoIgual(fila.anticipo, pedido.anticipo);
}

/** `numeric`/`int` de PostgREST llegan como número JSON; en un doble de prueba
 *  pueden faltar. Ausente es `null` — jamás 0. */
function numeroONull(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function textoONull(v: unknown): string | null {
  return v === undefined || v === null ? null : String(v);
}

export async function buscarViajePorFolio(
  tenantId: string, folio: string,
): Promise<{ dato: ViajeCreado; contenido: ContenidoViaje } | null> {
  const { data, error } = await acotada(
    supabaseAdmin().from('viaje')
      .select('id, folio, estatus, operador_id, origen, destino, fecha_inicio, unidad_id, cliente_id, ingreso_flete, km_recorridos, anticipo')
      .eq('tenant_id', tenantId).eq('folio', folio).maybeSingle(),
    'v1.buscarViajePorFolio',
  );
  // FALLAR CERRADO. Devolver `null` ante un error de lectura diría "no existe"
  // y mandaría a insertar: el unique lo atraparía, pero el integrador recibiría
  // un 500 en vez del acuse que ya le tocaba. Se lanza y `escribir` traduce.
  if (error) throw new Error(`buscarViajePorFolio: ${error.message}`);
  if (!data) return null;
  const f = data as Record<string, unknown>;
  return {
    dato: { id: String(f.id), folio: String(f.folio), estatus: String(f.estatus) },
    contenido: {
      operadorId: textoONull(f.operador_id),
      origen: textoONull(f.origen),
      destino: textoONull(f.destino),
      fechaInicio: textoONull(f.fecha_inicio),
      unidadId: textoONull(f.unidad_id),
      clienteId: textoONull(f.cliente_id),
      ingresoFlete: numeroONull(f.ingreso_flete),
      kmRecorridos: numeroONull(f.km_recorridos),
      // `viaje.anticipo` es NOT NULL DEFAULT 0 (0001): en la base siempre hay
      // número, y 0 es la medición de "no se adelantó nada".
      anticipo: numeroONull(f.anticipo) ?? 0,
    },
  };
}

export interface UnidadCreada {
  id: string;
  numeroEconomico: string;
}

/** El contenido de una unidad, sin su número económico (por él se buscó). */
export interface ContenidoUnidad {
  placas: string | null;
  marca: string | null;
  modelo: string | null;
  anio: number | null;
}

export function unidadCoincide(fila: ContenidoUnidad, pedido: ContenidoUnidad): boolean {
  return textoIgual(fila.placas, pedido.placas)
    && textoIgual(fila.marca, pedido.marca)
    && textoIgual(fila.modelo, pedido.modelo)
    && montoIgual(fila.anio, pedido.anio);
}

export async function buscarUnidadPorEconomico(
  tenantId: string, numeroEconomico: string,
): Promise<{ dato: UnidadCreada; contenido: ContenidoUnidad } | null> {
  const { data, error } = await acotada(
    supabaseAdmin().from('unidad')
      .select('id, numero_economico, placas, marca, modelo, anio')
      .eq('tenant_id', tenantId).eq('numero_economico', numeroEconomico).maybeSingle(),
    'v1.buscarUnidadPorEconomico',
  );
  if (error) throw new Error(`buscarUnidadPorEconomico: ${error.message}`);
  if (!data) return null;
  const f = data as Record<string, unknown>;
  return {
    dato: { id: String(f.id), numeroEconomico: String(f.numero_economico) },
    contenido: {
      placas: textoONull(f.placas),
      marca: textoONull(f.marca),
      modelo: textoONull(f.modelo),
      anio: numeroONull(f.anio),
    },
  };
}
