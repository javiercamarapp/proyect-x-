import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { correoDePropuesta } from './portal_pago_aviso';

// ═══════════════════════════════════════════════════════════════════════════
// EL CABLEADO DEL PORTAL — lo que ninguna prueba de unidad puede afirmar.
//
// La garantía central de esta entrega es NEGATIVA: que no exista un camino
// desde una petición anónima hasta `pago_recibido`. Una prueba de unidad no la
// puede demostrar (probaría que la función que llamé no lo hace, no que
// ninguna otra lo haga). Lo que sí se puede afirmar es sobre la FUENTE: quién
// importa qué, y qué nombres aparecen dónde — el mismo recurso que usan
// `facturacion_escritura_cableado.test.ts` y
// `consultas_admin_filtran_tenant.test.ts`.
//
// Estas pruebas fallan si alguien "solo por rapidez" mete el abono real en la
// ruta pública. Es el hallazgo que van a cazar, y es el caro.
// ═══════════════════════════════════════════════════════════════════════════

const RUTA_PUBLICA = 'src/app/api/pago/registrar/route.ts';
// El folio del complemento es un SEGMENTO de la ruta y no un query param
// (`c7-16`): con parcialidades hay varios REP y cada uno necesita su descarga,
// pero el portal sigue sin aceptar parámetros sueltos.
const RUTA_XML = 'src/app/pago/[token]/complemento/[uuid]/route.ts';
const PAGINA = 'src/app/pago/[token]/page.tsx';
const LECTURA = 'src/lib/likida/portal_pago_lectura.ts';
const ESCRITURA = 'src/lib/likida/portal_pago_escritura.ts';
const PROPUESTA = 'src/lib/likida/portal_pago_propuesta.ts';
const MIGRACION = 'supabase/migrations/0228_portal_pago.sql';

// eslint-disable-next-line security/detect-non-literal-fs-filename -- las seis rutas son constantes de este archivo (fuente del propio repo, en tiempo de prueba); ninguna viene de una entrada de usuario.
const leer = (p: string) => readFileSync(p, 'utf8');

/**
 * El archivo SIN sus comentarios.
 *
 * Estos archivos están llenos de prosa que EXPLICA lo que no hacen —«no toca
 * pago_recibido», «sin IP ni user-agent»—, y una aserción sobre el texto crudo
 * se dispara con la explicación en vez de con el código. Se quitan las líneas
 * que empiezan con marcador de comentario (`//`, `*`, `/*`, `--`), que es la
 * forma en la que este repo escribe sus bloques.
 */
function sinComentarios(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('--'));
    })
    .join('\n');
}

describe('la ruta pública no puede llegar a pago_recibido', () => {
  it('no nombra `pago_recibido` ni el RPC que crea abonos', () => {
    const src = sinComentarios(leer(RUTA_PUBLICA));
    expect(src).not.toContain('pago_recibido');
    expect(src).not.toContain('registrar_pago_tx');
    expect(src).not.toContain('registrarPago');
  });

  it('no importa `facturacion_escritura` ni `supabaseAdmin` directo', () => {
    // Todo lo que toca la base pasa por los módulos donde el alcance está
    // anclado a la liga.
    const src = sinComentarios(leer(RUTA_PUBLICA));
    expect(src).not.toContain('facturacion_escritura');
    expect(src).not.toContain('@/lib/supabase/admin');
  });

  it('NO importa `portal_pago_escritura`: ahí viven los verbos del contralor', () => {
    // Dos cosas a la vez. La de seguridad: si esta línea cambiara, la ruta
    // pública tendría a `conciliarPropuesta` y a `crearLigaPago` a un `import`
    // de distancia. Y la de latencia: `portal_pago_escritura` arrastra `sharp`
    // y `zxing-wasm` (vía registrarPago → intake/cfdi) al arranque en frío de
    // la página que un tercero abre desde su teléfono — medido: 265 archivos
    // contra los 169 de una ruta mínima.
    const src = sinComentarios(leer(RUTA_PUBLICA));
    expect(src).not.toContain('portal_pago_escritura');
    expect(src).toContain("from '@/lib/likida/portal_pago_propuesta'");
  });

  it('el módulo del cliente NO importa nada de la cadena del contralor', () => {
    const src = sinComentarios(leer(PROPUESTA));
    expect(src).not.toContain('facturacion_escritura');
    expect(src).not.toContain('intake/cfdi');
    expect(src).not.toContain('portal_pago_escritura');
  });

  it('trae los tres candados del molde #124, en la fuente', () => {
    const src = leer(RUTA_PUBLICA);
    expect(src).toContain('leerTextoAcotado');
    expect(src).toContain('rateLimit');
    expect(src).toContain('esCarnada');
  });

  it('el honeypot contesta 200, no un error: no se le enseña al bot', () => {
    const src = sinComentarios(leer(RUTA_PUBLICA));
    // `lastIndexOf` y no `indexOf`: la primera aparición es el `import`.
    const i = src.lastIndexOf('esCarnada(');
    expect(i).toBeGreaterThan(-1);
    const bloque = src.slice(i, i + 300);
    expect(bloque).toContain('ok: true');
    expect(bloque).not.toContain('status: 4');
  });
});

describe('el alcance del portal es una factura, y no hay parámetro que lo cambie', () => {
  it('la página recibe SOLO el token: ni searchParams ni otro id', () => {
    // El `facturaId` que sí aparece en el render sale de la liga YA resuelta,
    // no de la petición. Lo que esta prueba cierra es la entrada: sin
    // `searchParams` no hay parámetro que un visitante pueda inventar.
    const src = sinComentarios(leer(PAGINA));
    expect(src).toContain('params: Promise<{ token: string }>');
    expect(src).not.toContain('searchParams');
  });

  it('la ruta del XML recibe el token y el folio, y NINGÚN parámetro suelto', () => {
    // El folio elige CUÁL complemento de esta factura se baja; no amplía el
    // alcance, porque `xmlDelRep` sigue filtrando por el `factura_id` y el
    // `tenant_id` de la liga resuelta. Un folio de otra flota no encuentra
    // fila. Lo que esta prueba cierra sigue siendo la entrada: sin
    // `searchParams` no hay parámetro que un visitante pueda inventar.
    const src = sinComentarios(leer(RUTA_XML));
    expect(src).toContain('params: Promise<{ token: string; uuid: string }>');
    expect(src).not.toContain('searchParams');
  });

  it('la lectura del XML sigue anclada a la factura de la liga, no al folio', () => {
    // La afirmación de arriba se sostiene sobre esto: el folio es un filtro
    // MÁS, nunca el único.
    const src = sinComentarios(leer(LECTURA));
    const i = src.indexOf('export async function xmlDelRep');
    expect(i).toBeGreaterThan(-1);
    const cuerpo = src.slice(i, i + 1200);
    expect(cuerpo).toContain("eq('factura_id', liga.facturaId)");
    expect(cuerpo).toContain("eq('tenant_id', liga.tenantId)");
  });

  it('la página va noindex y sin Referer hacia fuera', () => {
    // El token vive en la URL: las dos fugas que eso abre se cierran aquí.
    const src = leer(PAGINA);
    expect(src).toContain('index: false');
    expect(src).toContain("referrer: 'no-referrer'");
  });
});

describe('toda lectura del portal va anclada al tenant', () => {
  it('cada `.from(` de la lectura lleva un ancla de flota', () => {
    // `supabaseAdmin()` bypassa RLS: el filtro de la aplicación es la ÚNICA
    // frontera. Se comprueba archivo adentro, como hace la capa 2 del CI.
    //
    // `token_prefijo` cuenta como ancla y es la ÚNICA excepción: es la
    // consulta que RESUELVE de qué flota se trata. Pedirle que filtre por un
    // tenant que todavía no conoce sería pedirle que adivine.
    const src = sinComentarios(leer(LECTURA));
    const consultas = src.split('.from(').slice(1);
    expect(consultas.length).toBeGreaterThan(5);
    for (const c of consultas) {
      const bloque = c.slice(0, 500);
      expect(
        bloque.includes("eq('tenant_id'")
        // Un INSERT no filtra: DECLARA de qué flota es la fila que nace.
        || bloque.includes('tenant_id:')
        || bloque.includes("eq('liga_id'")
        // La fila del tenant se ancla por su propia PK: `eq('id', tenantId)`.
        || bloque.includes("eq('id', liga.tenantId)")
        || bloque.includes("eq('token_prefijo'"),
        `una consulta de ${LECTURA} no filtra por tenant: ${bloque.slice(0, 120)}`,
      ).toBe(true);
    }
  });

  it('las escrituras tampoco tocan una fila sin decir de qué flota es', () => {
    for (const f of [ESCRITURA, PROPUESTA]) {
      const src = sinComentarios(leer(f));
      for (const c of src.split('.from(').slice(1)) {
        const bloque = c.slice(0, 700);
        expect(
          bloque.includes("eq('tenant_id'") || bloque.includes('tenant_id:'),
          `una escritura de ${f} no dice de qué flota es: ${bloque.slice(0, 120)}`,
        ).toBe(true);
      }
    }
  });
});

describe('el token en claro no llega a la base', () => {
  it('el insert de la liga manda el hash y el prefijo, jamás `enClaro`', () => {
    const src = sinComentarios(leer(ESCRITURA));
    const i = src.indexOf("from('portal_pago_liga').insert");
    expect(i).toBeGreaterThan(-1);
    // La ventana se corta en el `.select` que cierra el insert: `enClaro` SÍ
    // aparece después, armando la URL que se enseña una vez, y eso es correcto.
    const bloque = src.slice(i, src.indexOf('.select', i));
    expect(bloque).toContain('token.hash');
    expect(bloque).toContain('token.prefijo');
    expect(bloque).not.toContain('token.enClaro');
  });

  it('la migración pone el CHECK de 64 hex, que es la red de esa regla', () => {
    expect(leer(MIGRACION)).toContain("check (token_hash ~ '^[0-9a-f]{64}$')");
  });
});

describe('la migración cierra las cuatro tablas nuevas', () => {
  const src = leer(MIGRACION);
  const TABLAS = ['portal_pago_liga', 'portal_pago_propuesta', 'rep_emitido', 'portal_pago_acceso'];

  for (const t of TABLAS) {
    it(`${t}: RLS activo, revoke a anon/authenticated y grant solo a service_role`, () => {
      expect(src).toContain(`alter table public.${t}`);
      expect(src).toMatch(new RegExp(`alter table public\\.${t}\\s+enable row level security`));
      expect(src).toMatch(new RegExp(`revoke all on public\\.${t}\\s+from public, anon, authenticated`));
      expect(src).toMatch(new RegExp(`on public\\.${t}\\s+to service_role`));
    });
  }

  it('ninguna de las cuatro crea una política: cero políticas es deniega-todo', () => {
    // Con RLS activo, cero políticas es el lado seguro — y lo dice
    // `capa1_auditoria_estatica.sql` en su propia cabecera.
    for (const t of TABLAS) {
      expect(src).not.toContain(`create policy on public.${t}`);
    }
    expect(src).not.toContain('create policy');
  });

  it('el REP emitido NO se mezcla con cfdi_pago: son IVA contrarios', () => {
    // `cfdi_pago` (0199) es el REP RECIBIDO, que libera IVA ACREDITABLE. Este
    // es el EMITIDO, con IVA TRASLADADO. Mezclarlos infla el acreditable de la
    // flota con el IVA que ella misma trasladó.
    expect(src).toContain('create table if not exists public.rep_emitido');
    expect(src).not.toMatch(/insert into public\.cfdi_pago|alter table public\.cfdi_pago/);
  });
});

describe('la conciliación pasa por el mismo camino que el pago tecleado', () => {
  it('`conciliarPropuesta` usa `registrarPago`, no un insert propio', () => {
    // Un segundo camino a `pago_recibido` sería una segunda regla de dinero:
    // sin el `for update`, sin el rechazo por sobrepago y sin el sello de
    // `estatus = 'pagada'` en la misma transacción.
    const src = leer(ESCRITURA);
    expect(src).toContain("import { registrarPago } from './facturacion_escritura'");
    expect(src).toContain('await registrarPago(');
    expect(src).not.toContain("from('pago_recibido').insert");
  });

  it('el sello de la propuesta va condicionado a que siga pendiente', () => {
    const src = leer(ESCRITURA);
    const i = src.indexOf('conciliarPropuesta.sellar');
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i - 600, i)).toContain("eq('estado', 'pendiente')");
  });
});

describe('la bitácora del portal no guarda datos personales de más', () => {
  it('ni IP ni user-agent en ningún archivo del portal', () => {
    // El visitante es un tercero que nunca aceptó un aviso de privacidad de
    // Likida. Minimización (art. 13 LFPDPPP), mismo criterio que sitio_evento.
    for (const f of [LECTURA, ESCRITURA, PROPUESTA, RUTA_PUBLICA, PAGINA]) {
      const src = sinComentarios(leer(f)).toLowerCase();
      expect(src, `${f} nombra el user-agent fuera de un comentario`).not.toContain('user-agent');
      expect(src, `${f} nombra useragent fuera de un comentario`).not.toContain('useragent');
    }
  });

  it('las tablas del portal no tienen dónde guardar una IP ni un user-agent', () => {
    // Sobre la MIGRACIÓN la afirmación es más fuerte que "no se nombra": es
    // que no existe la columna. (El `comment on table` sí dice las palabras,
    // porque documenta justamente que no se guardan.)
    const src = leer(MIGRACION);
    const columnas = [...src.matchAll(/^\s{2}([a-z_]+)\s{2,}/gm)].map((m) => m[1]);
    expect(columnas.length).toBeGreaterThan(20);
    for (const c of columnas) {
      expect(c, `la 0228 declara una columna «${c}»`).not.toMatch(/^(ip|ip_.*|user_agent|ua|navegador)$/);
    }
  });

  it('la bitácora del portal no recibe la IP ni siquiera desde la ruta', () => {
    const src = sinComentarios(leer(RUTA_PUBLICA));
    // `clientIp` sí se usa, pero SOLO para la llave del límite de tasa: no
    // puede acabar dentro de un `anotarAcceso`.
    const i = src.indexOf('anotarAcceso');
    expect(src.slice(i, i + 200)).not.toContain('clientIp');
  });
});

// ── El correo del aviso ────────────────────────────────────────────────────

describe('correoDePropuesta — dice que el saldo NO se movió', () => {
  const A = {
    flota: 'Transportes del Bajío',
    cliente: 'Cementos del Norte',
    identificaFactura: 'A-1042',
    fecha: '2026-08-20',
    monto: 11600,
    referencia: 'REF-8891',
    metodo: 'transferencia',
  };

  it('el asunto trae quién y cuánto, formateado por lib/formato', () => {
    const c = correoDePropuesta(A);
    expect(c.asunto).toContain('Cementos del Norte');
    expect(c.asunto).toContain('$11,600.00');
  });

  it('el cuerpo declara que NO está aplicado — es la línea que evita el error caro', () => {
    const c = correoDePropuesta(A);
    const cuerpo = c.parrafos.join(' ');
    expect(cuerpo).toMatch(/NO está aplicado/);
    expect(cuerpo).toMatch(/no se movió/);
  });

  it('lleva los seis datos que hacen falta para cruzarlo contra el banco', () => {
    const c = correoDePropuesta(A);
    const etiquetas = (c.datos ?? []).map(([k]) => k);
    expect(etiquetas).toEqual(['Cliente', 'Factura', 'Fecha del pago', 'Monto', 'Forma', 'Referencia']);
    expect((c.datos ?? []).find(([k]) => k === 'Referencia')?.[1]).toBe('REF-8891');
  });

  it('el botón lleva a Facturación, que es donde se concilia', () => {
    expect(correoDePropuesta(A).boton?.href).toMatch(/\/dashboard\/facturacion$/);
  });

  it('dice por qué le llegó, que es obligatorio en este canal', () => {
    expect(correoDePropuesta(A).porQueLoRecibes).toContain('Transportes del Bajío');
  });
});
