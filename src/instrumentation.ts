// Hook de arranque de Next.js (se ejecuta una vez al iniciar el servidor) y
// punto único de captura de los errores que ninguna superficie web atrapa.

/**
 * Arranque. El orden importa: primero se dice si hay observabilidad, después se
 * enciende, y solo entonces se prueban las migraciones — así el diagnóstico de
 * las migraciones sale por un canal que ya existe, y no se pierde si es
 * precisamente eso lo que falla.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return; // solo runtime Node del servidor

  // Auditoría 5: `SENTRY_DSN` no estaba en Vercel y el sistema arrancaba igual,
  // sin decirlo. El cableado existía desde antes; lo que faltaba era que la
  // ausencia se oyera. Ver observability/sentry.ts.
  const obs = await import('@/lib/observability/sentry');
  obs.avisarObservabilidad();
  await obs.precargar();

  // Y las variables cuya ausencia no rompe nada pero contesta mal (DEMO_TENANT_ID
  // es la cara: el panel pinta cero liquidaciones y parece que el producto no
  // guardó nada). Va después de encender Sentry para que el aviso tenga destino.
  const { avisarConfiguracionSilenciosa } = await import('@/lib/observability/arranque');
  avisarConfiguracionSilenciosa();

  const { verificarMigracionesCriticas, verificarAvisoDePrivacidad } = await import('@/lib/likida/startup');
  // TAMPOCO SE ESPERA (auditoría prod 22-ago-2026, RES-2): eran once sondeos
  // en serie contra la base, sin tope de consulta, y `register()` retenía la
  // primera petición de la instancia fría hasta que todos contestaran. Ahora
  // corren en paralelo, acotados, y el diagnóstico sale por el log sin
  // bloquear el primer 200. Nunca lanza; el catch es por si acaso.
  void verificarMigracionesCriticas().catch(() => { /* ya se reportó dentro */ });

  // Y si la liga del aviso de privacidad EXISTE. Es lo único que distingue un
  // dominio bien escrito de uno sin registrar, y hasta la auditoría 6 la función
  // que lo comprueba no la llamaba nadie más que sus pruebas. Va al final porque
  // hace una petición de red: no puede retrasar el diagnóstico de lo demás.
  //
  // Y NO SE ESPERA (auditoría 18, B11): `register()` tiene que terminar antes
  // de que el servidor atienda la primera petición, y esto son hasta 10s de
  // red hacia un tercero (HEAD + GET con 5s cada uno) que no tiene nada que
  // ver con liquidar. Una instancia fría del webhook pagaba ese sondeo ANTES
  // del primer 200 a Meta. Se dispara y se deja correr: el diagnóstico sale
  // por el log igual, solo que ya no bloquea el arranque. Nunca lanza, pero
  // el catch está para que un rechazo tampoco sea un unhandledRejection.
  void verificarAvisoDePrivacidad().catch(() => { /* ya se reportó dentro */ });
}

type PeticionConError = { path?: string; method?: string; headers?: Record<string, string> } | undefined;
type ContextoDeError = { routerKind?: string; routePath?: string; routeType?: string } | undefined;

/**
 * Next llama a esto ante CUALQUIER error no atrapado del servidor: Server
 * Components, route handlers, acciones y proxy.
 *
 * Es la única forma de instrumentar las superficies web sin tocar `src/app/`:
 * hasta la auditoría 5, `src/app/` no importaba el `logger` en ningún archivo
 * salvo el webhook, así que el panel, `/acceso` y las rutas de API fallaban
 * **sin dejar una sola línea en el servidor**. Escenario del 6 de agosto: el
 * contralor ve "No se pudo cargar el panel" en la sala y no hay nada que
 * buscar después.
 *
 * Se registra el `digest` porque es el hash que Next enseña en pantalla: es lo
 * único que se le puede pedir al usuario para localizar SU fallo entre todos.
 *
 * Nunca lanza: un error aquí se sumaría al que ya está ocurriendo y se comería
 * la página de error de Next.
 */
export async function onRequestError(
  err: unknown,
  request: PeticionConError,
  context: ContextoDeError,
): Promise<void> {
  try {
    const { logger } = await import('@/lib/logger');
    const { reportarExcepcion, digestDe, flushObservabilidad } = await import(
      '@/lib/observability/sentry'
    );

    logger.error('request.fail', {
      ruta: context?.routePath ?? request?.path,
      tipo: context?.routeType,
      metodo: request?.method,
      digest: digestDe(err),
      err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });

    reportarExcepcion(err, {
      ruta: context?.routePath ?? request?.path,
      tipo: context?.routeType,
      metodo: request?.method,
    });
    // Aquí sí se puede esperar: la respuesta al usuario ya se decidió, y este es
    // el punto donde la invocación está a punto de terminar.
    await flushObservabilidad();
  } catch {
    /* el reporte del fallo no puede ser otro fallo */
  }
}
