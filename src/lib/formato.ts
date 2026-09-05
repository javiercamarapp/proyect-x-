// ═══════════════════════════════════════════════════════════════════════════
// CÓMO SE IMPRIME UNA CIFRA. UNA SOLA VEZ, PARA TODO EL PRODUCTO.
//
// POR QUÉ ESTE ARCHIVO EXISTE Y NO ESTÁ EN `utils.ts`, QUE ERA LO OBVIO:
// `utils.ts` importa `clsx` y `tailwind-merge` para `cn()`, que son librerías de
// CSS del panel. El motor del cuadre (`engine.ts`) es puro y sin I/O, y el PDF
// viaja en el bundle de la función del webhook: ninguno de los dos tiene por qué
// arrastrar el sistema de clases de Tailwind para escribir "$1,234.56".
//
// Hoy el tree-shaking de Next lo salva —se midió sobre el `.nft.json` del
// webhook y `clsx` no entra—, pero eso depende de que nadie añada un
// side-effect a `utils.ts`. Un archivo sin una sola importación no depende de la
// suerte. `utils.ts` reexporta de aquí para no romper al panel.
//
// ── EL HALLAZGO QUE CIERRA, Y VA POR SU TERCERA RONDA ──────────────────────
//
// `mxn()` estaba escrita A MANO en el producto, y el número CRECÍA entre rondas:
//
//     ronda 6 →  3 sitios
//     ronda 7 →  8 sitios
//     hoy     → 11 sitios  (7 de moneda + los de litros)
//
// Siete copias idénticas de la misma línea, cada una en un archivo que imprime
// dinero que el contralor lee: el PDF, el resumen de WhatsApp, el panel, el
// aviso del tope del 15%, los acreditables y el motor. Que sean idénticas HOY no
// es una defensa: el hallazgo gemelo de `litros()` ya se divergió una vez, y ahí
// el panel decía "1,235 L" donde el PDF decía "1,234.56 L".
//
// Una cifra fiscal que se lee distinta en dos pantallas se lee como dos
// cálculos distintos.
// ═══════════════════════════════════════════════════════════════════════════

/** Zona del cliente: la flota, el contralor y el SAT están todos aquí. */
export const TZ_MX = 'America/Mexico_City';

/**
 * HOY en México como `AAAA-MM-DD` (o el día de México de la fecha que se pase).
 * `en-CA` es el locale cuyo formato corto YA es ISO: no hay que rearmar.
 *
 * Antes esto se escribía a mano en ~38 sitios con dos ortografías
 * (`toLocaleDateString('en-CA', { timeZone: TZ_MX })` e
 * `Intl.DateTimeFormat('en-CA', …)`) y dos de ellos ni usaban la constante:
 * hardcodeaban 'America/Mexico_City'. El guardia de formato.test.ts ahora lo
 * impide. Si pasa una fecha inválida lanza (RangeError), igual que antes.
 */
export function hoyMx(fecha: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ_MX, year: 'numeric', month: '2-digit', day: '2-digit' }).format(fecha);
}

/** Día natural de un instante en una zona IANA. Postgres es la autoridad para
 * persistir el bucket; este helper sólo cubre el fallback de despliegue y hace
 * explícito que el servidor no debe usar su zona local. */
export function diaEnZona(momento: Date, zonaHoraria: string): string {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: zonaHoraria, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(momento);
  const valor = (tipo: Intl.DateTimeFormatPartTypes) =>
    partes.find((p) => p.type === tipo)?.value;
  const dia = `${valor('year')}-${valor('month')}-${valor('day')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) throw new Error(`zona IANA inválida: ${zonaHoraria}`);
  return dia;
}


/**
 * El desfase fijo de México contra UTC, para armar un instante a partir de un
 * día de calendario. Va en horas enteras y NO cambia en todo el año: México
 * dejó el horario de verano en 2022 (por eso `TZ_MX` puede tratarse como
 * UTC−6 sin ramas). Vive aquí, junto a `TZ_MX`, porque un `-06:00` tecleado
 * en cada consulta es la misma clase de copia que ya divergió con `mxn()`.
 */
export const OFFSET_MX = '-06:00';

/**
 * El PRIMER instante de un día de México, en ISO con offset:
 * `'2026-12-31'` → `'2026-12-31T00:00:00-06:00'`.
 *
 * AUDITORÍA PROD, DAT-08/DAT-23 — el corte de una ventana se armaba con
 * `${dia}T00:00:00Z`, que es la MEDIANOCHE DE LONDRES: las 18:00 del día
 * ANTERIOR en México. Todo lo capturado entre las 18:00 y las 24:00 caía del
 * lado equivocado del filtro, y el 31 de diciembre eso significa cifras del
 * ejercicio fiscal que no es.
 */
export function inicioDiaMx(dia: string): string {
  return `${dia}T00:00:00${OFFSET_MX}`;
}

/**
 * El ÚLTIMO instante representable de un día de México:
 * `'2026-12-31'` → `'2026-12-31T23:59:59.999-06:00'`.
 *
 * Para un `lte` inclusivo. Cuando el filtro admite media abierta es preferible
 * `inicioDiaMx(díaSiguiente)` con `lt` —no deja el hueco del último
 * milisegundo—, pero PostgREST no siempre permite reescribir el operador y
 * este es el cierre que ya usaba el código, ahora en la zona correcta.
 */
export function finDiaMx(dia: string): string {
  return `${dia}T23:59:59.999${OFFSET_MX}`;
}

/**
 * Redondea a dos decimales (centavos) sin creerle a la coma flotante.
 *
 * AUDITORÍA 9, ALTO REINCIDENTE (arquitectura) — reimplementado a mano en
 * CUATRO archivos de dinero (`engine.ts`, `analytics.ts`, `pagadero.ts`,
 * `combustible.ts`), los cuatro con `Math.round(n * 100) / 100` y el mismo
 * bug: `round2(1.005)` daba `1`, no `1.01`. `1.005` no es representable
 * exacto en punto flotante —se guarda como `1.00499999999999989…`— y
 * `Math.round(100.4999…)` cae para abajo. El `+ Number.EPSILON` antes de
 * multiplicar empuja el valor lo suficiente para que el redondeo caiga del
 * lado correcto sin afectar los casos que ya funcionaban.
 *
 * El signo se separa ANTES de sumar el `EPSILON`: sumar un épsilon positivo a
 * un negativo lo acerca a cero (`-1.005 + EPSILON` es MENOS negativo), y el
 * mismo truco que arregla el redondeo hacia arriba lo rompe hacia abajo. Se
 * corrige sobre el valor absoluto y se restaura el signo al final.
 */
export function round2(n: number): number {
  return Math.sign(n) * Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100;
}

/**
 * MEDIO CENTAVO: la holgura con la que se decide si un abono cabe en el saldo.
 *
 * AUDITORÍA 7, `c7-6` — el portal de pago usaba `saldo + 0.01` y
 * `registrar_pago_tx` (0159) usa `v_saldo + 0.005`. Dos verdades sobre el mismo
 * peso, y el hueco entre ellas era un agujero por el que caía dinero real: con
 * un saldo de $1,160.00 el cliente teclea $1,160.01 —una comisión, un redondeo
 * del banco—, el portal lo ACEPTA (1160.01 > 1160.01 es falso) y la RPC lo
 * RECHAZA (1160.01 > 1160.005 es cierto). La propuesta se registraba, salía el
 * correo al contralor, y al apretar «Conciliar» rebotaba con
 * `CU011 motivo=sobrepago` para siempre: el cliente veía «por confirmar»
 * indefinidamente sobre un depósito que ya había hecho.
 *
 * Ahora la constante vive UNA vez y la importan los dos lados de TypeScript
 * (`evaluarAbono` y el validador del portal). La tercera copia es la de SQL, y
 * no se puede importar: el bloque 192 de `verificaciones.sql` la compara
 * ejecutando la RPC contra el valor de aquí, que es la única forma de que las
 * dos no vuelvan a separarse en silencio.
 *
 * NO es `TOLERANCIA_CENTAVO` (0.01, en `libro_viaje.ts`): aquélla es la holgura
 * con la que se PINTA una factura como saldada, la misma que `factura_saldo`.
 * Ésta decide si un abono ENTRA. Son dos preguntas distintas y por eso son dos
 * constantes distintas, cada una espejando lo que la base hace en su caso.
 */
export const TOLERANCIA_ABONO_MXN = 0.005;

/** % de cambio de `actual` contra `base`, o `null` si no se puede calcular
 *  honesto: sin base (0 o desconocida) un "+100%" o un "$0 → $500" como
 *  "∞%" no dicen nada real — es la MISMA regla que `costoPorViaje` (en
 *  `analytics.ts`) aplica para no dividir entre cero.
 *
 *  Vive aquí, no en `analytics.ts` (de donde se movió el 8-ago-2026): es
 *  pura, sin consulta a la base, y las tarjetas de KPI con flechas de
 *  periodo (`kpi-periodo.tsx`) la necesitan desde un Client Component.
 *  `analytics.ts` importa `supabaseAdmin` — "NUNCA importar en código de
 *  cliente" es el comentario textual en ese archivo — así que cualquier
 *  valor en tiempo de ejecución que se importe de ahí arrastra esa cadena
 *  al bundle del navegador aunque la función en sí no la use. */
export function pctCambio(actual: number, base: number | null): number | null {
  if (base === null || base === 0) return null;
  return round2(((actual - base) / base) * 100);
}

/** Pesos mexicanos como los espera un contador: `$1,234.56`. */
export function mxn(n: number): string {
  return n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
}

/**
 * Dólares, para el costo interno de los modelos — nunca para el cliente.
 *
 * AUDITORÍA 10, BAJO — `mxn(1.83)` y `usd(1.83)` daban el mismo string,
 * "$1.83": los dos estilos de moneda de Intl usan el símbolo genérico "$".
 * En /admin, "Gastado en IA" y "Costo de IA" son dólares en la misma
 * pantalla que enseña pesos en todo lo demás, y nada en el texto avisaba
 * cuál era cuál. El prefijo "US$" es el símbolo real que ya se usa para
 * distinguir moneda de EUA de otras monedas con signo "$" (MXN, CAD, ARS…);
 * `mxn()` se queda con el símbolo genérico porque es el que espera un
 * contador MEXICANO leyendo pesos.
 */
export function usd(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }).replaceAll('$', 'US$');
}

/**
 * Dólares con CUATRO decimales — el costo de una corrida de IA, no dinero del
 * cliente.
 *
 * AUDITORÍA PROD, FE-22 — /admin/qa imprimía `US$${n.toFixed(4)}` a mano en
 * CINCO sitios (el gasto del día, la fila de cada corrida, el total y cada
 * paso de la corrida viva, el aviso del tope). `toFixed` NO pone separador de
 * millares: en cuanto el gasto acumulado pasa de mil, "US$1234.5678" es la
 * misma cifra escrita distinto que el "US$1,234.57" de la tarjeta de al lado
 * —exactamente el hallazgo que `mxn()`/`litros()` ya pagaron tres rondas—.
 *
 * Cuatro decimales y no dos porque una llamada al modelo cuesta fracciones de
 * centavo: `usd(0.0003)` daría "US$0.00", que se lee como "gratis".
 */
export function usd4(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 4 }).replaceAll('$', 'US$');
}

/** El corte a partir del cual `mxnCompacto` abrevia. Por debajo, la cifra se
 *  imprime COMPLETA: un contralor lee "$999,999.00" sin esfuerzo, y abreviar
 *  antes solo esconde centavos que sí caben. */
const COMPACTO_DESDE = 1_000_000;

/**
 * Pesos ABREVIADOS para una tarjeta angosta: `$9,000 M` en vez de
 * `$9,000,000,000.00`.
 *
 * AUDITORÍA PROD, FE-17 — a escala 50k una tarjeta de KPI enseña miles de
 * millones, y veinte caracteres no caben: el número se desbordaba o se
 * recortaba, y un monto recortado ("$9,000,000,00…") es peor que uno
 * abreviado, porque parece completo.
 *
 * ES UNA CIFRA REDONDEADA, y por eso solo se usa donde el rótulo lo admite —
 * nunca en el PDF, ni en una liquidación, ni en nada que el contralor cruce
 * contra su contabilidad. La regla del producto no prohíbe redondear: prohíbe
 * INVENTAR. Debajo de un millón devuelve exactamente lo mismo que `mxn()`,
 * así que las pantallas de una flota real no cambian ni un carácter.
 *
 * `useGrouping` explícito: con `notation: 'compact'` el default de es-MX
 * imprime "$9000 M", sin la coma de los millares.
 *
 * `minimumFractionDigits: 0` explícito, y NO es redundante — AUDITORÍA 18-c4,
 * FMT-C4-1: declarar `maximumFractionDigits` a secas saca a ICU de su
 * "compact rounding" (el modo que suelta los ceros de cola) y lo pasa a
 * dígitos fijos, que los conserva. Con solo el máximo, 9,000 millones salían
 * `"$9,000.0 M"`: diez caracteres en la tarjeta de ocho — justo el desborde
 * que FE-17 vino a cerrar. Declarando el mínimo vuelve a `"$9,000 M"`, y
 * `$1.5 M` sigue enseñando su decimal.
 */
export function mxnCompacto(n: number): string {
  if (Math.abs(n) < COMPACTO_DESDE) return mxn(n);
  return n.toLocaleString('es-MX', {
    style: 'currency', currency: 'MXN',
    notation: 'compact',
    minimumFractionDigits: 0, maximumFractionDigits: 1,
    useGrouping: true,
  });
}

/** Un entero con separador de millares, sin moneda ni unidad — tokens, conteos. */
export function numero(n: number): string {
  return n.toLocaleString('es-MX');
}

/**
 * Un porcentaje YA CALCULADO, como lo lee una persona: `42.9%`, `50%`.
 *
 * Recibe el número EN PUNTOS PORCENTUALES (42.9 → `"42.9%"`), no la fracción:
 * es lo que devuelven `pctCambio` y las tasas del repo, y convertir aquí
 * invitaría a que la mitad de los llamadores pasara `0.429` y la otra mitad
 * `42.9` sin que nada lo notara.
 *
 * AUDITORÍA CICLO 7, c7-34 (regla 10 — formato SOLO por este archivo): el
 * parte del embudo escribía `${e.tasaPct.toFixed(1)}%` y la promo diaria
 * `${(factor * 100).toFixed(0)}%` a mano. `toFixed` NO es `toLocaleString`:
 * no pone separador de millares y ancla el punto decimal del inglés, así que
 * un `1234.5` salía `1234.5%` en un texto que se pega en LinkedIn con la marca
 * encima. Aquí se formatea una vez, con la misma configuración regional que el
 * resto del producto.
 *
 * `decimales` fija los decimales EXACTOS (no un máximo): una tasa que se
 * publica con un decimal tiene que enseñar `50.0%` y no `50%`, porque la
 * ausencia del decimal en una columna que sí los lleva se lee como otra
 * precisión.
 */
export function porcentaje(n: number, decimales = 1): string {
  return `${n.toLocaleString('es-MX', {
    minimumFractionDigits: decimales, maximumFractionDigits: decimales,
  })}%`;
}

/**
 * Litros con separador de millares y hasta dos decimales, sin rellenar ceros.
 *
 * El motor redondea a dos decimales, así que el tope no puede recortar
 * información: solo evita que un `1234.5600000001` de coma flotante salga con
 * tres cifras donde el papel enseña dos.
 */
export function litros(n: number): string {
  return `${n.toLocaleString('es-MX', { maximumFractionDigits: 2 })} L`;
}

/**
 * Fecha en hora de México: `31 jul 2026`.
 *
 * Devuelve `—` ante una fecha ausente o ilegible en vez de `Invalid Date`: una
 * celda vacía es más honesta que una cadena de error en la columna que el
 * contralor usa para ordenar su corte.
 *
 * La zona es explícita porque `.slice(0,10)` sobre un `timestamptz` se queda con
 * la fecha UTC, y CST es UTC−6: todo lo cerrado después de las 18:00 hora local
 * salía fechado al día siguiente. Las liquidaciones se cierran de noche, al
 * terminar el viaje, así que en el corte mensual una del 31 de julio aparecía en
 * agosto.
 */
export function fechaMx(iso?: string | null): string {
  if (!iso) return '—';

  // UNA FECHA SIN HORA NO TIENE ZONA, Y CONVERTIRLA LA CORRE UN DÍA.
  //
  // `gasto.fecha` es `date` en Postgres y llega como '2026-07-15'. `new Date()`
  // lo interpreta como MEDIANOCHE UTC, y al formatearlo en America/Mexico_City
  // (UTC−6) sale «14 jul». TODAS las fechas del PDF salían un día antes.
  //
  // Se vio en el primer PDF real (1-ago-2026), y el propio documento se
  // contradecía: la tabla decía «18 jun 2026» y la línea de diferencias, tres
  // párrafos abajo, «(2026-06-19)». El ticket del Costco es del 1 de julio y
  // aparecía como «30 jun» — otro mes, otro periodo fiscal.
  //
  // La ironía: esta función nació para arreglar el problema INVERSO. Un
  // `.slice(0,10)` sobre un `timestamptz` se quedaba con la fecha UTC y los
  // cierres nocturnos salían fechados al día siguiente. Aquello se arregló
  // poniendo la zona, y esa misma zona rompió el caso sin hora.
  //
  // Un valor de solo fecha es un día del calendario, no un instante: tiene que
  // imprimirse tal cual está escrito. Se formatea en UTC —la zona en la que se
  // construyó— para que no se mueva.
  const soloFecha = /^\d{4}-\d{2}-\d{2}$/.test(iso.trim());
  const d = soloFecha ? new Date(`${iso.trim()}T00:00:00Z`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-MX', {
    day: '2-digit', month: 'short', year: 'numeric',
    timeZone: soloFecha ? 'UTC' : TZ_MX,
  });
}

/**
 * Fecha corta, SIN año: `27 jul`. Misma lógica de zona que `fechaMx` (fecha
 * simple → UTC, para que no se corra un día) — solo cambia el formato de
 * salida, para etiquetas de espacio angosto como el rango de una tarjeta de
 * KPI ("27 jul – 02 ago") donde el año ya es obvio por contexto.
 */
export function fechaCorta(iso?: string | null): string {
  if (!iso) return '—';
  const soloFecha = /^\d{4}-\d{2}-\d{2}$/.test(iso.trim());
  const d = soloFecha ? new Date(`${iso.trim()}T00:00:00Z`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-MX', {
    day: '2-digit', month: 'short',
    timeZone: soloFecha ? 'UTC' : TZ_MX,
  });
}

/**
 * Fecha CON hora, en hora de México: `04 ago 2026, 14:32`.
 *
 * La necesitó la confirmación del chofer (mig. 0058): a un contralor le basta
 * el día en que se cerró una liquidación, pero a un jefe de tráfico no le sirve
 * saber que el chofer confirmó "el 4 de agosto" — la decisión de cambiar de
 * personal se toma por horas, y el plazo de escalación son 5.
 *
 * Vive aquí y no en el componente por la misma razón que `fechaMx`: una hora
 * formateada a mano en la pantalla se separa de la de al lado en la siguiente
 * ronda. `h23` es explícito porque `hour12: false` puede imprimir "24:00" para
 * la medianoche según la versión de ICU, y "24:00" no es una hora que exista.
 *
 * Un valor de SOLO FECHA (`2026-08-04`) no tiene hora que enseñar, y darle una
 * sería inventarla: cae en `fechaMx`, que además lo formatea en UTC para que no
 * se corra un día. Las cuatro columnas de la 0058 son `timestamptz`, así que en
 * la práctica esa rama no se usa; existe para que no pueda mentir si se usa.
 */
export function fechaHoraMx(iso?: string | null): string {
  if (!iso) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso.trim())) return fechaMx(iso);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-MX', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    timeZone: TZ_MX,
  });
}

/**
 * Fecha-hora en el formato del SAT (`AAAA-MM-DDThh:mm:ss`, sin zona), en hora
 * de México. Es el formato de `FechaHoraSalidaLlegada` del complemento Carta
 * Porte y de `Fecha` del CFDI: el estándar NO lleva offset — la zona la da el
 * código postal del emisor, y para una flota mexicana esa hora es la de
 * `TZ_MX` (fijo UTC−6 desde 2022, ver `OFFSET_MX`).
 *
 * Vive aquí y no en carta_porte_xml.ts por el guardia de fechas de
 * formato.test.ts: toda conversión a hora de México pasa por este archivo,
 * o dos pantallas terminan afirmando dos horas para el mismo instante.
 *
 * `null` para entrada inválida — el llamador decide si eso es faltante o
 * error; jamás se inventa una fecha.
 */
export function fechaHoraSat(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ_MX,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  // `h23` explícito por la misma razón que fechaHoraMx: "24:00" no existe.
  return `${partes.year}-${partes.month}-${partes.day}T${partes.hour}:${partes.minute}:${partes.second}`;
}

/**
 * Tamaño de archivo legible («340 KB», «2.3 MB») — para la bandeja de
 * insumos (0267) y cualquier otra pantalla que enseñe un archivo subido.
 * Vive aquí por el mismo guardia que el resto del archivo: un tamaño no se
 * formatea dos veces distinto en dos pantallas. `null`/negativo/NaN ⇒ '—',
 * nunca "0 KB" — un tamaño desconocido no es un archivo vacío.
 */
export function pesoArchivo(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/** Fecha RFC3339 estricta y normalizada. Las partes de tamaño fijo se validan
 * separadas de la fracción para evitar cuantificadores anidados y discrepancias
 * entre el webhook y el reconciliador de Cal.com. No recorta whitespace. */
export function instanteRFC3339(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const base = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(valor.slice(0, 19));
  if (!base) return null;
  const zona = valor.endsWith('Z') ? 'Z' : valor.slice(-6);
  if (zona !== 'Z' && !/^[+-]\d{2}:\d{2}$/.test(zona)) return null;
  const fraccion = valor.slice(19, valor.length - zona.length);
  if (fraccion && !/^\.\d+$/.test(fraccion)) return null;
  const [year, month, day, hour, minute, second] = base.slice(1).map(Number);
  const bisiesto = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const diasMes = [31, bisiesto ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > diasMes[month - 1]
      || hour > 23 || minute > 59 || second > 59) return null;
  if (zona !== 'Z' && (Number(zona.slice(1, 3)) > 23 || Number(zona.slice(4)) > 59)) return null;
  const ms = Date.parse(valor);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
