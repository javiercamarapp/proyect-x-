// ═══════════════════════════════════════════════════════════════════════════
// EL MAPA DE PROSPECTOS (Fase D, orden del 17-ago) — datos y criterio.
//
// Dos porcentajes viven aquí y los dos son ESTIMACIONES DETERMINISTAS con el
// criterio a la vista (regla de la casa: una estimación se puede mostrar,
// declarada y con su supuesto — jamás una cifra que parezca medición):
//
//  · URGENCIA — qué tanto les duele HOY, leído de su propia conducta: la
//    vacante que publicaron (nombrar la liquidación es confesión directa),
//    cuántos anuncios y qué tan recientes.
//  · CIERRE — qué tan alcanzable es el trato: si hay teléfono/correo/decisor
//    (no se puede cerrar a quien no se puede llamar), el fit del giro y qué
//    tan avanzado va el embudo.
//
// Las funciones de score son puras y exportadas: la prueba las fija y el
// pie del mapa enseña el criterio con las mismas palabras de este archivo.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase/admin';
import { conteo, exigir, traerTodo, traerPorIds, PAGINA, LecturaIncompleta, type RespuestaPg } from '@/lib/likida/pg';
import { logger } from '@/lib/logger';
import { anotarBitacora } from '@/lib/likida/bitacora_escritura';
import { normalizarEstadoProspecto } from '@/lib/likida/vendedores';
import {
  type DatosMapa, type DetalleProspecto, type FilaCompacta, type Giro,
  type ProspectoMapa, type Tamano, type TextosProspecto,
} from './prospectos-mapa-client';
export { COLOR_EMBUDO, CRITERIO_SCORES, NOMBRE_GIRO, TAMANOS, desempacar } from './prospectos-mapa-client';
export type {
  DatosMapa, DetalleProspecto, FilaCompacta, Giro, PersonaProspecto,
  ProspectoMapa, Tamano, TextosProspecto,
} from './prospectos-mapa-client';

// ── El embudo → color. UNA fuente para pines SVG, marcadores de calle,
// leyenda y tarjetas — dos paletas del mismo estado se desincronizan. ──────

// ── Normalización y plaza ───────────────────────────────────────────────────

function normalizar(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Alias → nombre EXACTO de ESTADOS_GEO (mexico-estados-geo.ts). */
const ALIAS_ENTIDAD: Record<string, string> = {
  'cdmx': 'Ciudad de México', 'ciudad de mexico': 'Ciudad de México', 'df': 'Ciudad de México',
  'distrito federal': 'Ciudad de México',
  'estado de mexico': 'México', 'edomex': 'México', 'mexico': 'México', 'edo de mexico': 'México',
  'nuevo leon': 'Nuevo León', 'michoacan': 'Michoacán', 'queretaro': 'Querétaro',
  'san luis potosi': 'San Luis Potosí', 'yucatan': 'Yucatán', 'baja california': 'Baja California',
  'baja california sur': 'Baja California Sur', 'aguascalientes': 'Aguascalientes',
  'campeche': 'Campeche', 'chiapas': 'Chiapas', 'chihuahua': 'Chihuahua', 'coahuila': 'Coahuila',
  'colima': 'Colima', 'durango': 'Durango', 'guanajuato': 'Guanajuato', 'guerrero': 'Guerrero',
  'hidalgo': 'Hidalgo', 'jalisco': 'Jalisco', 'morelos': 'Morelos', 'nayarit': 'Nayarit',
  'oaxaca': 'Oaxaca', 'puebla': 'Puebla', 'quintana roo': 'Quintana Roo', 'sinaloa': 'Sinaloa',
  'sonora': 'Sonora', 'tabasco': 'Tabasco', 'tamaulipas': 'Tamaulipas', 'tlaxcala': 'Tlaxcala',
  'veracruz': 'Veracruz', 'zacatecas': 'Zacatecas',
};

/** Ciudades frecuentes del censo → su estado, para los prospectos cuya
 *  `ciudad` viene sin entidad ("Guadalajara" a secas). Cobertura parcial a
 *  propósito: lo que no se sabe cae a "sin plaza", no se adivina. */
const CIUDAD_A_ENTIDAD: Record<string, string> = {
  'guadalajara': 'Jalisco', 'zapopan': 'Jalisco', 'tlaquepaque': 'Jalisco', 'san pedro tlaquepaque': 'Jalisco', 'tonala': 'Jalisco', 'tlajomulco': 'Jalisco',
  'monterrey': 'Nuevo León', 'escobedo': 'Nuevo León', 'apodaca': 'Nuevo León', 'guadalupe': 'Nuevo León', 'san nicolas': 'Nuevo León', 'santa catarina': 'Nuevo León', 'garcia': 'Nuevo León', 'san pedro garza garcia': 'Nuevo León',
  'merida': 'Yucatán', 'kanasin': 'Yucatán', 'progreso': 'Yucatán', 'uman': 'Yucatán',
  'celaya': 'Guanajuato', 'leon': 'Guanajuato', 'irapuato': 'Guanajuato', 'silao': 'Guanajuato', 'salamanca': 'Guanajuato',
  'tijuana': 'Baja California', 'mexicali': 'Baja California', 'ensenada': 'Baja California',
  'queretaro': 'Querétaro', 'el marques': 'Querétaro', 'san juan del rio': 'Querétaro',
  'toluca': 'México', 'tultitlan': 'México', 'naucalpan': 'México', 'tlalnepantla': 'México', 'ecatepec': 'México', 'cuautitlan': 'México', 'cuautitlan izcalli': 'México', 'tepotzotlan': 'México', 'lerma': 'México',
  'azcapotzalco': 'Ciudad de México', 'iztapalapa': 'Ciudad de México', 'gustavo a madero': 'Ciudad de México', 'cuauhtemoc': 'Ciudad de México', 'miguel hidalgo': 'Ciudad de México', 'vallejo': 'Ciudad de México', 'iztacalco': 'Ciudad de México',
  'puebla': 'Puebla', 'veracruz': 'Veracruz', 'cordoba': 'Veracruz', 'coatzacoalcos': 'Veracruz',
  'culiacan': 'Sinaloa', 'mazatlan': 'Sinaloa', 'hermosillo': 'Sonora', 'chihuahua': 'Chihuahua',
  'ciudad juarez': 'Chihuahua', 'juarez': 'Chihuahua', 'torreon': 'Coahuila', 'saltillo': 'Coahuila',
  'ramos arizpe': 'Coahuila', 'nuevo laredo': 'Tamaulipas', 'reynosa': 'Tamaulipas',
  'matamoros': 'Tamaulipas', 'altamira': 'Tamaulipas', 'tampico': 'Tamaulipas',
  'aguascalientes': 'Aguascalientes', 'san luis potosi': 'San Luis Potosí', 'villahermosa': 'Tabasco',
  'cancun': 'Quintana Roo', 'playa del carmen': 'Quintana Roo', 'chetumal': 'Quintana Roo',
  'oaxaca': 'Oaxaca', 'tuxtla': 'Chiapas', 'tuxtla gutierrez': 'Chiapas', 'tapachula': 'Chiapas',
  'morelia': 'Michoacán', 'uruapan': 'Michoacán', 'lazaro cardenas': 'Michoacán',
  'pachuca': 'Hidalgo', 'tizayuca': 'Hidalgo', 'cuernavaca': 'Morelos', 'durango': 'Durango',
  'zacatecas': 'Zacatecas', 'tepic': 'Nayarit', 'colima': 'Colima', 'manzanillo': 'Colima',
  'acapulco': 'Guerrero', 'campeche': 'Campeche', 'ciudad del carmen': 'Campeche', 'la paz': 'Baja California Sur',
};

/** "Escobedo, Nuevo León" → { ciudad: 'Escobedo', entidad: 'Nuevo León' }.
 *  Devuelve entidad null cuando de verdad no se sabe — "sin plaza" es un
 *  dato, no un hueco a rellenar. */
export function plazaDe(ciudadCruda: string | null): { ciudad: string | null; entidad: string | null } {
  if (!ciudadCruda) return { ciudad: null, entidad: null };
  const crudo = ciudadCruda.trim();
  if (!crudo || /nacional|remoto|computrabajo|indeed|occ/i.test(crudo)) return { ciudad: null, entidad: null };
  const partes = crudo.split(',').map((p) => p.trim()).filter(Boolean);
  const ultima = normalizar(partes[partes.length - 1]);
  if (partes.length > 1 && ALIAS_ENTIDAD[ultima]) {
    return { ciudad: partes.slice(0, -1).join(', '), entidad: ALIAS_ENTIDAD[ultima] };
  }
  // Una sola parte: puede ser una entidad a secas o una ciudad conocida.
  const unica = normalizar(partes[0]);
  if (partes.length === 1 && ALIAS_ENTIDAD[unica] && !CIUDAD_A_ENTIDAD[unica]) {
    return { ciudad: null, entidad: ALIAS_ENTIDAD[unica] };
  }
  const porCiudad = CIUDAD_A_ENTIDAD[normalizar(partes[0])];
  return { ciudad: partes[0], entidad: porCiudad ?? null };
}

// ── Giro ────────────────────────────────────────────────────────────────────

export function giroDe(empresa: string, vacante: string | null, notas: string | null, scian?: string | null): Giro {
  const nombre = normalizar(empresa);
  const todo = normalizar(`${empresa} ${vacante ?? ''} ${notas ?? ''}`);
  // La actividad DENUE (viaja en notas) es la clasificación más confiable —
  // se evalúa antes que las heurísticas de nombre.
  if (/(elaboracion|purificacion|manufactura).{0,30}(bebida|refresco|cerveza|agua)|embotellad/.test(todo)) return 'embotelladora';
  if (/comercio al por mayor de (abarrotes|alimentos|bebidas|hielo|tabaco|frutas|carnes|leche|semillas)/.test(todo)) return 'abarrotes_mayoreo';
  // El SCIAN, cuando existe, es el único veredicto duro (0139) — el sector
  // 48-49 completo comparte la palabra "transporte" con decenas de giros que
  // NO son autotransporte de carga: 485 pasajeros, 488 aduanales/grúas, 492
  // paquetería, 493 almacenamiento. Sin este candado, "AAZ TRANSPORTE"
  // (concesionario de pasajeros) o "24-7 TRANSPORTES INTERNACIONALES"
  // (bróker) calificaban como transportista por el nombre solo — el mismo
  // error que decenas de agentes de investigación han venido corrigiendo a
  // mano, empresa por empresa (18-ago).
  // DENUE normally sends six digits. Compare the three-digit SCIAN prefix,
  // otherwise `484121` slips through as an unknown code and the hard cargo
  // classification is lost.
  const scianPrefix = normalizarScian(scian);
  const esOtroSectorDeTransporte = !!scianPrefix && scianPrefix !== '484';
  if (!esOtroSectorDeTransporte
    && (/\b(transportes|transporte|autotransportes|autotransporte|fletes|trucking|carga|tractocamion|freight)\b/.test(nombre)
      || /autotransporte (foraneo|de carga|local)/.test(todo))) return 'transportista';
  if (/\b(logistica|logistics|forwarding|almacenadora|freight forward|3pl)\b/.test(todo)) return 'logistica';
  if (/\b(reparto|cedis|distribucion|distribuidora|comercializadora|ruta de venta|autoventa|panificad)\b/.test(todo)
    || /comercio al por mayor/.test(todo)) return 'flota_propia';
  return 'otro';
}

/** Normalize 3- or 6-digit SCIAN values to the sector prefix. */
export function normalizarScian(scian: string | null | undefined): string | null {
  const digitos = (scian ?? '').replace(/\D/g, '');
  return digitos.length >= 3 ? digitos.slice(0, 3) : null;
}

export function esScianCarga(scian: string | null | undefined): boolean {
  return normalizarScian(scian) === '484';
}

// ── Tamaño de flota (el estrato DENUE viaja en notas) ──────────────────────

export function tamanoDe(notas: string | null): Tamano | null {
  const m = (notas ?? '').match(/·\s*(\d+) a (\d+) personas|·\s*251 y más personas/);
  if (!m) return null;
  if (!m[1]) return '250+';
  const desde = Number(m[1]);
  if (desde >= 101) return '101-250';
  if (desde >= 51) return '51-100';
  if (desde >= 31) return '31-50';
  if (desde >= 11) return '11-30';
  return null; // 0-10: fuera del ICP, no se etiqueta
}

/** Qué tan COMPLETO está el expediente para salir a venderle (0-100):
 *  teléfono 30 + correo 25 + decisor 20 + ubicación 15 + sitio web 10.
 *  Determinista y declarado, como los otros dos (CRITERIO_SCORES). */
export function completitudDe(p: {
  telefono: string | null; correo: string | null; contacto_nombre: string | null;
  lat: number | null; notas: string | null;
  /** De la 0139. `false` = el enriquecedor lo trajo y nadie lo comprobó. */
  sitioVerificado?: boolean | null;
}): number {
  let s = 0;
  if (p.telefono) s += 30;
  if (p.correo) s += 25;
  if (p.contacto_nombre) s += 20;
  if (p.lat !== null) s += 15;
  // ── TENER UN SITIO NO ES TENER EL SITIO CORRECTO ─────────────────────────
  // Estos 10 puntos se regalaban con solo encontrar el texto «sitio:» en las
  // notas, y eso convertía el error de scraping en PRIORIDAD DE VENTA: una
  // fila con el dominio equivocado puntuaba 100 igual que una correcta y subía
  // en el tablero por encima de prospectos buenos.
  //
  // No es teórico. La auditoría del 18-ago midió 820 filas cuyo dominio está
  // pegado a varias empresas distintas —`grupomodelo.com` aparece en 38,
  // `fedex.com` en 20—, porque el enriquecedor se queda con el del corporativo
  // padre cuando la razón social no tiene sitio propio. Y una fila llegó con
  // el dominio de un PERIÓDICO DE IDAHO.
  //
  // Ahora los puntos los da `sitio_verificado`, no la presencia del texto.
  if (p.sitioVerificado === true) s += 10;
  return s;
}

// ── Los dos porcentajes (0-100, deterministas, criterio a la vista) ────────

/** Cuántos anuncios dice la nota del censo ("· 3 anuncios en el censo"). */
function anunciosDe(notas: string): number {
  const m = notas.match(/(\d+)\s+anuncios?\s+en el censo/);
  return m ? Number(m[1]) : 0;
}

export function scoreUrgencia(p: {
  vacante: string | null; notas: string | null; urgenciaDeclarada?: string | null;
}): number {
  // ── LO QUE DICE DE SÍ MISMO MANDA SOBRE LO QUE INFERIMOS DE ÉL ────────────
  // Todo lo que sigue es arqueología: se deduce el dolor de una vacante que
  // alguien publicó. Cuando la persona lo declaró en /getdemo ya no hay nada
  // que deducir, así que su respuesta FIJA el score en vez de sumarle puntos.
  //
  // Y manda en LOS DOS SENTIDOS, que es lo que hace honesto al número: quien
  // contestó "estoy explorando opciones" queda con TECHO aunque su vacante
  // grite. Si solo subiera, el que te dijo que no corre prisa se ordenaría
  // arriba del que te dijo que sí — el tablero contradiría al prospecto y
  // mandaría a Javier a llamar al equivocado.
  if (p.urgenciaDeclarada === 'inmediata') return 100;

  const notas = p.notas ?? '';
  let s = 0;
  // La confesión directa: su propia vacante nombra la liquidación.
  if (/DOLOR DIRECTO/i.test(notas) || /liquida/i.test(p.vacante ?? '')) s += 45;
  else if (notas) s += 15; // señal del giro: duele, pero lo dijo de lado
  // Insistencia: más anuncios = el puesto no se llena (o rota).
  s += Math.min(20, anunciosDe(notas) * 4);
  // Recencia del último anuncio (formato del censo: "Hace 8 hor", "Hace 3
  // día"). OJO: `normalizar` ya quitó los dos puntos — el patrón va sin ':'.
  const plano = normalizar(notas);
  if (/ultimo anuncio hace \d+ (hor|min)/.test(plano)) s += 20;
  else if (/ultimo anuncio hace [1-7] dia/.test(plano)) s += 15;
  else if (/ultimo anuncio/.test(plano)) s += 5;
  // La ficha trabajada a mano (cuentas nombradas) documenta el dolor textual.
  if (/FICHA 1\d-ago|martirio/i.test(notas)) s += 15;
  const inferida = Math.min(100, s);
  if (p.urgenciaDeclarada === 'trimestre') return Math.min(70, inferida);
  if (p.urgenciaDeclarada === 'explorando') return Math.min(35, inferida);
  return inferida;
}

export function scoreCierre(p: {
  telefono: string | null; correo: string | null; contacto_nombre: string | null;
  estado: string; fuente: string; empresa: string; vacante: string | null; notas: string | null;
  /** Personas de `prospecto_persona` con contacto NO inferido (0138). */
  personasVerificadas?: number;
  /** Código DENUE (0139) — el veredicto duro que usa giroDe. */
  scian?: string | null;
  /** Flota investigada (hecho), preferred over a declared range. */
  numUnidades?: number | null;
  /** Range declared in the public form. */
  unidadesDeclaradas?: string | null;
}): number {
  let s = 0;
  // Alcanzabilidad: no se cierra a quien no se puede llamar.
  if (p.telefono) s += 20;
  if (p.correo) s += 15;
  if (p.contacto_nombre) s += 20;
  // Fit del giro: el transportista vive el ciclo completo (RFA/IEPS/peaje);
  // la flota propia solo una parte.
  const g = giroDe(p.empresa, p.vacante, p.notas, p.scian);
  if (g === 'transportista') s += 15;
  else if (g === 'logistica') s += 10;
  else if (g === 'flota_propia') s += 8;
  // El embudo manda: lo avanzado pesa más que cualquier señal. Los alias se
  // normalizan antes de puntuar; una fila histórica no puede cambiar de score
  // solo por usar el nombre anterior de la misma etapa.
  const estado = normalizarEstadoProspecto(p.estado);
  if (estado === 'contactado') s += 15;
  else if (estado === 'appointment') s += 18;
  else if (estado === 'rescheduled') s += 16;
  else if (estado === 'demo') s += 25;
  else if (estado === 'proposal') s += 32;
  else if (estado === 'pilot') s += 40;
  else if (estado === 'won') return 100;
  else if (estado === 'lost' || estado === 'cancelled') return 0;

  // Fleet size is a fit signal, not an urgency signal. Prefer the researched
  // fact and fall back to the floor of the declared range.
  const unidades = p.numUnidades ?? unidadesMinimas(p.unidadesDeclaradas);
  if (unidades !== null && unidades >= 250) s += 12;
  else if (unidades !== null && unidades >= 100) s += 10;
  else if (unidades !== null && unidades >= 30) s += 7;
  else if (unidades !== null && unidades >= 5) s += 4;
  // Cuenta trabajada a mano (ficha) — ya hay contexto para personalizar.
  if (p.fuente === 'manual') s += 10;

  // ── QUIEN VINO SOLO NO SE COMPARA CON UNO SCRAPEADO ──────────────────────
  // Un renglón del censo es una empresa que NO sabe que existimos. Uno de
  // `landing`/`ads-*`/`campana` llenó un formulario con su nombre y su
  // teléfono: ya hay permiso y ya hay intención. Ordenar los dos con el mismo
  // criterio manda a Javier a llamar en frío teniendo una mano levantada
  // esperando.
  if (p.fuente === 'landing' || p.fuente === 'campana') s += 20;
  else if (p.fuente.startsWith('ads-')) s += 25; // además costó dinero traerlo

  // Un decisor con nombre y correo VERIFICADO vale más que el buzón genérico
  // de contacto@. `inferido` no cuenta: un correo adivinado no es alcance, es
  // una apuesta, y sumarlo aquí pintaría de verde un camino que rebota.
  s += Math.min(20, (p.personasVerificadas ?? 0) * 10);

  return Math.min(100, s);
}

function unidadesMinimas(rango: string | null | undefined): number | null {
  if (!rango) return null;
  if (rango === '250+') return 250;
  const match = /^(\d+)/.exec(rango);
  return match ? Number(match[1]) : null;
}

/** El criterio se importa del contrato client-safe: cálculo y UI comparten
 *  exactamente el mismo texto y no pueden divergir por bundling. */

// ── EL LISTADO LIGERO Y LOS TEXTOS LARGOS (FE-16) ──────────────────────────
//
// El Cerebro necesita UNA fila por prospecto para poder filtrar y contar en
// el cliente (los 14 filtros y los cuatro KPIs se calculan sobre el universo
// entero, no sobre una página). Lo que NO necesita para eso son los textos
// largos: `notas` (241 bytes de promedio × 33 mil filas = 7.8 MB), el mensaje
// de WhatsApp y el correo redactados por el agente experto (otros 7.5 MB).
// Esos tres solo se PINTAN en la ficha, en la tarjeta abierta y en el popup
// de calles — un puñado de prospectos a la vez—, así que se piden cuando se
// abren (`getTextosProspectos`) y no viajan en la carga inicial.
//
// `notas` sí se LEE del servidor: `giroDe`, `tamanoDe`, `scoreUrgencia`,
// `completitudDe` y el filtro de duplicados viven de ella. Lo que cambia es
// que se queda de este lado.

/**
 * La fila TAL COMO VIAJA: una tupla, no un objeto.
 *
 * No es micro-optimización. Los nombres de los 22 campos son ~238 bytes por
 * fila y el universo son 33 mil: 7.8 MB de payload que dice treinta y tres mil
 * veces "similitudIcpPct" y ni un dato. En tupla ese costo es cero. Y es una
 * tupla ETIQUETADA —TypeScript nombra cada posición—, así que un campo movido
 * de lugar no compila, en vez de pintar el teléfono en la columna del correo.
 *
 * Medido contra producción el 22-ago-2026 (33,065 prospectos vivos): el mapa
 * baja de 33 MB (objetos, con los textos largos) a ~15 MB (objetos, ya sin
 * ellos) a ~8.5 MB (tuplas).
 */
export function empacar(p: ProspectoMapa): FilaCompacta {
  return [
    p.id, p.empresa, p.ciudad, p.entidad, p.lat, p.lng, p.telefono, p.correo,
    p.contacto, p.vacante, p.estado, p.fuente, p.giro, p.urgencia, p.cierre,
    p.tamano, p.completitud, p.ultimoToque, p.mensajesGeneradosEn,
    p.numUnidades, p.similitudIcpPct, p.necesidadPct,
  ];
}

interface FilaProspecto {
  id: string; empresa: string; ciudad: string | null; lat: number | null; lng: number | null;
  telefono: string | null; correo: string | null; contacto_nombre: string | null;
  vacante: string | null; estado: string; fuente: string; notas: string | null;
  scian: string | null;
  urgencia: string | null;
  unidades?: string | null;
  duplicado_de: string | null;
  mensajes_generados_en: string | null;
  updated_at: string;
  prospecto_toque: Array<{ creado_en: string }> | null;
  /** 0140 — solo lo que hace falta para filtrar/ordenar el mapa. */
  sitio_verificado: boolean;
  num_unidades: number | null;
  similitud_icp_pct: number;
  necesidad_pct: number;
  prospecto_persona: Array<{ confianza: 'alta' | 'media' | 'baja'; origen: string }> | null;
}

/** Las columnas del LISTADO. `mensaje_wa`, `mensaje_correo_asunto` y
 *  `mensaje_correo` NO están: 7.5 MB que no se pintan en el mapa. `notas` sí
 *  —la usan giroDe/tamanoDe/scoreUrgencia/completitudDe y el filtro de
 *  duplicados—, pero se queda en el servidor. */
const COLUMNAS_LISTADO =
  'id, empresa, ciudad, lat, lng, telefono, correo, contacto_nombre, vacante, estado, fuente, notas, scian, urgencia, unidades, duplicado_de, mensajes_generados_en, updated_at, sitio_verificado, num_unidades, similitud_icp_pct, necesidad_pct, prospecto_toque(creado_en), prospecto_persona(confianza, origen)';

/** Cuántas páginas de 1,000 se piden A LA VEZ (mismo criterio que
 *  `TANDAS_EN_PARALELO` de `traerPorIds` en pg.ts: acotado para no abrir
 *  treinta conexiones de golpe contra Supabase). */
const PAGINAS_EN_PARALELO = 6;

/**
 * Lee TODA la tabla en PARALELO — no página por página como `traerTodo`.
 *
 * El Cerebro lee ~33,000 prospectos: a 1,000 filas por página son 33 viajes
 * de red EN FILA, uno tras otro, y eso — no el render del mapa, que ya tiene
 * su propio tope (`TOPE_LUCES_PAIS`) — era el "se queda pasmado" al volver
 * del detalle de un prospecto (auditoría de rendimiento, 21-ago): varios
 * segundos de nada en pantalla antes de que `getDatosMapa` terminara.
 *
 * Mismo contrato que `traerTodo` — se demuestra con el conteo EXACTO de la
 * primera página que llegó todo, o se LANZA `LecturaIncompleta`, nunca se
 * enseña una cartera recortada — pero las páginas 2..N se piden TODAS A LA
 * VEZ (acotado, como `traerPorIds`) en vez de una por una.
 *
 * NO reemplaza a `traerTodo` en ningún otro lado: es seguro aquí porque el
 * mapa es lectura de venta, no lo financiero, y un prospecto de más o de
 * menos durante los pocos segundos que tarda la lectura no descuadra un
 * viaje. Lo financiero (`fiscal.ts`, `analytics.ts`, …) se queda con el
 * cursor secuencial que ya se ganó su desconfianza (ver pg.ts).
 */
export async function traerTodoEnParalelo<T>(
  construir: (desde: number, hasta: number) => PromiseLike<RespuestaPg<T[]>>,
  consulta: string,
): Promise<T[]> {
  const res0 = await construir(0, PAGINA - 1);
  const pag0 = exigir(res0, consulta) ?? [];
  const esperadas = typeof res0.count === 'number' ? res0.count : null;
  // Sin conteo exacto no hay con qué demostrar que llegó todo pidiendo a
  // ciegas en paralelo — cae al camino secuencial, ya probado.
  if (esperadas === null) return traerTodo(construir, consulta);
  if (pag0.length >= esperadas) return pag0;

  const totalPaginas = Math.ceil(esperadas / PAGINA);
  const resto: T[][] = new Array(totalPaginas - 1);
  let siguiente = 1;
  const obrero = async () => {
    for (;;) {
      const p = siguiente++;
      if (p >= totalPaginas) return;
      const res = await construir(p * PAGINA, p * PAGINA + PAGINA - 1);
      resto[p - 1] = exigir(res, consulta) ?? [];
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAGINAS_EN_PARALELO, totalPaginas - 1) }, obrero));
  const filas = [pag0, ...resto].flat();
  if (filas.length < esperadas) throw new LecturaIncompleta(consulta, filas.length, esperadas);
  return filas;
}

/** El filtro de duplicados del mapa: la marca la escribe el deduplicador
 *  dentro de `notas` (0139). Se resuelve aquí y no en SQL porque `notas` ya
 *  viaja hasta el servidor para calcular giro/tamaño/urgencia. */
function esDuplicado(f: { notas: string | null; duplicado_de?: string | null }): boolean {
  return Boolean(f.duplicado_de) || /DUPLICADO:/.test(f.notas ?? '');
}

function aProspecto(p: FilaProspecto): ProspectoMapa {
  const { ciudad, entidad } = plazaDe(p.ciudad);
  return {
    id: p.id,
    empresa: p.empresa,
    ciudad,
    entidad,
    lat: p.lat,
    lng: p.lng,
    telefono: p.telefono,
    correo: p.correo,
    contacto: p.contacto_nombre,
    vacante: p.vacante,
    estado: p.estado,
    fuente: p.fuente,
    giro: giroDe(p.empresa, p.vacante, p.notas, p.scian),
    tamano: tamanoDe(p.notas),
    completitud: completitudDe({
      telefono: p.telefono, correo: p.correo, contacto_nombre: p.contacto_nombre,
      lat: p.lat, notas: p.notas, sitioVerificado: p.sitio_verificado,
    }),
    mensajesGeneradosEn: p.mensajes_generados_en,
    ultimoToque: (p.prospecto_toque ?? []).reduce<string | null>(
      (max, t) => (max === null || t.creado_en > max ? t.creado_en : max), null),
    urgencia: scoreUrgencia({ vacante: p.vacante, notas: p.notas, urgenciaDeclarada: p.urgencia }),
    cierre: scoreCierre({
      telefono: p.telefono, correo: p.correo, contacto_nombre: p.contacto_nombre,
      estado: p.estado, fuente: p.fuente, empresa: p.empresa, vacante: p.vacante, notas: p.notas,
      scian: p.scian,
      numUnidades: p.num_unidades,
      unidadesDeclaradas: p.unidades,
      personasVerificadas: (p.prospecto_persona ?? [])
        // AUDITORÍA 19 (legal, reincidente #16): un correo `origen='inferido'`
        // nace con confianza 'media' (la 0138 solo prohíbe 'alta'), así que
        // `confianza !== 'baja'` contaba lo ADIVINADO como decisor verificado
        // — y ese conteo suma puntos de cierre (scoreCierre) que deciden a
        // quién se le llama primero. Verificado = leído en alguna parte:
        // el inferido queda fuera por su origen, no por su confianza.
        .filter((x) => x.origen !== 'inferido' && x.confianza !== 'baja').length,
    }),
    numUnidades: p.num_unidades,
    similitudIcpPct: p.similitud_icp_pct,
    necesidadPct: p.necesidad_pct,
  };
}

/**
 * Cuántos prospectos ve el mapa AHORA MISMO, contados por la base.
 *
 * Existe por una sola razón: el delta no puede ver una BAJA. Una fila borrada
 * (purga, deduplicación) no se "actualiza", desaparece, y un cliente que solo
 * pide cambios se quedaría con su fantasma para siempre. Dos `count` de
 * cabecera (`head: true` — no viaja una sola fila) contra el conteo del
 * cliente bastan para detectarlo y pedir la carga completa.
 *
 * Se cuenta en dos preguntas y no en una con `not.ilike`: `notas` es NULL en
 * miles de filas y `NULL not ilike '...'` es NULL, o sea que el filtro
 * negado se comería en silencio a todo prospecto sin notas. Restar los
 * duplicados —un filtro POSITIVO, que con NULL simplemente no aplica— no
 * tiene esa trampa.
 */
async function contarMapa(): Promise<number | null> {
  const admin = supabaseAdmin();
  const base = admin.from('prospecto').select('id', { count: 'exact', head: true });
  if (typeof (base as { is?: unknown }).is === 'function') {
    const vivas = await (base as typeof base & { is: (c: string, v: null) => typeof base }).is('duplicado_de', null);
    if (vivas.error || typeof vivas.count !== 'number') return null;
    return vivas.count;
  }
  // Compatibility for tiny test doubles and older PostgREST clients. The
  // production path above always uses the indexed NULL predicate.
  const [todo, dup] = await Promise.all([
    admin.from('prospecto').select('id', { count: 'exact', head: true }),
    admin.from('prospecto').select('id', { count: 'exact', head: true }).ilike('notas', '%DUPLICADO:%'),
  ]);
  if (todo.error || dup.error || typeof todo.count !== 'number' || typeof dup.count !== 'number') return null;
  return todo.count - dup.count;
}

/**
 * El mapa entero, o SOLO lo que cambió desde `desde` (FE-16).
 *
 * Sin `desde` es la carga inicial: el universo en formato compacto y sin los
 * textos largos. Con `desde` es el latido: `updated_at > desde`, que en una
 * cartera en reposo son CERO filas y unos cientos de bytes en vez de los ~33
 * MB que bajaba antes cada 5 minutos.
 *
 * Que `updated_at` diga la verdad lo garantiza el trigger de la 0167 — antes
 * de esa migración la columna decía la hora del INSERT para todas las filas y
 * un delta montado sobre ella habría contestado "nada cambió" mientras el
 * embudo avanzaba.
 */
export async function getDatosMapa(opciones?: { desde?: string | null }): Promise<DatosMapa> {
  const generadoEn = new Date().toISOString();
  // Cadena vacía = sin marca (primera carga), no una marca de 1970.
  const desde = opciones?.desde || null;
  // traerTodoEnParalelo, no .limit(): PostgREST recorta a 1,000 filas EN
  // SILENCIO (trampa documentada en CLAUDE.md) y el universo DENUE ya pasa
  // de 33,000 — un mapa con la primera página se leería como "el país
  // entero" sin serlo. El delta usa el mismo camino: un enriquecedor que
  // acaba de tocar 5,000 filas también pasa de mil.
  let filas: FilaProspecto[];
  try {
    filas = await traerTodoEnParalelo<FilaProspecto>(
      (d, h) => {
        const raw = supabaseAdmin().from('prospecto').select(COLUMNAS_LISTADO, conteo(d));
        const q = typeof (raw as { is?: unknown }).is === 'function'
          ? (raw as typeof raw & { is: (c: string, v: null) => typeof raw }).is('duplicado_de', null)
          : raw;
        // El orden secundario por id NO es adorno: created_at se repite (los
        // lotes de siembra comparten el now() de su transacción) y paginar
        // sobre un orden no único duplica y salta filas entre páginas — se
        // vio como pines duplicados en el mapa (17-ago). El delta ordena por
        // la misma columna que filtra, que es lo estable ahí.
        return desde
          ? q.gt('updated_at', desde).order('updated_at', { ascending: true }).order('id', { ascending: true }).range(d, h)
          : q.order('created_at', { ascending: false }).order('id', { ascending: true }).range(d, h);
      },
      desde ? 'prospecto (mapa, delta)' : 'prospecto (mapa)',
    );
  } catch (e) {
    logger.error('mapa_prospectos.leer', { delta: desde !== null, err: e instanceof Error ? e.message : String(e) });
    return { filas: [], generadoEn, fallo: true, marca: null, delta: desde !== null, total: null };
  }
  // Cinturón sobre los tirantes: si aun así llegara un id repetido, una fila
  // gana y las demás se tiran — dos luces del mismo prospecto mienten.
  const porId = new Map<string, FilaProspecto>();
  for (const f of filas) if (!porId.has(f.id)) porId.set(f.id, f);
  filas = [...porId.values()];

  // La marca sale de TODAS las filas leídas, duplicados incluidos: si la fila
  // más reciente resulta ser un duplicado y no avanzara la marca, el
  // siguiente latido volvería a pedirla, y el siguiente, para siempre.
  const marca = filas.reduce<string | null>(
    (max, f) => (max === null || f.updated_at > max ? f.updated_at : max), null);

  const vivas = filas.filter((f) => !esDuplicado(f));
  return {
    filas: vivas.map(aProspecto).map(empacar),
    generadoEn,
    fallo: false,
    marca,
    delta: desde !== null,
    // En la carga completa el conteo del servidor ES la lista (y
    // `traerTodoEnParalelo` ya demostró que llegó entera): no se paga un
    // viaje extra para preguntar lo que se acaba de leer.
    total: desde ? await contarMapa() : vivas.length,
  };
}

/**
 * Los textos largos de un puñado de prospectos — lo que el listado no trae.
 *
 * `traerPorIds` y no un `.in()` a pelo: la lista de ids viaja EN LA URL y
 * PostgREST además recorta a 1,000 filas en silencio (los dos techos mudos de
 * pg.ts). Con tandas de 200 no se toca ninguno.
 */
export async function getTextosProspectos(ids: string[]): Promise<TextosProspecto[]> {
  if (ids.length === 0) return [];
  const filas = await traerPorIds<{
    id: string; notas: string | null; mensaje_wa: string | null;
    mensaje_correo_asunto: string | null; mensaje_correo: string | null; duplicado_de?: string | null;
  }>(
    ids,
    (tanda) => supabaseAdmin()
      .from('prospecto')
      .select('id, notas, mensaje_wa, mensaje_correo_asunto, mensaje_correo, duplicado_de')
      .in('id', tanda),
    'prospecto (textos)',
  );
  return filas.filter((f) => !f.duplicado_de).map((f) => ({
    id: f.id,
    notas: f.notas,
    mensajeWaIa: f.mensaje_wa,
    correoAsuntoIa: f.mensaje_correo_asunto,
    correoCuerpoIa: f.mensaje_correo,
  }));
}

// ── La ficha de UN prospecto — /admin/mapa-prospectos/[id] ─────────────────
// Todo lo que el mapa resume, aquí desglosado: los hechos crudos (0140:
// num_unidades/historia, NULL si no se encontró — nunca se infiere), los tres
// derivados GENERADOS (similitud_icp_pct/necesidad_pct/viajes_mes_estimado —
// se leen, jamás se calculan aquí, para no desincronizarse de la fórmula de
// la migración) y las personas investigadas (0138, prospecto_persona).

/** La ficha y sus personas comparten el contrato client-safe reexportado. */

interface FilaDetalle extends FilaProspecto {
  mensaje_wa: string | null;
  mensaje_correo_asunto: string | null;
  mensaje_correo: string | null;
  sitio: string | null;
  sitio_verificado: boolean;
  num_unidades: number | null;
  historia: string | null;
  similitud_icp_pct: number;
  necesidad_pct: number;
  viajes_mes_estimado: number | null;
  duplicado_de: string | null;
  created_at: string;
  prospecto_persona: Array<{
    id: string; nombre: string; puesto: string | null; correo: string | null;
    telefono: string | null; linkedin: string | null; origen: string;
    confianza: 'alta' | 'media' | 'baja'; evidencia: string | null;
  }> | null;
}

/** null = no existe, es un duplicado (0139: se navega a la ficha principal,
 *  no a una copia), o la lectura falló — el llamador decide el 404. */
export async function getDetalleProspecto(id: string): Promise<DetalleProspecto | null> {
  const admin = supabaseAdmin();
  const res = await admin
    .from('prospecto')
    .select(`id, empresa, ciudad, lat, lng, telefono, correo, contacto_nombre, vacante, estado,
      fuente, notas, scian, urgencia, unidades, mensaje_wa, mensaje_correo_asunto, mensaje_correo, mensajes_generados_en,
      sitio, sitio_verificado, num_unidades, historia, similitud_icp_pct, necesidad_pct,
      viajes_mes_estimado, duplicado_de, created_at, updated_at,
      prospecto_toque(creado_en),
      prospecto_persona(id, nombre, puesto, correo, telefono, linkedin, origen, confianza, evidencia)`)
    .eq('id', id)
    .maybeSingle();
  const p = exigir(res as { data: FilaDetalle | null; error: { message: string } | null }, 'prospecto (detalle)');
  if (!p || p.duplicado_de) return null;

  const { ciudad, entidad } = plazaDe(p.ciudad);
  return {
    id: p.id, empresa: p.empresa, ciudad, entidad, lat: p.lat, lng: p.lng,
    telefono: p.telefono, correo: p.correo, contacto: p.contacto_nombre,
    vacante: p.vacante, notas: p.notas, estado: p.estado, fuente: p.fuente,
    giro: giroDe(p.empresa, p.vacante, p.notas, p.scian),
    tamano: tamanoDe(p.notas),
    completitud: completitudDe({
      telefono: p.telefono, correo: p.correo, contacto_nombre: p.contacto_nombre,
      lat: p.lat, notas: p.notas, sitioVerificado: p.sitio_verificado,
    }),
    mensajeWaIa: p.mensaje_wa, correoAsuntoIa: p.mensaje_correo_asunto,
    correoCuerpoIa: p.mensaje_correo, mensajesGeneradosEn: p.mensajes_generados_en,
    ultimoToque: (p.prospecto_toque ?? []).reduce<string | null>(
      (max, t) => (max === null || t.creado_en > max ? t.creado_en : max), null),
    urgencia: scoreUrgencia({ vacante: p.vacante, notas: p.notas, urgenciaDeclarada: p.urgencia }),
    cierre: scoreCierre({
      telefono: p.telefono, correo: p.correo, contacto_nombre: p.contacto_nombre,
      estado: p.estado, fuente: p.fuente, empresa: p.empresa, vacante: p.vacante, notas: p.notas,
      scian: p.scian, numUnidades: p.num_unidades, unidadesDeclaradas: p.unidades,
      personasVerificadas: (p.prospecto_persona ?? [])
        // AUDITORÍA 19 (legal, reincidente #16): un correo `origen='inferido'`
        // nace con confianza 'media' (la 0138 solo prohíbe 'alta'), así que
        // `confianza !== 'baja'` contaba lo ADIVINADO como decisor verificado
        // — y ese conteo suma puntos de cierre (scoreCierre) que deciden a
        // quién se le llama primero. Verificado = leído en alguna parte:
        // el inferido queda fuera por su origen, no por su confianza.
        .filter((x) => x.origen !== 'inferido' && x.confianza !== 'baja').length,
    }),
    sitio: p.sitio, sitioVerificado: p.sitio_verificado,
    numUnidades: p.num_unidades, historia: p.historia,
    similitudIcpPct: p.similitud_icp_pct, necesidadPct: p.necesidad_pct,
    viajesMesEstimado: p.viajes_mes_estimado,
    fuenteCruda: p.fuente, creadoEn: p.created_at,
    personas: (p.prospecto_persona ?? []).map((x) => ({
      id: x.id, nombre: x.nombre, puesto: x.puesto, correo: x.correo, telefono: x.telefono,
      linkedin: x.linkedin, origen: x.origen, confianza: x.confianza, evidencia: x.evidencia,
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ADM-8 (auditoría 24, MEDIO) — el rastro de una exportación.
//
// Un clic en "Exportar CSV (N)" de `cerebro.tsx` descarga la cartera
// filtrada COMPLETA (hasta 33k filas, con teléfono y correo de decisores) y
// no dejaba NINGUNA huella: ni el listado GET ni el fetch de textos llaman
// `anotarBitacora`. Con una sola sesión de superadmin comprometida, la fuga
// es masiva y sin evidencia para LFPDPPP.
//
// Vía `anotarBitacora` (lib/likida/bitacora_escritura.ts) — el ÚNICO
// escritor de `bitacora_auditoria` (auditoría 18, A1: "un solo escritor",
// `bitacora_escritura.test.ts` lo hace cumplir por grep sobre todo `src/`).
// `'prospecto'` se agregó al dominio de `EntidadBitacora` ahí mismo, "Ampliar
// AQUÍ, no en el llamador" — su propio comentario. `detalle` lleva SOLO el
// conteo y los filtros elegidos (giro, estado, texto de búsqueda) — nunca una
// fila de prospecto: la bitácora no puede volverse ella misma una segunda
// copia de los datos que audita. `entidadId` es `'csv'`: no hay una fila de
// prospecto singular que nombrar — es la cartera filtrada completa.
//
// BEST-EFFORT, nunca lanza: `anotarBitacora` ya no lanza por diseño (una
// bitácora que tumbara la descarga sería peor que una descarga sin rastro).
// ═══════════════════════════════════════════════════════════════════════════

export async function registrarExportacionProspectos(
  actorId: string | null,
  n: number,
  filtros: Record<string, unknown>,
): Promise<void> {
  await anotarBitacora(
    {
      tenantId: null,
      actor: actorId ? { id: actorId } : 'sistema',
      accion: 'prospectos.exportados',
      entidad: 'prospecto',
      entidadId: 'csv',
      detalle: { n, filtros },
    },
    { evento: 'prospectos.exportacion_no_bitacorada' },
  );
}
