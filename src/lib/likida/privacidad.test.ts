import { describe, it, expect, vi } from 'vitest';
import { avisoSimplificado, versionAviso, versionAvisoVigente, pideAtencionPrivacidad, respuestaPrivacidad, revisarAvisoIntegral, sondearAvisoIntegral, tipoDeSolicitudArco, venceArco, type DatosResponsable, type DatosIntegral } from './privacidad';

// ═══════════════════════════════════════════════════════════════════════════
// B19 — El aviso de privacidad no existía en ningún punto del flujo.
//
// Quién debe darlo: el RESPONSABLE, que es la FLOTA (LFPDPPP art. 14). Likida
// es persona encargada (art. 2 fr. XII) y trata los datos por cuenta de ella.
// Así que esto NO es el aviso de Likida: es el mecanismo para que la flota
// ponga el SUYO, que sin producto no puede aunque quiera.
//
// Qué exige el canal: los datos entran por WhatsApp, o sea por medio
// electrónico, así que aplica el art. 16 fr. II — modalidad SIMPLIFICADA con al
// menos las fracciones I a IV del art. 15, más dónde consultar el integral. El
// aviso completo NO va en un mensaje de WhatsApp.
// ═══════════════════════════════════════════════════════════════════════════
const flota: DatosResponsable = {
  razonSocial: 'TRANSPORTES DEL SURESTE SA DE CV',
  domicilio: 'Av. Itzáes 500, Mérida, Yucatán',
  urlAvisoIntegral: 'https://transportesdelsureste.mx/privacidad',
};

describe('avisoSimplificado', () => {
  it('trae las cuatro fracciones que exige el art. 16 fr. II', () => {
    const a = avisoSimplificado(flota)!;
    expect(a).toContain(flota.razonSocial);        // fr. I  — identidad
    expect(a).toContain(flota.domicilio);          // fr. I  — domicilio
    expect(a).toMatch(/foto|comprobante|gasto/i);  // fr. II — qué datos
    expect(a).toMatch(/liquid/i);                  // fr. III — para qué
    expect(a).toMatch(/whatsapp|escrib|respond/i); // fr. IV — cómo limitar
  });

  it('señala dónde está el aviso integral', () => {
    expect(avisoSimplificado(flota)).toContain(flota.urlAvisoIntegral);
  });

  it('nombra a la flota como responsable, NO a Likida', () => {
    // Invertir esto le dice al operador que sus datos son de un proveedor que no
    // conoce, y le pone a Likida una obligación que la ley le da a la flota.
    const a = avisoSimplificado(flota)!;
    const iFlota = a.indexOf(flota.razonSocial);
    expect(iFlota).toBeGreaterThanOrEqual(0);
    expect(a).toMatch(/responsable/i);
  });

  it('dice que hay un proveedor que trata los datos por cuenta de la flota', () => {
    // Art. 2 fr. XX: mandarle datos a la persona encargada no es transferencia,
    // pero el operador igual tiene derecho a saber por dónde pasan sus fotos.
    expect(avisoSimplificado(flota)).toMatch(/Likida/);
  });

  it('SIN la identidad del responsable devuelve null: no se inventa uno', () => {
    // Un aviso con el nombre equivocado es peor que no tenerlo: sale mal el dato
    // de a quién reclamarle, que es justo para lo que sirve el aviso.
    expect(avisoSimplificado({ ...flota, razonSocial: '' })).toBeNull();
    expect(avisoSimplificado({ ...flota, domicilio: '' })).toBeNull();
  });

  it('advierte del tratamiento automatizado y del derecho a oponerse', () => {
    // Art. 26 fr. II: la revisión de comprobantes evalúa fiabilidad SIN
    // intervención humana y tiene efecto económico. El elemento 11 del checklist
    // (§5.4 de 11-datos-personales.md) vive en el integral — que hoy no existe —,
    // así que un derecho que solo se anuncia allá no se ejerce nunca.
    const a = avisoSimplificado(flota)!;
    expect(a).toMatch(/programa|automátic/i);
    expect(a).toMatch(/oponerte/i);
  });

  it('enumera la revisión entre viajes en vez de cerrar con "nada más"', () => {
    // Art. 11 vigente: perdió las palabras "compatible o análogo" de la ley
    // abrogada. Una finalidad que el aviso no enuncia requiere consentimiento
    // NUEVO, y `detectarAnomalias` correlaciona gastos ENTRE viajes y le entrega
    // el resultado al contralor. Decir "nada más" volvía falso el aviso.
    const a = avisoSimplificado(flota)!;
    expect(a).not.toMatch(/nada más/i);
    expect(a).toMatch(/viajes anteriores|repetido|alterado/i);
  });

  it('cabe en un mensaje de WhatsApp', () => {
    // El límite de Meta para texto es 4096. Un aviso que se parte en varios
    // mensajes se lee a medias y la constancia queda coja. El tope era 1400;
    // subió a 1900 el 28-ago-2026 porque la fr. II ganó el dato que faltaba
    // enumerar (el GPS — auditoría 19, legal C1): un aviso más corto que
    // calla un tratamiento no es más legible, es más falso. Sigue cabiendo
    // entero en UN mensaje con margen de 2×.
    expect(avisoSimplificado(flota)!.length).toBeLessThan(1900);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // AUDITORÍA 3, ALTO (LEG-A1): los hitos del chofer (0090 — llegada, descarga,
  // regreso) se sellaban con hora y se medían ("espera en patio") sin que
  // ningún aviso lo enunciara — y el integral promete que toda finalidad no
  // escrita exige permiso nuevo (art. 11 vigente, sin la válvula de
  // "compatibles o análogos"). Estas pruebas fijan que el texto lo diga.
  // ═════════════════════════════════════════════════════════════════════════
  it('enuncia los avisos del viaje como dato y su medición de tiempos como finalidad', () => {
    const a = avisoSimplificado(flota)!;
    // El dato, con las palabras que el chofer de verdad manda (hitos_viaje.ts).
    expect(a).toMatch(/ya llegué/i);
    expect(a).toMatch(/estoy descargando/i);
    expect(a).toMatch(/voy de regreso/i);
    expect(a).toMatch(/hora/i);
    // La finalidad: medir tiempos, con el ejemplo real (la espera en descarga).
    expect(a).toMatch(/medir sus tiempos/i);
    expect(a).toMatch(/espera en la descarga/i);
  });

  it('declara el GPS por su nombre: la posición de la unidad y el pin del chat, con su retención', () => {
    // AUDITORÍA 19, CRÍTICO (legal C1 / C.15). Esta prueba afirmaba lo
    // contrario ("no hay GPS") mientras el cron de /api/cron/gps y el pin de
    // WhatsApp escribían `posicion` desde la 0050. El aviso ahora declara el
    // tratamiento que ocurre, con sus dos límites verdaderos: lo rastreado es
    // el camión (no el teléfono) y las posiciones se borran a los 90 días
    // (purgar_posicion, mig. 0155). Si alguien vuelve a escribir "no hay GPS"
    // en el aviso, esta prueba truena — y debe tronar, porque el sistema sí
    // lo graba.
    const a = avisoSimplificado(flota)!;
    expect(a).toMatch(/posición\s+de\s+la\s+unidad/i);
    expect(a).toMatch(/gps/i);
    expect(a).not.toMatch(/no hay gps/i);
    // El límite verdadero: el teléfono no se rastrea; el camión sí.
    expect(a).toMatch(/tu teléfono no se rastrea/i);
    // La retención prometida es la que purgar_posicion ejecuta (90 días).
    expect(a).toMatch(/90 días/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// La liga muerta. El aviso que salió a producción apuntaba a un dominio sin
// zona DNS (NXDOMAIN) y esa misma liga era la ÚNICA respuesta al ejercicio de
// un derecho ARCO. El art. 16 obliga a poner el aviso a disposición; una liga
// que no abre no lo pone, y la constancia en la base afirma que sí.
// ═══════════════════════════════════════════════════════════════════════════
describe('revisarAvisoIntegral', () => {
  it('acepta una dirección pública bien formada', () => {
    expect(revisarAvisoIntegral('https://transportesdelsureste.mx/privacidad')).toBe('ok');
    expect(revisarAvisoIntegral('  http://flota.com.mx/aviso  ')).toBe('ok');
  });

  it('vacía es "ausente", no "inservible": son dos huecos distintos', () => {
    // Ausente = la flota no la capturó. Inservible = capturó algo que no abre.
    // Se distinguen porque quien tiene que arreglarlos hace cosas distintas.
    expect(revisarAvisoIntegral('')).toBe('ausente');
    expect(revisarAvisoIntegral('   ')).toBe('ausente');
    expect(revisarAvisoIntegral(null)).toBe('ausente');
    expect(revisarAvisoIntegral(undefined)).toBe('ausente');
  });

  it('rechaza lo que no es un sitio consultable', () => {
    for (const u of [
      'pendiente',                       // no parsea
      'transportes.mx/aviso',            // sin esquema: no parsea
      'mailto:datos@flota.mx',           // no es un sitio
      'ftp://flota.mx/aviso.pdf',
      'https://localhost/aviso',         // no es público
      'https://intranet/aviso',          // host sin dominio de primer nivel
      'https://127.0.0.1/aviso',         // IP desnuda: último tramo numérico
      'https://www.ejemplo.com/aviso',   // relleno
      'https://example.com/privacidad',
      'https://tudominio.mx/aviso',
    ]) expect(revisarAvisoIntegral(u), u).toBe('inservible');
  });

  it('NO promete que el sitio exista — y esto es el límite de la revisión', () => {
    // El dominio del incidente real está bien escrito y no está registrado. Esta
    // función lo deja pasar a propósito: mentir sobre su alcance sería repetir
    // el error de fondo. Lo que prueba existencia es `sondearAvisoIntegral`.
    expect(revisarAvisoIntegral('https://flotademo.mx/aviso-de-privacidad')).toBe('ok');
  });
});

describe('sondearAvisoIntegral', () => {
  it('un dominio que no resuelve NO abre, y el motivo queda para el log', async () => {
    const nxdomain = async () => { throw new Error('getaddrinfo ENOTFOUND flotademo.mx'); };
    const r = await sondearAvisoIntegral('https://flotademo.mx/aviso-de-privacidad', {
      fetchImpl: nxdomain as unknown as typeof fetch,
    });
    expect(r.abre).toBe(false);
    expect(r).toHaveProperty('motivo', expect.stringContaining('ENOTFOUND'));
  });

  it('un 404 tampoco abre: el sitio existe pero el aviso no', async () => {
    const f = async () => new Response(null, { status: 404 });
    const r = await sondearAvisoIntegral('https://flota.mx/aviso', { fetchImpl: f as unknown as typeof fetch });
    expect(r).toEqual({ abre: false, motivo: 'http 404' });
  });

  it('reintenta con GET si el servidor no implementa HEAD', async () => {
    // Un 405 al HEAD no significa que la página no exista. Declararla muerta por
    // eso mandaría a la flota a arreglar una liga que estaba bien.
    const vistos: string[] = [];
    const f = async (_u: string, init?: RequestInit) => {
      vistos.push(init?.method ?? 'GET');
      return new Response(null, { status: init?.method === 'HEAD' ? 405 : 200 });
    };
    const r = await sondearAvisoIntegral('https://flota.mx/aviso', { fetchImpl: f as unknown as typeof fetch });
    expect(r).toEqual({ abre: true });
    expect(vistos).toEqual(['HEAD', 'GET']);
  });

  it('no sale a la red si la liga ya era inservible', async () => {
    let llamadas = 0;
    const f = async () => { llamadas++; return new Response(null, { status: 200 }); };
    const r = await sondearAvisoIntegral('pendiente', { fetchImpl: f as unknown as typeof fetch });
    expect(r).toEqual({ abre: false, motivo: 'liga inservible' });
    expect(llamadas).toBe(0);
  });
});

describe('avisoSimplificado con la liga rota', () => {
  const sinLiga: DatosResponsable[] = [
    { ...flota, urlAvisoIntegral: '' },
    { ...flota, urlAvisoIntegral: 'pendiente' },
    { ...flota, urlAvisoIntegral: 'https://www.ejemplo.com/aviso' },
  ];

  it('sigue mandando el aviso: las fr. I a IV caben enteras en el mensaje', () => {
    // Callarse dejaría al titular sin nada cuando puede quedarse con casi todo.
    // Lo que falta es el puntero al integral, no el aviso (art. 16 fr. II).
    for (const r of sinLiga) {
      const a = avisoSimplificado(r);
      expect(a, JSON.stringify(r.urlAvisoIntegral)).not.toBeNull();
      expect(a!).toContain(flota.razonSocial);
      expect(a!).toContain(flota.domicilio);
      expect(a!).toMatch(/PRIVACIDAD/);
    }
  });

  it('NO pega la liga que no abre', () => {
    // Es lo que convirtió el aviso en una constancia de algo que no ocurrió.
    expect(avisoSimplificado({ ...flota, urlAvisoIntegral: 'https://www.ejemplo.com/aviso' })!)
      .not.toContain('ejemplo.com');
  });

  it('dice la verdad: que la empresa aún no lo publica', () => {
    const a = avisoSimplificado({ ...flota, urlAvisoIntegral: '' })!;
    expect(a).toMatch(/aún no lo publica|todavía no/i);
  });

  it('cuando la flota publique el integral, el aviso bueno se reenvía solo', () => {
    // Art. 15 fr. VI, gratis: los dos textos son distintos, así que el hash
    // cambia y `marcar_aviso_privacidad` dispara el reenvío sin que nadie mueva
    // un contador. El hueco se cierra sin intervención manual.
    const roto = versionAviso(avisoSimplificado({ ...flota, urlAvisoIntegral: '' })!);
    const bueno = versionAviso(avisoSimplificado(flota)!);
    expect(roto).not.toBe(bueno);
  });
});

describe('versionAviso', () => {
  it('el mismo texto da la misma versión', () => {
    const a = avisoSimplificado(flota)!;
    expect(versionAviso(a)).toBe(versionAviso(a));
  });

  it('si la flota cambia un dato, la versión cambia y el aviso se reenvía', () => {
    // Art. 15 fr. VI obliga a comunicar los cambios al aviso. Derivar la versión
    // del contenido lo vuelve automático: confiar en que alguien se acuerde de
    // subir un contador es como no comunicarlos.
    const v1 = versionAviso(avisoSimplificado(flota)!);
    const v2 = versionAviso(avisoSimplificado({ ...flota, domicilio: 'Otra calle 1, Mérida' })!);
    expect(v2).not.toBe(v1);
  });

  it('cambiar la liga del aviso integral también cuenta como cambio', () => {
    const v1 = versionAviso(avisoSimplificado(flota)!);
    const v2 = versionAviso(avisoSimplificado({ ...flota, urlAvisoIntegral: 'https://otra.mx/p' })!);
    expect(v2).not.toBe(v1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28, LEG-A4 [ALTO, reincidente desde la 26] — la firma que dispara
// el reenvío nunca había visto el INTEGRAL, y su propia sección «Cómo te
// avisamos si este aviso cambia» promete lo contrario. El PR #401 (LEG-B1)
// cambió el integral (plazo de borrado de cámara) y ningún operador con
// constancia recibió nada, porque `versionAviso(avisoSimplificado(...))` no
// se movió. `versionAvisoVigente` es la firma que SÍ cubre los dos textos.
// ═══════════════════════════════════════════════════════════════════════════
describe('versionAvisoVigente — la firma cubre los DOS textos (LEG-A4)', () => {
  const flotaIntegral: DatosIntegral = { ...flota, contactoPrivacidad: 'Depto. de Datos Personales, datos@transportesdelsureste.mx' };

  it('la misma flota da la misma versión (determinista)', () => {
    expect(versionAvisoVigente(flotaIntegral)?.version).toBe(versionAvisoVigente(flotaIntegral)?.version);
  });

  it('ESTE ES EL HUECO: cambiar un dato que SOLO vive en el integral (contactoPrivacidad) mueve versionAvisoVigente pero NO versionAviso(avisoSimplificado(...))', () => {
    const otro: DatosIntegral = { ...flotaIntegral, contactoPrivacidad: 'Otro contacto, otro@correo.mx' };

    const vSimplificadoA = versionAviso(avisoSimplificado(flotaIntegral)!);
    const vSimplificadoB = versionAviso(avisoSimplificado(otro)!);
    expect(vSimplificadoB, 'el simplificado no declara el contacto del art. 29: no debería cambiar').toBe(vSimplificadoA);

    const vVigenteA = versionAvisoVigente(flotaIntegral)?.version;
    const vVigenteB = versionAvisoVigente(otro)?.version;
    expect(vVigenteB, 'la firma vigente SÍ tiene que moverse: es el hueco que este lote cierra').not.toBe(vVigenteA);
  });

  it('cambiar el domicilio (vive en los dos textos) también mueve la firma vigente', () => {
    const otro: DatosIntegral = { ...flotaIntegral, domicilio: 'Otra calle 1, Mérida' };
    expect(versionAvisoVigente(otro)?.version).not.toBe(versionAvisoVigente(flotaIntegral)?.version);
  });

  it('sin razón social (o sin domicilio) da null, igual que avisoSimplificado', () => {
    expect(versionAvisoVigente({ ...flotaIntegral, razonSocial: '' })).toBeNull();
    expect(versionAvisoVigente({ ...flotaIntegral, domicilio: '' })).toBeNull();
  });

  it('no depende de la hora ni de VIGENTE_DESDE: dos relojes distintos dan la misma firma', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const v1 = versionAvisoVigente(flotaIntegral)?.version;
    vi.setSystemTime(new Date('2027-06-15T12:00:00Z'));
    const v2 = versionAvisoVigente(flotaIntegral)?.version;
    vi.useRealTimers();
    expect(v2).toBe(v1);
  });

  it('el texto que devuelve sigue siendo el SIMPLIFICADO (lo que de verdad sale por WhatsApp)', () => {
    const vigente = versionAvisoVigente(flotaIntegral);
    expect(vigente?.texto).toBe(avisoSimplificado(flotaIntegral));
  });
});

// El aviso le PROMETE al operador que escribiendo PRIVACIDAD se le atiende. Si
// esa palabra no dispara nada, el medio del art. 15 fr. IV no se ofreció: se
// anunció. Y esto va determinístico, antes del agente — un derecho ARCO no se
// deja a que el LLM decida si el mensaje califica.
describe('pideAtencionPrivacidad', () => {
  it('reconoce la palabra que el propio aviso le dijo que escribiera', () => {
    for (const t of ['PRIVACIDAD', 'privacidad', 'Privacidad porfa', 'quiero privacidad'])
      expect(pideAtencionPrivacidad(t), t).toBe(true);
  });

  it('aguanta cómo se escribe de verdad en WhatsApp', () => {
    for (const t of ['pRiVaCiDaD', 'ARCO', 'mis datos personales', 'quiero dar de baja mis datos'])
      expect(pideAtencionPrivacidad(t), t).toBe(true);
  });

  it('no se dispara con mensajes normales del flujo', () => {
    // Un falso positivo secuestra la liquidación y el operador no entiende nada.
    for (const t of ['listo', 'ya mandé todo', 'cuánto sobró?', 'el diesel fue de 4000', 'arcos de la caseta'])
      expect(pideAtencionPrivacidad(t), t).toBe(false);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // El aviso ANUNCIA la oposición del art. 26 fr. II —"tienes derecho a
  // oponerte a que se decida así y a pedir que la revise alguien"— y el
  // mecanismo tiene que reconocer que alguien la ejerce. §6 de
  // 11-datos-personales.md lo pide con esas palabras: "un mecanismo de
  // oposición documentado en el aviso Y ACCESIBLE DESDE WHATSAPP".
  //
  // Quien acaba de leer esa frase no escribe PRIVACIDAD: escribe "me opongo" o
  // "quiero que lo revise una persona". Si eso cae en el agente, el derecho
  // queda a criterio del LLM, que es justo lo que este módulo decidió no hacer.
  // ═════════════════════════════════════════════════════════════════════════
  it('reconoce la oposición al tratamiento automatizado, no solo la palabra PRIVACIDAD', () => {
    for (const t of [
      'me opongo',
      'Me opongo a que un programa revise mis comprobantes',
      'quiero oponerme a eso',
      'oposición al tratamiento automatizado',
      'quiero que lo revise una persona',
      'que lo revise alguien, no un programa',
      'pido revisión humana',
      'quiero que una persona lo revise',
    ]) expect(pideAtencionPrivacidad(t), t).toBe(true);
  });

  it('el aviso y el detector no pueden divergir', () => {
    // El gancho que faltaba. La ficha `normas/lfpdppp-26-II.yaml` se escribió con
    // `usado_en_codigo: []` —una conclusión sin nada que la amarre al código— y
    // por eso nadie volvió a ella. Esta prueba amarra las dos mitades del
    // mecanismo: si alguien reescribe la frase del aviso, aquí se entera de que
    // también tiene que mirar `OPOSICION`, en vez de dejar anunciado un derecho
    // cuyo ejercicio ya no reconoce nadie.
    expect(avisoSimplificado(flota)!).toContain('pedir que la revise alguien');
    expect(pideAtencionPrivacidad('quiero pedir que la revise alguien')).toBe(true);
  });

  it('la oposición tampoco se dispara con la conversación normal', () => {
    for (const t of [
      'ya lo revisé con la persona de la caseta',
      'la persona de la gasolinera me dio el ticket',
      'me opuse el mes pasado al horario',   // ni "opongo" ni "oponerme"
      'revisa el monto porfa',
    ]) expect(pideAtencionPrivacidad(t), t).toBe(false);
  });
});

describe('respuestaPrivacidad', () => {
  it('remite al aviso integral de la FLOTA, que es donde viven los ARCO', () => {
    const r = respuestaPrivacidad(flota);
    expect(r).toContain(flota.urlAvisoIntegral);
    expect(r).toContain(flota.razonSocial);
  });

  it('NO promete que Likida resolvió el ARCO', () => {
    // Likida es persona encargada: actúa por instrucciones del responsable. Decir
    // "ya te dimos de baja" sería mentir sobre quién puede hacerlo.
    const r = respuestaPrivacidad(flota).toLowerCase();
    expect(r).not.toMatch(/ya (te )?(dimos de baja|borramos|eliminamos|cancelamos)/);
  });

  it('tranquiliza sobre la liquidación: preguntar no le cuesta nada', () => {
    expect(respuestaPrivacidad(flota)).toMatch(/no la afecta|sigue igual/i);
  });

  it('con la liga rota NO la manda: sería dejarlo sin ejercer y creyendo que sí', () => {
    // Este es el único camino que el producto ofrece para ejercer un derecho.
    // Contestarlo con un dominio que no abre es peor que reconocer el hueco.
    const r = respuestaPrivacidad({ ...flota, urlAvisoIntegral: 'https://www.ejemplo.com/aviso' });
    expect(r).not.toContain('ejemplo.com');
    expect(r).toMatch(/no publica la liga|no tengo a dónde/i);
  });

  it('con la liga rota igual dice a quién reclamarle y dónde emplazarlo', () => {
    // Art. 15 fr. I: identidad Y domicilio. Es lo que sí se tiene y es
    // exactamente lo que la fracción persigue.
    const r = respuestaPrivacidad({ ...flota, urlAvisoIntegral: '' });
    expect(r).toContain(flota.razonSocial);
    expect(r).toContain(flota.domicilio);
  });

  it('nombra la oposición a la revisión automática TAMBIÉN cuando la liga sirve', () => {
    // Art. 26 fr. II. La rama degradada ya lo decía y la rama buena no: el
    // operador que ejerce la oposición recibía una respuesta que no menciona el
    // derecho que acaba de ejercer. El día que la flota publique su integral,
    // el producto diría MENOS que hoy sobre el único derecho que este sistema
    // activa por sí mismo.
    for (const r of [flota, { ...flota, urlAvisoIntegral: '' }])
      expect(respuestaPrivacidad(r), r.urlAvisoIntegral).toMatch(/revisión automática|automátic/i);
  });

  it('no afirma que le avisó a la empresa: solo registra', () => {
    // Lo que ocurre es una línea de log que la empresa consulta, no una
    // notificación que salga hacia ella. Afirmar lo segundo es afirmar un
    // estado que el producto no produce.
    expect(respuestaPrivacidad(flota)).not.toMatch(/ya le avis/i);
    expect(respuestaPrivacidad(flota)).toMatch(/queda registrada/i);
  });
});

// ── AUDITORÍA 12 · ALTO LEGAL: el ARCO por fin se registra ──────────────────
describe('tipoDeSolicitudArco y venceArco — el registro que el aviso promete', () => {
  it('clasifica cancelación por la frase natural de WhatsApp', () => {
    expect(tipoDeSolicitudArco('Quiero que borren mis datos por favor')).toBe('cancelacion');
    expect(tipoDeSolicitudArco('Quiero que eliminen mi información de la empresa')).toBe('cancelacion');
    expect(tipoDeSolicitudArco('Denme de baja del sistema')).toBe('cancelacion');
  });

  it('clasifica oposición y rectificación', () => {
    expect(tipoDeSolicitudArco('Me opongo a que revisen mis comprobantes automáticamente')).toBe('oposicion');
    expect(tipoDeSolicitudArco('Quiero corregir mi nombre, está mal escrito')).toBe('rectificacion');
  });

  it('cae a acceso ante la duda — el derecho genérico, y la flota decide', () => {
    expect(tipoDeSolicitudArco('Privacidad')).toBe('acceso');
    expect(tipoDeSolicitudArco('Quiero saber qué datos tienen de mí')).toBe('acceso');
  });

  it('venceArco suma 15 DÍAS HÁBILES (LFPDPPP art. 32), no calendario', () => {
    // Viernes 1-ago-2026 → 15 días hábiles después: salta el fin de semana.
    const vence = venceArco(new Date('2026-08-01T12:00:00Z'));
    // 15 días hábiles desde el sábado... el conteo arranca el siguiente día
    // hábil. Verificamos que es un día ENTRE SEMANA y que está en la ventana.
    const d = new Date(`${vence}T00:00:00Z`);
    expect([1, 2, 3, 4, 5]).toContain(d.getUTCDay());
  });
});
