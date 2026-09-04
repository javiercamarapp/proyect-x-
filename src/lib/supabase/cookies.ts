// ═══════════════════════════════════════════════════════════════════════════
// LAS OPCIONES DE LA COOKIE DE SESIÓN — un solo sitio, dos clientes.
//
// AUDITORÍA PROD (22-ago-2026) · SEG-3. `@supabase/ssr` escribe la cookie de
// sesión con `httpOnly: false` por default (verificable en
// `node_modules/@supabase/ssr/dist/main/utils/constants.js`: la lista trae
// `path`, `sameSite: 'lax'`, `httpOnly: false` y el `maxAge` de 400 días).
// El motivo del default es que el cliente de NAVEGADOR
// (`createBrowserClient`) necesita leerla desde JavaScript.
//
// AQUÍ NO EXISTE ESE CLIENTE. Se verificó en todo `src/`: cero
// `createBrowserClient`, cero `document.cookie`, cero `js-cookie`. Los dos
// únicos lugares que tocan la sesión son de servidor —`proxy.ts` y
// `supabase/server.ts`—, así que la cookie no tiene por qué ser legible desde
// el navegador, y siéndolo, cualquier XSS que se cuele por el
// `script-src 'unsafe-inline'` del CSP se lleva el token de sesión completo
// del contralor. Con `httpOnly` ese mismo XSS ya no puede leerlo.
//
// Vive en su propio archivo para que `proxy.ts` (runtime de proxy) y
// `server.ts` (Node) usen EXACTAMENTE la misma decisión: dos copias de esto
// se desincronizan en el primer cambio, y la que se quede atrás lo hace en
// silencio. No importa `next/headers` ni nada de Node a propósito — el proxy
// no podría importarlo.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Lo que se le impone a la cookie de sesión, encima de lo que ponga el SDK.
 *
 * `Secure` se fuerza en producción: HSTS ayuda al navegador, pero no sustituye
 * el atributo de la cookie. En local queda apagado para que `npm run dev`
 * funcione sobre http://localhost. `SameSite=Lax` conserva el retorno del
 * magic link y `path=/` evita cookies de sesión con alcances distintos.
 */
export const COOKIES_DE_SESION = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
} as const;
