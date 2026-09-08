// ═══════════════════════════════════════════════════════════════════════════
// EL CALIFICADOR DE `verificaciones.sql` — las funciones PURAS del runner.
//
// Vivían dentro de `correr-verificaciones.mjs`, que corre su lote al
// importarse: no había forma de probarlas sin un Postgres. PRU-1 (auditoría
// 24) las saca aquí para que `calificar_verificacion_aud24.test.ts` pueda
// alimentar una salida sintética («FINANZAS_RLS … tarifas=1») y exigir que
// el veredicto sea `falla`, no `sin_calificar`. Sin efectos: leer, partir,
// comparar. El runner importa de aquí y sigue siendo el único que habla con
// `psql`.
//
// CÓMO SE LEE UN MENSAJE:
//
//   raise exception E'MUTEX  1er=%  concurrente=%  tras-unlock=%   (esperado t / f / t)',
//     l1, l2, l3;
//
// Postgres sustituye los `%` por l1/l2/l3 ANTES de que psql lo imprima, así
// que lo que se captura ya trae los valores reales: "1er=t  concurrente=f
// tras-unlock=t   (esperado t / f / t)". Se separan las dos mitades por
// "(esperado", se sacan los NOMBRES de clave (`1er=`, `concurrente=`, …) del
// lado izquierdo para usarlos de frontera —así el VALOR de una clave puede
// traer comas o espacios sin romper el siguiente— y se compara cada valor
// contra su posición en la lista de la derecha, partida por "/".
//
// SUS LÍMITES, para no fingir más certeza de la que da:
//
// · Un token esperado con espacios adentro ("la url", "cualquier otra cosa
//   es fuga al chofer") NO es un valor literal: es prosa del autor. Se trata
//   como comodín — siempre pasa, y sirve para que un humano lo lea.
// · Si el número de claves detectadas no coincide con el número de valores
//   esperados, el bloque NO se puede calificar con certeza: `sin_calificar`.
//   Desde PRU-1 eso es FALLA en el runner — un verde que no distingue
//   "verifiqué" de "no supe leer" no es una compuerta.
// · Un bloque sin `(esperado …)` es un REPORTE (su salida depende de datos o
//   de tiempos): se corre igual, se lista aparte, nunca como fallo.
// · (auditoría 28, PRU-A3) Si el mensaje trae MÁS de un grupo `(esperado …)`,
//   o si después del `)` que cierra el ÚNICO grupo quedan más tokens
//   `identificador=` (mediciones que el autor puso DESPUÉS del paréntesis en
//   vez de antes), tampoco se puede calificar con certeza: `sin_calificar`.
//   El defecto de clase que esto atrapa: `indexOf('(esperado')` encontraba el
//   grupo, pero el corte del lado derecho llegaba hasta el FINAL del mensaje
//   en vez de hasta el `)` que lo cierra — así que cualquier medición escrita
//   después de ese `)` (el caso real: el bloque 47, `verificaciones.sql`) se
//   tragaba entera como texto del ÚLTIMO valor esperado, con espacios adentro
//   → comodín de prosa → `ok:true` sin importar lo que esa medición dijera.
//   El cierre se encuentra contando paréntesis anidados desde el `(` de
//   "(esperado" (hay bloques con paréntesis DENTRO del propio grupo, p. ej.
//   `(esperado "(tenant_id, created_at DESC, id DESC)" / f / f / t / t)`).
// ═══════════════════════════════════════════════════════════════════════════

/** Parte un archivo en sus bloques `do $$ ... end $$;` de nivel superior. */
export function extraerBloques(sql, archivo) {
  const bloques = [];
  const re = /^do \$\$/gm;
  let m;
  while ((m = re.exec(sql))) {
    const inicio = m.index;
    const marcaCierre = '\nend $$;';
    const cierre = sql.indexOf(marcaCierre, inicio);
    if (cierre === -1) {
      throw new Error(`${archivo}: bloque sin 'end $$;' de cierre, abre en la línea ${linea(sql, inicio)}`);
    }
    const fin = cierre + marcaCierre.length;
    bloques.push({ archivo, sql: sql.slice(inicio, fin), linea: linea(sql, inicio) });
    re.lastIndex = fin;
  }
  return bloques;
}

function linea(sql, offset) {
  return sql.slice(0, offset).split('\n').length;
}

/**
 * ¿El error que psql reportó es el `raise exception` de CIERRE que el propio
 * bloque escribió a propósito, o un error genuino que Postgres levantó por su
 * cuenta (tabla que no existe, columna NOT NULL vacía, permiso denegado)?
 * La señal es el CONTEXT que psql imprime: un `raise exception` deja
 * "…at RAISE"; cualquier otro fallo deja "…at SQL statement" / "…at
 * assignment" / ningún CONTEXT en absoluto.
 */
export function esRaiseDelPropioBloque(stderr) {
  return /PL\/pgSQL function inline_code_block line \d+ at RAISE/.test(stderr);
}

/**
 * Del stderr de psql para un bloque que SÍ lanzó, extrae el texto del
 * mensaje de error (entre "ERROR:  " y la siguiente línea "CONTEXT:"/"HINT:",
 * o el final si no hay ninguna). Colapsa saltos de línea internos a un solo
 * espacio.
 */
export function extraerMensaje(stderr) {
  const m = /ERROR:\s{2}([\s\S]*?)(?:\n[A-ZÁÉÍÓÚ]+:\s|$)/.exec(stderr);
  if (!m) return null;
  return m[1].replace(/\s+/g, ' ').trim();
}

/** Encuentra el `)` que cierra el grupo `(…` que abre en `marcador`, contando
 * paréntesis anidados (algunos valores esperados traen paréntesis propios). */
function cierreDelGrupo(mensaje, marcador) {
  let profundidad = 0;
  for (let i = marcador; i < mensaje.length; i++) {
    if (mensaje[i] === '(') profundidad++;
    else if (mensaje[i] === ')') {
      profundidad--;
      if (profundidad === 0) return i;
    }
  }
  return -1; // sin cierre: paréntesis desbalanceado
}

/** Separa "clave1=val1  clave2=val2   (esperado a / b)" en sus dos mitades. */
export function partirEnClavesYEsperado(mensaje) {
  const marcador = mensaje.indexOf('(esperado');
  if (marcador === -1) return null; // bloque-reporte: nada que calificar

  // Más de un grupo `(esperado …)` en el mismo mensaje es ambiguo: no hay
  // forma de saber a cuál de los dos pertenece cada clave del lado izquierdo.
  const grupos = (mensaje.match(/\(esperado/g) ?? []).length;

  const cierre = cierreDelGrupo(mensaje, marcador);

  // Todo lo que sigue DESPUÉS del `)` que cierra el grupo: si trae otro
  // `identificador=`, el autor escribió una medición donde el calificador no
  // la puede alcanzar (el defecto real del bloque 47 de `verificaciones.sql`,
  // PRU-A3 — ver la nota de cabecera de este archivo).
  const resto = cierre === -1 ? '' : mensaje.slice(cierre + 1);
  const clavesRe0 = /([\wÁÉÍÓÚáéíóúñÑ+-]+)=/g;
  const clavesTrasCierre = [];
  let cmr;
  while ((cmr = clavesRe0.exec(resto))) clavesTrasCierre.push(cmr[1]);

  if (grupos > 1 || cierre === -1 || clavesTrasCierre.length > 0) {
    const razon = grupos > 1
      ? `${grupos} grupos (esperado …) en un mismo mensaje`
      : cierre === -1
        ? 'el grupo (esperado …) no tiene un `)` de cierre'
        : `mediciones después del ) que cierra (esperado …): ${clavesTrasCierre.join(', ')}`;
    return { izq: mensaje.slice(0, marcador).trim(), esperados: [], pares: [], razonSinCalificar: razon };
  }

  let izq = mensaje.slice(0, marcador).trim();

  // Varios bloques hacen una "falsificación" al final: desarman a propósito
  // la protección que acaban de probar para demostrar que la prueba SÍ
  // hubiera reprobado — y narran eso con más `clave=valor` que la lista
  // `(esperado …)` no cubre. Cortar ahí evita que esa segunda mitad se
  // cuente como parte de la primera.
  const corteFalsificacion = izq.indexOf('FALSIFICADO');
  if (corteFalsificacion !== -1) izq = izq.slice(0, corteFalsificacion).trim();

  let der = mensaje.slice(marcador + '(esperado'.length, cierre).trim();
  der = der.replace(/\)\s*$/, ''); // por si el propio grupo cierra doble, cinturón y tirantes
  const esperados = der.split(/\s*\/\s*/).map((s) => s.trim());

  // El ÚLTIMO valor puede traer prosa tras un guion largo ("0 — nunca 2, que
  // sería ver los dos choferes"): se recorta a lo que hay ANTES del guion.
  // Si no hay nada antes del guion, no es prosa — es el valor «—».
  const ultimo = esperados.length - 1;
  const conProsa = /^(\S.*?)\s+—\s+\S.*$/.exec(esperados[ultimo]);
  if (conProsa) esperados[ultimo] = conProsa[1].trim();

  // Claves = todo token `identificador=` en el lado izquierdo, en orden.
  // El `+` entra en la clase (`facturas+2=t`). No se añade `/`: en `anon=f/f`
  // la barra es parte del VALOR, no separador de claves.
  const clavesRe = /([\wÁÉÍÓÚáéíóúñÑ+-]+)=/g;
  const posiciones = [];
  let cm;
  while ((cm = clavesRe.exec(izq))) posiciones.push({ clave: cm[1], desde: clavesRe.lastIndex });
  if (posiciones.length === 0) return { izq, esperados, pares: [] };

  const pares = posiciones.map((p, i) => {
    const hasta = i + 1 < posiciones.length
      ? izq.lastIndexOf(
          posiciones[i + 1].clave + '=',
          posiciones[i + 1].desde - posiciones[i + 1].clave.length - 1,
        )
      : izq.length;
    const valor = izq.slice(p.desde, hasta).trim();
    return { clave: p.clave, valor };
  });

  return { izq, esperados, pares };
}

// Booleano: RAISE imprime `t`/`f`, pero varios `(esperado …)` los escriben
// "true"/"false" en palabras. Son el mismo valor.
const BOOL_A_LETRA = { true: 't', false: 'f', verdadero: 't', falso: 'f' };
// "Lista vacía" tiene varias formas según qué autor escribió el bloque.
const VACIOS = new Set(['—', 'vacío', 'vacio', '[]', '', 'ninguno', 'ninguna']);

export function normalizar(v) {
  const s = v.trim();
  const low = s.toLowerCase();
  if (low in BOOL_A_LETRA) return BOOL_A_LETRA[low];
  if (VACIOS.has(low)) return '∅';
  return s;
}

/** ">=1", "<=5", ">0", "<10" — comparación numérica en vez de literal. */
export function comparaDesigualdad(actual, esperado) {
  const m = /^([<>]=?)\s*(-?\d+(?:\.\d+)?)$/.exec(esperado);
  if (!m) return null;
  const n = Number(actual);
  if (!Number.isFinite(n)) return false;
  const limite = Number(m[2]);
  switch (m[1]) {
    case '>=': return n >= limite;
    case '<=': return n <= limite;
    case '>': return n > limite;
    case '<': return n < limite;
    default: return null;
  }
}

/**
 * El veredicto de UN mensaje: `{tipo:'reporte'}`, `{tipo:'sin_calificar', razon}`,
 * `{tipo:'ok', detalle}` o `{tipo:'falla', detalle, falla}`.
 */
export function calificar(mensaje) {
  const partido = partirEnClavesYEsperado(mensaje);
  if (partido === null) return { tipo: 'reporte' };
  if (partido.razonSinCalificar) {
    return { tipo: 'sin_calificar', razon: partido.razonSinCalificar, pares: partido.pares, esperados: partido.esperados };
  }
  const { esperados, pares } = partido;
  if (esperados.length !== pares.length) {
    return {
      tipo: 'sin_calificar',
      razon: `${pares.length} clave(s) detectada(s) vs ${esperados.length} valor(es) esperado(s)`,
      pares,
      esperados,
    };
  }
  const detalle = pares.map((p, i) => {
    const esp = esperados[i];
    // Un esperado que repite el NOMBRE de su propia clave es prosa del autor
    // dentro del paréntesis; uno con espacios adentro también. Comodín.
    const autoReferencial = esp.startsWith(`${p.clave}=`);
    const prosa = /\s/.test(esp);
    if (autoReferencial || prosa) {
      return { clave: p.clave, actual: p.valor, esperado: esp, comodin: true, ok: true };
    }
    const desigualdad = comparaDesigualdad(p.valor, esp);
    if (desigualdad !== null) {
      return { clave: p.clave, actual: p.valor, esperado: esp, comodin: false, ok: desigualdad };
    }
    // `numeric` imprime "2300.00"; el autor escribe "2300". Mismo número.
    const numActual = Number(p.valor);
    const numEsp = Number(esp);
    const sonNumericos = p.valor.trim() !== '' && esp.trim() !== ''
      && Number.isFinite(numActual) && Number.isFinite(numEsp);
    const ok = sonNumericos ? numActual === numEsp : normalizar(p.valor) === normalizar(esp);
    return { clave: p.clave, actual: p.valor, esperado: esp, comodin: false, ok };
  });
  const falla = detalle.filter((d) => !d.ok);
  return { tipo: falla.length === 0 ? 'ok' : 'falla', detalle, falla };
}
