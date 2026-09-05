import { hostNoPublico } from '@/lib/http/destino_publico';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { anotarBitacora } from '@/lib/likida/bitacora_escritura';
import { acotada } from '../presupuesto';
import { DatoInvalido } from '../errores';
import { cifrar, descifrar, pistasDe, cofreConfigurado } from './cofre';
import { conectorPorId } from './registro';
import { faltantes, httpReal, veredictoDe, type Http, type ResultadoPrueba, type ValoresCredencial } from './tipos';

// ═══════════════════════════════════════════════════════════════════════════
// CREDENCIALES DE CONECTOR — la escritura que la 0094 dejó prometida.
//
// El cofre (`cofre.ts`) sabía cifrar y la tabla `conector_credencial` sabía
// guardar, pero hasta este archivo (hallazgo C2, auditoría 4) NADIE los
// conectaba: los 14 conectores con `claveAlmacen: null` —los 8 de ERP y los 6
// de peaje— no tenían forma de recibir un solo acceso aunque su adaptador
// estuviera completo. Este módulo es el puente, y lo llama la pantalla de
// /dashboard/conexiones.
//
// Las reglas que NO se negocian aquí:
//   · El secreto viaja UNA vez, del formulario al cifrado. No vuelve al
//     panel (`listarCredenciales` jamás selecciona `valores_cifrados`), no
//     entra a un log, no entra a la bitácora.
//   · Sin `LIKIDA_COFRE_LLAVE` NO se guarda — y se dice qué falta. El modo de
//     falla aceptable es "no se pudo guardar", nunca "se guardó en claro"
//     (el CHECK `conector_credencial_no_en_claro` es el segundo candado).
//   · Guardar NO es conectar: la fila nace con `probada_en: null` y la
//     pantalla lo dice — "guardada, sin probar contra el sistema real".
// ═══════════════════════════════════════════════════════════════════════════

/** Bitácora best-effort — patrón `anotar` de `clientes.ts`: si falla, la
 *  credencial YA se guardó y tirar la operación dejaría el sistema peor. Al
 *  detalle van NOMBRES de campos, jamás valores. */
async function anotar(
  tenantId: string,
  accion: string,
  entidadId: string,
  detalle: Record<string, unknown>,
  actor?: { id?: string; email?: string },
): Promise<void> {
  await anotarBitacora(
    { tenantId, actor: actor ?? {}, accion, entidad: 'conector_credencial', entidadId, detalle },
    { evento: 'conector_credencial.bitacora_no_escribio' },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24, SEG-6 (BAJO) — EL `base_url` QUE APUNTABA HACIA ADENTRO.
//
// Ocho conectores (4 de GPS, 3 de ERP, 1 de peaje) piden `base_url` y
// `gps.ts:54` sólo le quitaba la diagonal final: ni esquema ni host. Un
// flota_admin podía guardar `http://10.0.0.5:9200` y apretar «Probar»; la
// función de Vercel hacía el POST desde DENTRO y la pantalla enseñaba el
// veredicto por código HTTP y `e.message` — un oráculo del estado de lo que
// haya en esa dirección. Lo acota que sólo llega ahí quien administra la flota
// y que la red de Vercel no expone servicios internos de Likida; no lo acota
// la CSP, porque el POST no sale del navegador.
//
// Se valida al guardar y otra vez en el lookup del socket al usar: un dominio
// público puede resolver después a una red interna (DNS rebinding).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `base_url` (y cualquier credencial que termine en `_url`) tiene que ser una
 * dirección pública por HTTPS. Lanza `DatoInvalido` con el porqué: la pantalla
 * de Conexiones lo enseña tal cual, y el dueño de la flota necesita saber que
 * lo que escribió no es el portal de su proveedor.
 */
export function validarUrlDeCredencial(clave: string, valor: string): void {
  let u: URL;
  try {
    u = new URL(valor);
  } catch {
    throw new DatoInvalido(`El campo ${clave} no es una dirección válida. Se espera la dirección del portal de tu proveedor, con https:// al principio.`);
  }
  if (u.protocol !== 'https:') {
    throw new DatoInvalido(`El campo ${clave} tiene que ir por https:// — por ${u.protocol.replace(':', '')} la credencial viajaría sin cifrar.`);
  }
  if (u.username || u.password) {
    throw new DatoInvalido(`El campo ${clave} no debe incluir usuario ni contraseña en la URL.`);
  }
  if (hostNoPublico(u.hostname)) {
    throw new DatoInvalido(`El campo ${clave} apunta a una dirección de red interna (${u.hostname}). Se espera el portal público de tu proveedor.`);
  }
}

/** `base_url`, `api_url`, … — la convención del catálogo de conectores. */
function esCampoUrl(clave: string): boolean {
  return clave === 'url' || clave.endsWith('_url');
}

/**
 * Guarda (o reemplaza) los accesos de un conector para la flota.
 *
 * El `tenantId` viene por argumento desde la sesión del servidor, NUNCA del
 * formulario. UPSERT por `(tenant_id, conector_id)` porque la 0094 admite UNA
 * credencial por conector y flota: capturar de nuevo ES reemplazar, y la
 * fila reemplazada vuelve a `probada_en: null` — la credencial nueva no
 * hereda la prueba de la vieja, porque nadie la ha probado.
 */
export async function guardarCredencial(
  tenantId: string,
  conectorId: string,
  valores: ValoresCredencial,
  actor?: { id?: string; email?: string },
): Promise<string> {
  if (!cofreConfigurado()) {
    // Se dice QUÉ falta, sin inventar un camino alterno: guardar en claro no
    // es una opción (ver `llave()` en cofre.ts).
    throw new DatoInvalido(
      'El cofre de credenciales no está configurado en este entorno (falta LIKIDA_COFRE_LLAVE, mínimo 32 caracteres). Sin él no se guardan accesos — guardarlos sin cifrar no es una opción.',
    );
  }

  const conector = conectorPorId(conectorId);
  if (!conector) throw new DatoInvalido('Ese sistema no está en el catálogo de conectores.');
  if (conector.credenciales.length === 0) {
    // Los `por_archivo` y los sin API no piden nada: aceptarles un guardado
    // fingiría una conexión que ese camino no usa.
    throw new DatoInvalido(`${conector.nombre} no pide credenciales — su camino de conexión no las usa.`);
  }

  // SOLO los campos declarados por el conector viajan al cofre. Un formulario
  // manipulado podría mandar claves extra, y cifrarlas las volvería carga
  // invisible que `probar()` nunca leería pero un descifrado sí devolvería.
  const limpios: Record<string, string> = {};
  for (const campo of conector.credenciales) {
    const v = (valores[campo.clave] ?? '').trim();
    if (v !== '') limpios[campo.clave] = v;
  }

  const falta = faltantes(conector, limpios);
  if (falta.length > 0) {
    throw new DatoInvalido(`Faltan datos para guardar ${conector.nombre}: ${falta.join(', ')}.`);
  }

  // SEG-6: antes de cifrar. Una dirección interna guardada ya es el oráculo,
  // aunque nadie apriete «Probar»: el poller la usaría cada 5 minutos.
  for (const [clave, valor] of Object.entries(limpios)) {
    if (esCampoUrl(clave)) validarUrlDeCredencial(clave, valor);
  }

  const { data, error } = await acotada(supabaseAdmin().from('conector_credencial').upsert({
    tenant_id: tenantId,
    conector_id: conector.id,
    valores_cifrados: cifrar(limpios),
    pistas: pistasDe(conector.credenciales, limpios),
    activo: true,
    // Reemplazar borra la historia de la prueba A PROPÓSITO: una fila con la
    // `probada_en` vieja y valores nuevos pintaría verde algo que nadie probó.
    probada_en: null,
    ultimo_error: null,
    creada_por: actor?.id ?? null,
  }, { onConflict: 'tenant_id,conector_id' }).select('id').single(), 'guardarCredencial');

  if (error) throw new Error(`guardarCredencial: ${error.message}`);
  const id = (data as { id?: unknown } | null)?.id;
  if (!id) throw new Error('guardarCredencial: el upsert no devolvió id');

  await anotar(tenantId, 'conector_credencial.guardada', String(id), {
    // Nombres de campos, no valores: la bitácora se lee del panel.
    conectorId: conector.id, campos: Object.keys(limpios),
  }, actor);

  return String(id);
}

export interface CredencialListada {
  conectorId: string;
  /** Lo ÚNICO de los valores que vuelve al panel: no-secretos en claro y los
   *  últimos 4 de cada secreto (ver `pistasDe`). */
  pistas: Record<string, string>;
  activo: boolean;
  /** `null` = guardada pero NUNCA probada contra el sistema real. La
   *  pantalla lo dice así, no lo pinta verde. */
  probadaEn: string | null;
  ultimoError: string | null;
  creadaEn: string;
}

/**
 * El sufijo con el que `sesion_portal.ts` guarda la SESIÓN de un portal en el
 * mismo cofre (`portal_facturacion:g500#sesion`). Se declara aquí —y no se
 * importa de allá— para no arrastrar Playwright ni el módulo de facturación a
 * la pantalla de Conexiones; el valor está fijado por la 0232 y hay una prueba
 * que compara los dos.
 */
export const SUFIJO_SESION_PORTAL = '#sesion';

/**
 * Las credenciales de la flota, nuevas primero.
 *
 * `valores_cifrados` NO se selecciona — ni cifrado tiene por qué viajar a la
 * capa de pantalla. Y un error de lectura LANZA en vez de devolver `[]`: una
 * base caída pintada como "no tienes credenciales" invitaría a capturarlas
 * de nuevo encima de las que sí existen.
 *
 * LAS FILAS `#sesion` NO SON CREDENCIALES Y NO SALEN DE AQUÍ.
 *
 * AUDITORÍA CICLO 7, c7-21: `guardarSesionPortal` guarda la sesión de
 * Playwright en esta misma tabla bajo `conector_id = '<portal>#sesion'`, y
 * esto las traía todas. En cuanto una flota vinculaba un portal, Conexiones
 * pintaba un renglón fantasma titulado `portal_facturacion:g500#sesion` —el id
 * crudo, porque no está en el catálogo— «guardada, sin probar», con botones
 * **Probar** y **Desactivar**. Probar no hacía nada (corta en `conectorPorId`),
 * pero DESACTIVAR SÍ FUNCIONABA: apagaba la sesión del portal sin decir que
 * eso era lo que hacía. El dueño creería que borró una credencial huérfana y
 * se quedaría sin autofacturación hasta volver a pasar un captcha.
 *
 * El estado de esas sesiones ya tiene su pantalla y su tabla en claro
 * (`portal_estado`, 0232), que es donde se cuenta sin acercarse al cofre. El
 * filtro va en el SERVIDOR y no en la vista: así ninguna pantalla futura las
 * hereda por olvido.
 */
export async function listarCredenciales(tenantId: string): Promise<CredencialListada[]> {
  const { data, error } = await acotada(supabaseAdmin().from('conector_credencial')
    .select('conector_id, pistas, activo, probada_en, ultimo_error, creada_en')
    .eq('tenant_id', tenantId)
    // `not.like` en la base y no un `filter` en JS: lo que no viaja no se
    // puede pintar por accidente.
    .not('conector_id', 'like', `%${SUFIJO_SESION_PORTAL}`)
    .order('creada_en', { ascending: false }), 'listarCredenciales');

  if (error) throw new Error(`listarCredenciales: ${error.message}`);

  return (data ?? [])
    // Cinturón sobre el tirante: si el `not.like` se cayera en un refactor de
    // la consulta, esta línea sigue impidiendo que una sesión se pinte como
    // credencial con un botón que la apaga.
    .filter((f) => !String(f.conector_id).endsWith(SUFIJO_SESION_PORTAL))
    .map((f) => ({
    conectorId: String(f.conector_id),
    pistas: (f.pistas ?? {}) as Record<string, string>,
    activo: Boolean(f.activo),
    probadaEn: f.probada_en == null ? null : String(f.probada_en),
    ultimoError: f.ultimo_error == null ? null : String(f.ultimo_error),
    creadaEn: String(f.creada_en),
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// PROBAR DE VERDAD — el tramo que faltaba entre `probar()` y la pantalla.
//
// Los 19 conectores traen su `probar()` escrito y verificado contra la
// documentación del fabricante, y `probada_en`/`ultimo_error` existen desde la
// 0094 y SE RENDERIZAN. Lo que no existía era el camino de en medio: nadie
// leía la credencial guardada, nadie llamaba a `probar()` y nadie sellaba el
// resultado. `probar()` era código muerto y la pantalla enseñaba para siempre
// «guardada — sin probar contra el sistema real».
//
// La regla que manda aquí: la prueba es CONTRA EL PROVEEDOR, no un ping falso.
// No hay un camino que devuelva «ok» sin que alguien de fuera haya contestado
// — `probarConGuardas` y `veredictoHttp` (tipos.ts) ya lo garantizan, y aquí
// no se agrega ninguna rama que los esquive.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Los valores DESCIFRADOS de una credencial activa, o `null` si no hay ninguna.
 *
 * `null` significa exactamente una cosa —no hay fila activa de ese conector en
 * esta flota— y NUNCA "no se pudo leer": un error de base LANZA. Aplastar los
 * dos casos en `null` haría que una base caída se leyera como "nunca
 * capturaste esa credencial", que es justo el mensaje que manda a recapturar.
 *
 * El descifrado también lanza: un texto alterado o una llave cambiada tienen
 * que parar aquí y no producir un objeto a medias que acabe intentando
 * autenticarse contra el sistema del cliente (ver `descifrar` en cofre.ts).
 *
 * Este es el ÚNICO lugar de la capa de pantalla donde un secreto vuelve a
 * existir en claro, y vive solo el tiempo de la llamada a `probar()`: no se
 * devuelve al navegador, no se anota en la bitácora, no entra a un log.
 */
export async function leerCredencial(
  tenantId: string,
  conectorId: string,
): Promise<ValoresCredencial | null> {
  const { data, error } = await acotada(supabaseAdmin().from('conector_credencial')
    .select('valores_cifrados')
    .eq('tenant_id', tenantId)
    .eq('conector_id', conectorId)
    .eq('activo', true)
    .maybeSingle(), 'leerCredencial');

  if (error) throw new Error(`leerCredencial: ${error.message}`);
  const cifrado = (data as { valores_cifrados?: unknown } | null)?.valores_cifrados;
  if (typeof cifrado !== 'string' || cifrado === '') return null;

  try {
    return descifrar(cifrado);
  } catch (e) {
    // Se dice qué pasó SIN reintentar ni adivinar: si el cofre no puede abrir
    // lo guardado, la credencial hay que capturarla de nuevo, y afirmar otra
    // cosa mandaría a buscar el problema al proveedor.
    throw new DatoInvalido(
      `No se pudo abrir la credencial guardada de ese sistema: ${e instanceof Error ? e.message : String(e)}. Suele significar que la llave del cofre cambió en este entorno; hay que capturar el acceso de nuevo.`,
    );
  }
}

/** Tope de lo que se guarda en `ultimo_error`. La frase la escribimos nosotros
 *  y es corta; el tope existe para que el mensaje de una excepción rara no
 *  llene la columna que la pantalla pinta en un renglón. */
const TOPE_ULTIMO_ERROR = 500;

/**
 * SELLA el resultado de una prueba en la fila. Es lo que convierte «se probó»
 * en algo que la pantalla y la auditoría pueden leer mañana.
 *
 *   · Salió bien → `probada_en = ahora` y `ultimo_error = null`.
 *   · Salió mal  → `probada_en = null` y `ultimo_error = <el motivo>`.
 *
 * Que un fallo BORRE la `probada_en` anterior es deliberado y es la mitad
 * fail-closed de esto: una credencial que ayer sirvió y hoy la rechazan no
 * puede seguir diciendo «probada el 12 de agosto» — eso pintaría de verde una
 * conexión muerta, que es el modo de falla que la 0094 escribió para evitar.
 * La columna dice el estado de la ÚLTIMA prueba, no el de la mejor.
 *
 * Qué se guarda en `ultimo_error`: el `detalle` del `ResultadoPrueba`, TAL
 * CUAL. Ese detalle es una frase nuestra que ya incluye lo que contestó el
 * proveedor (su código, su mensaje de error) porque `probarConGuardas` y
 * `veredictoHttp` la arman así — y NUNCA el cuerpo crudo de la respuesta, que
 * puede traer el token. Reescribirla aquí perdería el dato accionable.
 *
 * El UPDATE comprueba las filas tocadas por la misma razón que
 * `desactivarCredencial`: con el conector de otra flota toca cero filas y
 * Postgres no lo considera un error.
 */
export async function marcarProbada(
  tenantId: string,
  conectorId: string,
  resultado: Pick<ResultadoPrueba, 'ok' | 'detalle'> & { verificadoContra?: string | null },
  actor?: { id?: string; email?: string },
): Promise<void> {
  const { data, error } = await acotada(supabaseAdmin().from('conector_credencial')
    .update(resultado.ok
      ? { probada_en: new Date().toISOString(), ultimo_error: null }
      : { probada_en: null, ultimo_error: resultado.detalle.slice(0, TOPE_ULTIMO_ERROR) })
    .eq('tenant_id', tenantId)
    .eq('conector_id', conectorId)
    .eq('activo', true)
    .select('id'), 'marcarProbada');

  if (error) throw new Error(`marcarProbada: ${error.message}`);
  if (!Array.isArray(data) || data.length === 0) {
    throw new DatoInvalido('No hay una credencial activa de ese sistema en tu flota — no se pudo sellar el resultado de la prueba. Recarga la pantalla.');
  }

  await anotar(tenantId, 'conector_credencial.probada', String((data[0] as { id: unknown }).id), {
    // La bitácora se lee del panel: van el veredicto y CONTRA QUÉ se habló,
    // nunca los valores. `verificadoContra` es el endpoint, no un secreto.
    conectorId, ok: resultado.ok, verificadoContra: resultado.verificadoContra ?? null,
  }, actor);
}

/**
 * El ciclo completo: leer la credencial guardada, llamar al proveedor DE VERDAD
 * y sellar lo que contestó.
 *
 * Vive aquí y no dentro de la server action para que se pueda probar entera sin
 * Next: la action es un envoltorio de cinco líneas. `http` se inyecta por la
 * misma razón que en `probar()` — el adaptador se ejercita sin red.
 *
 * Lo que NO hace: inventar un veredicto. Si el conector no está en el catálogo,
 * si no pide credenciales o si no hay fila activa, devuelve `ok: false` con el
 * motivo y NO toca la fila — sellar un fallo nuestro como si el proveedor
 * hubiera rechazado la credencial mandaría al cliente a regenerar un token que
 * está bien.
 */
export async function probarCredencial(
  tenantId: string,
  conectorId: string,
  actor?: { id?: string; email?: string },
  http: Http = httpReal(),
): Promise<ResultadoPrueba> {
  const conector = conectorPorId(conectorId);
  if (!conector) {
    return { ok: false, detalle: 'Ese sistema no está en el catálogo de conectores.', verificadoContra: null };
  }
  if (conector.credenciales.length === 0) {
    return {
      ok: false,
      detalle: `${conector.nombre} no pide credenciales — su camino de conexión no las usa, así que no hay nada que probar.`,
      verificadoContra: null,
    };
  }

  const valores = await leerCredencial(tenantId, conectorId);
  if (valores === null) {
    return {
      ok: false,
      detalle: `No hay una credencial activa de ${conector.nombre} en tu flota. Captúrala antes de probar.`,
      verificadoContra: null,
    };
  }

  // Aquí es donde se habla con el proveedor. `probar()` ya falla cerrado por su
  // cuenta (`probarConGuardas`): no hace falta —ni se debe— envolverlo en un
  // catch que invente un "conectado".
  const resultado = await conector.probar(valores, http);

  // SOLO SE SELLA LO QUE SEA UN VEREDICTO SOBRE LA CREDENCIAL.
  //
  // AUDITORÍA CICLO 7, c7-12 (alto): esto sellaba TODO resultado, y
  // `marcarProbada` con `ok: false` escribe `probada_en: null`. O sea que un
  // 503 de Samsara, un DNS caído o el `AbortSignal.timeout(15_000)` de una VPN
  // lenta BORRABAN `probada_en` —el único registro de que esa credencial se
  // verificó alguna vez— y pintaban el badge de la pantalla en «la última
  // prueba FALLÓ», en `var(--bad)`, como si el cliente hubiera hecho algo mal.
  // `probarConGuardas` ya devolvía el texto correcto («Un error de red NO
  // significa que la credencial sea mala») y el sello lo ignoraba,
  // contradiciendo el docstring de esta misma función tres párrafos más
  // arriba: «sellar un fallo nuestro como si el proveedor hubiera rechazado la
  // credencial mandaría al cliente a regenerar un token que está bien».
  //
  // `verificadoContra` no bastaba para separar los casos: `veredictoHttp` lo
  // llena TAMBIÉN en el 5xx, cuyo propio texto dice «esto NO dice nada sobre la
  // credencial». Por eso el veredicto se declara como dato
  // (`sobreLaCredencial`) y no se deduce de una frase. Sin veredicto la fila NO
  // se toca: `probada_en` conserva su fecha, `ultimo_error` conserva lo último
  // que sí dijo el proveedor, y el detalle del fallo se devuelve igual para que
  // la pantalla lo enseñe EN EL MOMENTO, sin convertirlo en historia.
  if (veredictoDe(resultado) === 'no_se_sabe') {
    logger.warn('conector.prueba_sin_veredicto', {
      tenant: tenantId, conectorId,
      verificadoContra: resultado.verificadoContra,
      // El `detalle` ya viene saneado por `probarConGuardas`/`veredictoHttp`:
      // nunca trae el cuerpo crudo de la respuesta ni un token.
      detalle: resultado.detalle.slice(0, 200),
    });
    return resultado;
  }

  await marcarProbada(tenantId, conectorId, resultado, actor);
  return resultado;
}

/**
 * Desactiva la credencial de un conector: `activo = false` Y el secreto se
 * DESTRUYE.
 *
 * AUDITORÍA 19 (legal, reincidente #17): antes solo apagaba `activo` y el
 * JSON cifrado se quedaba "para auditar qué acceso existió". La auditoría no
 * necesita el SECRETO: la fila (conector, fechas, actor en la bitácora) y las
 * `pistas` (últimos 4) ya dicen qué acceso existió y hasta cuándo. Conservar
 * la contraseña cifrada de un cliente después de que la revocó es retención
 * sin finalidad (LFPDPPP art. 11) y una promesa rota de /seguridad
 * («Desactivarlas desde el panel corta el acceso») — cortado a medias si el
 * día que la llave del cofre se filtre, lo revocado se vuelve a abrir. El
 * valor se pisa con un marcador (`revocada:<fecha>`, que el CHECK
 * `conector_credencial_no_en_claro` acepta y `descifrar` jamás abrirá);
 * reactivar siempre fue capturar de nuevo (`guardarCredencial` pisa el
 * cifrado), así que nada pierde un camino que existiera.
 *
 * El UPDATE va anclado a `tenant_id` Y comprueba las filas devueltas: con el
 * conector de otra flota —o uno ya desactivado— toca cero filas, y Postgres
 * no considera eso un error. Sin mirarlo, la pantalla diría "desactivada"
 * sobre una credencial que sigue viva.
 */
export async function desactivarCredencial(
  tenantId: string,
  conectorId: string,
  actor?: { id?: string; email?: string },
): Promise<void> {
  const { data, error } = await acotada(supabaseAdmin().from('conector_credencial')
    .update({ activo: false, valores_cifrados: `revocada:${new Date().toISOString()}` })
    .eq('tenant_id', tenantId)
    .eq('conector_id', conectorId)
    .eq('activo', true)
    .select('id'), 'desactivarCredencial');

  if (error) throw new Error(`desactivarCredencial: ${error.message}`);
  if (!Array.isArray(data) || data.length === 0) {
    throw new DatoInvalido('No hay una credencial activa de ese sistema en tu flota. Puede que ya estuviera desactivada — recarga la pantalla.');
  }

  await anotar(tenantId, 'conector_credencial.desactivada', String((data[0] as { id: unknown }).id), { conectorId }, actor);

  // AUDITORÍA 1, ALTO (Legal): desactivar tiene que CORTAR EL ACCESO —es lo que
  // promete `/terminos`—, y una credencial de portal puede tener una SESIÓN ya
  // iniciada guardada aparte (fila `#sesion`, `sesion_portal.ts`). Si esa sesión
  // sobrevive, el robot sigue entrando con la cookie aunque la credencial esté
  // desactivada: el acceso NO se cortó. Se apaga junto con la credencial. El
  // helper es idempotente y no lanza —la desactivación de la credencial ya
  // quedó firme—; un fallo se registra y la sesión cae igual por su vigencia.
  const { invalidarSesionPortal } = await import('../facturacion/sesion_portal');
  await invalidarSesionPortal(tenantId, conectorId);
}
