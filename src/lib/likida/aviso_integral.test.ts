import { describe, it, expect } from 'vitest';
import { avisoIntegral, avisoSimplificado, revisarAvisoIntegral, versionAviso } from './privacidad';

// ═══════════════════════════════════════════════════════════════════════════
// EL AVISO INTEGRAL FALTABA ENTERO. 31-jul-2026.
//
// `tenant.url_aviso_privacidad` apuntaba a `flotademo.mx`, que
// responde NXDOMAIN. El art. 16 fr. II obliga a "señalar el sitio donde se podrá
// consultar el aviso integral", y no había sitio: el operador recibía una liga
// muerta y la respuesta a *PRIVACIDAD* tenía que confesar que no había a dónde
// mandarlo.
//
// Seis de los once elementos del checklist (docs/conocimiento/11-datos-
// personales.md §5.4) viven SOLO en el integral, así que no existían en ningún
// lado: ARCO (15 fr. V), cambios al aviso (15 fr. VI), transferencias (35),
// revocación (7 último párr.), contacto (29) y oposición al tratamiento
// automatizado (26 fr. II).
//
// Esta prueba mide el CONTENIDO contra ese checklist, que es la única forma de
// que "está completo" signifique algo. Por eso `avisoIntegral` devuelve
// secciones y no HTML.
// ═══════════════════════════════════════════════════════════════════════════

const FLOTA = {
  razonSocial: 'FLOTA DEMO SA DE CV',
  domicilio: 'Carretera Silao-Romita Km 4.5, 36100 Silao, Guanajuato',
  // El mismo valor que siembra `supabase/seed.sql` para la flota demo, host
  // incluido: se copió de ahí y se movió con él a `app.likida.ai` el
  // 17-ago-2026 (`likida.ai/aviso/…` da 404 — es la landing estática).
  urlAvisoIntegral: 'https://app.likida.ai/aviso/11111111-1111-1111-1111-111111111111',
};

const todo = (r = FLOTA) => avisoIntegral(r).flatMap((s) => [s.titulo, ...s.parrafos]).join('\n');
const fundamentos = (r = FLOTA) => avisoIntegral(r).map((s) => s.fundamento).join(' | ');

describe('los once elementos del checklist §5.4', () => {
  // La tabla del checklist, tal cual, con el fundamento que la ancla. Si mañana
  // alguien reordena o borra una sección, esto dice CUÁL se perdió — no "el
  // texto cambió".
  const ELEMENTOS: Array<[string, string, RegExp]> = [
    ['1  identidad y domicilio del responsable', 'art. 15 fr. I', /responsable de tus datos personales/i],
    ['2  catálogo de datos, marcando sensibles', 'art. 15 fr. II',
      // La frase cambió el 16-ago-2026 (auditoría externa P2): 'no se
      // tratan' prometía más de lo que el flujo hace — la foto viaja completa
      // al motor de lectura y el filtro impide CONSERVAR lo sensible. El
      // aviso ahora dice exactamente eso, y esta prueba ancla la frase nueva.
      /No se piden ni se conservan datos sensibles/i],
    ['3  finalidades, separando las necesarias', 'art. 15 fr. III', /Finalidades necesarias/i],
    ['4  opciones para limitar uso o divulgación', 'art. 15 fr. IV', /Cómo limitar el uso/i],
    ['5  mecanismos y procedimiento ARCO', 'art. 15 fr. V', /20 días hábiles/i],
    ['6  cómo se comunican los cambios', 'art. 15 fr. VI', /recibes el aviso nuevo por el mismo WhatsApp/i],
    ['7  cláusula de transferencias', 'art. 35', /no se venden/i],
    ['8  revocación del consentimiento', 'art. 7 último párrafo', /retirar tu consentimiento/i],
    ['10 contacto de datos personales', 'art. 29', /dirigirte en la empresa/i],
    ['11 oposición al tratamiento automatizado', 'art. 26 fr. II', /sin que una persona la mire antes/i],
  ];

  it.each(ELEMENTOS)('%s está en el texto', (_elemento, fundamento, marca) => {
    expect(todo()).toMatch(marca);
    expect(fundamentos()).toContain(fundamento);
  });

  it('el 9 (liga al integral) vive en el SIMPLIFICADO, no aquí', () => {
    // Es el único de los once que NO va en el integral: sería una liga a sí
    // mismo. Se comprueba donde sí va, para que la tabla quede cubierta entera.
    const simple = avisoSimplificado(FLOTA);
    expect(simple).toContain(FLOTA.urlAvisoIntegral);
  });
});

describe('lo que el aviso NO puede inventar', () => {
  it('sin contacto capturado lo DICE, en vez de rellenarlo con el chat', () => {
    // El criterio que ya rige a la liga rota: decirle la verdad al titular
    // cumple más que un contacto que no existe. Y deja el hueco visible.
    const s = avisoIntegral(FLOTA).find((x) => x.fundamento === 'LFPDPPP art. 29')!;
    expect(s.pendiente).toBe(true);
    expect(s.parrafos.join(' ')).toMatch(/todavía no ha designado/i);
  });

  it('con contacto capturado, lo pone y deja de estar pendiente', () => {
    const s = avisoIntegral({ ...FLOTA, contactoPrivacidad: 'Datos Personales · datos@flotademo.mx · 477 100 2000' })
      .find((x) => x.fundamento === 'LFPDPPP art. 29')!;
    expect(s.pendiente).toBeFalsy();
    expect(s.parrafos[0]).toContain('datos@flotademo.mx');
  });

  it('ninguna otra sección nace pendiente: solo el art. 29 depende de un dato de la flota', () => {
    const pendientes = avisoIntegral(FLOTA).filter((s) => s.pendiente).map((s) => s.fundamento);
    expect(pendientes).toEqual(['LFPDPPP art. 29']);
  });

  it('la razón social y el domicilio salen de los datos, no de una plantilla', () => {
    const otra = avisoIntegral({ ...FLOTA, razonSocial: 'FLETES DEL BAJÍO SA', domicilio: 'Calle 5, León' });
    const texto = otra.flatMap((s) => s.parrafos).join('\n');
    expect(texto).toContain('FLETES DEL BAJÍO SA');
    expect(texto).toContain('Calle 5, León');
    expect(texto).not.toContain('DEMO');
  });
});

describe('lo que este producto sí hace, dicho sin adornos', () => {
  it('nombra la conservación de cinco años del CFF 30 como límite de la revocación', () => {
    // El titular tiene que saber ANTES que revocar no borra los comprobantes ya
    // usados. Prometer un borrado que la ley impide es la clase de promesa que
    // se descubre justo cuando alguien la ejerce.
    const s = avisoIntegral(FLOTA).find((x) => x.fundamento.includes('art. 7'))!;
    expect(s.parrafos.join(' ')).toMatch(/cinco años/);
    expect(s.parrafos.join(' ')).toMatch(/CFF art\. 30|art\. 30/);
  });

  it('dice que los modelos de lenguaje leen las fotos, y que se les pide no retener', () => {
    // Esconderlo detrás de "proveedores tecnológicos" sería cierto y useless.
    //
    // AUDITORÍA 8, ALTO: "contratados con retención cero" afirmaba un contrato
    // de Zero Data Retention que nadie negoció con OpenRouter —
    // `data_collection: 'deny'` es una preferencia de ruteo que se PIDE en
    // cada llamada, no una garantía confirmada del lado del proveedor. El
    // aviso ya no puede decir más de lo que el código sabe.
    expect(todo()).toMatch(/modelos de lenguaje/i);
    expect(todo(), 'ya no debe prometer un contrato que no existe').not.toMatch(/retención cero/i);
    expect(todo()).toMatch(/se les pide|se le pide/i);
    expect(todo()).toMatch(/no retengan|no retenga/i);
  });

  it('separa encargados de transferencias, que es la distinción del art. 2 fr. XX', () => {
    const s = avisoIntegral(FLOTA).find((x) => x.fundamento === 'LFPDPPP art. 35')!;
    expect(s.parrafos.join(' ')).toMatch(/no es una transferencia/i);
    expect(s.parrafos.join(' ')).toMatch(/art\. 2 fr\. XX/);
  });

  it('el silencio NO cuenta como aceptar una transferencia futura', () => {
    const s = avisoIntegral(FLOTA).find((x) => x.fundamento === 'LFPDPPP art. 35')!;
    expect(s.parrafos.join(' ')).toMatch(/No hacer nada al leer esto no cuenta/i);
  });

  it('oponerse a la revisión automática no detiene la liquidación, y lo dice', () => {
    const s = avisoIntegral(FLOTA).find((x) => x.fundamento === 'LFPDPPP art. 26 fr. II')!;
    expect(s.parrafos.join(' ')).toMatch(/no detiene tu liquidación/i);
  });

  it('deja claro quién responde: la flota, no Likida', () => {
    const s = avisoIntegral(FLOTA)[0];
    expect(s.parrafos.join(' ')).toMatch(/persona encargada/i);
    expect(s.parrafos.join(' ')).toMatch(/eso no cambia quién responde/i);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // AUDITORÍA 3, ALTO (LEG-A1): los hitos del chofer (0090) — "ya llegué",
  // "estoy descargando", "voy de regreso" — se sellan con hora y se miden
  // (espera en descarga, bitácora por chofer con nombre) y ningún aviso los
  // enunciaba, cuando la fr. III de este mismo texto promete que toda
  // finalidad no escrita exige permiso nuevo (art. 11 vigente).
  // ═════════════════════════════════════════════════════════════════════════
  it('enuncia los avisos del viaje como categoría de dato (fr. II)', () => {
    const s = avisoIntegral(FLOTA).find((x) => x.fundamento === 'LFPDPPP art. 15 fr. II')!;
    const t = s.parrafos.join(' ');
    expect(t).toMatch(/avisos del viaje/i);
    expect(t).toMatch(/ya llegué/);
    expect(t).toMatch(/estoy descargando/);
    expect(t).toMatch(/voy de regreso/);
    expect(t).toMatch(/hora/i);
  });

  it('enuncia la medición de tiempos como finalidad, y ENTRE las no necesarias', () => {
    // La liquidación cierra igual sin hitos: es seguimiento pedido por la
    // empresa, no requisito. Por eso tiene que vivir DESPUÉS del rótulo de
    // "NO son necesarias" — donde el titular conserva la oposición sin que
    // eso afecte su liquidación. Antes del rótulo sería declararla forzosa.
    const s = avisoIntegral(FLOTA).find((x) => x.fundamento === 'LFPDPPP art. 15 fr. III')!;
    const t = s.parrafos.join('\n');
    const rotulo = t.indexOf('NO son necesarias');
    const hitos = t.indexOf('avisos del viaje');
    expect(rotulo).toBeGreaterThan(-1);
    expect(hitos).toBeGreaterThan(rotulo);
    expect(t).toMatch(/espera en la descarga/i);
  });

  it('declara el GPS de la unidad como dato (fr. II) y su uso como finalidad oponible (fr. III)', () => {
    // AUDITORÍA 19, CRÍTICO (legal C1 / C.15). Esta prueba afirmaba "No hay
    // GPS ni rastreo" mientras sincronizar_gps.ts (cron cada 5 min) y el pin
    // de WhatsApp escribían `posicion` desde la 0050 — el aviso negaba un
    // tratamiento que corre en producción. Ahora fija lo contrario: que el
    // dato esté enumerado, que la finalidad esté enunciada entre las NO
    // necesarias (la liquidación cierra sin posiciones — 0207), y que la
    // retención dicha sea la que purgar_posicion ejecuta (90 días).
    expect(todo()).toMatch(/posición GPS de la unidad/i);
    expect(todo()).not.toMatch(/No hay GPS/i);
    // El límite verdadero, dicho: el rastreado es el camión, no el teléfono.
    expect(todo()).toMatch(/tu teléfono no se rastrea/i);
    expect(todo()).toMatch(/90 días/i);
    // La finalidad del GPS vive entre las NO necesarias, con oposición.
    const frIII = avisoIntegral(FLOTA).find((s) => s.fundamento.includes('15 fr. III'))!;
    const t = frIII.parrafos.join('\n');
    const rotulo = t.indexOf('NO son necesarias');
    const gps = t.indexOf('posiciones GPS');
    expect(rotulo).toBeGreaterThan(-1);
    expect(gps).toBeGreaterThan(rotulo);
  });
});

describe('la liga que se le manda al operador ya resuelve', () => {
  it('la del integral servido por la app pasa la revisión de forma', () => {
    // Era el fallo entero: `flotademo.mx` responde NXDOMAIN, así
    // que el simplificado salía degradado y ARCO no tenía a dónde mandar.
    expect(revisarAvisoIntegral(FLOTA.urlAvisoIntegral)).toBe('ok');
  });

  it('y la vieja seguiría pasando la de FORMA — por eso hacía falta una que EXISTA', () => {
    // Deja escrito el límite de `revisarAvisoIntegral`: revisa la forma, no la
    // existencia. Una prueba verde sobre la URL muerta habría dado por bueno el
    // estado anterior; lo que lo arregla es que ahora hay una página detrás.
    expect(revisarAvisoIntegral('https://flotademo.mx/aviso-de-privacidad')).toBe('ok');
  });

  it('en localhost se degrada a propósito: en dev no hay integral público', () => {
    expect(revisarAvisoIntegral('http://localhost:3000/aviso/11111111-1111-1111-1111-111111111111')).toBe('inservible');
  });

  it('cambiar la liga cambia la versión, así que el aviso bueno se reenvía solo', () => {
    // Art. 15 fr. VI. Es lo que hace que las flotas ya avisadas con la liga rota
    // reciban el aviso nuevo sin que nadie corra un script.
    const viejo = avisoSimplificado({ ...FLOTA, urlAvisoIntegral: 'https://flotademo.mx/aviso-de-privacidad' })!;
    const nuevo = avisoSimplificado(FLOTA)!;
    expect(versionAviso(viejo)).not.toBe(versionAviso(nuevo));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28, LEG-M4 [MEDIO]: el párrafo de salud prometía, para el ejemplo
// del ticket de farmacia, que el filtro lo excluía ENTERO ("no se guarda como
// dato, no participa en tu liquidación"). `intake/sanitizar.ts`
// (`sanitizarProducto`) SOLO descarta el campo `producto`; el nombre del
// comercio, su RFC (`ocr_extra.emisor`, `rfc_emisor`), el monto, la fecha y la
// imagen se guardan igual (`repo.ts` `addGasto`) y el gasto entra al cuadre.
// ═══════════════════════════════════════════════════════════════════════════
describe('LEG-M4 · el ticket de farmacia describe el tratamiento real, no una exclusión total', () => {
  it('ya no promete que el filtro lo excluye entero', () => {
    expect(todo()).not.toMatch(/no se guarda como dato, no participa en tu liquidación/i);
  });

  it('dice qué se descarta (el producto) y qué se conserva (comercio, RFC, monto, fecha, imagen)', () => {
    const t = todo();
    expect(t).toMatch(/descarta la línea del.{0,20}producto/i);
    expect(t).toMatch(/el medicamento/i);
    expect(t).toMatch(/nombre del comercio/i);
    expect(t).toMatch(/su RFC/i);
    expect(t).toMatch(/comprobante fiscal/i);
    // Y sigue siendo cierto que ese gasto entra a la liquidación.
    expect(t).toMatch(/ese gasto entra a tu liquidación/i);
  });

  it('la promesa de "no se piden ni se conservan datos sensibles" (categorías, no el ticket) se conserva', () => {
    // Es el elemento 2 del checklist §5.4 — sigue siendo cierto para origen
    // racial, creencias, afiliación sindical, preferencias sexuales y datos
    // biométricos. Lo que cambió es el ejemplo del ticket, no esta promesa.
    expect(todo()).toMatch(/No se piden ni se conservan datos sensibles/i);
  });
});
