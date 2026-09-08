#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// LA COMPUERTA DE DESPLIEGUE — OP-P1 / OP-P3 (auditoría 24, BLOQUEANTE).
//
// Producción corría con la base en la migración 0271 mientras `master` pedía
// la forma 0272 de `poliza_datos_tenant`. Las dos verdades (código y esquema)
// solo coincidían si un humano recordaba el orden «migrar → verificar →
// [deploy]». Este script lo convierte en regla:
//
//   · `vercel.json` lo corre como `ignoreCommand`. Exit 0 = construir; exit 1
//     = no construir (Vercel invierte: su ignoreCommand «exit 1» significa
//     «sí construye», por eso el `&& exit 1 || exit 0` del vercel.json).
//   · `salud-produccion.yml` lo corre en cada push con `[deploy]` para que el
//     mismo veredicto salga EN ROJO en Actions —el ignoreCommand de Vercel es
//     silencioso, y un deploy que no ocurre sin decirlo es exactamente OP-P3.
//
// QUÉ COMPARA: la última migración del repo que se va a publicar
// (`supabase/migrations/NNNN_*.sql`) contra `migracion.base` de
// `https://app.likida.ai/api/health`, que la base registra como aplicada
// (`migraciones_aplicadas()`, 0234). Base atrás → no se construye, y el
// mensaje dice qué aplicar.
//
// CUÁNDO SÍ DEJA PASAR AUNQUE NO PUEDA COTEJAR: solo si el health desplegado
// NO publica `migracion` todavía (la versión anterior a esta auditoría) — es
// el arranque, una sola vez; a partir del siguiente deploy la compuerta
// compara. Health caído o base ilegible = NO se construye: un cotejo que no
// pudo hacerse no es un cotejo verde. La salida a la vista es `[deploy:forzar]`
// en el asunto: construye igual y deja el aviso.
// ═══════════════════════════════════════════════════════════════════════════

import { readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const HEALTH_URL = 'https://app.likida.ai/api/health';

/** TODOS los prefijos de cuatro dígitos en `supabase/migrations` (sin repetir, ordenados). */
export function prefijosMigraciones(dir = 'supabase/migrations') {
  const vistos = new Set(
    readdirSync(dir)
      .map((f) => /^(\d{4})_.*\.sql$/.exec(f)?.[1])
      .filter((p) => p !== undefined),
  );
  if (vistos.size === 0) throw new Error(`${dir} sin migraciones`);
  return [...vistos].sort();
}

// La MISMA regex que `decidir()` aplica a la primera línea del commit —
// exportada para que nadie más la reimplemente (ver `ultimoConDeployEnAsunto`
// abajo: auditoría 25, ALTO — `git log --grep` casaba contra asunto Y cuerpo).
export const FLAG_DEPLOY_RE = /\[deploy(?::forzar)?\]/i;

/** El prefijo de cuatro dígitos más alto en `supabase/migrations`. */
export function ultimaMigracion(dir = 'supabase/migrations') {
  const prefijos = prefijosMigraciones(dir);
  return prefijos[prefijos.length - 1];
}

function siguiente(prefijo) {
  return String(Number(prefijo) + 1).padStart(4, '0');
}

/**
 * PURA. `commits` = lista de `{ sha, asunto }`, más nuevo primero (como
 * `git log --format='%H%x1f%s'`). Devuelve el `sha` del primer commit cuyo
 * ASUNTO (no el cuerpo) lleva `[deploy]`/`[deploy:forzar]` — la MISMA regla
 * que `decidir()` aplica al tip de `master` — o `null` si ninguno lo lleva.
 *
 * AUDITORÍA 25, ALTO REINCIDENTE: `salud-produccion.yml` cotejaba con
 * `git log -i --grep='\[deploy' -1`, y `--grep` de git casa contra asunto Y
 * CUERPO. Un merge commit cuyo asunto es "Merge pull request #N from <rama>"
 * (sin la bandera) pero cuyo cuerpo la hereda del commit mergeado pasaba el
 * filtro igual — exactamente lo que le pasó a `4f94490` el 3-sep-2026: el
 * detector se ancló en un commit que Vercel nunca pudo construir (su asunto
 * no lleva `[deploy]`) y quedó en rojo permanente. Esta función es la única
 * fuente de verdad para "el último commit que la compuerta habría publicado",
 * y por eso comparte la regex con `decidir()` en vez de reimplementarla.
 */
export function ultimoConDeployEnAsunto(commits) {
  for (const { sha, asunto } of commits) {
    if (FLAG_DEPLOY_RE.test(String(asunto ?? '').split('\n')[0])) return sha;
  }
  return null;
}

/**
 * PURA. `asunto` = primera línea del commit; `codigo` = última migración del
 * repo; `prefijosCodigo` = TODOS los prefijos del repo (para el cotejo por
 * CONJUNTO, no por máximo — ver el comentario de arriba y `Migracion.aplicados`
 * en `src/app/api/health/migracion.ts`); `health` = el JSON de /api/health, o
 * `null` si no se pudo leer. Devuelve `{ construir, nivel: 'ok'|'aviso'|'error', motivo }`.
 * @param {{ asunto: string, codigo: string, prefijosCodigo?: string[] | null, health: unknown }} p
 */
export function decidir({ asunto, codigo, prefijosCodigo = null, health }) {
  const primera = String(asunto ?? '').split('\n')[0];
  if (!FLAG_DEPLOY_RE.test(primera)) {
    return { construir: false, nivel: 'ok', motivo: 'el asunto no lleva [deploy]: este push NO construye a propósito (vercel.json).' };
  }
  const forzar = /\[deploy:forzar\]/i.test(primera);
  const bloquear = (motivo) => (forzar
    ? { construir: true, nivel: 'aviso', motivo: `${motivo} — [deploy:forzar] en el asunto: se construye igual, bajo tu responsabilidad.` }
    : { construir: false, nivel: 'error', motivo: `${motivo} Si de verdad quieres publicar sin cotejar, pon [deploy:forzar] en el asunto.` });

  if (health === null || typeof health !== 'object') {
    return bloquear(`no se pudo leer ${HEALTH_URL}: sin base cotejada no se despliega.`);
  }
  const m = health.migracion;
  if (m === undefined) {
    return {
      construir: true, nivel: 'aviso',
      motivo: 'el health desplegado no publica `migracion` (versión anterior a la auditoría 24): se construye esta vez; a partir del siguiente deploy la compuerta compara base y código.',
    };
  }
  if (!m || typeof m !== 'object' || typeof m.base !== 'string' || !/^\d{4}$/.test(m.base)) {
    return bloquear(`la base no se pudo cotejar (${(m && m.motivo) || 'sin motivo'}).`);
  }

  // ARQUITECTURA 25 (MEDIO): `base`/`codigo` son MÁXIMOS, y máximo-contra-máximo
  // es fail-OPEN el día que una rama cortada abajo aterrice con un prefijo
  // MENOR al que producción ya trae — `atras` sale en 0 con esa migración sin
  // aplicar. Si el health trae el CONJUNTO completo (`m.aplicados`, desde esta
  // ronda) y aquí tenemos el repo completo (`prefijosCodigo`), se coteja el
  // CONJUNTO: cualquier prefijo del repo que la base no tenga aplicado
  // bloquea, sea o no el más alto.
  if (Array.isArray(m.aplicados) && Array.isArray(prefijosCodigo)) {
    const aplicadosSet = new Set(m.aplicados);
    const faltantes = prefijosCodigo.filter((p) => !aplicadosSet.has(p));
    if (faltantes.length > 0) {
      return bloquear(
        `la base no tiene aplicada(s) ${faltantes.length} migración(es) del repo: ${faltantes.slice(0, 12).join(', ')}${faltantes.length > 12 ? '…' : ''}. ` +
        'Aplícalas primero (scripts/aplicar-migraciones-y-humos.sh, que ahora verifica el conjunto completo contra `migraciones_aplicadas()`), confirma /api/health y vuelve a pushear con [deploy].',
      );
    }
    return { construir: true, nivel: 'ok', motivo: `base ${m.base} tiene aplicado el CONJUNTO completo de migraciones del código (${prefijosCodigo.length}): se construye.` };
  }

  // Sin `m.aplicados` (health de una versión anterior a esta ronda): el
  // cotejo débil, máximo contra máximo — se documenta que es el débil.
  const atras = Number(codigo) - Number(m.base);
  if (atras > 0) {
    return bloquear(
      `la base está en ${m.base} y el código que vas a publicar llega a ${codigo}: faltan ${atras} migración(es) (${siguiente(m.base)}..${codigo}). ` +
      'Aplícalas primero (scripts/aplicar-migraciones-y-humos.sh, que ahora verifica el conjunto completo contra `migraciones_aplicadas()`), confirma /api/health con migracion.atras=0 y vuelve a pushear con [deploy].',
    );
  }
  return { construir: true, nivel: 'ok', motivo: `base ${m.base} a la par del código ${codigo} (cotejo por máximo, health anterior a esta ronda): se construye.` };
}

function asuntoDelCommit(args) {
  const i = args.indexOf('--asunto');
  if (i !== -1 && args[i + 1] !== undefined) return args[i + 1];
  try {
    return execSync('git log -1 --pretty=%s', { encoding: 'utf8' }).trim();
  } catch {
    return (process.env.VERCEL_GIT_COMMIT_MESSAGE ?? '').split('\n')[0];
  }
}

// AUDITORÍA 25, ALTO REINCIDENTE — `/api/health` responde 429 (rateLimit sin
// Redis, "Upstash parpadea") ANTES de calcular `migracion`: el cuerpo es
// `{ok:false,status:'fail',error:'demasiadas peticiones'}`, SIN el campo
// `migracion`. Leer ese cuerpo igual que un 200/503 hacía que `decidir()`
// cayera en la puerta de escape pensada para el ARRANQUE ("el health
// desplegado no publica migracion, versión anterior a la auditoría 24") y
// CONSTRUYERA con la base atrás del código — la pieza BLOQUEANTE se volvía
// no-op justo en el escenario que vino a impedir.
//
// La regla ahora: solo 200 y 503 cuentan como "health leído" (son los dos
// códigos que la propia ruta usa a propósito). Cualquier otro código —429
// incluido— NO se lee; se reintenta unas veces con backoff (Upstash
// parpadea, no está caído) y si sigue sin responder bien se devuelve `null`,
// que `decidir()` ya trata como "no se pudo leer: sin base cotejada no se
// despliega" — fail closed, no una puerta de escape.
export async function leerHealth(url, intentos = 3) {
  for (let i = 0; i < intentos; i++) {
    let r;
    try {
      r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'likida-compuerta-deploy' } });
    } catch (e) {
      console.log(`compuerta: ${url} no contestó (${e instanceof Error ? e.message : String(e)})`);
      if (i === intentos - 1) return null;
      continue;
    }
    if (r.status === 200 || r.status === 503) return await r.json();
    if (r.status === 429 && i < intentos - 1) {
      console.log(`compuerta: ${url} respondió 429 (intento ${i + 1}/${intentos}): reintentando…`);
      await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
      continue;
    }
    console.log(`compuerta: ${url} respondió ${r.status}: no se cuenta como health leído.`);
    return null;
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const iUrl = args.indexOf('--health');
  const url = iUrl !== -1 && args[iUrl + 1] ? args[iUrl + 1] : HEALTH_URL;
  const asunto = asuntoDelCommit(args);
  const prefijosCodigo = prefijosMigraciones();
  const codigo = prefijosCodigo[prefijosCodigo.length - 1];
  const health = await leerHealth(url);
  const v = decidir({ asunto, codigo, prefijosCodigo, health });
  const enActions = !!process.env.GITHUB_ACTIONS;
  const prefijo = v.nivel === 'error' ? (enActions ? '::error::' : 'ERROR: ') : v.nivel === 'aviso' ? (enActions ? '::warning::' : 'AVISO: ') : '';
  console.log(`compuerta de despliegue · asunto="${asunto.slice(0, 80)}" · código=${codigo} · base=${health?.migracion?.base ?? '?'}`);
  console.log(`${prefijo}${v.motivo}`);
  console.log(v.construir ? 'compuerta: CONSTRUIR' : 'compuerta: NO construir');
  process.exit(v.construir ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
