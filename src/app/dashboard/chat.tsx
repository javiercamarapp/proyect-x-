'use client';

import { useEffect, useRef, useState } from 'react';
import { Send, ArrowUp, Search, Paperclip, Camera, FileImage, X, FileText, History, PencilLine, PanelRightClose, Check } from 'lucide-react';
import type { DashboardKpis, Acreditables } from '@/lib/likida/analytics';
import { mxn, litros, numero, fechaCorta } from '@/lib/formato';
import { useSearchParams } from 'next/navigation';
import { Logo, LogoIcono } from '../logo';
import { CampoPixeles } from './pixeles';
import { Dona, AreaChartSimple } from '../admin/charts';

/**
 * Mismo criterio que admin/chat.tsx: coincidencia de palabras clave contra
 * datos YA calculados en el servidor (`kpis`/`acred`), nunca lenguaje
 * natural a SQL con permisos de servicio. Aquí pesa MÁS que en admin —
 * un tenant real, no solo Javier, podría escribir cualquier cosa en esta
 * caja.
 */
const PREGUNTAS = [
  '¿Cuánto llevo comprobado?',
  '¿Cuántos viajes tengo con diferencia?',
  '¿Cuánto diésel es elegible para el estímulo?',
  '¿Cuál es mi tasa de cuadre?',
  '¿Cuánto llevo de acreditables?',
];

// ── Respuestas con forma (12-ago-2026: "que responda con gráficas, tablas
// y muy visual") — cada respuesta puede traer, además del texto, una pieza
// visual armada con los MISMOS datos ya calculados: una tabla chica, la
// dona de `admin/charts` o una cifra grande. Nada se grafica sin dato real:
// con la flota en cero, la respuesta es el texto honesto de siempre.

type Visual =
  | { tipo: 'tabla'; filas: Array<[string, string]> }
  | { tipo: 'dona'; segmentos: Array<{ etiqueta: string; valor: number }> }
  | { tipo: 'cifra'; valor: string; nota?: string }
  | { tipo: 'serie'; puntos: Array<{ dia: string; valor: number }>; formato: 'mxn' | 'numero' };

interface Respuesta { texto: string; visual?: Visual; visuales?: Visual[]; pendiente?: boolean }

/** Cómo se lee cada tool del analista en la secuencia de pensamiento
 *  (13-ago: pasos narrados en vivo). Pasos REALES
 *  del ciclo — el servidor los transmite cuando de verdad ocurren. */
const ETIQUETA_TOOL: Record<string, string> = {
  kpis_flota: 'Leyendo los KPIs de la flota',
  acreditables_periodo: 'Sumando IVA y peaje del periodo',
  motor_fiscal: 'Consultando el motor fiscal',
  viajes_flota: 'Leyendo tus viajes',
  liquidaciones_flota: 'Leyendo tus liquidaciones',
  serie_gasto: 'Trazando el gasto por semana',
  serie_liquidado: 'Trazando lo liquidado por semana',
  top_rutas: 'Rankeando tus rutas por gasto',
  duplicados_detectados: 'Buscando tickets duplicados',
  proyectar_serie: 'Proyectando la serie',
  entregar_respuesta: 'Armando la respuesta',
};
const rotuloTool = (t: string) => ETIQUETA_TOOL[t] ?? t.replaceAll('_', ' ');

/** Las fases del "pensando" (pedido del 12-ago: como Claude). Son honestas
 *  por construcción: solo se AVANZA de fase si de verdad sigue trabajando —
 *  un saludo se resuelve en la primera y nunca dice "leyendo tu operación". */
const FASES_PENSANDO: Array<[number, string]> = [
  [0, 'Pensando…'],
  [3000, 'Leyendo tu operación…'],
  [9000, 'Cruzando cifras…'],
  [17000, 'Armando la respuesta…'],
  [30000, 'Esto está tardando más de lo normal…'],
];

/** Los bloques del agente analista (/api/dashboard/chat) → la Respuesta que
 *  esta interfaz ya sabe pintar. El agente manda números crudos; aquí se
 *  formatean con lib/formato — UNA sola fuente de formato, como siempre. */
function respuestaDeBloques(bloques: Array<Record<string, unknown>>): Respuesta {
  const textos: string[] = [];
  const visuales: Visual[] = [];
  for (const b of bloques) {
    if (b.tipo === 'texto' && typeof b.texto === 'string') textos.push(b.texto);
    else if (b.tipo === 'cifra' && typeof b.valor === 'number') {
      const f = b.formato === 'mxn' ? mxn : b.formato === 'litros' ? litros : numero;
      visuales.push({ tipo: 'cifra', valor: f(b.valor), nota: typeof b.nota === 'string' ? b.nota : undefined });
    } else if (b.tipo === 'tabla' && Array.isArray(b.filas)) {
      visuales.push({ tipo: 'tabla', filas: (b.filas as Array<[string, string | number]>).map(([k, v]) => [k, typeof v === 'number' ? numero(v) : v]) });
    } else if (b.tipo === 'dona' && Array.isArray(b.segmentos)) {
      visuales.push({ tipo: 'dona', segmentos: b.segmentos as Array<{ etiqueta: string; valor: number }> });
    } else if (b.tipo === 'serie' && Array.isArray(b.puntos)) {
      visuales.push({ tipo: 'serie', puntos: b.puntos as Array<{ dia: string; valor: number }>, formato: b.formato === 'mxn' ? 'mxn' : 'numero' });
    }
  }
  return { texto: textos.join(' ') || 'Listo.', visuales: visuales.length > 0 ? visuales : undefined };
}

export function responder(pregunta: string, kpis: DashboardKpis | null, acred: Acreditables | null): Respuesta {
  const q = pregunta.toLowerCase();
  const sinLiq = { texto: 'Todavía no hay liquidaciones para calcular esto.' };
  if (q.includes('comprobad') || q.includes('monto')) {
    if (!kpis) return sinLiq;
    return {
      texto: `Llevas ${mxn(kpis.montoComprobado)} comprobados en ${kpis.viajesLiquidados} viaje${kpis.viajesLiquidados === 1 ? '' : 's'}.`,
      visual: {
        tipo: 'tabla',
        filas: [
          ['Monto comprobado', mxn(kpis.montoComprobado)],
          ['Viajes liquidados', numero(kpis.viajesLiquidados)],
          ['Con diferencias', numero(kpis.conDiferencias)],
          ['Por revisar', numero(kpis.porRevisar)],
          ['Fuera de regla o duplicado', mxn(kpis.diferenciaDetectada)],
        ],
      },
    };
  }
  if (q.includes('diferencia') || q.includes('revisar')) {
    if (!kpis) return sinLiq;
    const limpias = Math.max(0, kpis.viajesLiquidados - kpis.conDiferencias - kpis.porRevisar);
    return {
      texto: `${kpis.conDiferencias + kpis.porRevisar} liquidaciones tienen diferencia o están por revisar, de ${kpis.viajesLiquidados} en total.`,
      visual: kpis.viajesLiquidados > 0
        ? { tipo: 'dona', segmentos: [
            { etiqueta: 'Sin diferencias', valor: limpias },
            { etiqueta: 'Con diferencias', valor: kpis.conDiferencias },
            { etiqueta: 'Por revisar', valor: kpis.porRevisar },
          ] }
        : undefined,
    };
  }
  if (q.includes('diesel') || q.includes('diésel') || q.includes('litro')) {
    if (!acred) return { texto: 'Todavía no hay datos de diésel este periodo.' };
    return {
      texto: `${litros(acred.litrosDiesel)} elegibles para el estímulo este periodo.`,
      visual: { tipo: 'cifra', valor: litros(acred.litrosDiesel), nota: 'LIF 2026, Art. 20-A — el estímulo en pesos lo fija la cuota DOF de cada semana.' },
    };
  }
  if (q.includes('tasa') || q.includes('cuadre') || q.includes('cuadra')) {
    if (!kpis) return sinLiq;
    const limpias = Math.max(0, kpis.viajesLiquidados - kpis.conDiferencias - kpis.porRevisar);
    return {
      texto: `Tu tasa de cuadre es ${kpis.tasaCuadre}% — liquidaciones sin diferencias sobre el total.`,
      visual: kpis.viajesLiquidados > 0
        ? { tipo: 'dona', segmentos: [
            { etiqueta: 'Sin diferencias', valor: limpias },
            { etiqueta: 'Con diferencias o por revisar', valor: kpis.conDiferencias + kpis.porRevisar },
          ] }
        : undefined,
    };
  }
  if (q.includes('iva') || q.includes('peaje') || q.includes('caseta') || q.includes('acreditable')) {
    if (!acred) return { texto: 'Todavía no hay datos de acreditables este periodo.' };
    return {
      texto: q.includes('iva')
        ? `${mxn(acred.iva)} de IVA acreditable este periodo (LIVA, Art. 5).`
        : q.includes('peaje') || q.includes('caseta')
          ? `${mxn(acred.peaje)} de peaje acreditable (50%) este periodo — sujeto a elegibilidad.`
          : 'Esto es lo que llevas de acreditables este periodo:',
      visual: {
        tipo: 'tabla',
        filas: [
          ['IVA acreditable', mxn(acred.iva)],
          ['Peaje acreditable (50%)', mxn(acred.peaje)],
          ['Diésel elegible', litros(acred.litrosDiesel)],
        ],
      },
    };
  }
  return { texto: 'Todavía no sé responder eso — pregúntame sobre lo comprobado, diferencias, diésel, IVA, peaje o tu tasa de cuadre.' };
}

/**
 * H4 (auditoría 24): el respondedor local de palabras clave es el
 * "paracaídas" de `responder()` — corre con lo que YA está en la página
 * (`kpis`/`acred`), no con una lectura fresca de la operación. Cuando el
 * analista de verdad falló (el servidor lo dice con `{t:'error'}`, o el
 * `fetch` reventó), esa diferencia importa: el contralor tiene que saber que
 * está viendo una respuesta de reserva, no la del agente que acaba de leer su
 * flota. `motivo` es `null` cuando no hubo fallo (el paracaídas de un `q` que
 * el respondedor local tampoco entiende no necesita este aviso).
 */
export function respuestaLocal(
  pregunta: string, kpis: DashboardKpis | null, acred: Acreditables | null, motivo: string | null,
): Respuesta {
  const base = responder(pregunta, kpis, acred);
  if (!motivo) return base;
  const aviso = motivo.charAt(0).toUpperCase() + motivo.slice(1);
  return {
    ...base,
    texto: `${aviso.endsWith('.') ? aviso : `${aviso}.`} Esto es lo que puedo contestarte con lo último que ya tenía cargado, no una lectura nueva de tu operación:\n\n${base.texto}`,
  };
}

/** La pieza visual de una respuesta — tabla chica, dona o cifra grande,
 *  con los mismos componentes del resto del panel (nunca una segunda
 *  librería). */
function VisualRespuesta({ v }: { v: Visual }) {
  if (v.tipo === 'cifra') {
    return (
      <div className="card px-4 py-3 mt-2 inline-block">
        <div className="font-display text-[22px] leading-tight font-semibold tabular">{v.valor}</div>
        {v.nota && <p className="text-[11px] mt-1" style={{ color: 'var(--faint)' }}>{v.nota}</p>}
      </div>
    );
  }
  if (v.tipo === 'dona') {
    return <div className="card p-3 mt-2"><Dona segmentos={v.segmentos} /></div>;
  }
  if (v.tipo === 'serie') {
    return (
      <div className="card p-3 mt-2">
        <AreaChartSimple datos={v.puntos} etiquetaValor={v.formato === 'mxn' ? mxn : numero} />
      </div>
    );
  }
  return (
    // FE-19: la tabla que devuelve el asistente es de ancho DESCONOCIDO (la
    // arma una consulta): scrollea dentro de la tarjeta o estira la página.
    <div className="card p-1.5 mt-2 overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <tbody>
          {v.filas.map(([k, val]) => (
            <tr key={k} className="border-b last:border-b-0" style={{ borderColor: 'var(--line2)' }}>
              <td className="px-2.5 py-1.5" style={{ color: 'var(--muted)' }}>{k}</td>
              <td className="cifra-mono px-2.5 py-1.5 text-right">{val}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ChatFlota({
  kpis, acred, compacto = false, variante = 'panel',
}: {
  kpis: DashboardKpis | null;
  acred: Acreditables | null;
  compacto?: boolean;
  /**
   * `panel` — la caja de siempre. La usa el rail del Asistente, que es angosto
   *   y ya vive DENTRO de un recuadro: otro hero ahí saldría apretado.
   * `hero` — la página completa `/dashboard/chat`: composición centrada con un
   *   solo recuadro, el de escribir.
   * El default es `panel` a propósito: así el rail no cambia de aspecto por
   * un rediseño que solo pidió la página.
   */
  variante?: 'panel' | 'hero';
}) {
  const [historial, setHistorial] = useState<Array<{ q: string; r: Respuesta }>>([]);
  const [texto, setTexto] = useState('');
  // Ingesta REAL de prueba (12-ago): la imagen adjunta viaja a
  // /api/dashboard/ingesta, que corre el MISMO OCR del motor y devuelve lo
  // leído — sin registrar nada. `ocupado` bloquea dobles envíos mientras la
  // visión trabaja.
  const [ocupado, setOcupado] = useState(false);
  const [recomendar, setRecomendar] = useState(false);
  const [menuAdjuntar, setMenuAdjuntar] = useState(false);
  const inputArchivo = useRef<HTMLInputElement>(null);
  const inputImagen = useRef<HTMLInputElement>(null);
  const inputCamara = useRef<HTMLInputElement>(null);
  const finConversacion = useRef<HTMLDivElement>(null);

  // Ancla la vista al último mensaje, como cualquier chat.
  useEffect(() => {
    finConversacion.current?.scrollIntoView({ block: 'end' });
  }, [historial.length]);

  // El documento adjunto a la conversación (extracto acotado por el
  // servidor): viaja en cada pregunta hasta que el usuario lo quite.
  const [documento, setDocumento] = useState<{ nombre: string; extracto: string } | null>(null);

  // ── Historial persistente (0088, 13-ago-2026) ────────────────────────────
  // La conversación abierta vive en la base; este id la ancla. `convs` es la
  // lista del panel: null = cargando, 'error' = no se pudo leer (y se DICE —
  // una lista vacía por error afirmaría "no has chateado").
  const [conversacionId, setConversacionId] = useState<string | null>(null);
  const [historialAbierto, setHistorialAbierto] = useState(false);
  const [convs, setConvs] = useState<Array<{ id: string; titulo: string; actualizadoEn: string }> | 'error' | null>(null);
  const [busqueda, setBusqueda] = useState('');
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  // El ancla sticky marca el TOPE VISIBLE del área del chat (debajo de la
  // cinta de "ver como" cuando existe, 13-ago: "al nivel del color gris").
  // El cajón se mide contra ella AL ABRIR — en el handler, no en un efecto.
  const anclaChat = useRef<HTMLDivElement>(null);
  const [topPanel, setTopPanel] = useState(16);

  function abrirHistorial() {
    const r = anclaChat.current?.getBoundingClientRect();
    setTopPanel(Math.max(16, Math.round(r?.top ?? 16)));
    setErrorCarga(null);
    setHistorialAbierto(true);
  }

  async function leerArchivo(archivo: File) {
    if (ocupado) return;
    if (!archivo.type.startsWith('image/')) {
      // Lector universal (12-ago): PDF, Excel, CSV, XML de CFDI, texto…
      // El extracto regresa acotado y se ADJUNTA a la conversación.
      setOcupado(true);
      const etiqueta = `Adjuntar: ${archivo.name}`;
      try {
        const b64 = await new Promise<string>((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result));
          fr.onerror = () => rej(fr.error);
          fr.readAsDataURL(archivo);
        });
        const resp = await fetch('/api/dashboard/archivo', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nombre: archivo.name, contenido: b64 }),
          signal: AbortSignal.timeout(75_000),
        });
        const d = await resp.json().catch(() => null);
        if (!resp.ok || !d?.extracto) {
          setHistorial((h) => [...h, { q: etiqueta, r: { texto: d?.error ?? 'No se pudo leer el archivo en este momento.' } }]);
          return;
        }
        setDocumento({ nombre: archivo.name, extracto: d.extracto });
        setHistorial((h) => [...h, {
          q: etiqueta,
          r: {
            texto: `Listo, leí «${archivo.name}» y lo tengo a la mano en esta conversación — pregúntame lo que quieras sobre él.`,
            visual: Array.isArray(d.meta) && d.meta.length > 0 ? { tipo: 'tabla', filas: d.meta as Array<[string, string]> } : undefined,
          },
        }]);
      } catch {
        setHistorial((h) => [...h, { q: etiqueta, r: { texto: 'No se pudo leer el archivo en este momento.' } }]);
      } finally {
        setOcupado(false);
        if (inputArchivo.current) inputArchivo.current.value = '';
      }
      return;
    }
    setOcupado(true);
    const etiquetaQ = `Leer comprobante: ${archivo.name}`;
    try {
      const dataUrl = await new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => rej(fr.error);
        fr.readAsDataURL(archivo);
      });
      // H14 (auditoría 24): a diferencia de /chat y /conversaciones*, esta
      // llamada NO mandaba `?tenant=` — un superadmin previsualizando una
      // flota (`?tenant=X&vista=…`) que probara "Leer comprobante" aquí
      // corría el OCR contra SU PROPIA sesión (sin flota real, o la
      // equivocada), nunca contra la flota que está viendo. `tenantEfectivoChat`
      // (chat/tenant.ts) es la misma regla que ya usan sus hermanas.
      const tenantIngesta = spChat.get('tenant');
      const resp = await fetch(`/api/dashboard/ingesta${tenantIngesta ? `?tenant=${encodeURIComponent(tenantIngesta)}` : ''}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imagen: dataUrl }),
      });
      const d = await resp.json().catch(() => null);
      if (!resp.ok || !d) {
        setHistorial((h) => [...h, { q: etiquetaQ, r: { texto: d?.error ?? 'No se pudo leer la imagen en este momento.' } }]);
        return;
      }
      if (!d.legible) {
        setHistorial((h) => [...h, { q: etiquetaQ, r: { texto: `El motor no pudo leer este papel${d.motivo ? ` (${d.motivo})` : ''}. Con una foto más cercana y sin reflejos suele salir.` } }]);
        return;
      }
      const filas: Array<[string, string]> = [];
      if (d.campos.concepto) filas.push(['Concepto', String(d.campos.concepto)]);
      if (typeof d.campos.monto === 'number') filas.push(['Monto', mxn(d.campos.monto)]);
      if (d.campos.fecha) filas.push(['Fecha', String(d.campos.fecha)]);
      if (d.campos.folio) filas.push(['Folio', String(d.campos.folio)]);
      if (d.campos.rfcEmisor) filas.push(['RFC emisor', String(d.campos.rfcEmisor)]);
      if (typeof d.campos.litros === 'number') filas.push(['Litros', litros(d.campos.litros)]);
      if (typeof d.campos.confianza === 'number') filas.push(['Confianza del OCR', `${Math.round(d.campos.confianza * 100)}%`]);
      setHistorial((h) => [...h, {
        q: etiquetaQ,
        r: {
          texto: 'Esto fue lo que el motor leyó del papel — lectura de prueba, no se registró ningún gasto.',
          visual: filas.length > 0 ? { tipo: 'tabla', filas } : undefined,
        },
      }]);
    } catch {
      setHistorial((h) => [...h, { q: etiquetaQ, r: { texto: 'No se pudo leer la imagen en este momento.' } }]);
    } finally {
      setOcupado(false);
      if (inputArchivo.current) inputArchivo.current.value = '';
    }
  }

  /** El catálogo de Consulta, por CATEGORÍA y formal (pedido del 12-ago:
   *  al ancho de la caja y con muchas más opciones). SIEMPRE completo: las
   *  respuestas ya degradan con honestidad cuando falta el dato ("todavía
   *  no hay..."), así que esconder categorías solo empobrecía el menú.
   *  Cada frase conserva una palabra clave que `responder` entiende —
   *  verificadas contra sus ramas una por una. */
  const CATALOGO_CONSULTA: Array<{ categoria: string; preguntas: string[] }> = [
    {
      categoria: 'Cuadre y liquidaciones',
      preguntas: [
        'Muéstrame el desglose de lo comprobado a la fecha',
        'Estado de las liquidaciones con diferencia o por revisar',
        '¿Cuántos viajes están por revisar?',
        'Monto observado por el motor en las liquidaciones',
      ],
    },
    {
      categoria: 'Salud del cuadre',
      preguntas: [
        'Tasa de cuadre del periodo',
        '¿Cuántas liquidaciones cerraron sin diferencias?',
        '¿Cuánto llevo comprobado?',
      ],
    },
    {
      categoria: 'Fiscal y acreditables',
      preguntas: [
        'Desglose de acreditables del periodo',
        'IVA acreditable del periodo',
        'Peaje acreditable del periodo',
        'Litros de diésel elegibles para el estímulo',
      ],
    },
  ];

  const spChat = useSearchParams();

  // La lista del panel Historial — se carga al montar la página hero para
  // que el botón traiga su conteo real.
  useEffect(() => {
    if (variante !== 'hero') return;
    let vivo = true;
    const tenant = spChat.get('tenant');
    fetch(`/api/dashboard/conversaciones${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ''}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (vivo) setConvs(Array.isArray(d?.conversaciones) ? d.conversaciones : 'error'); })
      .catch(() => { if (vivo) setConvs('error'); });
    return () => { vivo = false; };
  }, [variante, spChat]);

  /** Reabre una conversación guardada: sus mensajes bajan al hilo y las
   *  visuales se re-pintan desde los bloques crudos. */
  async function cargarConversacion(id: string) {
    if (ocupado) return;
    setErrorCarga(null);
    try {
      const tenant = spChat.get('tenant');
      const resp = await fetch(`/api/dashboard/conversaciones/${id}${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ''}`);
      const d = await resp.json().catch(() => null);
      if (!resp.ok || !d || !Array.isArray(d.mensajes)) throw new Error('respuesta inválida');
      const pares: Array<{ q: string; r: Respuesta }> = [];
      for (const m of d.mensajes as Array<{ rol: string; texto: string; bloques: unknown }>) {
        if (m.rol === 'usuario') {
          pares.push({ q: m.texto, r: { texto: '' } });
        } else if (pares.length > 0) {
          pares[pares.length - 1].r = Array.isArray(m.bloques) && m.bloques.length > 0
            ? respuestaDeBloques(m.bloques as Array<Record<string, unknown>>)
            : { texto: m.texto };
        }
      }
      setHistorial(pares);
      setConversacionId(id);
      setDocumento(null);
      setHistorialAbierto(false);
    } catch {
      setErrorCarga('No se pudo abrir esa conversación — inténtalo de nuevo.');
    }
  }

  function nuevoChat() {
    setHistorial([]);
    setConversacionId(null);
    setDocumento(null);
    setTexto('');
    setHistorialAbierto(false);
  }

  function preguntar(q: string) {
    if (!q.trim() || ocupado) return;
    setTexto('');
    // TODO mensaje va al agente (12-ago: "no quiero respuestas prehechas").
    // El orquestador del servidor decide el modelo: conserje barato para
    // charla/producto, analista con herramientas para datos. El respondedor
    // local de keywords queda SOLO como paracaídas si el API falla.
    void preguntarAnalista(q);
  }

  const [fasePensando, setFasePensando] = useState('Pensando…');
  // La secuencia REAL de tools del turno en curso (streaming NDJSON del
  // servidor): 'inicio' agrega un renglón, 'fin' palomea el suyo.
  const [pasosVivos, setPasosVivos] = useState<Array<{ tool: string; listo: boolean }>>([]);

  async function preguntarAnalista(q: string) {
    setOcupado(true);
    setFasePensando('Pensando…');
    setPasosVivos([]);
    setHistorial((h) => [...h, { q, r: { texto: 'Pensando…', pendiente: true } }]);
    // El intervalo cuenta su propio tiempo (700ms × ticks) en vez de leer
    // Date.now(): mismo comportamiento a la precisión que estas fases
    // necesitan, y sin llamadas impuras que `react-hooks/purity` no puede
    // probar seguras en una función definida durante el render.
    let ticks = 0;
    const relojFases = setInterval(() => {
      ticks += 1;
      const t = ticks * 700;
      const fase = [...FASES_PENSANDO].reverse().find(([desde]) => t >= desde);
      if (fase) setFasePensando(fase[1]);
    }, 700);
    try {
      const previos = historial.flatMap((h) => [
        { rol: 'usuario' as const, texto: h.q },
        { rol: 'asistente' as const, texto: h.r.texto },
      ]);
      const tenant = spChat.get('tenant');
      const resp = await fetch(`/api/dashboard/chat${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ''}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mensajes: [...previos, { rol: 'usuario', texto: q }], documento, conversacionId }),
        // Sin esto, un servidor colgado dejaba "pensando…" para siempre
        // (reportado en vivo el 12-ago).
        signal: AbortSignal.timeout(75_000),
      });
      // El endpoint transmite NDJSON (la secuencia de pensamiento en vivo);
      // los caminos de tope siguen contestando JSON plano — se entienden
      // ambos, y un evento ilegible se ignora sin tumbar el turno.
      let d: Record<string, unknown> | null = null;
      if (resp.ok && resp.body && (resp.headers.get('content-type') ?? '').includes('ndjson')) {
        const lector = resp.body.getReader();
        const dec = new TextDecoder();
        let resto = '';
        for (;;) {
          const { done, value } = await lector.read();
          if (done) break;
          resto += dec.decode(value, { stream: true });
          let salto;
          while ((salto = resto.indexOf('\n')) >= 0) {
            const linea = resto.slice(0, salto).trim();
            resto = resto.slice(salto + 1);
            if (!linea) continue;
            let ev: Record<string, unknown> | null = null;
            try { ev = JSON.parse(linea) as Record<string, unknown>; } catch { continue; }
            if (ev.t === 'paso' && typeof ev.tool === 'string') {
              const tool = ev.tool;
              if (ev.fase === 'inicio') {
                setPasosVivos((p) => [...p, { tool, listo: false }]);
              } else {
                setPasosVivos((p) => {
                  // findLastIndex a mano: el target de TS de este repo no lo trae.
                  let idx = -1;
                  for (let i = p.length - 1; i >= 0; i--) {
                    if (p[i].tool === tool && !p[i].listo) { idx = i; break; }
                  }
                  if (idx >= 0) return p.map((x, i) => (i === idx ? { ...x, listo: true } : x));
                  return [...p, { tool, listo: true }];
                });
              }
            } else if (ev.t === 'fin' || ev.t === 'error') {
              d = ev;
            }
          }
        }
      } else {
        d = await resp.json().catch(() => null);
      }
      // H4 (auditoría 24): cuando el analista falla de verdad, el servidor
      // manda `{t:'error', error:'...'}` con `resp.ok` en 200 (el fallo va
      // DENTRO del NDJSON, no en el status HTTP) — antes ese `d.error` se
      // tiraba y la caja pasaba derecho al respondedor local de palabras
      // clave, que contesta con lo que YA estaba cargado en la página
      // (`kpis`/`acred`, potencialmente de hace rato). El usuario veía una
      // respuesta fluida sin ninguna señal de que el analista, el que de
      // verdad lee su operación completa, no pudo correr. `respuestaLocal`
      // declara el fallo antes de dar la respuesta de reserva — el mismo
      // criterio que "fallar cerrado y decirlo" del resto del producto.
      const r: Respuesta = resp.ok && d && Array.isArray(d.bloques)
        ? respuestaDeBloques(d.bloques as Array<Record<string, unknown>>)
        : respuestaLocal(q, kpis, acred, d && d.t === 'error' && typeof d.error === 'string' ? d.error : null);
      // El servidor guardó el intercambio (0088) y dice en qué conversación:
      // se ancla para los turnos siguientes y la lista del panel se actualiza
      // localmente (la verdad completa se relee al reabrir la página).
      if (resp.ok && d && typeof d.conversacionId === 'string') {
        const idConv = d.conversacionId;
        setConversacionId(idConv);
        setConvs((prev) => {
          if (!Array.isArray(prev)) return prev;
          const ya = prev.find((c) => c.id === idConv);
          const fila = ya ?? { id: idConv, titulo: q.replace(/\s+/g, ' ').trim().slice(0, 60), actualizadoEn: new Date().toISOString() };
          return [{ ...fila, actualizadoEn: new Date().toISOString() }, ...prev.filter((c) => c.id !== idConv)];
        });
      }
      setHistorial((h) => [...h.slice(0, -1), { q, r }]);
    } catch {
      // Mismo caso que arriba: el `fetch` reventó (red, timeout de 75 s) — el
      // analista tampoco corrió, y hay que decirlo, no disfrazarlo de
      // respuesta normal.
      setHistorial((h) => [...h.slice(0, -1), { q, r: respuestaLocal(q, kpis, acred, 'no se pudo conectar con el analista') }]);
    } finally {
      clearInterval(relojFases);
      setPasosVivos([]);
      setOcupado(false);
    }
  }

  const historialView = historial.length > 0 ? (
    <div className="space-y-3">
      {historial.map((h, i) => (
        <div key={i} className="text-sm">
          <div className="font-medium">{h.q}</div>
          <div style={{ color: 'var(--muted)' }}>{h.r.texto}</div>
        </div>
      ))}
    </div>
  ) : (
    <p className="text-sm" style={{ color: 'var(--muted)' }}>
      Pregúntame sobre lo comprobado, diferencias, diésel, IVA o peaje.
    </p>
  );

  const pie = (
    <>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {(compacto ? PREGUNTAS.slice(0, 2) : PREGUNTAS).map((p) => (
          <button key={p} type="button" onClick={() => preguntar(p)}
            className="text-xs px-2.5 py-1.5 rounded-full hairline hover:opacity-70 text-left transition-opacity">
            {p}
          </button>
        ))}
      </div>

      <form onSubmit={(e) => { e.preventDefault(); preguntar(texto); }} className="flex items-center gap-2">
        <input value={texto} onChange={(e) => setTexto(e.target.value)}
          placeholder="Pregunta algo…"
          className="flex-1 min-w-0 text-sm px-3 py-2.5 rounded-lg hairline" style={{ background: 'var(--surface)' }} />
        <button type="submit" aria-label="Enviar"
          className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-opacity hover:opacity-85"
          style={{ background: 'var(--marca)', color: 'var(--marca-fg)' }}>
          <Send width={15} height={15} strokeWidth={2} />
        </button>
      </form>
    </>
  );

  if (variante === 'hero') {
    const vacio = historial.length === 0;

    /* EL recuadro — el mismo en portada y en conversación. Consulta alterna
       el catálogo; el clip pregunta: tomar foto / subir imágenes / adjuntar
       archivos (los tres terminan en el mismo OCR real; `capture` abre la
       cámara del teléfono y en desktop cae al selector). */
    const caja = (
      <form
        onSubmit={(e) => { e.preventDefault(); preguntar(texto); }}
        className="relative w-full rounded-2xl px-4 pt-3.5 pb-3 transition-shadow focus-within:shadow-lg"
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--line)',
          boxShadow: 'var(--shadow-card)',
        }}
      >
        {menuAdjuntar && (
          <>
            {/* Clic afuera cierra, sin oscurecer nada. */}
            <button type="button" aria-label="Cerrar menú" onClick={() => setMenuAdjuntar(false)}
              className="fixed inset-0 z-20 cursor-default" style={{ background: 'transparent' }} />
            <div className={`absolute left-0 right-0 z-30 card p-1.5 ${vacio ? 'top-[calc(100%+8px)]' : 'bottom-[calc(100%+8px)]'}`}>
              <button type="button"
                onClick={() => { setMenuAdjuntar(false); inputCamara.current?.click(); }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors hover:bg-[var(--canvas)] text-left">
                <Camera width={15} height={15} strokeWidth={1.75} className="shrink-0" style={{ color: 'var(--muted)' }} />
                <span className="text-[13.5px] font-medium shrink-0">Tomar foto</span>
                <span className="text-[13px] truncate" style={{ color: 'var(--muted)' }}>Con la cámara del teléfono</span>
              </button>
              <button type="button"
                onClick={() => { setMenuAdjuntar(false); inputImagen.current?.click(); }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors hover:bg-[var(--canvas)] text-left">
                <FileImage width={15} height={15} strokeWidth={1.75} className="shrink-0" style={{ color: 'var(--muted)' }} />
                <span className="text-[13.5px] font-medium shrink-0">Subir imágenes</span>
                <span className="text-[13px] truncate" style={{ color: 'var(--muted)' }}>Fotos de tickets desde tu equipo</span>
              </button>
              <button type="button"
                onClick={() => { setMenuAdjuntar(false); inputArchivo.current?.click(); }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors hover:bg-[var(--canvas)] text-left">
                <Paperclip width={15} height={15} strokeWidth={1.75} className="shrink-0" style={{ color: 'var(--muted)' }} />
                <span className="text-[13.5px] font-medium shrink-0">Adjuntar archivos</span>
                <span className="text-[13px] truncate" style={{ color: 'var(--muted)' }}>PDF, Excel, CSV, XML de CFDI…</span>
              </button>
            </div>
          </>
        )}
        {documento && (
          <div className="mb-2">
            <span className="hairline inline-flex items-center gap-1.5 text-[12px] font-medium pl-2.5 pr-1.5 py-1 rounded-full" style={{ background: 'var(--canvas)' }}>
              <FileText width={13} height={13} strokeWidth={1.75} style={{ color: 'var(--muted)' }} />
              <span className="max-w-[260px] truncate">{documento.nombre}</span>
              <button type="button" aria-label="Quitar archivo" onClick={() => setDocumento(null)}
                className="w-5 h-5 rounded-full inline-flex items-center justify-center transition-colors hover:bg-[var(--line2)]">
                <X width={12} height={12} strokeWidth={2} />
              </button>
            </span>
          </div>
        )}
        <input
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          placeholder={documento ? `Pregunta sobre «${documento.nombre}» o tu operación…` : 'Pregunta sobre tu operación…'}
          aria-label="Pregunta sobre tu operación"
          className="w-full bg-transparent border-0 outline-none text-[15px] leading-relaxed"
        />
        <div className="flex items-center justify-between mt-3 relative">
          <button type="button" onClick={() => setRecomendar((v) => !v)}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full transition-opacity hover:opacity-85"
            style={{ background: 'var(--marca)', color: 'var(--marca-fg)' }}>
            <Search width={11} height={11} strokeWidth={2.25} />
            Consulta
          </button>

          <div className="flex items-center gap-1.5">
            <input ref={inputCamara} type="file" accept="image/*" capture="environment" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void leerArchivo(f); }} />
            <input ref={inputImagen} type="file" accept="image/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void leerArchivo(f); }} />
            <input ref={inputArchivo} type="file" accept="image/*,.pdf,.xlsx,.xls,.csv,.tsv,.ods,.xml,.txt,.json,.md" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void leerArchivo(f); }} />
            <button type="button" aria-label="Adjuntar comprobante" title="Adjuntar comprobante"
              onClick={() => setMenuAdjuntar((v) => !v)} disabled={ocupado}
              className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-colors hover:bg-[var(--canvas)] disabled:opacity-50"
              style={{ color: 'var(--ink2)' }}>
              <Paperclip width={14} height={14} strokeWidth={2} />
            </button>
            <button
              type="submit"
              aria-label="Enviar"
              disabled={!texto.trim() || ocupado}
              className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-opacity disabled:cursor-default"
              style={{
                background: 'var(--marca)',
                color: 'var(--marca-fg)',
                opacity: texto.trim() && !ocupado ? 1 : 0.35,
              }}
            >
              <ArrowUp width={15} height={15} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </form>
    );

    /* El catálogo de Consulta — al ancho de la caja y SCROLLEABLE (pedido
       del 12-ago): tres columnas de categorías con tope de alto. */
    const panelConsulta = recomendar && (
      <div className="w-full max-h-72 overflow-y-auto grid grid-cols-1 sm:grid-cols-3 gap-2.5 pr-0.5">
        {CATALOGO_CONSULTA.map((c) => (
          <div key={c.categoria} className="card p-3 self-start">
            <div className="etiqueta-mono text-[10px] font-medium uppercase mb-1.5" style={{ color: 'var(--muted)' }}>
              {c.categoria}
            </div>
            {c.preguntas.map((rq) => (
              <button key={rq} type="button"
                onClick={() => { setRecomendar(false); preguntar(rq); }}
                className="w-full text-left text-[13px] px-2 py-1.5 rounded-lg transition-colors hover:bg-[var(--canvas)]">
                {rq}
              </button>
            ))}
          </div>
        ))}
      </div>
    );

    // ── HISTORIAL (0088): botón pill
    // flotante con el conteo real, y un cajón izquierdo con Nuevo chat,
    // búsqueda y las conversaciones guardadas. Fixed a propósito: el hilo
    // scrollea y un absolute se iría con él.
    const listaFiltrada = Array.isArray(convs)
      ? convs.filter((c) => c.titulo.toLowerCase().includes(busqueda.trim().toLowerCase()))
      : [];
    const pillHistorial = (
      <div ref={anclaChat} className="sticky top-0 z-30 h-0 w-full">
        {!historialAbierto && (
          <button type="button" onClick={abrirHistorial}
            className="absolute top-3 right-4 hairline inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5 rounded-full text-[12.5px] font-medium transition-colors hover:bg-[var(--canvas)]"
            style={{ background: 'var(--surface)', color: 'var(--ink2)' }}>
            <History width={13} height={13} strokeWidth={1.75} style={{ color: 'var(--muted)' }} />
            Historial
            {Array.isArray(convs) && (
              <span className="cifra-mono text-[11px] px-1.5 py-0.5 rounded-full" style={{ background: 'var(--canvas)', color: 'var(--muted)' }}>
                {numero(convs.length)}
              </span>
            )}
          </button>
        )}
      </div>
    );

    // EN FLUJO y no encima (13-ago: "que no choque, que se mueva como
    // ChatGPT"): el panel es un hermano flex del contenido — al abrirse, el
    // chat se comprime y se re-centra solo. El ancho anima con la misma
    // curva easeOutQuint del resto del producto; sticky para quedarse
    // pegado mientras el hilo scrollea, y la altura se midió contra el
    // ancla al abrir (arranca al nivel del gris, cinta de rol incluida).
    //
    // H12 (auditoría 24): esos 352px fijos son correctos en escritorio, pero
    // en un teléfono (<lg) 352px es casi TODO el ancho disponible — el hilo
    // de la conversación quedaba comprimido a unos pocos píxeles al lado,
    // ilegible, en vez de que el historial ocupe la pantalla completa como
    // una cortina. Bajo `lg` y con el historial abierto, el panel se vuelve
    // un overlay `fixed inset-0` de ancho completo (`!` fuerza el override
    // sobre el `width` inline, que sigue animando el caso de escritorio).
    const panelHistorialMovil = historialAbierto
      ? 'max-lg:!fixed max-lg:!inset-0 max-lg:!top-0 max-lg:!mt-0 max-lg:!w-full max-lg:!h-full max-lg:z-40'
      : '';
    const panelHistorial = (
      <div className={`shrink-0 self-start sticky top-4 mt-4 overflow-hidden ${panelHistorialMovil}`}
        style={{ width: historialAbierto ? 352 : 0, height: `calc(100dvh - ${topPanel + 32}px)`, transition: 'width 480ms cubic-bezier(0.22, 1, 0.36, 1)' }}>
        <div className="w-[320px] mx-4 h-full rounded-2xl hairline flex flex-col p-3 gap-2.5 max-lg:!w-full max-lg:!mx-0 max-lg:!rounded-none"
          style={{ background: 'var(--surface)', boxShadow: 'var(--shadow-card)' }}>
          <div className="flex items-center justify-between">
            <button type="button" onClick={nuevoChat}
              className="hairline flex-1 flex items-center gap-2 px-3 py-2 rounded-xl text-[13px] font-medium transition-colors hover:bg-[var(--canvas)]">
              <PencilLine width={14} height={14} strokeWidth={1.75} style={{ color: 'var(--muted)' }} />
              Nuevo chat
            </button>
            <button type="button" aria-label="Cerrar historial" title="Cerrar historial" onClick={() => setHistorialAbierto(false)}
              className="w-8 h-8 ml-1.5 rounded-lg flex items-center justify-center shrink-0 transition-colors hover:bg-[var(--canvas)]"
              style={{ color: 'var(--muted)' }}>
              <PanelRightClose width={15} height={15} strokeWidth={1.75} />
            </button>
          </div>

          <div className="hairline flex items-center gap-2 px-3 py-2 rounded-full" style={{ background: 'var(--canvas)' }}>
            <Search width={13} height={13} strokeWidth={2} style={{ color: 'var(--muted)' }} />
            <input value={busqueda} onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar chats" aria-label="Buscar chats"
              className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[13px]" />
          </div>

          <div className="etiqueta-mono text-[10px] uppercase px-1 pt-1" style={{ color: 'var(--faint)' }}>
            Recientes
          </div>

          {errorCarga && (
            <p className="text-[12px] px-1" style={{ color: 'var(--bad)' }}>{errorCarga}</p>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto space-y-0.5">
            {convs === null && (
              <div className="space-y-2 px-1 pt-1">
                <div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-4/5" /><div className="skeleton h-4 rounded w-3/5" />
              </div>
            )}
            {convs === 'error' && (
              <p className="text-[12.5px] px-1" style={{ color: 'var(--muted)' }}>
                No se pudo leer el historial ahora mismo — tus conversaciones siguen
                guardadas; reintenta en un momento.
              </p>
            )}
            {Array.isArray(convs) && listaFiltrada.length === 0 && (
              <p className="text-[12.5px] px-1" style={{ color: 'var(--muted)' }}>
                {convs.length === 0 ? 'Sin chats recientes.' : `Nada coincide con «${busqueda.trim()}».`}
              </p>
            )}
            {listaFiltrada.map((c) => {
              const activa = c.id === conversacionId;
              return (
                <button key={c.id} type="button" onClick={() => void cargarConversacion(c.id)}
                  className={`w-full text-left px-2.5 py-2 rounded-lg text-[13px] transition-colors ${activa ? 'font-medium' : 'hover:bg-[var(--canvas)]'}`}
                  style={activa ? { background: 'var(--g1)', color: 'var(--marca)' } : undefined}>
                  <span className="block truncate">{c.titulo}</span>
                  <span className="block text-[11px] mt-0.5" style={{ color: 'var(--faint)' }}>{fechaCorta(c.actualizadoEn)}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );

    // ── CONVERSACIÓN, tipo ChatGPT/Claude (pedido del 12-ago): al primer
    // mensaje la portada se retira, las burbujas suben y la caja se ancla
    // abajo. Tu pregunta a la derecha; el motor a la izquierda con su
    // tabla/gráfica cuando la trae.
    if (!vacio) {
      return (
        <div className="min-h-full w-full flex-1 flex">
          <div className="flex-1 min-w-0 flex flex-col">
            {pillHistorial}
            <div className="flex-1 flex flex-col px-4 pt-4">
          <div className="w-full max-w-2xl mx-auto flex-1 flex flex-col">
            <div className="flex-1 space-y-4 py-2">
              {historial.map((h, i) => (
                <div key={i}>
                  <div className="flex justify-end">
                    <div className="hairline rounded-2xl rounded-br-md px-3.5 py-2 text-sm max-w-[85%]" style={{ background: 'var(--surface)' }}>
                      {h.q}
                    </div>
                  </div>
                  <div className="mt-2.5 text-sm max-w-[85%]">
                    {h.r.pendiente ? (
                      <div className="flex items-start gap-2.5">
                        <span className="likida-respira shrink-0 mt-0.5" style={{ color: 'var(--ink)' }}><LogoIcono alto="h-[16px]" /></span>
                        <div>
                          <div style={{ color: 'var(--muted)' }}>{fasePensando}</div>
                          {pasosVivos.length > 0 && (
                            <div className="mt-2 space-y-1.5">
                              {pasosVivos.map((p, j) => (
                                <div key={j} className="flex items-center gap-2 text-[12.5px]"
                                  style={{ color: p.listo ? 'var(--faint)' : 'var(--ink)' }}>
                                  {p.listo
                                    ? <Check width={12} height={12} strokeWidth={2} className="shrink-0" style={{ color: 'var(--muted)' }} />
                                    : <span className="skeleton inline-block w-2.5 h-2.5 rounded-full shrink-0" />}
                                  {rotuloTool(p.tool)}{p.listo ? '' : '…'}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div>{h.r.texto}</div>
                    )}
                    {h.r.visual && <VisualRespuesta v={h.r.visual} />}
                    {h.r.visuales?.map((v, j) => <VisualRespuesta key={j} v={v} />)}
                  </div>
                </div>
              ))}
              <div ref={finConversacion} />
            </div>
            <div className="sticky bottom-0 shrink-0 pt-3 pb-4" style={{ background: 'var(--g1)' }}>
              {panelConsulta}
              <div className={recomendar ? 'mt-3' : ''}>{caja}</div>
            </div>
          </div>
            </div>
          </div>
          {panelHistorial}
        </div>
      );
    }

    // ── PORTADA (sin mensajes todavía) ──
    return (
      <div className="min-h-full w-full flex-1 flex">
        <div className="relative flex-1 min-w-0 flex flex-col">
        <CampoPixeles />
        {pillHistorial}
        {/* El centrado vive en ESTA capa: con el ancla sticky adentro del
            justify-center, el pill saldría a media pantalla, no arriba. */}
        <div className="relative z-10 w-full flex-1 flex flex-col items-center justify-center px-4 py-10">
        <div className="w-full max-w-2xl flex flex-col items-center">
          <Logo alto="h-7" className="mb-6" />
          <h1 className="text-[26px] leading-tight font-medium tracking-tight text-center">
            Pregunta a tus datos
          </h1>
          <p className="mt-2 mb-8 text-sm text-center max-w-md" style={{ color: 'var(--muted)' }}>
            Tu operación, con la cifra que ya calculó el motor — y adjunta un PDF, un Excel
            o la foto de un comprobante para analizarlo aquí mismo.
          </p>

          {caja}

          {/* Con el menú del clip abierto, las recomendaciones se ESCONDEN
              pero conservan su espacio (invisible, no display:none): quitarlas
              del layout recorría el título y la caja — "lo de arriba no se
              mueve" (13-ago). El menú cae encima de este hueco. */}
          {recomendar ? (
            <div className={`w-full mt-4 ${menuAdjuntar ? 'invisible' : ''}`}>{panelConsulta}</div>
          ) : (
            <div className={`flex flex-wrap justify-center gap-2 mt-4 ${menuAdjuntar ? 'invisible' : ''}`}>
              {PREGUNTAS.map((pq) => (
                <button
                  key={pq}
                  type="button"
                  onClick={() => preguntar(pq)}
                  className="text-xs px-3 py-1.5 rounded-full hairline transition-opacity hover:opacity-70"
                  // BLANCO explícito (12-ago): la página hero vive sobre el
                  // lienzo tenue --g1 y un chip transparente se veía gris.
                  style={{ color: 'var(--ink2)', background: 'var(--surface)' }}
                >
                  {pq}
                </button>
              ))}
            </div>
          )}

          {/* La nota vive… salvo con el menú del clip abierto (13-ago: "solo
              cuando aprietas adjuntar"): invisible conservando su espacio,
              para que nada de arriba se mueva y no se asome bajo el menú. */}
          <p className={`mt-8 text-[11px] leading-relaxed text-center max-w-lg ${menuAdjuntar ? 'invisible' : ''}`} style={{ color: 'var(--faint)' }}>
            Responde con cifras ya calculadas en el servidor — en texto, tabla o gráfica según
            la pregunta. No traduce preguntas libres a consultas de base de datos, a propósito.
          </p>
        </div>
        </div>
        </div>
        {panelHistorial}
      </div>
    );
  }

  if (compacto) {
    return (
      <div>
        {historial.length > 0 && <div className="mb-3 max-h-56 overflow-y-auto">{historialView}</div>}
        {pie}
      </div>
    );
  }

  return (
    <div className="glass-panel p-6 h-full flex flex-col overflow-hidden">
      <h2 className="text-sm font-semibold uppercase tracking-wide mb-4 shrink-0" style={{ color: 'var(--muted)' }}>
        Pregunta a tus datos
      </h2>
      <div className="flex-1 min-h-0 overflow-y-auto">{historialView}</div>
      <div className="shrink-0 pt-4">{pie}</div>
    </div>
  );
}
