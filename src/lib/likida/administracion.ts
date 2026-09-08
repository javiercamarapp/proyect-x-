// ═══════════════════════════════════════════════════════════════════════════
// LO QUE HASTA HOY SE HACÍA CON SQL A MANO.
//
// Cuatro operaciones sostenían el alta de cualquier cliente nuevo y ninguna
// tenía pantalla: dar de alta una flota, registrar el teléfono de un operador,
// editar la política de gastos y reabrir un viaje liquidado. Mientras vivieran
// en un editor de SQL, Javier era el cuello de botella del segundo cliente —
// y cada alta era una oportunidad de teclear el tenant equivocado.
//
// TODAS ESCRIBEN EN LA BITÁCORA (0053). Son las operaciones que cambian a quién
// pertenece qué y cuánto se le permite gastar; sin rastro, un cambio de tope no
// se distingue de un error del motor tres semanas después.
//
// ESTE MÓDULO NO DECIDE PERMISOS. Los server actions que lo llaman repiten el
// chequeo de rol adentro (patrón de `dashboard/despacho/page.tsx`), porque el
// gateo de la UI solo decide si se pinta el formulario.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase/admin';
import { anotarBitacora, type EntidadBitacora } from '@/lib/likida/bitacora_escritura';
import { esRfcValido, rfcChecksumOk, esUuidValido } from './intake/cfdi';
import { validarDatosFiscales } from '@/lib/saas/fiscal';
import { variantesTelefono, acquireViajeLock, releaseViajeLock } from './conv';
import { destinatarioWhatsApp } from '@/lib/meta/client';
import { getConfig } from './config';
import { regimenElegiblePorClave } from './perfil/preguntas';
import type { PoliticaGasto } from './cuadre/engine';
import { logger } from '@/lib/logger';
import { DatoInvalido } from './errores';
import type { AjustesValidos } from './ajustes_operativos';
import { acotada } from './presupuesto';
import { resolverTerminalDeFlota } from './terminales';
import { PAPELES_UNIDAD } from './vigencias';
import { diasEntreIso } from './relojes_legales';

// `DatoInvalido` y `mensajeParaPantalla` viven en `errores.ts` desde que
// `saas/suscripcion.ts` los necesitó: importarlos de aquí metía todo este módulo
// —motor de cuadre, CFDI, cliente de Meta— en el bundle del webhook de Stripe.
// Se re-exportan para no mover los imports de las pantallas que ya los usan.
export { DatoInvalido, mensajeParaPantalla } from './errores';

/**
 * Deja constancia. Best-effort A PROPÓSITO: si la bitácora falla, el alta ya
 * ocurrió y tirarla dejaría el sistema peor —una flota a medio crear— que sin
 * el registro. El fallo se loguea para que no se pierda en silencio.
 */
/**
 * Mezcla un parcial sobre `tenant.config` en UN solo UPDATE (RPC
 * `tenant_config_merge`, 0159).
 *
 * La mezcla es PROFUNDA, igual que `fusionarConfig` (config.ts): los objetos se
 * recorren y los arrays reemplazan. Y el CHECK `tenant_config_valida` sigue
 * corriendo en ese UPDATE, así que una llave que `CuadraConfig` no conozca
 * rebota aquí en vez de guardarse para que nadie la lea.
 */
async function mezclarConfig(
  tenantId: string,
  parcial: Record<string, unknown>,
  etiqueta: string,
  borrar: string[] = [],
): Promise<{ error: Error | null }> {
  const { error } = await acotada(
    supabaseAdmin().rpc('tenant_config_merge', {
      p_tenant: tenantId,
      p_parcial: parcial,
      p_borrar: borrar,
    }),
    etiqueta,
  );
  if (!error) return { error: null };
  // CU013: la flota no existe. Es dato de entrada, no una caída.
  if ((error as { code?: string }).code === 'CU013') {
    return { error: new DatoInvalido('No se encontró tu flota. Recarga la pantalla.') };
  }
  return { error: new Error(`${etiqueta}: ${error.message}`) };
}

async function anotar(
  tenantId: string | null,
  accion: string,
  entidad: EntidadBitacora,
  entidadId: string,
  detalle?: Record<string, unknown>,
  actor?: { id?: string; email?: string },
): Promise<void> {
  await anotarBitacora({ tenantId, actor: actor ?? {}, accion, entidad, entidadId, detalle: detalle ?? null });
}

// ── 1. Dar de alta una flota ───────────────────────────────────────────────

export interface NuevaFlota {
  nombre: string;
  rfc?: string;
  ciudad?: string;
  /** Correo del primer administrador. Sin él la flota nace sin quién entre. */
  emailAdmin?: string;
  nombreAdmin?: string;
  /** WhatsApp del administrador (D5, auditoría 4): sin él, el dueño de una
   *  flota nueva no puede escribirle al bot — el matcher de oficina
   *  (`resolverCuentaOficina`) no lo reconoce. Opcional; se normaliza en
   *  `provisionarUsuario`. */
  telefonoAdmin?: string;
  /** RFA 2026 regla 2.9 (se piden AL REGISTRAR): ¿dedicación exclusiva al
   *  autotransporte terrestre de carga federal? Sin esta declaración el motor
   *  no puede abrir la facilidad del 15% de diésel en efectivo. */
  dedicacionExclusivaCarga?: boolean;
  /** RFA 2026 regla 2.9: ¿tributa en Título II Cap. VII (coordinados) o Título
   *  IV Cap. II Secc. I (PF con actividad empresarial)? — se captura como el
   *  código SAT real (c_RegimenFiscal) en `tenant.regimen_fiscal`, y la
   *  elegibilidad se DERIVA de él (los códigos 624/612 son los que califican
   *  — 601 NO entra: es Título II a secas, no Cap. VII. Ver el bloque
   *  FISC-C2-1 más abajo, donde `REGIMENES_ELEGIBLES` lo aplica). */
  regimenFiscal?: string;
  /** Razón social TAL CUAL la Constancia de Situación Fiscal. Junto con el RFC,
   *  el régimen, el CP fiscal y el uso, forma los CINCO datos que el CFDI 4.0
   *  exige del receptor — y sin los cinco, `getFiscalDeFlota` se niega a
   *  registrar la flota y NADA de esa flota se factura. */
  razonSocial?: string;
  /** CP del domicilio fiscal registrado ante el SAT. No es el de la calle donde
   *  está el patio: el PAC lo compara contra el que el SAT tiene para ese RFC. */
  codigoPostalFiscal?: string;
  /** Clave `c_UsoCFDI`. G03 (gastos en general) es lo normal para una flota. */
  usoCfdi?: string;
}

/**
 * Crea el tenant y, si se dio correo, su primer `flota_admin`.
 *
 * EL RFC SE RECHAZA AQUÍ SI ESTÁ MAL, y es la única oportunidad barata de
 * hacerlo. `getConfig()` ya detecta un RFC con dígito verificador inválido,
 * pero para entonces solo puede escribir un `logger.error` y seguir con la
 * validación de receptor APAGADA: la flota cree que el sistema comprueba a
 * nombre de quién vienen sus facturas, y no. Un dato mal tecleado el día del
 * alta se arregla en dos segundos; descubierto tres meses después, ya contaminó
 * todas las liquidaciones.
 */
export async function crearFlota(
  f: NuevaFlota,
  actor?: { id?: string; email?: string },
): Promise<{ tenantId: string; userId?: string }> {
  const nombre = f.nombre.trim();
  if (nombre.length < 3) throw new DatoInvalido('El nombre de la flota necesita al menos 3 caracteres.');

  let rfc: string | undefined;
  if (f.rfc?.trim()) {
    rfc = f.rfc.toUpperCase().replace(/[^A-ZÑ&0-9]/g, '');
    if (!esRfcValido(rfc) || !rfcChecksumOk(rfc)) {
      throw new DatoInvalido(
        `El RFC "${f.rfc}" no pasa el dígito verificador. Revísalo: con un RFC inválido, ` +
        `la validación de facturas a nombre de la flota queda apagada y ninguna se rechaza por estar a nombre de otro.`,
      );
    }
  }

  // ── LOS CINCO DEL RECEPTOR, O NINGUNO ──────────────────────────────────────
  //
  // Se validan ANTES del insert y con el MISMO validador que la pantalla de
  // datos fiscales, para que no existan dos criterios de qué es un CP bueno.
  //
  // Por qué esto entró al alta (20-ago-2026): `getFiscalDeFlota` exige los cinco
  // —RFC, razón social, régimen, CP fiscal y uso— y sin ellos devuelve `falta` y
  // la flota NO se registra para facturar. El alta solo pedía tres, así que toda
  // flota nueva nacía sin poder facturar y nada lo decía: el hueco aparecía
  // semanas después, como un cron que no hacía nada, sin un error que mirar.
  //
  // OPCIONALES A PROPÓSITO. Una flota se puede dar de alta para operar viajes y
  // capturar lo fiscal más tarde en `/dashboard/suscripcion`. Lo que ya no pasa
  // es que se capture a MEDIAS y parezca completo: o van los cinco, o va solo el
  // RFC suelto como hasta hoy.
  const fiscalCompleto = Boolean(
    f.rfc?.trim() && f.razonSocial?.trim() && f.regimenFiscal?.trim()
    && f.codigoPostalFiscal?.trim() && f.usoCfdi?.trim(),
  );
  const filaFiscal = fiscalCompleto
    ? validarDatosFiscales({
        rfc: f.rfc!, razonSocial: f.razonSocial!, regimenFiscal: f.regimenFiscal!,
        codigoPostal: f.codigoPostalFiscal!, usoCfdi: f.usoCfdi!,
      })
    : null;

  const admin = supabaseAdmin();
  // RFA 2026 regla 2.9: el régimen se captura como el código SAT REAL
  // (tenant.regimen_fiscal — la columna que la facturación ya lee) y la
  // elegibilidad se DERIVA de él. El booleano `dedicacionExclusivaCarga` se
  // guarda en la config (el otro requisito, que el alta ya pregunta).
  //
  // FISC-C2-1 (auditoría 18-c2, CRÍTICO): aquí decía `['601', '612']` con el
  // comentario «601 (General de Ley PM — coordinados)», y son dos cosas
  // distintas del catálogo `c_RegimenFiscal`. La regla admite «Título II,
  // Capítulo VII o Título IV, Capítulo II, Sección I» (ficha
  // `normas/rfa-2026-2.9.yaml`, verificada contra fuente primaria):
  //   · Título II Cap. VII = COORDINADOS (LISR 72-73)  → clave **624**
  //   · Título II a secas  = la S.A. de C.V. ordinaria → clave 601, que NO
  //     entra: para ella sigue aplicando la LISR 27-III sin excepción.
  //   · Título IV Cap. II Secc. I = PF con act. empresarial → clave 612. ✔
  // Se falla cerrado a propósito: conceder de más imprime en el PDF, citando el
  // artículo, una deducción que la norma niega.
  //
  // 624 entra en `REGIMENES` y en el CHECK (mig. 0170). Un coordinado ya puede
  // declararse; la facilidad del 15% deja de ser solo para PF 612.
  // AUDITORÍA 29, FIS-C1: la lista vivía como literal local aquí, y por eso el
  // ESCRITOR de `/admin/flotas` podía contradecirla sin que nada lo notara.
  // Ahora la derivación es una sola (`perfil/preguntas.ts`) y la comparten el
  // alta —que deriva— y `actualizarFacilidad15` —que coteja—.
  const regimenElegible = regimenElegiblePorClave(f.regimenFiscal);
  const facilidad15 = (typeof f.dedicacionExclusivaCarga === 'boolean' && regimenElegible !== undefined)
    ? {
        facilidadCombustibleEfectivo: {
          dedicacionExclusivaCarga: f.dedicacionExclusivaCarga,
          regimenElegible,
        },
      }
    : undefined;
  const { data, error } = await admin
    .from('tenant')
    .insert({
      nombre, rfc: rfc ?? null, ciudad: f.ciudad?.trim() || null,
      regimen_fiscal: f.regimenFiscal ?? null,
      ...(facilidad15 ? { config: facilidad15 } : {}),
      // Va al final para que gane: `filaFiscal` trae el RFC y el régimen ya
      // normalizados por el mismo validador que usa la pantalla fiscal.
      ...(filaFiscal ?? {}),
    })
    .select('id')
    .maybeSingle();

  if (error) {
    // El nombre no es único por constraint, pero un duplicado exacto casi
    // siempre es un doble clic, no dos flotas que se llaman igual.
    throw new Error(`crearFlota: ${error.message}`);
  }
  const tenantId = data?.id as string | undefined;
  if (!tenantId) throw new Error('crearFlota: el insert no devolvió id');

  await anotar(tenantId, 'flota.creada', 'tenant', tenantId, { nombre, rfc: rfc ?? null }, actor);

  let userId: string | undefined;
  if (f.emailAdmin?.trim()) {
    const { provisionarUsuario } = await import('@/lib/auth/provisionar');
    const r = await provisionarUsuario(tenantId, f.emailAdmin.trim().toLowerCase(), f.nombreAdmin, 'flota_admin', f.telefonoAdmin);
    userId = r.userId;
    await anotar(tenantId, 'usuario.provisionado', 'app_user', userId, { rol: 'flota_admin' }, actor);
  }

  return { tenantId, userId };
}

// ── 2. Registrar un operador ───────────────────────────────────────────────

export interface NuevoOperador {
  nombre: string;
  telefono: string;
  numeroEmpleado?: string;
  licencia?: string;
  licenciaTipo?: string;
  /** ISO `AAAA-MM-DD`. */
  licenciaVence?: string;
  /** RFC del trabajador (0080, RLISR 57). Opcional; si viene, pasa el dígito
   *  verificador como en `actualizarOperador`. */
  rfc?: string;
  /** Patio al que pertenece (columna de la 0001, sin escritor hasta la
   *  0298). `undefined`/`''` = sin patio. Se comprueba que sea de la flota. */
  terminalId?: string | null;
}

/**
 * De lo tecleado al teléfono que se guarda: E.164 de México SIN el «+» y SIN
 * el «1» de Telmex que Meta agrega al entregar y rechaza al enviar
 * (`52` + 10 dígitos, la forma que `destinatarioWhatsApp` produce).
 *
 * PURA y exportada: la usan el alta unitaria, la edición (FE-4) y el
 * importador masivo, y los tres tienen que coincidir letra por letra — un
 * número que el alta acepta y la edición rechaza es un chofer al que nadie
 * puede corregirle el celular.
 *
 * SOLO MÉXICO, a propósito (auditoría 24, ADM-2/FE-4): el bot es un número
 * mexicano y `resolveOperador` casa por las variantes de `variantesTelefono`,
 * que son todas mexicanas. Un número de otro país entraría a la base con una
 * forma que ninguna variante genera, y ese chofer escribiría al bot para
 * recibir «no te tengo registrado» con su ticket en la mano.
 */
export function normalizarTelefonoOperador(crudo: string): string {
  const soloDigitos = (crudo ?? '').replace(/[^\d]/g, '');
  if (soloDigitos.length < 10) {
    throw new DatoInvalido(`El teléfono "${crudo}" tiene ${soloDigitos.length} dígitos; un número mexicano necesita 10 más la lada 52.`);
  }
  // 10 dígitos sueltos = número nacional sin lada: se le antepone 52. Con más,
  // se respeta lo tecleado y solo se quita el "1" que Meta ya no usa al enviar.
  const telefono = destinatarioWhatsApp(soloDigitos.length === 10 ? `52${soloDigitos}` : soloDigitos);
  if (!/^52\d{10}$/.test(telefono)) {
    throw new DatoInvalido(
      `El teléfono "${crudo}" no es un celular mexicano (lada 52 + 10 dígitos). ` +
      'Captúralo como 10 dígitos, o como 52 seguido de los 10 dígitos.',
    );
  }
  return telefono;
}

/**
 * Comprueba que el teléfono esté LIBRE antes de escribirlo, y lo dice en
 * palabras de quien captura. Lanza `DatoInvalido`; falla CERRADO si no pudo
 * leer (sin poder comprobar el duplicado NO se escribe).
 *
 * ── CONTRA TODAS LAS FLOTAS, no solo contra ésta ──────────────────────────
 * `resolveOperador()` busca por teléfono SIN filtrar por tenant. Si dos
 * flotas registran el mismo número, la resolución devuelve una fila
 * arbitraria y con ella se decide el `tenant_id` con el que se escriben el
 * gasto y la liquidación — dinero de una flota anotado en la de otra, y en
 * silencio. El propio `conv.ts` lo advierte; aquí es donde se puede impedir.
 *
 * ── SOLO LOS ACTIVOS BLOQUEAN entre flotas (auditoría 20, H2) ─────────────
 * `uq_operador_telefono_activo` (0024) es `where activo`: un operador dado de
 * baja en la flota A puede reaparecer en la flota B — rotación normal. Lo que
 * NO se relaja: dos filas ACTIVAS del mismo número siguen prohibidas.
 *
 * ── Y EN LA MISMA FLOTA, TODAS (activas o no) ─────────────────────────────
 * `uq_operador_tenant_telefono_norm` (0024) es por tenant sobre todas las
 * filas: la misma flota no tiene dos fichas del mismo número. Al chofer que
 * vuelve se le reactiva su ficha, no se le abre otra.
 *
 * `excluirOperadorId` es para la EDICIÓN (FE-4): la ficha que se está
 * corrigiendo no choca consigo misma.
 */
export async function comprobarTelefonoLibre(
  tenantId: string,
  telefono: string,
  excluirOperadorId?: string,
): Promise<void> {
  const admin = supabaseAdmin();
  const { data: choque, error: errBusca } = await admin
    .from('operador')
    .select('id, tenant_id, nombre, activo')
    .in('telefono', variantesTelefono(telefono))
    // `limit(20)` y no 2: con el filtro de activo hecho aquí, dos filas de baja
    // podían llenar el cupo y esconder a la activa que sí choca.
    .limit(20);

  if (errBusca) throw new Error(`comprobarTelefonoLibre: no se pudo comprobar el teléfono — ${errBusca.message}`);

  const filas = ((choque ?? []) as Array<{ id: string; tenant_id: string; nombre: string; activo: boolean }>)
    .filter((c) => !excluirOperadorId || c.id !== excluirOperadorId);
  const yaActivo = filas.find((c) => c.activo);
  if (yaActivo) {
    throw new DatoInvalido(
      yaActivo.tenant_id === tenantId
        ? `Ese teléfono ya está registrado en esta flota, a nombre de ${yaActivo.nombre}.`
        : `Ese teléfono ya está registrado en OTRA flota. Dos operadores con el mismo número harían que sus comprobantes se anoten en la flota equivocada.`,
    );
  }
  const propioDeBaja = filas.find((c) => c.tenant_id === tenantId);
  if (propioDeBaja) {
    throw new DatoInvalido(
      `Ese teléfono es de ${propioDeBaja.nombre}, que está dado de baja en tu flota. Si volvió a trabajar contigo, vuelve a marcarlo como activo en Operadores en vez de darlo de alta otra vez — así conserva su historial de viajes.`,
    );
  }
}

/** El RFC del operador como se guarda, o `null` si vino vacío. Lanza si no
 *  pasa el dígito verificador: mejor rechazarlo en la captura, que es la
 *  oportunidad barata, que en `engine.ts` (RLISR 57) tres semanas después. */
export function normalizarRfcOperador(crudo: string | null | undefined): string | null {
  const t = (crudo ?? '').trim();
  if (!t) return null;
  const rfc = t.toUpperCase().replace(/[^A-ZÑ&0-9]/g, '');
  if (!esRfcValido(rfc) || !rfcChecksumOk(rfc)) {
    throw new DatoInvalido(`El RFC "${crudo}" no pasa el dígito verificador. Revísalo antes de guardar.`);
  }
  return rfc;
}

/** Una fecha de licencia ISO, o `null` si vino vacía. Una fecha que no se
 *  pueda interpretar se guardaría vencida o vigente sin serlo. */
export function normalizarFechaLicencia(crudo: string | null | undefined): string | null {
  const v = (crudo ?? '').trim();
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw new DatoInvalido(`"${crudo}" no es una fecha válida (AAAA-MM-DD).`);
  }
  return v;
}

/**
 * Registra un operador y su teléfono de WhatsApp.
 *
 * Se guarda en la forma que Meta usa para ENVIAR (`52` + 10 dígitos, sin el 1),
 * que es la que `destinatarioWhatsApp` produce. La lectura sigue aceptando
 * todas las variantes. La comprobación de duplicado (entre flotas y dentro de
 * la propia) vive en `comprobarTelefonoLibre`, compartida con la edición y
 * con el importador masivo.
 *
 * EL AVISO DE PRIVACIDAD NO SE MANDA AQUÍ, y no es un olvido: Likida no puede
 * iniciar una conversación de WhatsApp con quien nunca le ha escrito (fuera de
 * la ventana de 24 h Meta solo entrega plantillas aprobadas, y no hay una del
 * aviso). El aviso se entrega en el PRIMER mensaje del chofer, antes de tratar
 * nada (`ponerAvisoADisposicion`, processor.ts) — la fila nace con
 * `aviso_privacidad_en = NULL` y el registro lo enseña como «aviso pendiente».
 */
export async function crearOperador(
  tenantId: string,
  o: NuevoOperador,
  actor?: { id?: string; email?: string },
): Promise<string> {
  const nombre = o.nombre.trim();
  if (nombre.length < 3) throw new DatoInvalido('El nombre del operador necesita al menos 3 caracteres.');

  const telefono = normalizarTelefonoOperador(o.telefono);
  const rfc = normalizarRfcOperador(o.rfc);
  const licenciaVence = normalizarFechaLicencia(o.licenciaVence);
  // Se resuelve ANTES de comprobar el teléfono para no gastar la consulta de
  // duplicados en una fila que va a rebotar por el patio.
  const terminalId = await resolverTerminalDeFlota(tenantId, o.terminalId);

  await comprobarTelefonoLibre(tenantId, telefono);

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from('operador')
    .insert({
      tenant_id: tenantId,
      nombre,
      telefono,
      numero_empleado: o.numeroEmpleado?.trim() || null,
      licencia: o.licencia?.trim() || null,
      licencia_tipo: o.licenciaTipo?.trim() || null,
      licencia_vence: licenciaVence,
      ...(rfc !== null ? { rfc } : {}),
      ...(terminalId !== null ? { terminal_id: terminalId } : {}),
    })
    .select('id')
    .maybeSingle();

  if (error) throw new Error(`crearOperador: ${error.message}`);
  const id = data?.id as string | undefined;
  if (!id) throw new Error('crearOperador: el insert no devolvió id');

  await anotar(tenantId, 'operador.creado', 'operador', id, { nombre, telefono }, actor);
  return id;
}

/** Lo que la pantalla deja editar de un operador ya dado de alta. `undefined`
 *  en cualquier llave = "no se tocó" (no se manda al `update`); `null` o `''`
 *  en las que lo aceptan = "bórralo". */
export interface CambiosOperador {
  nombre?: string;
  /**
   * EL TELÉFONO DE WHATSAPP (auditoría 24, FE-4). Es la identidad del chofer
   * para el bot: todo el flujo cuelga de él. Con cientos de choferes cambian
   * de número cada semana, y hasta hoy la única salida era dar de baja y dar
   * de alta otro operador — partiendo su historial y chocando con
   * `uq_operador_telefono_activo` si el número viejo seguía activo.
   *
   * Pasa por la MISMA normalización (lada 52, sin el 1) y la MISMA
   * comprobación de duplicado entre flotas que el alta (`comprobarTelefonoLibre`,
   * excluyendo la propia ficha). No admite vacío: `operador.telefono` es
   * NOT NULL y un chofer sin teléfono es un chofer al que el bot no puede
   * atender — se dice, no se guarda.
   */
  telefono?: string;
  /** Patio (0298). `null`/`''` = sin patio. Se comprueba que sea de la flota. */
  terminalId?: string | null;
  numeroEmpleado?: string | null;
  licencia?: string | null;
  licenciaTipo?: string | null;
  /** ISO `AAAA-MM-DD`, o `null`/`''` para borrarla. */
  licenciaVence?: string | null;
  /** RFC del trabajador (migración 0080, RLISR 57). */
  rfc?: string | null;
  /**
   * LA BAJA DEL CHOFER (auditoría 20, H2). `false` = renunció o lo corrieron.
   *
   * No es un campo cosmético, es el interruptor del que cuelga TODO el efecto
   * en cascada, y por eso vive aquí y no en una función aparte:
   *  · `resolveOperador` (conv.ts) busca `.eq('activo', true)` — el bot de
   *    WhatsApp deja de contestarle como operador de la flota en el turno
   *    siguiente. El medio arco de privacidad SÍ le sigue respondiendo
   *    (processor.ts, auditoría 12): quien se fue es justo quien ejerce
   *    cancelación, y ese camino busca el tenant sin el filtro de activo.
   *  · `buscarCatalogo` (repo.ts) filtra `.eq('activo', true)` — desaparece de
   *    los combos de despacho, y `crearViaje`/`reasignarOperador` lo rechazan
   *    también del lado del servidor (un POST directo no lo revive).
   *  · `uq_operador_telefono_activo` (0024) es parcial `where activo`, así que
   *    su teléfono queda LIBRE para que otra flota lo contrate — que es
   *    exactamente para lo que ese índice se diseñó parcial.
   *
   * Nunca se BORRA la fila: el historial de viajes, gastos y liquidaciones de
   * ese chofer es documentación fiscal y laboral que la flota tiene que poder
   * enseñar años después.
   */
  activo?: boolean;
}

/**
 * Corrige los datos de un operador ya existente — la puerta que faltaba
 * (auditoría 2): un chofer con la licencia mal tecleada o sin RFC se quedaba
 * así para siempre, porque `operadores/vista.tsx` solo listaba.
 *
 * ANCLADO A `tenant_id` EN EL WHERE Y COMPROBADO CON `.select('id')` DESPUÉS,
 * igual que `editarCliente` (clientes.ts): con el id de un operador de OTRA
 * flota, un `.update().eq('id', ...)` sin el `.eq('tenant_id', ...)` lo
 * editaría igual — y CON el tenant en el where pero SIN mirar cuántas filas
 * tocó, Postgres no marca error: el update de cero filas y el de una se ven
 * idénticos, y la pantalla diría "guardado" sobre un cambio que nunca ocurrió.
 * Es el mismo `fallar cerrado y decirlo` que ya cuesta este archivo entero.
 */
export async function actualizarOperador(
  tenantId: string,
  operadorId: string,
  cambios: CambiosOperador,
  actor?: { id?: string; email?: string },
): Promise<void> {
  if (!esUuidValido(operadorId)) {
    throw new DatoInvalido('No se reconoce ese operador. Vuelve a abrir la pantalla.');
  }

  const fila: Record<string, unknown> = {};

  if (cambios.nombre !== undefined) {
    const nombre = cambios.nombre.trim();
    if (nombre.length < 3) throw new DatoInvalido('El nombre del operador necesita al menos 3 caracteres.');
    fila.nombre = nombre;
  }

  if (cambios.numeroEmpleado !== undefined) {
    fila.numero_empleado = cambios.numeroEmpleado?.trim() || null;
  }

  if (cambios.licencia !== undefined) {
    fila.licencia = cambios.licencia?.trim() || null;
  }

  if (cambios.licenciaTipo !== undefined) {
    fila.licencia_tipo = cambios.licenciaTipo?.trim() || null;
  }

  if (cambios.licenciaVence !== undefined) {
    const v = cambios.licenciaVence?.trim();
    if (!v) {
      fila.licencia_vence = null;
    } else {
      // Mismo criterio que `operador.licencia_vence` (0053): una fecha que no
      // se pueda interpretar tal cual se guardaría vencida o vigente sin
      // serlo — ninguna de las dos es honesta si lo tecleado no es una fecha.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
        throw new DatoInvalido(`"${cambios.licenciaVence}" no es una fecha válida (AAAA-MM-DD).`);
      }
      fila.licencia_vence = v;
    }
  }

  if (cambios.rfc !== undefined) {
    // Mismo candado que `crearFlota`: un RFC con el dígito verificador mal
    // no truena aquí, pero sí más adelante en `engine.ts` (RLISR 57) — mejor
    // rechazarlo en la captura, que es la oportunidad barata de corregirlo.
    fila.rfc = normalizarRfcOperador(cambios.rfc);
  }

  if (cambios.activo !== undefined) {
    fila.activo = cambios.activo;
  }

  // FE-4: el teléfono se normaliza aquí y se comprueba contra la base ABAJO,
  // ya con el `admin` en mano — el orden importa para que un teléfono mal
  // tecleado rebote antes de cualquier consulta.
  let telefonoNuevo: string | null = null;
  if (cambios.telefono !== undefined) {
    telefonoNuevo = normalizarTelefonoOperador(cambios.telefono);
    fila.telefono = telefonoNuevo;
  }

  if (cambios.terminalId !== undefined) {
    fila.terminal_id = await resolverTerminalDeFlota(tenantId, cambios.terminalId);
  }

  if (Object.keys(fila).length === 0) {
    throw new DatoInvalido('No hay ningún cambio que guardar.');
  }

  const admin = supabaseAdmin();

  // ── EL TELÉFONO ANTERIOR, para saber si de verdad cambió (FE-4) ──────────
  // La forma manda el teléfono en CADA guardado (es un reemplazo de fila, no
  // un parche): sin leer el anterior, toda corrección de licencia pasaría por
  // la comprobación de duplicados y quedaría anotada como cambio de número.
  // Si no se pudo leer, se comprueba igual (fallar cerrado): un duplicado que
  // se cuela porque la lectura previa falló es justo lo que esta puerta evita.
  let telefonoAntes: string | null = null;
  if (telefonoNuevo !== null) {
    const { data: previoTel, error: errTel } = await admin
      .from('operador')
      .select('telefono')
      .eq('id', operadorId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (errTel) {
      logger.warn('operador.telefono_previo_ilegible', { tenantId, operadorId, err: errTel.message });
    } else {
      const v = (previoTel as { telefono?: unknown } | null)?.telefono;
      telefonoAntes = typeof v === 'string' ? destinatarioWhatsApp(v) : null;
    }
    if (telefonoAntes === telefonoNuevo) {
      delete fila.telefono;
      telefonoNuevo = null;
    } else {
      await comprobarTelefonoLibre(tenantId, telefonoNuevo, operadorId);
    }
  }

  // ── QUÉ ERA ANTES, para que la bitácora diga la verdad ────────────────────
  // La forma manda `activo` en CADA guardado (es un checkbox, no un parche),
  // así que sin leer el valor anterior toda corrección de licencia quedaría
  // anotada como "reactivado". Se lee SOLO cuando la baja está en juego: es la
  // única acción de esta pantalla que un abogado laboral puede querer fechar.
  //
  // "NO PUDE PREGUNTAR" NO ES "ERA DISTINTO" (revisión de Fable, 29-ago-2026).
  // El `error` del destructure se descartaba, así que un bache transitorio de
  // Supabase dejaba `previo = null` y de ahí el código concluía "cambió el
  // alta" — un guardado rutinario de licencia se anotaba como
  // `operador.reactivado`. Nunca escondía una baja real, pero ensuciaba con
  // reactivaciones inventadas justo el registro que existe para reconstruir
  // quién movió el alta de quién. Ante la duda se cae al nombre que no afirma
  // nada (`operador.editado`) y se deja dicho POR QUÉ en el detalle: el UPDATE
  // sigue adelante, porque la baja que el usuario pidió sí tiene que ocurrir.
  let activoAntes: boolean | null = null;
  let previaLeida = true;
  if (cambios.activo !== undefined) {
    const { data: previo, error: errPrevio } = await admin
      .from('operador')
      .select('activo')
      .eq('id', operadorId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (errPrevio) {
      previaLeida = false;
      logger.warn('operador.alta_previa_ilegible', { tenantId, operadorId, err: errPrevio.message });
    } else {
      const v = (previo as { activo?: unknown } | null)?.activo;
      activoAntes = typeof v === 'boolean' ? v : null;
    }
  }

  const { data, error } = await admin
    .from('operador')
    .update(fila)
    .eq('id', operadorId)
    .eq('tenant_id', tenantId) // el tenant SIEMPRE en el where: ver comentario de arriba
    .select('id');

  if (error) throw new Error(`actualizarOperador: ${error.message}`);
  if (!Array.isArray(data) || data.length === 0) {
    throw new DatoInvalido('No se encontró ese operador en tu flota. Puede que alguien lo haya borrado — recarga la pantalla.');
  }

  // La baja y la reactivación se anotan CON SU PROPIO NOMBRE, no escondidas
  // dentro de un `operador.editado` cuyo detalle nadie lee: son las dos únicas
  // acciones de esta pantalla que cortan (o devuelven) el acceso de una
  // persona al canal de WhatsApp de la flota. `quién` y `cuándo` los pone
  // `anotarBitacora` con el actor y el `creado_en` de la tabla.
  const cambioDeAlta = previaLeida && cambios.activo !== undefined && activoAntes !== cambios.activo;
  const accion = !cambioDeAlta
    ? 'operador.editado'
    : cambios.activo ? 'operador.reactivado' : 'operador.baja';

  // Cuando la lectura previa falló, el detalle lo dice: el `activo` que se
  // escribió sigue ahí (la fila entera va en `detalle`), y quien lea la
  // bitácora sabe que el NOMBRE de la acción se quedó corto por una consulta
  // caída, no porque el alta no se hubiera movido.
  const detalle = previaLeida ? fila : { ...fila, alta_previa_ilegible: true };

  await anotar(tenantId, accion, 'operador', operadorId, detalle, actor);

  // El cambio de número lleva SU PROPIA línea (FE-4): es el acto que mueve la
  // identidad del chofer ante el bot, y «¿desde cuándo este chofer escribe
  // desde otro celular?» es la pregunta que un huérfano «Sin nombre» de la
  // semana pasada va a hacerle a esta bitácora.
  if (telefonoNuevo !== null) {
    await anotar(tenantId, 'operador.telefono_cambiado', 'operador', operadorId,
      { de: telefonoAntes, a: telefonoNuevo }, actor);
  }
}


// ── 2b. El registro de operadores, paginado en SQL (auditoría 24) ──────────

export interface FilaRegistroOperador {
  operadorId: string;
  nombre: string;
  telefono: string | null;
  numeroEmpleado: string | null;
  rfc: string | null;
  activo: boolean;
  viajes: number;
  licencia: string | null;
  licenciaTipo: string | null;
  /** ISO AAAA-MM-DD, o null = NO CAPTURADA (≠ vencida). */
  licenciaVence: string | null;
  terminalId: string | null;
  terminalNombre: string | null;
  /** `null` = el aviso de privacidad todavía no se le ha puesto a disposición
   *  (se entrega en su primer mensaje al bot, LFPDPPP 16-II). */
  avisoPrivacidadEn: string | null;
}

export interface PaginaOperadores {
  filas: FilaRegistroOperador[];
  /** Cuántos operadores hay EN TOTAL con el filtro puesto — un count real de
   *  la base, no el largo de una lista topada. */
  total: number;
  pagina: number;
  paginas: number;
  q: string;
}

export interface ConteosOperadores {
  total: number;
  activos: number;
  sinTelefono: number;
  avisoPendiente: number;
  licenciasVencidas: number;
  licenciasPorVencer: number;
}

/** Filas por página del registro. */
export const OPERADORES_POR_PAGINA = 25;
/** Tope del texto de búsqueda — nadie busca un nombre de 80 letras. */
export const MAX_BUSQUEDA_OPERADORES = 80;

function esNumero(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }
function textoONull(v: unknown): string | null { return typeof v === 'string' && v !== '' ? v : null; }

/**
 * Una página del registro (`operadores_registro_tenant`, 0298): la base corta
 * la página sobre un orden TOTAL y devuelve el `total` en la misma respuesta.
 * A cientos de choferes, el catálogo entero ya no viaja a la pantalla.
 *
 * FALLA CERRADO: un error de lectura LANZA. La página lo atrapa y pinta la
 * sección caída diciéndolo — media lista se ve igual que la lista entera.
 */
export async function getOperadoresRegistro(
  tenantId: string,
  opciones: { q?: string; pagina?: number; porPagina?: number } = {},
): Promise<PaginaOperadores> {
  const porPagina = Math.max(1, Math.min(200, opciones.porPagina ?? OPERADORES_POR_PAGINA));
  const q = (opciones.q ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_BUSQUEDA_OPERADORES);
  // `%` y `_` son comodines del LIKE del lado de la base: se escapan para que
  // buscar «100%» busque eso y no «todo».
  const qSql = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  const pedida = Number.isInteger(opciones.pagina) && (opciones.pagina as number) >= 1 ? (opciones.pagina as number) : 1;

  const leer = async (pagina: number) => {
    const { data, error } = await acotada(supabaseAdmin().rpc('operadores_registro_tenant', {
      p_tenant: tenantId, p_q: qSql || null, p_desde: (pagina - 1) * porPagina, p_limite: porPagina,
    }), 'operadores_registro_tenant');
    if (error) throw new Error(`getOperadoresRegistro: ${error.message}`);
    const r = data as { total?: unknown; filas?: unknown } | null;
    if (!r || !esNumero(r.total) || !Array.isArray(r.filas)) {
      throw new Error('getOperadoresRegistro: operadores_registro_tenant devolvió otra forma (¿migración 0298 sin aplicar?)');
    }
    return { total: r.total, filas: r.filas as Array<Record<string, unknown>> };
  };

  let pagina = pedida;
  let r = await leer(pagina);
  const paginas = Math.max(1, Math.ceil(r.total / porPagina));
  // Un `?p=` más allá del final (un link viejo) cae a la última página real.
  if (pagina > paginas) { pagina = paginas; r = await leer(pagina); }

  const filas: FilaRegistroOperador[] = r.filas.map((f) => ({
    operadorId: String(f.operadorId),
    nombre: String(f.nombre),
    telefono: textoONull(f.telefono),
    numeroEmpleado: textoONull(f.numeroEmpleado),
    rfc: textoONull(f.rfc),
    activo: Boolean(f.activo),
    viajes: esNumero(f.viajes) ? f.viajes : Number(f.viajes ?? 0),
    licencia: textoONull(f.licencia),
    licenciaTipo: textoONull(f.licenciaTipo),
    licenciaVence: textoONull(f.licenciaVence),
    terminalId: textoONull(f.terminalId),
    terminalNombre: textoONull(f.terminalNombre),
    avisoPrivacidadEn: textoONull(f.avisoPrivacidadEn),
  }));
  return { filas, total: r.total, pagina, paginas, q };
}

/**
 * Los KPIs del registro sobre la FLOTA ENTERA (`operadores_conteos_tenant`,
 * 0298), con el día de México que manda la página. `null` = no se pudo
 * contar; la vista pinta «—» y lo dice, nunca un 0 que se lea como medición.
 */
export async function getOperadoresConteos(tenantId: string, hoyMx: string, diasAviso: number): Promise<ConteosOperadores | null> {
  const { data, error } = await acotada(supabaseAdmin().rpc('operadores_conteos_tenant', {
    p_tenant: tenantId, p_hoy: hoyMx, p_dias_aviso: diasAviso,
  }), 'operadores_conteos_tenant');
  if (error) {
    logger.warn('getOperadoresConteos', { tenantId, err: error.message });
    return null;
  }
  const r = data as Record<string, unknown> | null;
  const llaves: Array<keyof ConteosOperadores> = ['total', 'activos', 'sinTelefono', 'avisoPendiente', 'licenciasVencidas', 'licenciasPorVencer'];
  const salida = {} as ConteosOperadores;
  for (const k of llaves) {
    const v = r?.[k];
    const n = typeof v === 'string' ? Number(v) : v;
    if (!esNumero(n)) {
      logger.warn('getOperadoresConteos.forma', { tenantId, llave: k });
      return null;
    }
    salida[k] = n;
  }
  return salida;
}

// ── 3. Editar la política de gastos ────────────────────────────────────────

/**
 * Guarda la política de la flota en `tenant.config.politica`.
 *
 * LEE-MODIFICA-ESCRIBE sobre `config`, nunca `update({config: {politica}})`.
 * `config` es un jsonb con MÁS cosas dentro (estímulos, hidrocarburos,
 * validación); escribir el objeto entero con solo la política se lleva por
 * delante los topes fiscales, y el motor los lee con `if (x != null)` — así que
 * no truena: se SALTA el bloque. Es exactamente el bug que documenta
 * `fusionarConfig`, y su modo de fallo es una liquidación que declara todo
 * deducible sin un solo error en el log.
 *
 * `politica_gasto` (la tabla) está muerta desde hace tiempo. La política viva es
 * ésta.
 */
export async function guardarPolitica(
  tenantId: string,
  politica: PoliticaGasto[],
  actor?: { id?: string; email?: string },
): Promise<void> {
  if (!Array.isArray(politica)) throw new DatoInvalido('La política tiene que ser una lista de conceptos.');

  for (const p of politica) {
    if (!p.concepto?.trim()) throw new DatoInvalido('Hay un renglón de la política sin concepto.');
    if (p.topeMonto != null) {
      if (!Number.isFinite(p.topeMonto) || p.topeMonto < 0) {
        throw new DatoInvalido(`El tope de "${p.concepto}" tiene que ser un número mayor o igual a 0.`);
      }
      // Un tope de 0 es una decisión válida (no se permite el concepto), pero
      // se distingue de "sin tope", que es `undefined`. Escribir 0 creyendo que
      // es "sin límite" prohibiría el gasto entero.
    }
  }

  // La mezcla ocurre DENTRO del UPDATE (`tenant_config_merge`, 0159). El
  // lee-modifica-escribe de antes conservaba los hermanos de `config` —eso ya
  // estaba arreglado— pero contra el `config` que se leyó, no contra el que hay
  // al escribir: dos ediciones simultáneas y la de en medio desaparece sin
  // ruido. En `tenant.config` viven los topes fiscales, así que perder una
  // mezcla no es perder una preferencia (DAT-20).
  const { error } = await mezclarConfig(tenantId, { politica }, 'guardarPolitica');
  if (error) throw error;

  await anotar(tenantId, 'politica.editada', 'tenant', tenantId, { conceptos: politica.length }, actor);
}

/**
 * Guarda los ajustes OPERATIVOS de la flota (tabulador, catálogo de cuentas y
 * formato de salida) en `tenant.config`.
 *
 * Mismo LEE-MODIFICA-ESCRIBE que `guardarPolitica`, y por la misma razón: el
 * `config` es un jsonb con los topes fiscales adentro (estímulos,
 * hidrocarburos, validación). Escribirlo entero con solo estas tres llaves se
 * los lleva por delante, y el motor los lee con `if (x != null)` — así que no
 * truena: se SALTA el bloque, y la liquidación sale declarando todo deducible
 * sin un solo error en el log.
 *
 * Lo que este módulo NO deja tocar está documentado en `ajustes_operativos.ts`:
 * el corte entre "parámetros del negocio" y "parámetros de la ley" es legal,
 * no de interfaz. Aquí solo se escriben las tres llaves de negocio, y eso es
 * estructural — `validarAjustes` no puede devolver ninguna otra.
 *
 * VA A LA BITÁCORA porque cambia la aritmética de TODA liquidación futura: sin
 * rastro, un rendimiento que alguien bajó de 3.0 a 2.4 se ve idéntico a un
 * error del motor tres semanas después.
 */
export async function guardarAjustesOperativos(
  tenantId: string,
  ajustes: AjustesValidos,
  actor?: { id?: string; email?: string },
): Promise<void> {
  // Mismo motivo que en `guardarPolitica`: la mezcla la hace la base en un solo
  // UPDATE, así que dos pantallas guardando a la vez ya no se pisan (DAT-20).
  const { error } = await mezclarConfig(tenantId, {
    tabulador: ajustes.tabulador,
    catalogoCuentas: ajustes.catalogoCuentas,
    salida: ajustes.salida,
  }, 'guardarAjustesOperativos');
  if (error) throw error;

  // El detalle guarda los VALORES, no solo "se editó": el para qué de la
  // bitácora aquí es poder contestar "¿con qué rendimiento se cuadró el viaje
  // de marzo?" cuando el número de hoy ya es otro.
  await anotar(tenantId, 'ajustes.editados', 'tenant', tenantId, {
    tabulador: ajustes.tabulador,
    salida: ajustes.salida,
    cuentas: Object.keys(ajustes.catalogoCuentas).length,
  }, actor);
}

// ── Las OTRAS razones sociales de la flota (auditoría 20, hallazgo 7) ──────
//
// `config.empresa.rfcsAdicionales` se CONSUMÍA (el motor de cuadre acepta un
// CFDI cuyo receptor sea cualquiera de esos RFC — `engine.ts:365` vía
// `desde_db.ts:146`) y se MOSTRABA (`/dashboard/configuracion:131`, "También
// se aceptan: …"), pero NADA en `src/` lo escribía: la única forma de
// declararlo era un UPDATE a mano sobre `tenant.config`.
//
// El escenario es corriente en autotransporte: la flota factura con dos
// razones sociales (la de los camiones y la del arrendamiento, o la vieja y
// la nueva tras una reestructura). Los CFDI timbrados al segundo RFC salían
// "a revisar" en cada liquidación y no había pantalla donde decirlo.

/** Cuántas razones sociales adicionales se admiten. No es una limitación
 *  técnica: es que a partir de ahí lo que hay no es "una flota con dos
 *  razones sociales" sino un grupo, y eso son varios tenants. */
export const MAX_RFCS_ADICIONALES = 10;

/**
 * De lo tecleado (uno por línea o separados por coma) al arreglo que se
 * guarda: mayúsculas, sin repetidos y sin el RFC principal.
 *
 * PURA y exportada para poder probarla: cada rechazo de aquí es un CFDI que
 * el motor va a dejar de aceptar (o a aceptar de más), así que el RFC pasa
 * por el MISMO doble filtro que en el alta de flota y en el de clientes —
 * forma (`esRfcValido`) y dígito verificador (`rfcChecksumOk`)—. Un RFC con
 * un dígito mal no rebota en ningún lado: simplemente no empata nunca con el
 * receptor de un CFDI, y el contador se queda buscando por qué su segunda
 * razón social sigue "a revisar".
 *
 * Vacío es una respuesta válida: significa "esta flota factura con un solo
 * RFC", y guardarlo BORRA los que hubiera. Por eso la pantalla lo dice antes
 * de que alguien vacíe el campo sin querer.
 */
export function parsearRfcsAdicionales(crudo: string, rfcPrincipal: string): string[] {
  const principal = rfcPrincipal.trim().toUpperCase();
  const salida: string[] = [];

  for (const trozo of crudo.split(/[\n,;]/)) {
    const rfc = trozo.trim().toUpperCase();
    if (rfc === '') continue;
    if (!esRfcValido(rfc)) {
      throw new DatoInvalido(`"${rfc}" no tiene forma de RFC (12 o 13 caracteres, como AAA010101AAA).`);
    }
    if (!rfcChecksumOk(rfc)) {
      throw new DatoInvalido(`El RFC "${rfc}" no pasa el dígito verificador — revísalo contra la Constancia de Situación Fiscal.`);
    }
    if (rfc === principal) {
      // Silenciarlo lo dejaría duplicado en la lista de aceptados, que no
      // rompe nada pero le enseña al contador un RFC de más y le hace dudar.
      throw new DatoInvalido(`"${rfc}" ya es el RFC principal de la flota; aquí van SOLO las otras razones sociales.`);
    }
    if (salida.includes(rfc)) {
      throw new DatoInvalido(`"${rfc}" está repetido.`);
    }
    salida.push(rfc);
  }

  if (salida.length > MAX_RFCS_ADICIONALES) {
    throw new DatoInvalido(`Son ${salida.length} RFC y el máximo aquí es ${MAX_RFCS_ADICIONALES}. Con más de eso ya no es una flota con varias razones sociales: háblanos y lo montamos bien.`);
  }
  return salida;
}

/**
 * Guarda las razones sociales adicionales de la flota en `tenant.config`.
 *
 * La mezcla va por `tenant_config_merge` como todo lo demás (DAT-20): un
 * lee-modifica-escribe se llevaría por delante `empresa.rfc` —la identidad
 * fiscal contra la que se valida CADA CFDI— si dos pantallas guardan a la vez.
 * Y el CHECK `tenant_config_valida` (0085) ya comprueba del lado de la base
 * que `rfcsAdicionales` sea un array de textos.
 */
export async function guardarRfcsAdicionales(
  tenantId: string,
  rfcs: string[],
  actor?: { id?: string; email?: string },
): Promise<void> {
  const { error } = await mezclarConfig(tenantId, {
    empresa: { rfcsAdicionales: rfcs },
  }, 'guardarRfcsAdicionales');
  if (error) throw error;

  // Los RFC VAN en la bitácora: "cambió las razones sociales aceptadas" no
  // contesta la pregunta que se le va a hacer a esta línea seis meses después
  // ("¿desde cuándo aceptamos CFDI a nombre de la otra empresa?").
  await anotar(tenantId, 'empresa.rfcs_adicionales.editados', 'tenant', tenantId, { rfcs }, actor);
}

/** La política vigente de la flota, ya fusionada con la base. */
export async function politicaVigente(tenantId: string): Promise<PoliticaGasto[]> {
  return (await getConfig(tenantId)).politica;
}

/** Lo que un renglón del formulario de políticas manda por concepto. */
export interface RenglonPolitica {
  concepto: string;
  /** Tal como se tecleó. `''` es SIN TOPE; `'0'` es tope de cero. */
  tope: string;
  exigeCfdi: boolean;
}

/**
 * Arma la política que se va a guardar a partir de lo que se capturó.
 *
 * VIVE AQUÍ Y NO EN LA PÁGINA PORQUE PUEDE PERDER DATOS, y eso hay que poder
 * probarlo. `fusionarConfig` REEMPLAZA el arreglo completo en vez de fusionarlo
 * renglón por renglón, así que lo que esta función devuelva es la política
 * entera de la flota: lo que no venga aquí, se borró.
 *
 * De ahí `porRuta`. El formulario se indexa por CONCEPTO y no tiene dónde poner
 * la ruta, así que las reglas por ruta no viajan en el formulario — y guardar
 * sin ellas se las lleva. Se reponen verbatim. Borrarle a una flota su tope de
 * casetas de una ruta concreta, en silencio, por haber guardado otra cosa, es
 * el tipo de daño que nadie relaciona con esta pantalla tres semanas después.
 *
 * `''` vs `'0'`: vacío es SIN TOPE y cero es TOPE DE CERO (el concepto deja de
 * permitirse). `Number('')` da 0, que los confundiría — y confundirlos prohíbe
 * un gasto que nadie quiso prohibir.
 */
export function armarPolitica(
  renglones: RenglonPolitica[],
  porRuta: PoliticaGasto[] = [],
): PoliticaGasto[] {
  const nueva: PoliticaGasto[] = [];

  for (const r of renglones) {
    const concepto = r.concepto.trim();
    if (!concepto) throw new DatoInvalido('Hay un renglón de la política sin concepto.');

    const crudo = r.tope.trim();
    let topeMonto: number | undefined;
    if (crudo !== '') {
      const n = Number(crudo);
      if (!Number.isFinite(n) || n < 0) {
        throw new DatoInvalido(`El tope de "${concepto}" tiene que ser un número mayor o igual a 0.`);
      }
      topeMonto = n;
    }

    // Un renglón sin tope y sin exigir CFDI no dice nada: el motor lo ignora
    // igual y guardarlo solo ensucia la config.
    if (topeMonto === undefined && !r.exigeCfdi) continue;
    nueva.push({ concepto, topeMonto, requiereCfdi: r.exigeCfdi });
  }

  return [...nueva, ...porRuta];
}

// ── 4. Reabrir un viaje liquidado ──────────────────────────────────────────

/**
 * Reabre un viaje ya liquidado para que vuelva a aceptar comprobantes.
 *
 * NO BASTA CAMBIAR `viaje.estatus`, y esto costó cuatro "ya lo reabrí" que no
 * reabrían nada: el trigger de la 0036 mira si EXISTE una fila de `liquidacion`,
 * no el estatus. Mientras esa fila esté, no entra ni un gasto. La fila se
 * regenera sola al próximo `listo` (es un upsert).
 *
 * ES DESTRUCTIVO y por eso pide `confirmar`. Se pierde la liquidación anterior
 * —incluida la liga a su PDF— y ese PDF pudo haberse entregado ya. Quien reabre
 * tiene que saber que el papel que el operador tiene en la mano dejará de
 * cuadrar con lo que el sistema diga después.
 *
 * TOMA `acquireViajeLock` (auditoría 10, MEDIO de concurrencia) — el MISMO
 * mutex por viaje que `processor.ts` toma antes de cerrar (líneas 1290, 1646)
 * o de emparejar un XML. Sin él hay una carrera real, no solo teórica: borrar
 * la fila de `liquidacion` (paso 1) y poner `viaje.estatus = 'abierto'` (paso 2)
 * son DOS statements sueltos, cada uno su propia transacción — no la función
 * `guardar_liquidacion_tx` (0013), que sólo es atómica CONSIGO MISMA. Si un
 * "listo" que ya estaba en vuelo (mensaje reclamado antes de que se reabriera)
 * llega a `guardar_liquidacion_tx` justo entre esos dos pasos, su INSERT ya no
 * choca contra nada —la liquidación vieja se acaba de borrar— y crea una NUEVA
 * antes de que el paso 2 de aquí alcance a correr. El resultado, si el paso 2
 * gana la carrera: `viaje.estatus = 'abierto'` con una liquidación VIVA
 * apuntando al mismo viaje — el trigger de la 0036 (`gasto_no_tras_liquidar`,
 * que sólo mira si la fila EXISTE, no el estatus) bloquea entonces cualquier
 * gasto nuevo sobre un viaje que la pantalla enseña como abierto. Es exactamente
 * el mismo síntoma que el comentario de abajo describe para el bug del `error`
 * sin comprobar, pero producido por una carrera real en vez de por un bug de
 * lectura. `liquidacion_viaje_uidx` (0005) sólo impide que DOS liquidaciones
 * convivan para el mismo viaje; no impide el intercalado borrar→re-crear.
 * `acquireViajeLock` cierra la ventana por completo: mientras se reabre, ningún
 * cierre puede estar corriendo sobre el mismo viaje, y viceversa.
 *
 * AUDITORÍA 18 (DAT-06): los dos statements sueltos son ahora UNA transacción
 * (`reabrir_viaje_tx`, 0159) y van en el orden contrario —el estatus del viaje
 * PRIMERO, que es el paso que puede rebotar contra
 * `uq_viaje_abierto_por_operador`—, así que un rebote ya no deja un viaje
 * liquidado sin liquidación. Y la liquidación no se pierde: se archiva en
 * `liquidacion_historico` antes de retirarse, porque era la única constancia de
 * un papel que el operador ya tiene en la mano.
 */
export async function reabrirViaje(
  tenantId: string,
  folio: string,
  confirmar: boolean,
  actor?: { id?: string; email?: string },
): Promise<{ pdfPerdido: string | null }> {
  if (!confirmar) {
    throw new DatoInvalido('Reabrir retira la liquidación anterior y su PDF (queda archivada, pero deja de valer). Hay que confirmarlo explícitamente.');
  }

  const admin = supabaseAdmin();
  const { data: viaje, error: errViaje } = await admin
    .from('viaje')
    .select('id, estatus')
    .eq('tenant_id', tenantId)   // el tenant SIEMPRE en el where: el folio no es único global
    .eq('folio', folio)
    .maybeSingle();

  if (errViaje) throw new Error(`reabrirViaje: ${errViaje.message}`);
  if (!viaje) throw new DatoInvalido(`No existe el viaje ${folio} en esta flota.`);

  const viajeId = viaje.id as string;

  // Mutex ANTES de leer, igual que el brazo del XML en processor.ts: leer sin
  // exclusividad ya es parte de la carrera (la liquidación que se lee aquí
  // podría dejar de existir un instante después, por un cierre en vuelo).
  const lock = await acquireViajeLock(viajeId);
  if (!lock) {
    throw new DatoInvalido(
      `El viaje ${folio} está siendo procesado en este momento (un cierre o un XML en curso). ` +
      `Espera unos segundos y vuelve a intentar reabrirlo.`,
    );
  }

  try {
    // ── DAT-06 · EL ORDEN, Y EN UNA SOLA TRANSACCIÓN ──────────────────────
    //
    // Aquí se borraba la liquidación y DESPUÉS se abría el viaje. El segundo
    // paso puede rebotar: si el operador ya tiene otro viaje abierto,
    // `uq_viaje_abierto_por_operador` (0029) lanza 23505 — y la liquidación ya
    // no existe. Queda un viaje `liquidado` SIN liquidación: no se consulta, no
    // se re-cierra, y el PDF que el operador ya recibió no lo respalda nada.
    //
    // `reabrir_viaje_tx` (0159) lo hace al revés y en UNA transacción: traba el
    // viaje, lo pone `abierto` primero —el paso que puede fallar— y sólo
    // entonces ARCHIVA la liquidación en `liquidacion_historico` y la retira.
    // Si el estatus rebota, revierte todo con la liquidación intacta. Y el
    // papel emitido deja de desaparecer sin rastro: hasta hoy, reabrir borraba
    // la única constancia de lo que se le liquidó al operador.
    //
    // El mutex de arriba SIGUE: la transacción protege estas escrituras entre
    // sí, pero no contra el cierre, que calcula y genera el PDF FUERA de ella.
    const { data, error } = await acotada(
      admin.rpc('reabrir_viaje_tx', { p_tenant: tenantId, p_viaje: viajeId }),
      'reabrirViaje',
    );
    if (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new DatoInvalido(
          `No se puede reabrir ${folio}: su operador ya tiene otro viaje abierto. ` +
          'Cierra o cancela ese viaje primero — un operador solo puede tener uno abierto a la vez. ' +
          'La liquidación de este viaje NO se tocó.',
        );
      }
      if ((error as { code?: string }).code === 'CU012') {
        throw new DatoInvalido(`No existe el viaje ${folio} en esta flota.`);
      }
      throw new Error(`reabrirViaje: ${error.message}`);
    }

    const pdfPerdido = ((data as { pdf_perdido?: string | null } | null)?.pdf_perdido ?? null) as string | null;

    // La conversación de WhatsApp queda fuera de la transacción a propósito:
    // que no se pueda desligar el hilo NO es razón para no reabrir el viaje
    // (por eso es un warn y no un throw), y meterla dentro la volvería fatal.
    const { error: errConv } = await admin
      .from('wa_conversacion')
      .update({ viaje_id: null })
      .eq('tenant_id', tenantId)
      .eq('viaje_id', viajeId);
    if (errConv) logger.warn('reabrirViaje.conversacion', { folio, err: errConv.message });

    await anotar(tenantId, 'viaje.reabierto', 'viaje', viajeId, { folio, pdfPerdido }, actor);
    return { pdfPerdido };
  } finally {
    await releaseViajeLock(viajeId);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EL REGISTRO DE UNIDADES, PAGINADO POR LA BASE (auditoría 24, ADM-2)
//
// `getUnidades` (operacion.ts) trae el parque COMPLETO con `traerTodo` — lo
// que DEMUESTRA que está completo, y por eso sigue siendo lo correcto para el
// semáforo de la API y para cualquier cuenta sobre la flota. Lo que no es, a
// 800 tractos, es lo correcto para PINTAR 25 renglones: el catálogo entero
// viaja a la pantalla en cada render.
//
// `unidades_registro_tenant` (0298) corta la página sobre un orden TOTAL
// (papel más próximo a vencer, sin papeles al final, desempate por económico e
// id) y devuelve el `total` real en la MISMA respuesta.
//
// ── POR QUÉ EL CÁLCULO DE VENCIMIENTO SE REHACE AQUÍ ─────────────────────
//
// La cuenta de "cuál de los tres papeles vence antes y en cuántos días" vive
// dentro de `getUnidades`, en un bucle sin exportar. Esta lectura no la puede
// importar, así que la rehace — pero NO copiando la lista de papeles ni la
// aritmética a mano: los nombres salen de `PAPELES_UNIDAD` (vigencias.ts), que
// es la misma constante que usa el resto del producto, y los días de
// `diasEntreIso` (relojes_legales.ts). Lo único propio de aquí es el orden en
// que se recorren, y `administracion_aud24.test.ts` fija que las dos
// implementaciones coincidan sobre los mismos papeles.
// ═══════════════════════════════════════════════════════════════════════════

/** Una fila del registro de unidades. Superconjunto de lo que la pantalla
 *  necesita: trae las tres fechas crudas para precargar la forma de edición. */
export interface FilaRegistroUnidad {
  id: string;
  numeroEconomico: string;
  placas: string | null;
  marca: string | null;
  modelo: string | null;
  anio: number | null;
  estado: string;
  kmActual: number | null;
  /** Días al vencimiento MÁS PRÓXIMO de los tres papeles. NEGATIVO = ya
   *  venció. `null` = ninguno capturado — que NO es estar en regla. */
  diasAlVencimiento: number | null;
  /** Cuál de los tres vence antes. `null` sin dato. */
  queVence: string | null;
  polizaVence: string | null;
  permisoSictVence: string | null;
  verificacionVence: string | null;
  gpsProveedor: string | null;
  gpsDeviceId: string | null;
  gpsVistoEn: string | null;
  ordenesAbiertas: number;
  activo: boolean;
  terminalId: string | null;
  terminalNombre: string | null;
}

export interface PaginaUnidades {
  filas: FilaRegistroUnidad[];
  /** Cuántas casan con el filtro. Lo CUENTA la base; no es el largo de la
   *  página. */
  total: number;
  pagina: number;
  paginas: number;
  q: string;
}

export interface ConteosUnidades {
  total: number;
  activas: number;
  bajas: number;
  vencidos: number;
  porVencer: number;
  vigentes: number;
  sinDato: number;
}

/** Filas por página del registro de unidades. */
export const UNIDADES_POR_PAGINA = 25;

/**
 * Cuál de los tres papeles vence antes, y en cuántos días desde `hoy` (día de
 * México en ISO). Los nombres salen de `PAPELES_UNIDAD` para que la pantalla
 * de unidades, la API y el bot llamen igual al mismo papel.
 */
export function papelMasProximo(
  papeles: { polizaVence: string | null; permisoSictVence: string | null; verificacionVence: string | null },
  hoy: string,
): { diasAlVencimiento: number | null; queVence: string | null } {
  const fechas: Array<string | null> = [papeles.polizaVence, papeles.permisoSictVence, papeles.verificacionVence];
  let diasAlVencimiento: number | null = null;
  let queVence: string | null = null;
  for (let i = 0; i < fechas.length; i++) {
    const v = fechas[i];
    if (!v) continue;
    const iso = v.slice(0, 10);
    // Una fecha que no se pueda interpretar se SALTA, no se cuenta como hoy:
    // contarla daría 0 días y pintaría de amarillo un papel que nadie capturó.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || Number.isNaN(Date.parse(`${iso}T00:00:00Z`))) continue;
    const dias = diasEntreIso(hoy, iso);
    // `<` y no `<=`: con dos papeles el mismo día gana el primero de
    // `PAPELES_UNIDAD`, igual que en `getUnidades`.
    if (diasAlVencimiento === null || dias < diasAlVencimiento) {
      diasAlVencimiento = dias;
      queVence = PAPELES_UNIDAD[i];
    }
  }
  return { diasAlVencimiento, queVence };
}

/**
 * Una página del registro de unidades (`unidades_registro_tenant`, 0298).
 *
 * FALLA CERRADO: un error de lectura LANZA. La página lo atrapa y pinta la
 * sección caída diciéndolo — media lista se ve igual que la lista entera.
 */
export async function getUnidadesRegistro(
  tenantId: string,
  hoy: string,
  opciones: { q?: string; pagina?: number; porPagina?: number; activo?: boolean } = {},
): Promise<PaginaUnidades> {
  const porPagina = Math.max(1, Math.min(200, opciones.porPagina ?? UNIDADES_POR_PAGINA));
  const q = (opciones.q ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_BUSQUEDA_OPERADORES);
  // `%` y `_` son comodines del LIKE del lado de la base: se escapan para que
  // buscar «100%» busque eso y no «todo».
  const qSql = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  const pedida = Number.isInteger(opciones.pagina) && (opciones.pagina as number) >= 1 ? (opciones.pagina as number) : 1;

  const leer = async (pagina: number) => {
    const { data, error } = await acotada(supabaseAdmin().rpc('unidades_registro_tenant', {
      p_tenant: tenantId, p_q: qSql || null, p_activo: opciones.activo ?? true,
      p_desde: (pagina - 1) * porPagina, p_limite: porPagina,
    }), 'unidades_registro_tenant');
    if (error) throw new Error(`getUnidadesRegistro: ${error.message}`);
    const r = data as { total?: unknown; filas?: unknown } | null;
    if (!r || !esNumero(r.total) || !Array.isArray(r.filas)) {
      throw new Error('getUnidadesRegistro: unidades_registro_tenant devolvió otra forma (¿migración 0298 sin aplicar?)');
    }
    return { total: r.total, filas: r.filas as Array<Record<string, unknown>> };
  };

  let pagina = pedida;
  let r = await leer(pagina);
  const paginas = Math.max(1, Math.ceil(r.total / porPagina));
  // Un `?p=` más allá del final (un link viejo) cae a la última página real.
  if (pagina > paginas) { pagina = paginas; r = await leer(pagina); }

  const filas: FilaRegistroUnidad[] = r.filas.map((f) => {
    const polizaVence = textoONull(f.polizaVence);
    const permisoSictVence = textoONull(f.permisoSictVence);
    const verificacionVence = textoONull(f.verificacionVence);
    const { diasAlVencimiento, queVence } = papelMasProximo({ polizaVence, permisoSictVence, verificacionVence }, hoy);
    return {
      id: String(f.id),
      numeroEconomico: String(f.numeroEconomico),
      placas: textoONull(f.placas),
      marca: textoONull(f.marca),
      modelo: textoONull(f.modelo),
      // `null` se queda `null`: un 0 diría que la unidad es del año cero.
      anio: f.anio == null ? null : Number(f.anio),
      estado: String(f.estado),
      // Lo mismo con el odómetro: `null` = nadie lo capturó, NO cero km.
      kmActual: f.kmActual == null ? null : Number(f.kmActual),
      diasAlVencimiento,
      queVence,
      polizaVence,
      permisoSictVence,
      verificacionVence,
      gpsProveedor: textoONull(f.gpsProveedor),
      gpsDeviceId: textoONull(f.gpsDeviceId),
      gpsVistoEn: textoONull(f.gpsVistoEn),
      ordenesAbiertas: esNumero(f.ordenesAbiertas) ? f.ordenesAbiertas : Number(f.ordenesAbiertas ?? 0),
      activo: Boolean(f.activo),
      terminalId: textoONull(f.terminalId),
      terminalNombre: textoONull(f.terminalNombre),
    };
  });
  return { filas, total: r.total, pagina, paginas, q };
}

/**
 * Los contadores de papeles sobre la FLOTA ENTERA (`unidades_conteos_tenant`,
 * 0298). `null` = no se pudo contar; la vista pinta «—» y lo dice, nunca un 0
 * que se lea como medición.
 */
export async function getUnidadesConteos(tenantId: string, hoyMxIso: string, diasAviso: number): Promise<ConteosUnidades | null> {
  const { data, error } = await acotada(supabaseAdmin().rpc('unidades_conteos_tenant', {
    p_tenant: tenantId, p_hoy: hoyMxIso, p_dias_aviso: diasAviso,
  }), 'unidades_conteos_tenant');
  if (error) {
    logger.warn('getUnidadesConteos', { tenantId, err: error.message });
    return null;
  }
  const r = data as Record<string, unknown> | null;
  const llaves: Array<keyof ConteosUnidades> = ['total', 'activas', 'bajas', 'vencidos', 'porVencer', 'vigentes', 'sinDato'];
  const salida = {} as ConteosUnidades;
  for (const k of llaves) {
    const v = r?.[k];
    const n = typeof v === 'string' ? Number(v) : v;
    if (!esNumero(n)) {
      logger.warn('getUnidadesConteos.forma', { tenantId, llave: k });
      return null;
    }
    salida[k] = n;
  }
  return salida;
}
