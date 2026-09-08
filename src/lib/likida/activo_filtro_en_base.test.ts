import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// ═══════════════════════════════════════════════════════════════════════════
// MEDIO (auditoría 25, reauditoría, `agentico.md:247`) — LA MITAD DEL ARREGLO
// QUE NINGUNA PRUEBA DEFENDÍA ES LA QUE CARGA EL RAZONAMIENTO.
//
// `24ce4c2` (AGEN-C1) y el commit ALTO de esta misma ronda (correo) filtran
// `activo` en DOS capas: la BASE (`.or('activo.is.null,activo.eq.true')`) y
// TypeScript (`!== false`). Medido, no razonado: los dobles de prueba de estos
// archivos encadenan `.or()` como identidad —devuelven la tabla entera, igual
// que con `.select()` o `.eq()`— así que las 20+ pruebas que ya existen
// ejercen SOLO la capa de TS. Borrar las SEIS llamadas `.or(...)` de la base
// deja esas pruebas en verde.
//
// Y es la mitad que el propio código razona con más cuidado: el `.limit(1)`
// de `telefonoDeRol` y el `.limit(50)`/`.limit(200)` de las demás cuentan
// FILAS DEL SERVIDOR, así que sin el filtro de la base una fila de baja se
// puede llevar el cupo y esconder a la viva — el filtro de TS ya no alcanza
// a corregirlo porque la fila viva ni siquiera llegó.
//
// LO QUE ESTA PRUEBA PRUEBA Y LO QUE NO: es un escaneo de fuente, como
// `embeds_con_alias.test.ts` y `limite_con_orden.test.ts`. Si alguien borra
// (o nunca escribe) el `.or('activo.is.null,activo.eq.true')` de la base en
// cualquiera de los SEIS resolutores de destinatario que leen `app_user`,
// esto se pone rojo con el archivo y la función exactos. NO habla con
// PostgREST: no valida que la condición se evalúe de verdad ahí — eso ya lo
// hacen las pruebas de cada archivo con sus escenarios "de baja se descarta,
// viva se usa".
// ═══════════════════════════════════════════════════════════════════════════

/** Extrae el cuerpo de `function <nombre>(...)  { ... }`, balanceando llaves,
 *  para no depender de números de línea que se mueven con cada arreglo. */
function cuerpoDeFuncion(fuente: string, nombreFuncion: string): string {
  const patron = new RegExp(`(?:export\\s+)?async\\s+function\\s+${nombreFuncion}\\s*\\(`);
  const m = patron.exec(fuente);
  if (!m) throw new Error(`no se encontró \`function ${nombreFuncion}\` en el archivo`);
  const inicio = fuente.indexOf('{', m.index);
  let profundidad = 0;
  for (let i = inicio; i < fuente.length; i++) {
    if (fuente[i] === '{') profundidad++;
    else if (fuente[i] === '}') {
      profundidad--;
      if (profundidad === 0) return fuente.slice(inicio, i + 1);
    }
  }
  throw new Error(`no se pudo cerrar el cuerpo de \`${nombreFuncion}\` (llaves sin balancear)`);
}

/** Los seis resolutores de "a quién se le escribe/manda" que leen `app_user`
 *  por rol y dependen de que una cuenta dada de baja no cuente. Tres eran de
 *  WhatsApp (AGEN-C1, `24ce4c2`), uno de escalada de emergencia, y dos de
 *  CORREO (el ALTO de esta misma reauditoría). */
const SITIOS: Array<{ archivo: string; funcion: string }> = [
  { archivo: 'src/lib/likida/contactos.ts', funcion: 'resolverCuentaOficina' },
  { archivo: 'src/lib/likida/contactos.ts', funcion: 'telefonoParaDineroDe' },
  { archivo: 'src/lib/likida/contactos.ts', funcion: 'telefonosJefe' },
  { archivo: 'src/lib/likida/asistencia_escalamiento.ts', funcion: 'telefonoDeRol' },
  { archivo: 'src/lib/likida/facturacion/flota_fiscal.ts', funcion: 'correoDeFacturacion' },
  { archivo: 'src/lib/likida/agentes/notificaciones.ts', funcion: 'usuariosAvisables' },
];

/** Accesos a `app_user` que NO son resolutores por rol y por eso quedan fuera
 *  de SITIOS a propósito: traen una sola fila por llave primaria
 *  (`.eq('id', x).maybeSingle()`, sin `.limit()`), así que no hay cupo que una
 *  fila de baja pueda robarle a la viva — el filtro de `activo` en TS ya
 *  alcanza. Igual que SITIOS, es una lista cerrada: un OCTAVO acceso sin
 *  clasificar sigue rompiendo la prueba de abajo. */
const EXCLUIDOS_POR_ID: Array<{ archivo: string; funcion: string }> = [
  // AUDITORÍA 28, AG-A4: busca UNA cuenta por `id` (quien autorizó la
  // coordinación), no "a quién le toca por rol" — no hay `.limit()` que una
  // fila de baja pueda ganarle a la viva.
  { archivo: 'src/lib/likida/contactos.ts', funcion: 'telefonoDeUsuario' },
];

const OR_ACTIVO = "or('activo.is.null,activo.eq.true')";

describe('el filtro de `activo` sigue en la BASE, no solo en TS', () => {
  it.each(SITIOS)('$funcion ($archivo) trae `activo` en el select y lo filtra en el `.or()`', ({ archivo, funcion }) => {
    const fuente = readFileSync(archivo, 'utf8');
    const cuerpo = cuerpoDeFuncion(fuente, funcion);

    expect(cuerpo, `${funcion}: el \`.or(...)\` de la baja desapareció de la consulta`).toContain(OR_ACTIVO);

    // El `.select(...)` que antecede al `.or()` tiene que pedir `activo`: sin
    // la columna en el select, PostgREST no tiene sobre qué evaluar el `.or()`.
    const iSelect = cuerpo.indexOf('.select(');
    const iCierreSelect = cuerpo.indexOf(')', iSelect);
    const columnas = cuerpo.slice(iSelect, iCierreSelect + 1);
    expect(columnas, `${funcion}: el \`.select(...)\` no pide \`activo\``).toMatch(/activo/);
  });

  it('la lista de arriba sigue siendo la lista completa: nadie más consulta `app_user` por `rol` sin pasar por aquí', () => {
    // Barrido de guardia, igual que el que hizo la reauditoría de AGEN-C1
    // (`grep -rn "from('app_user')"`): si aparece un SÉPTIMO resolutor de
    // destinatario, esta prueba no lo sabe evaluar y hay que agregarlo arriba
    // — no basta con que las seis de la lista sigan pasando.
    const archivos = [...new Set([...SITIOS, ...EXCLUIDOS_POR_ID].map((s) => s.archivo))];
    for (const archivo of archivos) {
      const fuente = readFileSync(archivo, 'utf8');
      const enEsteArchivo = SITIOS.filter((s) => s.archivo === archivo).length
        + EXCLUIDOS_POR_ID.filter((s) => s.archivo === archivo).length;
      const ocurrencias = (fuente.match(/from\('app_user'\)/g) ?? []).length;
      expect(
        ocurrencias,
        `${archivo}: tiene ${ocurrencias} consulta(s) a \`app_user\` pero las listas de arriba solo cubren ${enEsteArchivo}. ` +
        'Si la nueva es un resolutor de destinatario (rol -> a quién se le escribe/manda), agrégala a SITIOS; ' +
        'si es una búsqueda por `id` de una sola fila (sin `.limit()`), agrégala a EXCLUIDOS_POR_ID.',
      ).toBe(enEsteArchivo);
    }
  });

  it.each(EXCLUIDOS_POR_ID)('$funcion ($archivo) sigue siendo una búsqueda de una sola fila por `id`, sin `.limit()`', ({ archivo, funcion }) => {
    // Si alguien la convierte en un resolutor multi-fila (por rol, con
    // `.limit()`), el filtro de TS deja de alcanzar y esta excepción deja de
    // ser válida — hay que moverla a SITIOS y darle el `.or()` de la base.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- ruta sale de EXCLUIDOS_POR_ID, una constante fija de este archivo, no de ninguna entrada de usuario.
    const fuente = readFileSync(archivo, 'utf8');
    const cuerpo = cuerpoDeFuncion(fuente, funcion);
    expect(cuerpo, `${funcion}: ya no busca por \`id\` — revisa si sigue mereciendo la excepción`).toMatch(/\.eq\(['"]id['"],/);
    expect(cuerpo, `${funcion}: ganó un \`.limit()\` — una fila de baja ya puede robarle el cupo a la viva`).not.toMatch(/\.limit\(/);
  });
});
