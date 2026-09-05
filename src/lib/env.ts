// Inventario de las variables de entorno cuya ausencia sí rompe algo, y quién
// falta de cada grupo.
//
// ═══════════════════════════════════════════════════════════════════════════
// POR QUÉ ESTO REPORTA Y YA NO LANZA (auditoría 5, MEDIO)
//
// Aquí vivía `requireEnv(group)`, que lanzaba con un mensaje claro y cuyo propio
// comentario decía «llamar en los paths críticos». Verificado con dos búsquedas
// distintas: la única aparición en todo el repo era su definición. Nunca se
// invocó. Un validador que nadie llama no es una defensa, es una promesa: al
// leer el archivo parece que la configuración está vigilada.
//
// No se le buscó un sitio donde lanzar, se cambió el mecanismo, por dos razones:
//
//   · Lanzar en el arranque de una función serverless no detiene nada — Vercel
//     vuelve a levantar la instancia en la siguiente petición. Convierte un
//     problema de configuración en una tormenta de 500 sin explicación, que es
//     peor que arrancar mal y decirlo.
//   · El resto del sistema ya decidió reportar en vez de lanzar cuando la
//     alternativa es tumbar el turno de un operador (`observability/arranque.ts`,
//     `likida/startup.ts`). Dos criterios distintos para lo mismo es lo que hace
//     que uno de los dos se ignore.
//
// Ahora `faltantes()` tiene un consumidor real: `avisarConfiguracionSilenciosa()`
// lo emite en el arranque de cada instancia desplegada. Si vuelve a quedarse sin
// llamar, sobra.
// ═══════════════════════════════════════════════════════════════════════════

const GROUPS = {
  llm: ['OPENROUTER_API_KEY'],
  whatsapp: ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET'],
  // `NEXT_PUBLIC_SUPABASE_ANON_KEY` entró al grupo con el login por usuario: la
  // usan `proxy.ts` y `supabase/server.ts`, así que sin ella `createServerClient`
  // lanza DENTRO del middleware y CADA petición a /dashboard se vuelve un 500.
  // Rompe ruidosamente, sí, pero en el turno de alguien y con el error del SDK:
  // aquí sale antes, con el nombre exacto.
  supabase: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
} as const;

export type EnvGroup = keyof typeof GROUPS;

const GRUPOS = Object.keys(GROUPS) as EnvGroup[];

// AUDITORÍA 1, CRÍTICO (Operabilidad): un valor MARCADOR se leía como "puesta".
// El 20-ago seis variables de Vercel quedaron con el valor literal "[SENSITIVE]"
// (el enmascarado del dashboard, re-guardado) y `!!process.env[k]` las daba por
// completas — el OCR facturó cero durante horas y el health-check decía verde.
// Un secreto, una URL o un token REALES nunca se ven así: envueltos en [..]/<..>,
// vacíos, o una plantilla sin llenar. Se rechazan por CONTENIDO, no solo presencia.
const MARCADOR = /^\s*(\[[^\]]*\]|<[^>]*>|tu[-_ ].*|xxx+|changeme|placeholder|your[-_ ].*)\s*$/i;

/** Validador reutilizable para configuración recibida por argumento. Mantiene
 * el mismo criterio que `envPuesta`, sin obligar al consumidor a escribir el
 * valor en `process.env` para poder validarlo. */
export function valorEntornoReal(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '' && !MARCADOR.test(v);
}

/** Piso defensivo para secretos operativos. La longitud evita claves humanas
 * triviales y la diversidad detecta rellenos como `aaaaaaaa...`; no pretende
 * estimar criptográficamente la entropía de una contraseña elegida a mano. */
export function secretoEntornoSeguro(v: unknown, minimo = 32): v is string {
  if (!valorEntornoReal(v)) return false;
  const limpio = v.trim();
  return limpio.length >= minimo && new Set(limpio).size >= 10;
}

/** `true` solo si la variable trae un valor REAL, no un marcador ni un hueco. */
export function envPuesta(k: string): boolean {
  return valorEntornoReal(process.env[k]);
}

/**
 * Qué variable falta de cada grupo. Objeto vacío = todo puesto.
 *
 * Devuelve NOMBRES, nunca valores: lo consume el log de arranque de producción.
 */
export function faltantes(): Partial<Record<EnvGroup, string[]>> {
  const out: Partial<Record<EnvGroup, string[]>> = {};
  for (const g of GRUPOS) {
    const sinPoner = GROUPS[g].filter((k) => !envPuesta(k));
    if (sinPoner.length) out[g] = sinPoner;
  }
  return out;
}

/** Reporte de configuración (para un health-check / panel admin). */
export function envHealth(): Record<EnvGroup, boolean> {
  return {
    llm: GROUPS.llm.every(envPuesta),
    whatsapp: GROUPS.whatsapp.every(envPuesta),
    supabase: GROUPS.supabase.every(envPuesta),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// URL BASE DE LA APP — UN SOLO ACCESOR (auditoría 18, A2)
//
// `process.env.NEXT_PUBLIC_APP_URL || 'https://app.likida.ai'` estaba copiado
// a mano en 10 archivos y ya había divergido: `suscripcion/page.tsx` caía a
// `''` y mandaba a Stripe una `return_url` RELATIVA, que Billing Portal
// rechaza. El 17-ago el suelo cambió de `likida.ai` a `app.likida.ai` y hubo
// que tocar cada copia; olvidar una no rompe el build ni ningún test.
//
// Este módulo no importa nada, así que sirve igual en servidor y en cliente:
// `NEXT_PUBLIC_*` se inyecta en build en los dos bundles.
// ═══════════════════════════════════════════════════════════════════════════

/** Suelo: el dominio del SOFTWARE. `likida.ai` es la landing y no tiene `/auth/callback`. */
export const APP_URL_SUELO = 'https://app.likida.ai';

/**
 * URL base de la app, SIN barra final, lista para concatenar `/ruta`.
 * Cae al suelo si la variable falta o trae un marcador (`[SENSITIVE]`).
 */
export function appUrl(): string {
  const v = envPuesta('NEXT_PUBLIC_APP_URL') ? String(process.env.NEXT_PUBLIC_APP_URL).trim() : APP_URL_SUELO;
  return v.replace(/\/+$/, '');
}
