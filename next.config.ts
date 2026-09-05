import type { NextConfig } from 'next';
import { readdirSync } from 'node:fs';

/**
 * La ÚLTIMA migración del repo (`0276` de `0276_prospecto_empleados.sql`),
 * leída EN BUILD y publicada como `process.env.LIKIDA_MIGRACION_CODIGO`.
 *
 * AUDITORÍA 24, OP-P1 (BLOQUEANTE): producción corría con la base en 0271 y
 * el código de master pidiendo la forma 0272 de `poliza_datos_tenant`, y nada
 * lo decía. `/api/health` compara este número contra lo que la base registra
 * aplicado (`migraciones_aplicadas()`, 0234) y se degrada si la base va atrás.
 * Se lee aquí, en build, porque el bundle de la función EXCLUYE `supabase/**`
 * (ver `outputFileTracingExcludes` abajo): en Vercel no hay carpeta que leer
 * en runtime. `next.config.ts` corre en la Mac o en el runner con el repo
 * entero, y `env` inlinea el valor en el bundle.
 */
function ultimaMigracionDelRepo(): string {
  const prefijos = readdirSync('supabase/migrations')
    .map((f) => /^(\d{4})_.*\.sql$/.exec(f)?.[1])
    .filter((p): p is string => p !== undefined)
    .sort();
  if (prefijos.length === 0) throw new Error('supabase/migrations sin migraciones: el health no podría comparar código y base');
  return prefijos[prefijos.length - 1];
}

const nextConfig: NextConfig = {
  env: { LIKIDA_MIGRACION_CODIGO: ultimaMigracionDelRepo() },
  // SEG-8 (auditoría 24): `x-powered-by: Next.js` no aporta nada al cliente y
  // le dice al que escanea qué framework y, por versión, qué CVE probar.
  poweredByHeader: false,
  // ── FE-1 (auditoría 24, CRÍTICO): LAS SUBIDAS POR SERVER ACTION MORÍAN EN 1 MB ──
  // Next capa el cuerpo de una server action a 1 MB por default. Las pantallas
  // del panel tenían topes de 2, 4 y 8 MB (`MAX_XML_BYTES`, `MAX_FOTO_BYTES`,
  // `MAX_DESGLOSE_BYTES`, `MAX_IMPORT_BYTES` en `src/app/dashboard/**`) y los
  // validan DENTRO de la action — que nunca corría: el runtime rebotaba antes
  // con una excepción que el error boundary pintaba como «No se pudo cargar el
  // panel». El consolidado mensual de TAG de 800 tractos, la foto de celular
  // de una factura de proveedor y el CSV de 2,000 viajes del TMS —las tres
  // puertas de entrada masiva— no funcionaban con archivos reales.
  //
  // Este límite de Next no eleva los4.5MB de Vercel Functions. Las subidas
  // actuales usan como máximo4MiB y las tres vías antes en8MiB ahora validan
  // también en el navegador, antes de enviar. La prueba
  // `scripts/ci/next_config_subidas_aud24.test.ts` lee este archivo y los
  // `MAX_*_BYTES` y falla si alguien sube un tope de pantalla por encima de
  // este límite, o lo baja aquí por debajo de lo que las pantallas prometen.
  experimental: {
    serverActions: { bodySizeLimit: '10mb' },
  },
  // `zxing-wasm` va aquí a propósito: el lector es WebAssembly y el `.wasm` se
  // lee de node_modules en tiempo de ejecución (ver cfdi.ts). Si el bundler se
  // lo lleva, el binario deja de estar donde `require.resolve` lo busca y el
  // decodificador truena EN EL DEPLOY, no en local — el modo de fallo caro.
  // `playwright-core` entra aquí desde que `/api/cron/facturar` lo alcanza (vía
  // `facturacion/adaptadores/pagina_playwright.ts`). Resuelve su driver y sus
  // utilidades con `require` calculados en runtime; bundlearlo deja esas rutas
  // apuntando a archivos que no existen y el fallo aparece EN EL DEPLOY, no en
  // local, que es el modo caro. Misma razón que `zxing-wasm`.
  // `@sparticuz/chromium` va por DOS razones, y las dos aparecen solo en el
  // deploy: (1) su `getBinPath()` calcula la carpeta `bin/` desde
  // `import.meta.url`, así que si el bundler mueve el módulo la ruta apunta a
  // un sitio donde no están los `.br` —el propio paquete lanza ahí un error que
  // dice "you must externalize @sparticuz/chromium"—; (2) es ESM puro con
  // efecto de módulo (pone LD_LIBRARY_PATH y FONTCONFIG_PATH al importarse),
  // y eso hay que dejarlo pasar tal cual.
  serverExternalPackages: ['sharp', 'zxing-wasm', 'pdf-lib', 'playwright-core', '@sparticuz/chromium'],
  // El `.wasm` del lector se lee de disco en runtime (ver cfdi.ts), sin ningún
  // import que el tracer pueda seguir — así que hay que meterlo a la fuerza al
  // bundle de la función. Sin esto el webhook despliega "bien" y truena al
  // decodificar el primer código, que es el modo de fallo caro.
  //
  // Los `bin/*.br` de `@sparticuz/chromium` son el MISMO caso: 66 MB de
  // archivos que ningún `import` menciona. El paquete los abre en runtime con
  // una ruta calculada (`dirname(import.meta.url) + "/../bin"`), y el tracer no
  // sigue eso. Sin este include el deploy sale "bien" y el cron responde 503
  // diciendo que el paquete no dio binario — el modo de fallo caro otra vez.
  // Va SOLO en la función del cron: es la única que abre un navegador, y meter
  // 66 MB en todas las demás las acercaría al límite de 250 MB sin motivo.
  outputFileTracingIncludes: {
    '/api/webhook/whatsapp': ['./node_modules/zxing-wasm/dist/reader/*.wasm'],
    '/api/cron/facturar': [
      './node_modules/@sparticuz/chromium/bin/**',
      './node_modules/playwright-core/browsers.json',
    ],
    // El callback de QStash ejecuta la MISMA lógica (procesarLoteEnCola) — su
    // bundle también necesita el binario de Chromium y el browsers.json de
    // playwright-core, o revienta con "Cannot find module browsers.json".
    '/api/cron/facturar/cola': [
      './node_modules/@sparticuz/chromium/bin/**',
      './node_modules/playwright-core/browsers.json',
    ],
  },
  // Cinturón, además del tirante. `cfdi.ts` lee el `.wasm` de disco en runtime y
  // eso hace que el tracer considere alcanzable cualquier archivo bajo el
  // proyecto: en una medición del 28-jul-2026 se colaron 348 archivos ajenos al
  // bundle, entre ellos `.env.local` —con la service role key, el token de
  // WhatsApp y el app secret— y 76 documentos internos de auditoría.
  //
  // Ninguno de esos archivos lo lee la función. Los secretos ya viven en las
  // variables de entorno de Vercel, así que subir además el fichero es superficie
  // regalada; y los .md son las notas internas del proyecto.
  //
  // ── LA LISTA SE ESCRIBIÓ CONTRA UN INVENTARIO; AHORA VA CONTRA EL TRACE ────
  //
  // Los excludes de arriba funcionaron: medido sobre
  // `.next/server/app/api/webhook/whatsapp/route.js.nft.json`, no queda ni un
  // `.md`, ni un `.env*`, ni `docs/`, ni `supabase/`, ni un `*.test.*`.
  //
  // Pero se escribieron listando lo que se sabía que sobraba, no leyendo lo que
  // de verdad entró. Y entraron 145 archivos del proyecto, 4.22 MB: el
  // `tsbuildinfo`, el lockfile, las fotos de los fixtures, el sistema de diseño,
  // las 19 fichas YAML, los arneses de pago y 82 archivos de TypeScript SIN
  // COMPILAR. Nada de eso lo abre la función.
  //
  // Verificado antes de excluir, que es la parte que importa: el ÚNICO archivo
  // que este bundle lee de disco en runtime es el `.wasm` de zxing, y vive bajo
  // `node_modules` (`cfdi.ts:213`, la ruta que el include de arriba protege).
  // `command grep -rn "readFileSync\|readFile(\|process.cwd()" src/` no devuelve
  // ningún otro lector, y las rutas `normas/*.yaml` de `indice.ts` son cadenas
  // de referencia para un humano — nadie las abre (`indice.ts:9`).
  //
  // Se excluye `src/**/*.ts` y `*.tsx`, no `src/**`: un `.ts` no lo puede
  // ejecutar el runtime de la función —ahí corre lo compilado de `.next/`—, así
  // que sacarlo es seguro por construcción. Excluir la carpeta entera no lo
  // sería: el día que alguien meta una plantilla o un asset bajo `src/` y lo lea
  // en runtime, el bundle lo seguiría llevando y esta lista no lo rompería.
  //
  // PARA VOLVER A MEDIR (es lo que nadie hizo, y por eso se coló todo esto):
  //   npm run build && node -e "const{readFileSync,statSync}=require('fs'),p=require('path');
  //   const T='.next/server/app/api/webhook/whatsapp/route.js.nft.json';
  //   const {files}=JSON.parse(readFileSync(T,'utf8'));let n=0,b=0;
  //   for(const f of files){const a=p.resolve(p.dirname(T),f);
  //   if(a.includes('node_modules'))continue;try{b+=statSync(a).size;n++}catch{}}
  //   console.log(n,'archivos del proyecto,',(b/1048576).toFixed(2),'MB')"
  //
  // Medido el 28-jul-2026, mismo build, antes y después de esta lista:
  //
  //                       archivos      tamaño     del proyecto
  //   antes                    623     24.18 MB     145 arch / 4.22 MB
  //   después                  498     22.46 MB      20 arch / 2.51 MB
  //   de node_modules          478     19.96 MB     (idéntico: no se tocó nada
  //                                                  que una dependencia use)
  //
  // De los 20 que quedan, 13 son los chunks compilados de `.next/` (2.55 MB) y
  // el resto son los config del proyecto y `src/app/globals.css` —que sobrevive
  // justo porque el exclude es por extensión y no por carpeta—.
  //
  // El arranque en frío lo sigue mandando `sharp-libvips` con 15.34 MB (68% de
  // la función), y ese no se puede excluir porque sí se usa: `cfdi.ts` reduce la
  // imagen a 1600 px con `sharp` antes de pasarla a zxing.
  outputFileTracingExcludes: {
    '*': [
      './.env*', './**/*.md', './**/*.test.*', './docs/**', './supabase/**', './scripts/**',
      // Artefactos de build, de instalación y de herramientas: los produce el
      // propio repo, no los consume la función.
      //
      // `coverage/` está aquí por haberlo visto pasar: entre dos builds del
      // 28-jul alguien corrió el reporte de cobertura y sus 28 archivos (192 KB)
      // aparecieron en el trace sin que nadie tocara nada. Es LITERALMENTE el
      // modo de fallo de esta lista —una carpeta nueva se cuela sola—, y la razón
      // es que `cfdi.ts` lee el `.wasm` con `process.cwd()`, lo que hace que el
      // tracer dé por alcanzable todo lo que cuelgue de la raíz del proyecto.
      // Cualquier carpeta generada que aparezca después va a colarse igual: hay
      // que volver a medir el trace, no confiar en esta lista.
      './tsconfig.tsbuildinfo', './package-lock.json', './schema.sql',
      './coverage/**', './.vercel/**',
      // Fuente sin compilar. La función ejecuta lo de `.next/`, no esto.
      './src/**/*.ts', './src/**/*.tsx',
      // Insumos de prueba: la foto de 131 KB del fixture de códigos entre ellos.
      './src/**/__fixtures__/**',
      // Arneses que hacen llamadas REALES de pago. Que viajen en el bundle de
      // producción es, además de peso, superficie que nadie quiere ahí.
      './pruebas-manuales/**',
      // Material de referencia humano: el sistema de diseño y las 19 fichas
      // normativas. `indice.ts` las cita por nombre; el runtime nunca las abre.
      './design-system/**', './normas/**',
    ],
  },
  // `next dev` compila `instrumentation.ts` también para el runtime edge, aunque
  // `register()` ya se sale con `if (process.env.NEXT_RUNTIME !== 'nodejs') return`
  // antes de tocar nada — el análisis estático de webpack resuelve los `import()`
  // igual, y truena en "Module not found: crypto" porque esa cadena (startup.ts →
  // repo.ts → meta/client.ts) sí usa `crypto` de Node. Bug abierto de Next.js
  // (vercel/next.js#86479), solo en dev, nunca en producción. `crypto` nunca se
  // ejecuta de verdad en edge —el guard ya lo impide—, así que basta con que el
  // bundle de edge lo trate como ausente para que compile.
  webpack: (config, { nextRuntime }) => {
    if (nextRuntime === 'edge') {
      config.resolve.fallback = { ...config.resolve.fallback, crypto: false };
    }
    return config;
  },
  // ═══════════════════════════════════════════════════════════════════════
  // CABECERAS DE SEGURIDAD — auditoría externa del 15-ago-2026, P2.
  //
  // LA AUDITORÍA DICE "no encontramos CSP en next.config.ts" Y TIENE RAZÓN
  // EN LA LETRA: no está aquí. Pero SÍ EXISTE, enforced (no Report-Only),
  // desde la auditoría 10 — vive en `src/proxy.ts` (Next 16 renombró
  // `middleware.ts` a `proxy.ts`, que es probablemente por qué el escaneo
  // externo no la vio: miró el archivo con el nombre de siempre). Esa CSP
  // fue construida recorriendo qué carga esta app de verdad —no una
  // plantilla— y tiene su propia batería de pruebas (`proxy.test.ts`):
  // presencia del header en página pública, en el redirect a /login y en
  // una respuesta con sesión, `unsafe-eval` SOLO en desarrollo (con una
  // prueba que fija el incidente del 8-ago: sin él, Fast Refresh nunca
  // hidrata y el panel se queda pegado en el skeleton para siempre), y el
  // resto de las cabeceras (X-Frame-Options, X-Content-Type-Options,
  // Referrer-Policy, Permissions-Policy, HSTS en producción).
  //
  // RE-VERIFICADO para esta entrega, no asumido: el fondo con shader WebGL
  // que la CSP de `proxy.ts` documenta como riesgo ya NO EXISTE — cambió a
  // un lienzo plano `var(--bg)` el 12-ago-2026 (`src/app/fondo.tsx`, ver su
  // propio historial). Sentry sigue siendo server-only (no hay
  // `NEXT_PUBLIC_SENTRY_DSN` ni `instrumentation-client.ts` en el repo), así
  // que `connect-src 'self'` sigue siendo toda la excepción que hace falta.
  //
  // ESTA ENTREGA NO TOCA `proxy.ts` — no está en el alcance asignado, y
  // duplicar la CSP aquí habría sido el riesgo real: dos cabeceras
  // `Content-Security-Policy` para la MISMA respuesta no se promedian ni se
  // ignoran, el navegador aplica cada directiva por la intersección más
  // estricta de las dos — dos políticas escritas por separado, sin
  // coordinarse, es exactamente "una CSP mal puesta tumba el producto".
  //
  // LA BRECHA REAL: el `matcher` de `proxy.ts` EXCLUYE `/api` a propósito
  // ('/((?!api|_next/static|_next/image|favicon.ico).*)') — el webhook de
  // WhatsApp, los cuatro export y /v1 no pasan por esa capa, y hasta esta
  // entrega no llevaban NINGUNA cabecera de seguridad. Ese es el hueco que
  // se cierra aquí, sin pisar lo que ya funciona.
  //
  // ENFORCE DIRECTO, NO REPORT-ONLY, y es una decisión — no un descuido.
  // Report-Only tiene sentido cuando existe riesgo real de romper algo que
  // SÍ se ejecuta (un script, un estilo, una imagen). `/api/*` nunca sirve
  // HTML: es JSON (`/v1`, `/demo`), CSV (los cuatro export), o un 200/429
  // sin cuerpo relevante (el webhook) — no hay script ni estilo que un
  // navegador vaya a intentar correr desde esa respuesta, así que
  // `default-src 'none'` no tiene nada legítimo que romper. Dejarla en modo
  // reporte sin un endpoint que reciba los reportes (construir uno es una
  // ruta nueva, `/api/algo`, fuera del alcance de esta entrega: solo se
  // autorizó tocar `ratelimit.ts`, sus llamadores, este archivo y la
  // migración 0113) habría sido ruido sin protección real.
  //
  // VERIFICADO con el dev server (`npm run dev`): `curl -i` contra una ruta
  // de `/api` y contra `/login` confirma que cada una lleva SOLO su propio
  // juego de cabeceras — no hay colisión porque no hay traslape de rutas.
  // ═══════════════════════════════════════════════════════════════════════
  async headers() {
    const produccion = process.env.NODE_ENV === 'production';
    return [
      {
        source: '/api/:path*',
        headers: [
          // Sin script, sin estilo, sin imagen que cargar desde una
          // respuesta que nunca es HTML: la política más cerrada que existe
          // no tiene costo aquí. `frame-ancestors`/`base-uri` en 'none'
          // porque nada de esto se sirve para incrustarse ni para servir de
          // base de una página.
          { key: 'Content-Security-Policy', value: "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" },
          // Cinturón sobre la CSP de arriba — mismo criterio "cinturón y
          // tirantes" que ya usa proxy.ts entre CSP y X-Frame-Options.
          { key: 'X-Frame-Options', value: 'DENY' },
          // El que de verdad importa para /api: el export de CSV entrega
          // texto que un chofer o un ERP no controlan del todo (conceptos,
          // notas) — sin nosniff, un navegador que abra la URL directo
          // podría intentar adivinar el tipo de contenido en vez de
          // respetar el `Content-Type: text/csv` que la ruta ya declara.
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'geolocation=(), microphone=(), camera=()' },
          // Mismo criterio que proxy.ts: HSTS solo tiene efecto sobre un
          // origen HTTPS real, así que restringirla a producción evita
          // publicar una cabecera que en `localhost` no hace nada, no una
          // que haga daño — pero se sigue el mismo patrón por consistencia.
          // SEG-5 (auditoría 24): mismo valor que `HSTS` en `src/proxy.ts`.
          ...(produccion ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' }] : []),
        ],
      },
    ];
  },
};

export default nextConfig;
