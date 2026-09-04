import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { sinComentarios, fuentesDeProduccion } from '@/lib/pruebas/codigo';

// ═══════════════════════════════════════════════════════════════════════════
// CAPA 2 DEL AISLAMIENTO — LA QUE DE VERDAD PROTEGE EL CAMINO REAL.
//
// El dato verificado que reordenó esta ronda: la app consulta con
// `service_role` (`src/lib/supabase/admin.ts`, `supabaseAdmin()`), y
// `service_role` SALTA RLS por diseño (confirmado contra `supabase/
// migrations/0064:187` y contra el propio comentario de `admin.ts`: "Salta
// RLS — re-imponer scope por tenant a mano con .eq('tenant_id', ...)"). O
// sea que RLS (capa 1, `supabase/pruebas-aislamiento/*.sql` +
// `verificaciones.sql`) es la SEGUNDA red — la que protege una sesión de
// navegador con el rol `authenticated`. La PRIMERA red, la que separa a una
// flota de otra en el camino que de verdad usa el producto, es el filtro
// `tenant_id` que cada consulta escribe a mano. Esta prueba vigila esa
// primera red.
//
// QUÉ HACE: escanea todo `.ts` de producción bajo `src/lib/**` que importe
// `supabaseAdmin` de `@/lib/supabase/admin`, encuentra cada `.from('tabla')`
// contra una tabla que SÍ tiene `tenant_id` (la lista sale de
// `supabase/migrations/*.sql` en cada corrida — una migración nueva que le
// agregue `tenant_id` a una tabla entra sola, sin tocar este archivo), y
// exige que la cadena que sigue mencione `tenant_id` en alguna parte —
// `.eq('tenant_id', …)`, `.match({tenant_id: …})`, `.in('tenant_id', …)` — o
// que el llamador esté en el ALLOWLIST de abajo, con su razón escrita.
//
// SUS LÍMITES, para no fingir más certeza de la que da (es un escaneo de
// FUENTE, no una ejecución):
//
// · "la cadena MENCIONA tenant_id" no es "la cadena FILTRA correctamente
//   por tenant_id". `.eq('tenant_id', OTRO_TENANT_ID)` —el id equivocado—
//   pasaría esta prueba y sería un IDOR real. Esto atrapa el olvido total
//   del filtro (el caso que de verdad ha pasado: ver el comentario de
//   `clientes.ts` sobre `crearViaje`/`operador_id`), no un id trocado.
// · Solo mira `src/lib/**`. Una consulta armada dentro de `src/app/**`
//   (poco común en este repo — la convención es que las páginas llamen a
//   funciones de `lib/`, nunca arman su propio `.from()`) no la ve esta
//   prueba. Si esa convención se rompe, hace falta ampliar el escaneo.
// · La ventana que se lee tras cada `.from(` es de hasta 2000 caracteres o
//   hasta que los paréntesis abiertos por la propia cadena vuelvan a cero
//   —lo que pase primero—. Una cadena de supabase-js más larga que eso es
//   un olor de código por su cuenta; hasta hoy (15-ago-2026) ninguna lo es.
// · No sigue funciones. Si una tabla se consulta a través de un helper
//   genérico que reciba el nombre de tabla como parámetro (no hay ninguno
//   así hoy — se confirmó con `grep -rn "\.from(nombreTabla\|\.from(tabla"`),
//   esta prueba no lo vería.
// ═══════════════════════════════════════════════════════════════════════════

const DIR_LIB = 'src/lib';
// 23-AGO-2026 (P0 de la auditoría externa): esta prueba SOLO miraba `src/lib`,
// y su propio encabezado lo admitía como límite conocido. Pero 74 archivos de
// `src/app` importan `supabaseAdmin` —rutas de API y componentes de servidor
// que arman consultas por su cuenta— y ninguno estaba vigilado. El aislamiento
// entre flotas se decide en cada consulta que corre con `service_role`, no en
// la carpeta donde vive el archivo.
const DIR_APP = 'src/app';
const DIR_MIGRACIONES = 'supabase/migrations';

/**
 * Tablas de `public` con columna `tenant_id`, generada de los propios
 * `.sql` — no una lista escrita a mano que se desactualiza. Solo entiende
 * `create table` (con o sin `if not exists`) y `drop table`: es lo único
 * que las 111 migraciones de hoy usan (no hay un solo `rename` ni un `add
 * column tenant_id` posterior a la creación — confirmado por grep), y basta
 * para el caso que le importa a esta prueba: una tabla nueva que declare
 * `tenant_id` en su propio `create table` se detecta sola.
 */
function tablasConTenantId(): Set<string> {
  const archivos = readdirSync(DIR_MIGRACIONES).filter((f) => f.endsWith('.sql')).sort();
  const conTenant = new Set<string>();
  const dropeadas = new Set<string>();

  const reCreate = /create table\s+(?:if not exists\s+)?(?:public\.)?"?(\w+)"?\s*\(([\s\S]*?)\n\);/gi;
  const reDrop = /drop table\s+(?:if exists\s+)?(?:public\.)?"?(\w+)"?/gi;

  for (const f of archivos) {
    const src = readFileSync(`${DIR_MIGRACIONES}/${f}`, 'utf8');
    let m: RegExpExecArray | null;
    reCreate.lastIndex = 0;
    while ((m = reCreate.exec(src))) {
      if (/\btenant_id\b/.test(m[2])) conTenant.add(m[1]);
    }
    reDrop.lastIndex = 0;
    while ((m = reDrop.exec(src))) dropeadas.add(m[1]);
  }
  for (const t of dropeadas) conTenant.delete(t);
  return conTenant;
}

/** ¿El archivo importa el cliente de service-role? Solo esos saltan RLS. */
const IMPORTA_ADMIN = /from\s+['"]@\/lib\/supabase\/admin['"]/;

/** Cada llamada `.from('tabla')`, con su posición en el fuente. */
function llamadasFrom(fuente: string): Array<{ tabla: string; desde: number }> {
  const re = /\.from\(\s*['"](\w+)['"]\s*\)/g;
  const salida: Array<{ tabla: string; desde: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(fuente))) salida.push({ tabla: m[1], desde: m.index });
  return salida;
}

/** Nombres de método de supabase-js: no son "funciones locales que construyen la fila". */
const NOMBRES_SUPABASE = new Set([
  'from', 'select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'in', 'is', 'match',
  'filter', 'order', 'range', 'limit', 'single', 'maybeSingle', 'then', 'catch', 'rpc',
  'contains', 'not', 'or', 'gte', 'lte', 'gt', 'lt', 'ilike', 'like', 'textSearch', 'returns',
  'throwOnError', 'csv', 'overlaps', 'containedBy',
]);

/** Avanza desde un '{' hasta su '}' que lo balancea (o hasta el final del fuente). */
function finDeLlaves(fuente: string, desdeLlave: number): number {
  let balance = 0;
  let i = desdeLlave;
  for (; i < fuente.length; i++) {
    if (fuente[i] === '{') balance++;
    else if (fuente[i] === '}') { balance--; if (balance === 0) return i + 1; }
  }
  return i;
}

/**
 * `function nombre(...) { ... }` o `const nombre = (...) => { ... }` de nivel
 * módulo — para poder mirar el CUERPO de un `filaTarifa(tenantId, t)` cuando
 * el `.insert(filaTarifa(...))` no trae `tenant_id` a la vista pero la fila
 * que arma sí. Es texto, no un parser de TypeScript: basta para lo que se
 * necesita (encontrar el bloque `{…}` que sigue a una firma de función) y
 * un caso que no calce cae, con seguridad, del lado de SEGUIR exigiendo el
 * filtro explícito.
 */
function cuerposDeFunciones(fuente: string): Map<string, string> {
  const mapa = new Map<string, string>();
  const re = /(?:function\s+(\w+)\s*\([^)]*\)\s*(?::[^{]+)?|(?:export\s+)?(?:async\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fuente))) {
    const nombre = m[1] ?? m[2];
    const abre = fuente.indexOf('{', re.lastIndex - 1);
    if (abre === -1) continue;
    const fin = finDeLlaves(fuente, abre);
    mapa.set(nombre, fuente.slice(abre, fin));
  }
  return mapa;
}

/**
 * Para un `.insert(…)`/`.upsert(…)` cuya cadena no menciona `tenant_id`: la
 * fila puede armarse ANTES, en la misma función (una constante que luego se
 * pasa por nombre) o en un helper del propio archivo (`filaTarifa(tenantId,
 * t)`). Se amplía la ventana al cuerpo de la función que envuelve la
 * llamada, más el cuerpo de cualquier función local que esa envolvente
 * invoque.
 *
 * SOLO para INSERT/UPSERT — nunca para SELECT/UPDATE/DELETE: la fila de un
 * insert se juzga por lo que CONTIENE (puede venir de otro lado), pero un
 * SELECT/UPDATE/DELETE se juzga por lo que FILTRA, y eso tiene que estar en
 * la propia cadena — "en algún lugar de esta función grande se menciona
 * tenant_id" no basta para saber que ESTE where lo usa.
 */
function ventanaAmpliadaParaEscritura(fuente: string, desdeFrom: number): string {
  const antes = fuente.slice(0, desdeFrom);
  const firmaRe = /(?:function\s+\w+\s*\([^)]*\)\s*(?::[^{]+)?|(?:export\s+)?(?:async\s+)?const\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>)\s*\{/g;
  let ultima: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = firmaRe.exec(antes))) ultima = m;
  if (!ultima) return '';
  const abre = antes.indexOf('{', ultima.index + ultima[0].length - 1);
  if (abre === -1) return '';
  const fin = finDeLlaves(fuente, abre);
  if (fin <= desdeFrom) return ''; // el `.from(` quedó FUERA de esa función: no aplica

  const envolvente = fuente.slice(abre, fin);
  const cuerpos = cuerposDeFunciones(fuente);
  const llamadas = new Set(
    [...envolvente.matchAll(/\b([a-zA-Z_]\w*)\(/g)].map((mm) => mm[1]).filter((n) => !NOMBRES_SUPABASE.has(n)),
  );
  let extra = '';
  for (const n of llamadas) if (cuerpos.has(n)) extra += ' ' + cuerpos.get(n);
  return envolvente + extra;
}

/** Avanza desde un '(' hasta su ')' que lo balancea (o hasta `fin`). */
function finDelGrupo(fuente: string, desdeParen: number, fin: number): number {
  let balance = 0;
  let i = desdeParen;
  for (; i < fin; i++) {
    if (fuente[i] === '(') balance++;
    else if (fuente[i] === ')') {
      balance--;
      if (balance === 0) return i + 1;
    }
  }
  return i;
}

/**
 * La CADENA COMPLETA que arranca en un `.from(`: su propia llamada, y cada
 * `.metodo(…)` encadenado que le sigue — `.from('cliente').select(…)
 * .eq('tenant_id', x).order(…)` es UNA cadena, no cuatro grupos sueltos.
 * Para en lo que venga primero: algo que no sea otro `.metodo(` encadenado,
 * o 2000 caracteres.
 */
function ventanaDeCadena(fuente: string, desde: number): string {
  const TOPE = 2000;
  const fin = Math.min(fuente.length, desde + TOPE);

  const primerParen = fuente.indexOf('(', desde);
  if (primerParen === -1 || primerParen >= fin) return fuente.slice(desde, fin);
  let i = finDelGrupo(fuente, primerParen, fin);

  for (;;) {
    let j = i;
    while (j < fin && /\s/.test(fuente[j])) j++; // espacios/saltos de línea entre eslabones
    if (fuente[j] !== '.') break;
    let k = j + 1;
    while (k < fin && /\w/.test(fuente[k])) k++; // nombre del método
    if (fuente[k] !== '(') break; // no es una llamada — fin de la cadena
    const siguiente = finDelGrupo(fuente, k, fin);
    if (siguiente === k) break; // no cerró dentro de la ventana
    i = siguiente;
  }
  return fuente.slice(desde, i);
}

/**
 * Llamador exento, con la razón por la que SÍ puede cruzar tenants o por la
 * que el escaneo no puede verlo (falso positivo conocido). Cada entrada es
 * `archivo:tabla` o `archivo:tabla:snippet` cuando una tabla se toca más de
 * una vez en el mismo archivo con destinos distintos.
 */
const ALLOWLIST: Record<string, string> = {
  'src/lib/admin/slo.ts': 'Los SLOs (fase 7, 17-ago-2026) miden la salud DEL PRODUCTO — tasa de éxito y p95 de agente_corrida de TODOS los tenants a propósito: un SLO por flota mediría a la flota, no al servicio. Solo lo lee la tarjeta de /admin/dev, detrás de requireSuperadmin.',
  'src/lib/admin/capacidad.ts': 'El modelo de capacidad (fase 7, 17-ago-2026) agrega llm_costo y cuenta liquidaciones DE TODA la operación a propósito: mide el costo unitario del PRODUCTO para los escenarios de escala del superadmin (/admin/capacidad-forecast, detrás de requireSuperadmin). Un filtro por tenant mediría la capacidad de una flota, no la de Likida.',
  'src/lib/admin/negocio.ts': 'CLAUDE.md la nombra, textual, como "la única función con ese permiso": la consola /admin (superadmin) cruza TODOS los tenants a propósito para ver costo de IA, flotas y agentes de TODAS las flotas a la vez.',
  'src/lib/admin/calidad.ts': 'El tablero de calidad de /admin/calidad-evals (superadmin) cuenta los veredictos de agente_corrida a través de TODOS los tenants a propósito: la salud es del AGENTE, no de una flota, y filtrar por una volvería invisible al agente que falla en las demás — el mismo dominio cross-tenant que ingenieria.ts y direccion.ts declaran para la misma tabla. Solo lee (agente, estado): cero datos de flota, cero datos personales. Su única puerta es la página bajo requireSuperadmin (layout de /admin); ninguna pantalla de /dashboard lo importa.',
  'src/lib/admin/consumo.ts': 'El panel de consumo de IA (/admin/consumo, 16-ago-2026) agrega agente_corrida POR AGENTE a través de todos los tenants a propósito — es la vista de gasto del back office de LIKIDA, solo alcanzable tras requireSuperadmin (layout de /admin). Mismo dominio y misma puerta que negocio.ts.',
  'src/lib/likida/agentes/runner.ts': 'El runner nivel 2 (0123) es el orquestador de agentes de LIKIDA, no de una flota: lee agente_corrida por AGENTE (el gasto del día contra el techo declarado), prospecto por estado (candidatos del lote — el pipeline es de Likida, 0105) y el conteo de cola_aprobacion pendiente (backpressure). Mismo dominio cross-tenant que cola.ts/redactor.ts, misma puerta: solo lo invocan el cron con CRON_SECRET y la acción confirmada del copiloto (superadmin).',
  'src/lib/agents/copiloto-tools.ts': 'Las tools del copiloto del fundador son cross-tenant POR DISEÑO (nivel compañía) y su única superficie es /api/admin/copiloto, re-gateada superadmin en cada llamada — el encabezado del archivo lo declara. Los conteos directos (cola_aprobacion pendiente en estado_runner, tenant por nombre en ficha_cliente) miden la plataforma entera a propósito.',
  'src/lib/likida/agentes/redactor.ts': 'El Redactor (C5, 0122) es un agente de LIKIDA, no de una flota: lee `prospecto` (el pipeline de ventas de Likida — su tenant_id es NULL hasta el cierre, 0105) anclado por id, y `cola_aprobacion`/`prospecto_contacto` anclados por prospecto_id — el mismo dominio cross-tenant que cola.ts, con la misma puerta: solo lo invoca la server action de /admin/vendedores, re-gateada superadmin, y las tablas son deny-all.',
  'src/lib/likida/agentes/investigador.ts': 'El investigador (0217, id `enriquecedor`) es un agente de LIKIDA sobre el MISMO pipeline comercial que redactor.ts: lee `prospecto` anclado por id o por estado (candidatos sin dossier) — su tenant_id es NULL hasta el cierre (0105) — y escribe `prospecto_dossier`/`prospecto_correo`, ambas deny-all y ancladas por prospecto_id. Su única puerta es el runner (cron con CRON_SECRET / copiloto superadmin).',
  'src/lib/likida/agentes/sdr.ts': 'El SDR (0217) es un agente de LIKIDA sobre el pipeline comercial (tenant_id NULL hasta el cierre, 0105): lee `prospecto` por estado, su historial `prospecto_contacto` y `cola_aprobacion` anclados por prospecto_id, todas deny-all. Misma puerta que el resto de la máquina: el runner.',
  'src/lib/likida/agentes/enviador.ts': 'El enviador (0217) es la puerta de salida de la campaña de LIKIDA: lee `cola_aprobacion` por tipo de campaña (la bandeja del superadmin, cross-tenant a propósito — misma razón que cola.ts), resuelve y envía por la puerta de cola.ts, y mueve `prospecto` anclado por id+estado. Todas deny-all; su única puerta es el runner y su kill switch propio (`agente:enviador`).',
  'src/lib/correo/respuesta_campana.ts': 'La respuesta a un correo de campaña (c5-2) es del pipeline comercial de LIKIDA: busca el `prospecto` por el CORREO del remitente (su tenant_id es NULL hasta el cierre, 0105 — no hay tenant por el cual anclar) para registrar la respuesta en su historial y honrar la BAJA. Tablas deny-all; su única puerta es el webhook de correo entrante, detrás de la firma svix de Resend.',
  'src/lib/likida/agentes/cola.ts': 'La cola de aprobación (0117) es la bandeja del SUPERADMIN y cruza tenants a propósito: su única pantalla es /admin/aprobaciones (requireSuperadmin en la página Y en cada server action), ninguna ruta de /dashboard la importa (verificado por grep al escribirla, 16-ago-2026), y la tabla es deny-all (RLS activa, cero policies — bloque 92 de verificaciones.sql). El `tenant_id` de una pieza ETIQUETA de quién es el borrador, no acota al aprobador; las transiciones van ancladas por id+estado=pendiente, con ids que solo esa pantalla pudo listar.',
  'src/lib/admin/soporte.ts': 'La cola de soporte del SUPERADMIN cruza tenants A PROPÓSITO — el encabezado del archivo lo declara y por eso vive en lib/admin y no en comercial.ts (cuyo `getTickets` sí es tenant-scoped en su primera línea). Su superficie es /admin/soporte y la bandeja de escalaciones, las dos detrás de requireSuperadmin. Hasta FE-11 (22-ago-2026) esta prueba lo dejaba pasar POR ACCIDENTE: la cadena mencionaba `tenant_id` porque era una COLUMNA del select, no un filtro — el límite que el encabezado de esta prueba ya advierte. Los conteos de `contarTickets` no seleccionan esa columna y lo destaparon. `getTicketsCruzados`/`contarTickets` aceptan `{ tenantId }`, que SÍ va al `.eq()`, y es como lo llama `ficha-cliente.ts` (la ficha de UNA flota); sin él, la lectura es la cross-tenant de siempre.',
  'src/lib/admin/bus.ts': 'ADM-12 (auditoría 24): `emailDeActor(userId)` busca UN app_user por su PK global (`id`), no un listado por flota — `id` ya identifica una fila única sin importar tenant, así que un filtro `tenant_id` sería redundante (y el superadmin que llama esto no tiene tenant). El resto del archivo (bus_pieza/bus_orden/bus_corrida) son tablas de PLATAFORMA sin tenant_id, mismo dominio que negocio.ts; su única puerta es /admin/tu-turno, requireSuperadmin.',
  'src/lib/admin/corridas-cruzadas.ts': 'El nombre lo dice: compara la corrida de un agente ENTRE flotas para detectar anomalías (una flota con un patrón muy distinto a las demás). Es analítica cross-tenant del superadmin, no una fuga hacia el panel de un cliente — /admin es la única superficie que la sirve.',
  'src/lib/admin/prospectos-mapa.ts': 'El Cerebro de ventas (17-ago-2026) lee `prospecto` — el pipeline comercial de LIKIDA, cuyo tenant_id es NULL hasta el cierre (0105) — para pintarlo entero en el mapa del superadmin. Mismo dominio cross-tenant que redactor.ts/cola.ts; sus dos superficies (/admin/mapa-prospectos y /api/admin/mapa-prospectos) re-chequean superadmin cada una (requireSuperadmin en la página, puerta.ts en la API).',
  'src/lib/admin/prospectos-arco.ts': 'Ejecutor ARCO del censo: Likida es RESPONSABLE de esos contactos (no la flota). `prospecto.tenant_id` es NULL hasta el cierre (0105); anonimiza por correo/teléfono a través de todo el pipeline. Superficie prevista: /admin/compliance, requireSuperadmin.',
  'src/lib/likida/startup.ts': 'Sondas de arranque (health checks) que confirman que el ESQUEMA existe y responde — cuentan filas o verifican metadatos de la base entera, no leen ni exponen el contenido de ningún tenant específico.',
  'src/lib/likida/agentes/finanzas.ts': 'Los 4 agentes financieros (0215) miden el NEGOCIO de Likida, no una flota — mismo dominio cross-tenant que negocio.ts/runner.ts: cola_aprobacion (su idempotencia por periodo, bandeja del superadmin), suscripcion/factura_saas (MRR y cobrado de TODAS las flotas — es el ingreso de Likida), prospecto (el pipeline de Likida, tenant NULL hasta el cierre, 0105). Su única superficie es el runner (cron con CRON_SECRET) y su salida es la bandeja de /admin/aprobaciones, deny-all + requireSuperadmin.',
  'src/lib/likida/agentes/exito.ts': 'Los 6 agentes de éxito del cliente (0218) barren TODAS las flotas en una pasada — ese es su trabajo: el parte de onboarding lista a las atoradas, el de silencio a las que dejaron de aparecer y el de retención compara a unas con otras. Todas sus lecturas de datos de flota (viaje, gasto, liquidacion, wa_conversacion, agente_corrida) SÍ van ancladas con `.eq(\'tenant_id\', …)`, una flota a la vez; la única consulta sin ese filtro es el pre-check de idempotencia sobre `cola_aprobacion`, que busca por (agente, titulo) porque la clave de la pieza es el PERIODO, no la flota —y para los partes de plataforma el tenant es NULL, así que no habría por qué anclar—. Misma tabla, mismo dominio y misma exención que finanzas.ts (0215): bandeja deny-all del superadmin, y la única puerta de este módulo es el runner (cron con CRON_SECRET).',
  'src/lib/likida/direccion/reportes.ts': 'Los reportes de DIRECCIÓN (0216) miden a LIKIDA, no a una flota: agente_corrida se lee POR AGENTE a través de todos los tenants (los detectores "no corrió"/"verde vacío" del orquestador — el mismo dominio cross-tenant que negocio.ts y runner.ts), y prospecto/factura_saas/cola_aprobacion son tablas del negocio (tenant NULL o etiqueta, 0105/0052/0117). Su única salida es el correo del OPERADOR (ALERTA_EMAIL) y el sello deny-all reporte_direccion; ningún panel de /dashboard importa este módulo — lo despacha el runner (cron con CRON_SECRET).',
  'src/lib/likida/agentes/backoffice.ts': 'El back office restante (0219) audita a LIKIDA, no a una flota. `agente_corrida` se lee POR AGENTE a través de todos los tenants a propósito — la tasa de fallo, el verde vacío y el costo por corrida son del agente, no de una flota (el mismo dominio cross-tenant que reportes.ts, negocio.ts y runner.ts). `cola_aprobacion` es la cola del back office de Likida (tenant NULL o etiqueta, 0117). `solicitud_arco` SÍ tiene tenant y se lee SIN filtrar a propósito: Likida es ENCARGADA del tratamiento y su reloj de compliance es el conjunto — un plazo del art. 31 que se vence en cualquier flota es un incumplimiento de Likida, y filtrar por una flota lo volvería invisible; el parte solo saca tipo, estado y fechas (los 8 primeros caracteres del id, cero datos del titular). Salida única: la bandeja de /admin/aprobaciones, gateada por requireSuperadmin(); ninguna pantalla de /dashboard importa este módulo — lo despacha el runner (cron con CRON_SECRET).',
  'src/lib/likida/agentes/crecimiento.ts': 'Los 10 agentes de crecimiento (0230) hacen el MARKETING de Likida, no el de una flota, y no hay una sola flota por la cual anclar sus dos consultas sin filtro. (1) `cola_aprobacion`: el pre-check de idempotencia busca por (agente, titulo) porque la clave de la pieza es el PERIODO —la semana, el día o el tema—, no la flota; las diez piezas se encolan con tenant NULL (un borrador de artículo o un encargo de video no son de nadie en particular), así que no existe el tenant que se estaría omitiendo. Misma tabla y misma exención que finanzas.ts (0215) y exito.ts (0218). (2) `prospecto` en el agente de alianzas: es el pipeline comercial de LIKIDA, cuyo `tenant_id` es NULL hasta el cierre (constraint `prospecto_tenant_solo_cerrado`, 0105) — se agrega por CIUDAD, sin leer un solo dato de contacto, para decirle al gremio cuántas plazas tiene capturadas Likida; filtrar por una flota contaría el directorio de un cliente, que no es lo que el parte afirma. Mismo dominio cross-tenant que prospectos-mapa.ts y redactor.ts. La única puerta de este módulo es el runner (cron con CRON_SECRET o el copiloto superadmin) y su única salida es la bandeja de /admin/aprobaciones, deny-all + requireSuperadmin; ninguna pantalla de /dashboard lo importa.',
  'src/lib/likida/agentes/ingenieria.ts': 'Los 4 agentes de ingeniería que miran la BASE (0234) auditan a LIKIDA, no a una flota. (1) `cola_aprobacion` sin filtro en dos lugares: el pre-check de idempotencia busca por (agente, titulo) porque la clave del parte es el PERIODO —la semana—, no la flota, y el censo previo de `rendimiento` busca el ÚLTIMO parte de ese agente por (agente, tipo); los ocho encolan con tenant NULL (el estado del esquema y el SHA desplegado no son de nadie en particular), así que no existe el tenant que se estaría omitiendo. Misma tabla y misma exención que finanzas.ts (0215), exito.ts (0218) y crecimiento.ts (0230). (2) `agente_corrida` se lee POR AGENTE a través de todos los tenants a propósito: el costo por corrida es del AGENTE, no de una flota, y filtrarlo por una mediría a la flota (el mismo dominio cross-tenant que reportes.ts, backoffice.ts y runner.ts). El resto de lo que este módulo lee no pasa por PostgREST: son las cuatro funciones de la 0234 sobre el catálogo de PostgreSQL, que no tienen tenant que filtrar. Salida única: la bandeja de /admin/aprobaciones, deny-all + requireSuperadmin; su única puerta es el runner (cron con CRON_SECRET).',
  'src/lib/likida/agentes/ingenieria_producto.ts': 'Los otros 4 de ingeniería (0234) miden a LIKIDA con el mismo dominio cross-tenant que su módulo hermano. `agente_corrida` sin filtro POR DISEÑO: `pruebas` cuenta fallos, verde vacío y patrones de error POR AGENTE, y `producto` solo saca la lista de agentes que corrieron — un filtro por flota mediría a la flota, no al servicio. `cola_aprobacion` es la bandeja del superadmin (tenant NULL o etiqueta, 0117): el pre-check por (agente, titulo) es del PERIODO, y `producto` la lee entera a propósito porque los rechazos y la bandeja atorada son de Likida. `incidencia` SÍ tiene tenant y se lee SIN filtrar, también a propósito: es la señal de producto que dice qué le duele a TODAS las flotas a la vez, y filtrar por una la volvería la anécdota de un cliente. El `select` es deliberadamente pobre —solo `tipo` y `prioridad`, ni ids, ni descripción, ni tenant_id— justo para que el parte NO pueda nombrar a ninguna flota ni a ninguna persona: el hallazgo sale agregado por tipo o no sale. Salida única: la bandeja de /admin/aprobaciones, deny-all + requireSuperadmin; su única puerta es el runner.',
  'src/lib/likida/agentes/contenido.ts': 'El agente de contenido fiscal (0230) escribe el BLOG de Likida, no el de una flota. Su única consulta sin filtro es `temasRechazados` sobre `cola_aprobacion`, y busca por (agente, estado) porque la clave de la pieza es el TEMA del corpus, no la flota: las piezas de este agente se encolan con tenant NULL (un borrador de artículo no es de nadie en particular), así que no existe el tenant que se estaría omitiendo. Solo lee `fuentes->>tema` y `motivo_rechazo` —el catálogo de temas y la frase que escribió Javier al rechazar—, cero datos de flota. Misma tabla y misma exención que crecimiento.ts (0230), finanzas.ts (0215) y exito.ts (0218). Entró con la correctiva del ciclo 7 (c7-10): sin esta lectura, una pieza rechazada dejaba al agente mudo para siempre reportando un motivo falso. La única puerta de este módulo es el runner (cron con CRON_SECRET) y su única salida es la bandeja de /admin/aprobaciones, deny-all + requireSuperadmin.',
  'src/lib/likida/agentes/direccion.ts': 'Los 3 de dirección que van a la bandeja (0235) miden a LIKIDA, no a una flota — mismo dominio cross-tenant que reportes.ts, backoffice.ts y negocio.ts. `agente_corrida` se lee POR AGENTE a través de todos los tenants a propósito: automejora mide la salud del AGENTE (fallos, costo medido, corridas sin pieza), y filtrar por una flota volvería invisible al agente que se rompe en las demás. `cola_aprobacion` se lee dos veces sin anclar: el pre-check de idempotencia busca por (agente, titulo) porque la clave de la pieza es el PERIODO —la semana o el mes—, y el conteo de piezas por agente de automejora es de la bandeja entera, que es del superadmin (0117). `suscripcion`, `factura_saas` y `prospecto` son las tablas del NEGOCIO de Likida (el MRR, el cobrado y el pipeline de toda la plataforma, 0052/0105) — exactamente la misma exención y por la misma razón que finanzas.ts (0215). OJO CON UNA QUE ESTA PRUEBA DEJA PASAR SIN VERLA, y se dice aquí para que no se descubra por accidente como en FE-11: la consulta de `incidencia` de `especialistas_incidente` TAMPOCO filtra por tenant, y pasa el escaneo solo porque `tenant_id` es una COLUMNA de su select. Es deliberada: una pasada barre los expedientes de emergencia abiertos de TODAS las flotas —el agente no sabe de antemano en cuál hay un siniestro— y la pieza que produce sí queda etiquetada con el tenant del incidente. Lo que SÍ va anclado con `.eq(\'tenant_id\', …)`, una flota a la vez, es todo lo que trae datos personales: `flota_poliza`, `proveedor_emergencia` y `contacto_emergencia`. Su única puerta es el runner (cron con CRON_SECRET) y su salida la bandeja deny-all de /admin/aprobaciones.',
  'src/lib/likida/agentes/leads.ts': 'Los 6 agentes de leads (0235) trabajan el pipeline comercial de LIKIDA, no el de una flota: `prospecto.tenant_id` es NULL hasta el cierre (constraint `prospecto_tenant_solo_cerrado`, 0105), así que no existe el tenant que se estaría omitiendo — mismo dominio y misma exención que redactor.ts, investigador.ts, sdr.ts y prospectos-mapa.ts. `cola_aprobacion` se toca solo en el pre-check de idempotencia, que busca por (agente, titulo) porque la clave de la pieza es el PERIODO o la EMPRESA, no la flota; las piezas se encolan con tenant NULL (un score, una ficha o una propuesta no son de ninguna flota) y la bandeja es del superadmin (0117) — misma exención que finanzas.ts (0215), exito.ts (0218) y crecimiento.ts (0230). Las tablas satélite del CRM (prospecto_correo, prospecto_persona, prospecto_contacto, prospecto_toque, prospecto_dossier) no tienen tenant_id y van ancladas por prospecto_id. La única puerta de este módulo es el runner (cron con CRON_SECRET o el copiloto superadmin); ninguna pantalla de /dashboard lo importa.',
  'src/lib/likida/agentes/insumos.ts': 'La bandeja de contexto universal (Fase D, 0267): `listarInsumosDeAgente` (la vista de la tarjeta de un agente en /admin/agentes) y `contarPendientesPorAgente` (el badge de la tabla del catálogo) leen TODOS los insumos, de todos los tenants, a propósito — casi todo el catálogo corre para LIKIDA (tenant_id NULL, ver corridas.ts) y el propio superadmin que ve la tarjeta o la tabla ya ve todo lo demás en /admin (mismo dominio cross-tenant que finanzas.ts/crecimiento.ts). `insumosPendientes` (lo que lee el runner en cada corrida) SÍ filtra con `.is(\'tenant_id\', null)` explícito — es la lectura real que consume el agente —, y `crearInsumoArchivo`/`crearInsumoTexto` escriben `tenant_id: null` explícito en el insert. Su única puerta de escritura es la Server Action de `/admin/agentes/[id]/insumos`, gateada `requireSuperadmin()`; la tabla es deny-all.',
  'src/lib/mcp/oauth.ts': 'El motor OAuth del servidor MCP (0260) es quien RESUELVE el tenant, así que en sus cinco consultas sin filtro no existe todavía (o ya no importa) un tenant por el cual anclar: el canje y la validación buscan por hash ÚNICO (unique + CHECK 64 hex) y la fila encontrada ES la que trae el tenant congelado — anclarla por tenant sería circular, la misma razón por la que `resolverLlave` busca `tenant_api_key` por prefijo; marcar un código usado o rotar/sellar un token van anclados por el id/familia de ESA fila recién resuelta (y el candado real es el `.is(null)` condicional, que es lo que la carrera necesita); y la limpieza de códigos expirados barre basura inservible de TODAS las flotas a propósito — un código expirado no es un dato de nadie. Todo lo que el MCP LEE de datos de flota va en lib/mcp/herramientas/, donde cada consulta sí lleva su `.eq(tenant_id)` (fijado por aislamiento.test.ts).',

  // Las seis de abajo se revisaron UNA POR UNA el 15-ago-2026 (no de bulto):
  // se siguió cada llamador hasta confirmar por qué el id que usa NO puede
  // venir de otro tenant. La razón de cada una es distinta a propósito —
  // copiar-pegar la misma frase en las seis habría sido la señal de que no
  // se revisó ninguna.
  'src/lib/auth/llave-api.ts': '`resolverLlave`: el `.eq(\'id\', hallada.id)` del sello de "último uso" opera sobre una fila que YA se autenticó por comparación de HASH de la llave en claro contra `tenant_api_key.hash` (líneas 140-161) — no por tenant_id. El id no puede ser de otro tenant porque salió de la fila que ganó esa comparación criptográfica, no de un parámetro externo.',
  'src/lib/likida/conv.ts': 'Cada `convId`/`viajeId` que llega a `saveConversation`/`intakePendientes` sale de una resolución YA filtrada por tenant, más arriba en el MISMO pipeline de WhatsApp: `loadConversation(tenantId, telefono, ...)` hace `.eq(\'tenant_id\', tenantId).eq(\'telefono\', telefono)` (línea 235) antes de devolver el `id` que usa `saveConversation`, y todo llamador de `esperarIntake`/`intakePendientes` trae `viajeId` emparejado con un `tenantId` ya resuelto por `resolveOperador(telefono)`. Rastreado hasta processor.ts (líneas 327, 1830, 1951, 2041, 2438) — ninguna ruta pasa un id sin resolver.',
  'src/lib/likida/interruptores.ts': '`listarInterruptores` resuelve NOMBRES de quién movió una palanca GLOBAL (`interruptor`, tabla sin tenant_id, deniega-todo a `authenticated`) leyendo `app_user` por los `id` que aparecen en esa bitácora — es auditoría superadmin, no un dato de flota. Su único llamador de interfaz es `/admin/observabilidad`, gateado por `requireSuperadmin()` en `admin/layout.tsx` (confirmado: ninguna ruta de `/dashboard` la importa).',
  'src/lib/likida/vendedores.ts': 'Es el pipeline de VENTAS de LIKIDA, no de una flota — lo dice el encabezado del propio archivo. `prospecto.tenant_id` es NULL hasta que el prospecto "cierra" (constraint `prospecto_tenant_solo_cerrado`, mig. 0105), y los `app_user` que toca son rol `vendedor` (tenant_id null, personal de Likida, no de una flota). El ancla real es `vendedor_id`, aplicado con `.eq(\'vendedor_id\', ...)` en cada escritura — es la regla #2 que el propio archivo documenta en su encabezado.',
  'src/lib/saas/suscripcion.ts': '`aplicarSuscripcion` (líneas 322-383): cada `.eq(\'id\', ...)` opera sobre una fila resuelta ANTES, en la MISMA función, por un identificador confiable — `stripe_subscription_id` (viene del webhook autenticado de Stripe, nunca de un usuario del panel) o `.eq(\'tenant_id\', datos.tenantId)` explícito (la búsqueda de `previa`, línea 361). Y el INSERT/UPDATE final escribe `tenant_id: datos.tenantId` de todas formas, así que aunque el id encontrado fuera de otra fila, la fila queda anclada al tenant correcto.',
  // ── 23-AGO-2026 · lo que apareció al ampliar el escaneo a `src/app` ──────
  // Trece consultas, ninguna una fuga entre flotas, pero cada una con su razón
  // escrita: una exención sin motivo es la misma falsa confianza que esta
  // prueba existe para quitar.
  'src/app/admin/agentes/contenido.tsx': 'El panel de agentes de /admin agrega `agente_corrida` POR AGENTE a través de todos los tenants a propósito — es el gasto del back office de LIKIDA, no de una flota. Mismo dominio y misma puerta que `src/lib/admin/consumo.ts`: `requireSuperadmin()` en el layout de /admin.',
  'src/app/admin/mi-perfil/page.tsx': '`app_user` se filtra por `.eq(\'id\', s.userId)` — el id de la PROPIA sesión, resuelto por `getSessionTenant()`, no por un parámetro del navegador. Un usuario editando su nombre y su avatar no puede alcanzar la fila de otro aunque `app_user` tenga `tenant_id`: el filtro por identidad es más estrecho que el filtro por flota.',
  'src/app/dashboard/suscripcion/page.tsx': 'Lee el correo del usuario de la sesión para prellenar el portal de facturación. `.eq(\'id\', s.userId)`: la propia fila, no la de otro.',
  'src/app/dashboard/mi-perfil/page.tsx': 'Mismo caso que su gemelo de /admin: `app_user` se filtra por el id de la PROPIA sesión (`getSessionTenant()`), no por un parámetro del navegador. El filtro por identidad es más estrecho que el filtro por flota.',
  'src/app/dashboard/agentes/seccion-notificaciones.tsx': 'Lee el correo del usuario de la sesión —`.eq(\'id\', sesion.userId)`— para mostrar a dónde llegarían los avisos. Un solo campo, de la propia fila.',
  'src/lib/likida/jornada/firma.ts': 'Mismo caso que /dashboard/mi-perfil: `app_user` se filtra por `.eq(\'id\', userId)` —el id de la PROPIA sesión, resuelto por `resolverTenantEfectivo`, no por un parámetro del navegador— y el filtro por identidad es más estrecho que el por flota. Además `app_user.tenant_id` es NULL para el superadmin, así que un `.eq(\'tenant_id\', ...)` dejaría sin firma justo a quien puede corregir cualquier flota. El archivo existe SOLO para esta consulta, con doce líneas, para no tener que exentar `jornada/repo.ts` —el escritor del registro de jornada— entero.',
  'src/lib/likida/jornada/derivar.ts': 'El derivador del registro de jornada barre `viaje` SIN filtro de flota A PROPÓSITO: es un cron multi-flota que arma su lista de trabajo de todos los tenants a la vez, y luego ancla CADA escritura por el `tenant_id` de la propia fila leída (`t.tenantId`, nunca un id que venga de fuera). Pasaba la vigilancia por accidente —la cadena `.select(\'id, tenant_id, ...\')` menciona `tenant_id` sin filtrarlo—, que es justo el límite que el encabezado de esta prueba admite. Queda exento con su razón escrita, para que la vigilancia sobre el motor que escribe un registro laboral sea real y no aparente. ⚠️ La exención vale mientras la lista se lea de `viaje` y cada escritura se ancle por la fila: si algún día un id de flota entra por parámetro, deja de valer.',
  'src/app/api/admin/mapa-prospectos/mensaje/route.ts': '`prospecto` es el pipeline comercial de LIKIDA (mig. 0105), no un dato de flota: cruza tenants por definición porque los prospectos todavía no son de nadie. La ruta está bajo /api/admin, re-gateada superadmin.',
  'src/app/api/correo/eventos/route.ts': '`cola_aprobacion` es la cola del back office de LIKIDA, no de una flota. Y el UPDATE se ancla por `provider_message_id`, un identificador que emite el proveedor de correo y llega por webhook firmado — no lo elige un usuario.',
  'src/app/api/cron/facturar/cola/route.ts': 'La re-validación `.in(\'id\', ids)` opera sobre el lote que el PROPIO cron encoló, y el cuerpo llega firmado por QStash (`verify()` al principio del handler, sin el cual —lo dice el encabezado— cualquiera podría encolar un lote). Los ids ya vienen de una consulta filtrada por flota; esto solo confirma que el gasto sigue sin CFDI. ⚠️ Su seguridad descansa en la firma, no en un filtro: si algún día se acepta un lote de otra fuente, esta exención deja de valer.',
  'src/app/api/cron/facturar/route.ts': 'Es un CONTEO de backlog (`count: exact, head: true`) para decidir cuántos lotes encolar: mide la cola del producto entero, que es lo que el cron necesita saber. No devuelve una sola fila de datos de nadie, y la ruta exige CRON_SECRET.',
  'src/app/api/lead/route.ts': '`prospecto` otra vez: un lead que llega de la landing no pertenece a ninguna flota todavía — buscarlo por correo o por empresa a través de todos los registros es exactamente lo que hace falta para no duplicarlo.',
  'src/app/api/webhook/calcom/route.ts': '`prospecto` es el CRM global de LIKIDA y tiene `tenant_id` NULL durante adquisición (0105). El webhook firmado de Cal.com debe encontrar por correo al lead capturado antes del calendario; exigir un tenant impediría enlazar precisamente todos los leads pre-cierre. La escritura queda anclada al id devuelto por esa búsqueda y las tablas son deny-all.',
  'src/lib/saas/transferencia.ts': '`conciliar`/`timbrarFactura` tocan `factura_saas` — la facturación de LIKIDA a sus clientes, no un dato de flota — y su ÚNICO llamador es `/admin/costos-facturacion` (confirmado por grep en todo `src/app`), gateado por `requireSuperadmin()` en `admin/layout.tsx`. `/dashboard` (cliente) no las importa.',
};

// Exención por cadena exacta: no libera otras consultas del módulo Cal.com.
const CALCOM_LOOKUP = ".from('prospecto').select('id,estado,calcom_booking_id,calcom_booking_aliases').eq('correo_normalizado', correo).is('duplicado_de', null).limit(2)";
const EXENCIONES_CONSULTA = [{
  archivo: 'src/lib/admin/calcom.ts', tabla: 'prospecto', cadena: CALCOM_LOOKUP,
  razon: 'CRM global de LIKIDA (0105): tenant_id sólo existe al cerrar. Este SELECT por correo canónico y no duplicado decide 0/1/>1 para reconciliar no-show; la entrada productiva es cron/escalar tras puertaCron y la entrega usa el webhook firmado. No exime escrituras ni otras tablas o consultas.',
}];
function consultaExenta(archivo: string, tabla: string, cadena: string): boolean {
  const normalizar = (s: string) => s.replace(/\s+/g, '');
  return EXENCIONES_CONSULTA.some((e) => e.archivo === archivo && e.tabla === tabla
    && normalizar(e.cadena) === normalizar(cadena));
}

const tenantTablas = tablasConTenantId();
const archivosLib = [
  ...fuentesDeProduccion(DIR_LIB),
  ...fuentesDeProduccion(DIR_APP),
].filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));

type Hallazgo = { archivo: string; tabla: string; contexto: string };

const hallazgos: Hallazgo[] = [];
for (const archivo of archivosLib) {
  const original = readFileSync(archivo, 'utf8');
  if (!IMPORTA_ADMIN.test(original)) continue;
  const fuente = sinComentarios(original);
  if (!IMPORTA_ADMIN.test(fuente)) continue; // el import mismo no es un comentario, pero por si acaso

  for (const { tabla, desde } of llamadasFrom(fuente)) {
    if (!tenantTablas.has(tabla)) continue;
    const ventana = ventanaDeCadena(fuente, desde);
    if (/tenant_id/.test(ventana)) continue; // menciona tenant_id en su propia cadena: pasa

    // Solo para escrituras nuevas: la fila de un INSERT/UPSERT se juzga por
    // lo que CONTIENE, y eso puede venir armado antes, en la misma función o
    // en un helper del archivo (`filaTarifa(tenantId, t)`). Un SELECT/UPDATE/
    // DELETE se juzga por lo que FILTRA, y eso tiene que estar en la propia
    // cadena — no se amplía la ventana para esos.
    if (/\.(?:insert|upsert)\(/.test(ventana)) {
      const ampliada = ventanaAmpliadaParaEscritura(fuente, desde);
      if (/tenant_id/.test(ampliada)) continue;
    }

    if (consultaExenta(archivo, tabla, ventana)) continue;
    if (ALLOWLIST[archivo]) continue; // exento a nivel de archivo, con su razón

    hallazgos.push({ archivo, tabla, contexto: ventana.slice(0, 140).replace(/\s+/g, ' ') });
  }
}

describe('capa 2 · toda consulta con supabaseAdmin contra una tabla con tenant_id la filtra', () => {
  it('encontró archivos que importan supabaseAdmin (si no, el escaneo no está mirando nada)', () => {
    const conAdmin = archivosLib.filter((f) => IMPORTA_ADMIN.test(readFileSync(f, 'utf8')));
    expect(conAdmin.length).toBeGreaterThan(20);
  });

  it('la lista de tablas con tenant_id salió de las migraciones (si no, nada se está comparando)', () => {
    expect(tenantTablas.size).toBeGreaterThan(20);
  });

  it('ninguna consulta se queda sin el filtro ni sin una exención con razón', () => {
    expect(
      hallazgos,
      `estas consultas con supabaseAdmin tocan una tabla con tenant_id sin que ` +
        `\`tenant_id\` aparezca en su propia cadena, y el archivo no está en el ALLOWLIST:\n\n` +
        hallazgos.map((h) => `  ${h.archivo} → .from('${h.tabla}')\n    ${h.contexto}…`).join('\n\n') +
        `\n\nSi es un olvido real del filtro: agrégalo. Si es a propósito (como ` +
        `\`lib/admin/negocio.ts\`): añade el archivo al ALLOWLIST de este archivo, con la razón.`,
    ).toEqual([]);
  });
});

describe('exención estrecha del lookup CRM de Cal.com', () => {
  it('autoriza sólo la consulta revisada, no todo el archivo ni la tabla', () => {
    const archivo = 'src/lib/admin/calcom.ts';
    expect(ALLOWLIST[archivo]).toBeUndefined();
    expect(EXENCIONES_CONSULTA[0].razon.length).toBeGreaterThan(100);
    expect(consultaExenta(archivo, 'prospecto', CALCOM_LOOKUP)).toBe(true);
    expect(consultaExenta(archivo, 'viaje', CALCOM_LOOKUP)).toBe(false);
    expect(consultaExenta('src/lib/admin/otro.ts', 'prospecto', CALCOM_LOOKUP)).toBe(false);
    expect(consultaExenta(archivo, 'prospecto', CALCOM_LOOKUP.replace(".eq('correo_normalizado', correo)", ''))).toBe(false);
    expect(consultaExenta(archivo, 'prospecto', ".from('prospecto').update({estado:'cerrado'}).eq('id', id)")).toBe(false);
  });

  it('la exención coincide con una consulta real y el cron exige su puerta antes del mantenimiento', () => {
    const fuente = sinComentarios(readFileSync('src/lib/admin/calcom.ts', 'utf8'));
    const exentas = llamadasFrom(fuente).filter(({ tabla, desde }) =>
      consultaExenta('src/lib/admin/calcom.ts', tabla, ventanaDeCadena(fuente, desde)));
    expect(exentas).toHaveLength(1);
    const cron = sinComentarios(readFileSync('src/app/api/cron/escalar/route.ts', 'utf8'));
    expect(cron).toMatch(/await puertaCron\('escalar'/);
    expect(cron.indexOf('if (puerta) return puerta')).toBeGreaterThan(-1);
    expect(cron.indexOf('if (puerta) return puerta')).toBeLessThan(cron.indexOf('await ejecutarMantenimientoCalcom('));
  });
});
