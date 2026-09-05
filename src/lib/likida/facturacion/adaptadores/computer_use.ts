import type OpenAI from 'openai';
import { generateWithTools } from '@/lib/llm/openrouter';
import type { LlmBudget } from '@/lib/llm/budget';
import { claimMutation, completeMutation, failMutation } from '@/lib/llm/tool-idempotency';
import { logger } from '@/lib/logger';
import type { CampoListo } from '../pendientes';
import type { AdaptadorPortal, ModoAgente, ResultadoAgente } from '../agente';
import type { PaginaPlaywright } from './pagina_playwright';

/** Abre una pestaña nueva. Es lo que devuelve `SesionNavegador.fabrica()`. */
export type AbrirPagina = () => Promise<PaginaPlaywright>;

// ═══════════════════════════════════════════════════════════════════════════
// UN ADAPTADOR PARA LOS PORTALES QUE NADIE ESCRIBIÓ.
//
// ── EL PROBLEMA QUE RESUELVE, CON NÚMEROS ────────────────────────────────
//
// `comercios.ts` tiene 37 portales. `adaptadores/registro.ts` tiene UNO escrito
// a mano (CAPUFE). Los otros 36 se enrutaban a un robot que no existe, y hasta
// el 20-ago-2026 ni siquiera se le avisaba a nadie: el ticket se quedaba en la
// cola en silencio. Escribir 36 adaptadores a mano es 36 veces el trabajo de
// leer un DOM ajeno y adivinar sus selectores.
//
// Este los cubre todos con el mismo ciclo: se le enseña al modelo el INVENTARIO
// del formulario que tiene enfrente y se le dan las manos de `PaginaPlaywright`
// —escribir, seleccionar, hacer clic—. El modelo decide dónde va cada dato; el
// código decide qué dato existe y qué está prohibido tocar.
//
// ── POR QUÉ INVENTARIO DEL DOM Y NO CAPTURAS DE PANTALLA ─────────────────
//
// "Computer use" en su forma canónica manda pixeles y devuelve coordenadas. Aquí
// sería la herramienta equivocada por tres razones medibles: una captura cuesta
// ~1,500 tokens de entrada contra ~300 del inventario; un clic por coordenada no
// se puede volver a ejecutar cuando el portal se re-renderiza; y las manos que
// este repo ya tiene —`escribir`, `seleccionar`, `hacerClic`— hablan selectores,
// con sus topes de tiempo y su manejo de error ya probados en CAPUFE.
//
// O sea: mismo poder —un modelo operando un sitio que nadie programó— sin tirar
// la infraestructura que ya funciona.
//
// ── LA REGLA QUE HACE ESTO ACEPTABLE EN UN DOCUMENTO FISCAL ──────────────
//
// EL MODELO NO PUEDE TECLEAR TEXTO LIBRE. Nunca.
//
// `escribir` no recibe un valor: recibe la CLAVE de un valor que el sistema ya
// tenía (`rfc`, `webId`, `monto`…). Si el modelo pide una clave que no existe,
// la herramienta se niega y se lo dice. Así, un modelo que alucine un RFC o
// redondee un importe no puede meterlo en un CFDI — el peor error posible de
// este producto, y el que la regla de "nunca inventar una cifra" existe para
// evitar. El modelo elige DÓNDE va cada dato; nunca CUÁL es.
//
// ── Y EL BOTÓN DE EMITIR ─────────────────────────────────────────────────
//
// En `ensayo` la herramienta de emitir NO SE LE OFRECE al modelo. No es que se
// le pida que no la use: no existe en su lista. Un candado que depende de que
// el modelo obedezca no es un candado.
//
// En `emitir` sí existe, y aun así pasa por `PROHIBIDOS`, la lista de cosas que
// no se tocan nunca —el checkbox de partidos políticos, que ya estaba prohibido
// por nombre en el adaptador de CAPUFE—.
//
// ── Y EL MISMO CANDADO QUE LAS DEMÁS TOOLS DE ESCRITURA (AUDITORÍA 25) ────
//
// `emitir` corre FUERA del executor normal (`tool-executor.ts`): este archivo
// le pasa su propio `toolExecutor` directo a `generateWithTools`, así que
// nunca pasa por `claimMutation`/lease/fencing. Sin eso, el handler de
// `emitir` no llevaba bandera de "ya emití": si el portal se re-renderiza y
// el botón sigue en el inventario —o el modelo elige otro selector del mismo
// botón—, una segunda llamada en la misma corrida se ejecutaba tal cual, y
// eso es un SEGUNDO CFDI timbrado ante el SAT por el mismo ticket.
//
// Se reusa el MISMO mecanismo durable que usan las tools de escritura del
// repo (`claimMutation`/`completeMutation`/`failMutation`, la RPC en
// Postgres), en vez de una bandera en memoria: una bandera local no
// sobrevive un proceso que muere entre el clic y la respuesta, y es
// exactamente ese hueco el que este candado cierra. La llave del efecto la
// arman los CAMPOS del ticket (folio/webId/monto/…) porque
// `AdaptadorPortal.facturar(campos, modo)` — la interfaz que comparten los
// 37 comercios — no recibe un id de ticket; cambiarla para dárselo tocaría
// los otros adaptadores por un hallazgo que es solo de éste.
// ═══════════════════════════════════════════════════════════════════════════

/** Cuántas vueltas de decisión antes de rendirse. Un portal normal necesita 6-10. */
const MAX_VUELTAS = 14;

/**
 * Lo que no se toca, pase lo que pase, lo pida quien lo pida.
 *
 * El checkbox de partidos políticos de CAPUFE marca el CFDI como donativo a un
 * partido. Ya estaba prohibido por nombre en `capufe.ts`; aquí se generaliza,
 * porque un modelo que ve una casilla sin marcar tiende a marcarla.
 */
const PROHIBIDOS = /partido|donativ|dona[rc]|suscrib|newsletter|public|acepto.*promo/i;

/**
 * RE-AUDITORÍA 25, FASE 3 (TC-CANDADO-CLIC-BYPASS, MEDIO): el candado durable
 * de `emitir` (`reclamarEmision`/`sellarEmision`, ver la cabecera) solo
 * envolvía el `case 'emitir'`. La tool hermana `clic` — "hace clic en un
 * botón del inventario", sin más restricción que `PROHIBIDOS` — puede
 * apretar EL MISMO botón físico de emisión sin pasar por el candado: mismo
 * clic, mismo CFDI, cero protección contra el doble timbrado.
 *
 * No hay forma de conocer de antemano el selector real del botón de emitir
 * de cada uno de los 37 portales (lo descubre el modelo en el inventario de
 * CADA portal), así que se reconoce por el mismo tipo de heurística que
 * `PROHIBIDOS` ya usa: palabras de la ACCIÓN de emitir en el propio selector
 * — el id/name que el portal le puso, o el texto del botón que `inventario()`
 * mete en el selector cuando no hay id/name (`button:has-text("Emitir…")`).
 * Deliberadamente NO incluye "factura" a secas: "ver factura" o "descargar
 * factura" son botones legítimos para `clic` y un falso positivo aquí no
 * bloquea el clic — lo enruta por `reclamarEmision`, que lo marcaría
 * "ya emitido" y le negaría al VERDADERO `emitir` su propio candado.
 */
const BOTON_DE_EMISION = /emitir|timbrar|facturar|generar.{0,3}factura|obtener.{0,3}factura|solicitar.{0,3}factura/i;

export interface DatosReceptorPortal {
  rfc: string;
  nombre: string;
  codigoPostal: string;
  regimenFiscal: string;
  usoCfdi: string;
  correo: string;
}

export interface OpcionesComputerUse {
  /** De qué flota es la emisión — la llave del candado de `emitir` va scoped
   *  a esto, igual que toda mutación del repo. */
  tenantId: string;
  comercio: string;
  portal: string;
  receptor: DatosReceptorPortal;
  abrirPagina: AbrirPagina;
  /** Tope de vueltas. Se baja en pruebas; en producción manda `MAX_VUELTAS`. */
  maxVueltas?: number;
  signal?: AbortSignal;
  /** Presupuesto persistido de la corrida; nunca se inventa un tenant aquí. */
  budget?: LlmBudget;
}

/** Lo que el modelo puede escribir: clave → valor. Nunca texto libre. */
function valoresDisponibles(campos: CampoListo[], r: DatosReceptorPortal): Record<string, string> {
  const v: Record<string, string> = {
    rfc: r.rfc,
    nombre: r.nombre,
    codigoPostal: r.codigoPostal,
    regimenFiscal: r.regimenFiscal,
    usoCfdi: r.usoCfdi,
    correo: r.correo,
  };
  for (const c of campos) {
    if (c.valor) v[c.clave] = c.valor;
  }
  return v;
}

/** El inventario del formulario que el modelo tiene enfrente. */
async function inventario(pagina: PaginaPlaywright): Promise<string> {
  const inv = await pagina.pagina.evaluate(() => {
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const sel = (el: Element) => {
      const id = el.getAttribute('id');
      if (id) return `#${id}`;
      const name = el.getAttribute('name');
      if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
      return '';
    };
    const etiqueta = (el: Element): string => {
      const id = el.getAttribute('id');
      if (id) {
        const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (l?.textContent?.trim()) return l.textContent.trim();
      }
      return el.closest('label')?.textContent?.trim()
        ?? el.previousElementSibling?.textContent?.trim() ?? '';
    };
    const campos = [...document.querySelectorAll('input, select, textarea')]
      .filter(visible).filter((el) => sel(el))
      .map((el) => {
        const opciones = el.tagName === 'SELECT'
          ? [...(el as HTMLSelectElement).options].slice(0, 40).map((o) => o.value).filter(Boolean)
          : [];
        return {
          s: sel(el),
          tipo: el.tagName === 'SELECT' ? 'select' : (el.getAttribute('type') ?? 'text'),
          etiqueta: etiqueta(el).slice(0, 60),
          placeholder: el.getAttribute('placeholder') ?? '',
          valorActual: (el as HTMLInputElement).value ?? '',
          opciones,
        };
      });
    const botones = [...document.querySelectorAll('button, input[type=submit], input[type=button], a[role=button]')]
      .filter(visible)
      .map((el) => ({
        s: sel(el) || `${el.tagName.toLowerCase()}:has-text("${(el.textContent ?? '').trim().slice(0, 30)}")`,
        texto: ((el.textContent ?? '') || (el as HTMLInputElement).value || '').trim().slice(0, 40),
      }))
      .filter((b) => b.texto);
    // El texto visible da el contexto que los campos solos no dan: avisos,
    // errores del portal, y si ya se emitió algo.
    const texto = (document.body.innerText ?? '').replace(/\n{2,}/g, '\n').slice(0, 1200);
    return { campos, botones, texto };
  });
  return JSON.stringify(inv);
}

/**
 * La llave del efecto "emitir este CFDI" — estable entre reintentos del
 * MISMO ticket (mismos campos), distinta entre tickets. Se arma de las
 * claves que YA identifican al ticket (folio, webId, monto…) porque
 * `facturar(campos, modo)` no recibe un id de ticket — ver la cabecera.
 */
function efectoEmitir(comercio: string, campos: CampoListo[]): string {
  const partes = campos
    .filter((c) => c.valor)
    .map((c) => `${c.clave}=${c.valor}`)
    .sort();
  return `facturacion.computer_use.emitir:${comercio}:${partes.join('|')}`;
}

type ReclamoEmision =
  /** `protegido: false` = no hay candado durable detrás (solo pruebas sin
   *  Postgres): `sellarEmision` no intenta sellar lo que nunca se reclamó. */
  | { kind: 'execute'; token: string; protegido: boolean }
  /** Ya se emitió antes (o está emitiéndose ahora): el mensaje es lo que lee
   *  el modelo — nunca se le dice "error", porque no lo es. */
  | { kind: 'detenido'; mensaje: string };

/**
 * Reclama el candado antes de apretar el botón. Fail-closed fuera de
 * pruebas: si Postgres no puede confirmar que nadie más está emitiendo este
 * mismo ticket, NO se aprieta el botón — un acto fiscal irreversible no se
 * arriesga a una condición de carrera por no poder demostrar que está solo.
 */
async function reclamarEmision(tenantId: string, efectoId: string): Promise<ReclamoEmision> {
  try {
    const c = await claimMutation(tenantId, efectoId, 'facturacion.computer_use.emitir');
    if (c.kind === 'cached') {
      return { kind: 'detenido', mensaje: 'Este CFDI YA SE EMITIÓ en un intento anterior de este mismo ticket. NO vuelvas a apretar el botón de emitir aunque el inventario lo siga mostrando — usa rendirse si el portal insiste en pedir la emisión.' };
    }
    if (c.kind === 'busy') {
      return { kind: 'detenido', mensaje: 'La emisión de este ticket ya se está procesando en otro intento. NO reintentes el clic — usa rendirse.' };
    }
    return { kind: 'execute', token: c.token, protegido: true };
  } catch (e) {
    const detalle = e instanceof Error ? e.message : String(e);
    if (process.env.NODE_ENV === 'test') {
      // Mismo criterio que `tool-executor.ts`: los tests de este archivo no
      // montan Postgres, así que ejercitan el handler sin falsear una
      // garantía de producción.
      logger.warn('facturacion.computer_use.idempotencia_mock', { err: detalle });
      return { kind: 'execute', token: '', protegido: false };
    }
    logger.error('facturacion.computer_use.idempotencia_no_disponible', { err: detalle });
    return { kind: 'detenido', mensaje: 'No se pudo proteger esta emisión contra un doble clic (falla de infraestructura). NO se debe apretar emitir sin esa protección — usa rendirse y repórtalo.' };
  }
}

/** Sella el resultado del clic. Best-effort: el clic YA ocurrió (o falló) —
 *  perder el sello degrada a "puede reintentar de más", nunca a perder el
 *  candado sobre un clic que no pasó. */
async function sellarEmision(
  tenantId: string, efectoId: string, reclamo: { token: string; protegido: boolean },
  resultado: { ok: true } | { ok: false; error: string },
): Promise<void> {
  if (!reclamo.protegido) return;   // nada que sellar: nunca se reclamó de verdad.
  try {
    if (resultado.ok) await completeMutation(tenantId, efectoId, reclamo.token, { clicado: true });
    else await failMutation(tenantId, efectoId, reclamo.token, resultado.error);
  } catch (e) {
    logger.error('facturacion.computer_use.sello_fallido', { err: e instanceof Error ? e.message : String(e) });
  }
}

const SISTEMA = `Operas el portal de facturación de un proveedor mexicano para obtener el CFDI de un ticket de gasto de una flota de carga.

Recibes el INVENTARIO del formulario en pantalla (campos visibles con su selector, tipo, etiqueta y opciones; botones con su selector y texto; y el texto visible de la página) y decides UNA acción a la vez.

REGLAS QUE NO SE ROMPEN:
- NO inventas datos. \`escribir\` recibe la CLAVE de un valor que ya existe, nunca el valor. Si un campo obligatorio del portal no tiene una clave que le corresponda, usa \`rendirse\` y di cuál falta.
- Un campo que ya trae el valor correcto NO se vuelve a escribir.
- No marcas casillas de donativos, partidos políticos, promociones ni suscripciones.
- Si aparece un CAPTCHA que bloquea, usa \`rendirse\` con motivo "captcha".
- Si el portal muestra un error, léelo y decide: corregir un campo, o rendirse diciendo qué dijo el portal.

Trabaja en este orden: primero los datos fiscales del receptor, luego los datos del ticket, luego el botón que valida/busca, y solo al final el que emite.`;

/** Adaptador genérico. Sirve para CUALQUIER comercio del catálogo. */
export class AdaptadorComputerUse implements AdaptadorPortal {
  readonly comercio: string;
  readonly portal: string;
  private readonly op: OpcionesComputerUse;

  constructor(op: OpcionesComputerUse) {
    this.comercio = op.comercio;
    this.portal = op.portal;
    this.op = op;
  }

  async facturar(campos: CampoListo[], modo: ModoAgente): Promise<ResultadoAgente> {
    const valores = valoresDisponibles(campos, this.op.receptor);
    const capturado: Record<string, string> = {};
    let abierta: PaginaPlaywright | null = null;
    let uuid: string | undefined;
    let rendido: string | null = null;
    let captcha = false;
    const efectoId = efectoEmitir(this.comercio, campos);

    try {
      const p = await this.op.abrirPagina();
      abierta = p;
      await p.abrir(this.portal);

      // ── LAS MANOS. En `ensayo`, `emitir` NO entra en la lista. ──────────
      const tools: OpenAI.Chat.ChatCompletionTool[] = [
        herramienta('escribir', 'Escribe en un campo el valor que corresponde a una clave conocida.', {
          selector: { type: 'string' }, clave: { type: 'string', enum: Object.keys(valores) },
        }),
        herramienta('seleccionar', 'Elige una opción de un <select>. `valor` tiene que venir de sus opciones.', {
          selector: { type: 'string' }, valor: { type: 'string' },
        }),
        herramienta('clic', 'Hace clic en un botón del inventario.', { selector: { type: 'string' } }),
        herramienta('rendirse', 'No se puede seguir. Di por qué, en una frase.', { motivo: { type: 'string' } }),
      ];
      if (modo === 'emitir') {
        tools.push(herramienta('emitir',
          'Aprieta el botón que EMITE el CFDI. Irreversible ante el SAT. Solo cuando todo lo demás esté validado.',
          { selector: { type: 'string' } }));
      }

      // El candado durable que usan las demás tools de escritura — ver la
      // cabecera del archivo. Sin él, un segundo clic sobre el botón de
      // emisión en la MISMA corrida (botón que sigue en el inventario, un
      // selector distinto del mismo botón, o la tool `clic` en vez de
      // `emitir` — TC-CANDADO-CLIC-BYPASS) volvía a apretarlo tal cual.
      // Compartida entre `case 'emitir'` y el bypass de `case 'clic'`: el
      // candado protege el CLIC FÍSICO, no el nombre de la tool que lo pidió.
      const clicDeEmision = async (selector: string): Promise<string> => {
        const reclamo = await reclamarEmision(this.op.tenantId, efectoId);
        if (reclamo.kind === 'detenido') return reclamo.mensaje;
        try {
          await p.hacerClic(selector);
        } catch (e) {
          await sellarEmision(this.op.tenantId, efectoId, reclamo, { ok: false, error: e instanceof Error ? e.message : String(e) });
          throw e;
        }
        const inv = await inventario(p);
        await sellarEmision(this.op.tenantId, efectoId, reclamo, { ok: true });
        return `EMITIDO. Inventario nuevo: ${inv}`;
      };

      const ejecutar = async (nombre: string, args: Record<string, unknown>): Promise<string> => {
        const selector = String(args.selector ?? '');
        if ((nombre === 'clic' || nombre === 'emitir') && PROHIBIDOS.test(selector)) {
          return 'PROHIBIDO: ese control no se toca nunca.';
        }
        switch (nombre) {
          case 'escribir': {
            const clave = String(args.clave ?? '');
            const valor = valores[clave];
            // La regla entera, en tres líneas: sin valor conocido, no se escribe.
            if (valor === undefined) return `No existe la clave "${clave}". Disponibles: ${Object.keys(valores).join(', ')}.`;
            await p.escribir(selector, valor);
            capturado[clave] = valor;
            return `escrito ${clave} en ${selector}`;
          }
          case 'seleccionar': {
            const valor = String(args.valor ?? '');
            await p.seleccionar(selector, valor);
            capturado[selector] = valor;
            return `seleccionado ${valor} en ${selector}`;
          }
          case 'clic': {
            // TC-CANDADO-CLIC-BYPASS: si el selector apunta al mismo botón de
            // emisión, `clic` NO es distinto de `emitir` — exige el mismo
            // candado, sin excepción por el nombre de la tool. Un botón
            // normal ("validar", "siguiente"…) sigue apretándose tal cual.
            if (BOTON_DE_EMISION.test(selector)) return clicDeEmision(selector);
            await p.hacerClic(selector);
            return `clic en ${selector}. Inventario nuevo: ${await inventario(p)}`;
          }
          case 'emitir':
            return clicDeEmision(selector);
          case 'rendirse':
            rendido = String(args.motivo ?? 'sin motivo');
            if (/captcha/i.test(rendido)) captcha = true;
            return 'anotado';
          default:
            return `herramienta desconocida: ${nombre}`;
        }
      };

      const r = await generateWithTools({
        // Sonnet 5 y no un modelo barato: un clic mal puesto aquí emite un CFDI
        // irreversible ante el SAT. No es el sitio donde se ahorra un centavo.
        role: 'cuadre',
        system: SISTEMA,
        messages: [{
          role: 'user',
          content: `Portal: ${this.comercio} (${this.portal})
Modo: ${modo}${modo === 'ensayo' ? ' — llena todo pero NO existe herramienta de emitir; termina cuando el formulario esté completo.' : ''}
Valores disponibles (clave: valor): ${JSON.stringify(valores)}
Inventario inicial: ${await inventario(p)}`,
        }],
        tools,
        toolExecutor: async (nombre, args) => {
          // Se envuelve en el contrato del repo —éxito, duración, error— para
          // que estas tools se vean en el log igual que las del cuadre. Y para
          // que un fallo del portal NO reviente el ciclo: vuelve como texto, y
          // el modelo decide si corrige el campo o se rinde. Un selector que no
          // existe es información, no una excepción.
          const t0 = Date.now();
          try {
            return { success: true, result: await ejecutar(nombre, args), durationMs: Date.now() - t0 };
          } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            return { success: false, result: `falló ${nombre}: ${error}`, error, durationMs: Date.now() - t0 };
          }
        },
        maxToolRounds: this.op.maxVueltas ?? MAX_VUELTAS,
        signal: this.op.signal,
        budget: this.op.budget,
      });

      // El UUID se busca en lo que el modelo leyó Y en la página, no solo en su
      // resumen: un modelo que "cree" haber emitido sin UUID es exactamente el
      // caso que `emitidoSinConfirmar` existe para no repetir.
      uuid = extraerUuid(r.finalText) ?? extraerUuid(await inventario(p)) ?? undefined;

      const captura = await p.captura().catch(() => undefined);
      logger.info('portal.computer_use', {
        comercio: this.comercio, modo, vueltas: r.toolCalls.length,
        campos: Object.keys(capturado).length, uuid: Boolean(uuid), costo: r.cost,
      });

      if (rendido) {
        return { modo, ok: false, capturado, error: rendido, captura, requiereCaptcha: captcha || undefined };
      }
      // EMITIR SIN UUID CONFIRMADO ES LA SEÑAL CARA: el CFDI puede existir.
      // Se declara para que el llamador NO lo reintente y lo mande con una
      // persona — duplicar un CFDI es peor que no emitirlo.
      if (modo === 'emitir' && !uuid) {
        return {
          modo, ok: false, capturado, captura,
          error: 'se operó el portal en modo emitir y no se pudo confirmar el UUID',
          emisionSinConfirmar: true,
        };
      }
      return { modo, ok: true, capturado, cfdiUuid: uuid, captura };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logger.warn('portal.computer_use_error', { comercio: this.comercio, error });
      return { modo, ok: false, capturado, error };
    } finally {
      await abierta?.cerrar().catch(() => {});
    }
  }
}

/** Azúcar para declarar una tool de OpenAI sin repetir el envoltorio. */
function herramienta(
  name: string, description: string, props: Record<string, unknown>,
): OpenAI.Chat.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name, description,
      parameters: { type: 'object', properties: props, required: Object.keys(props) },
    },
  };
}

/** Un UUID de CFDI donde sea que aparezca. */
export function extraerUuid(texto: string): string | null {
  const m = texto.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  // ARQ-19C2-5: `repo.ts` normaliza todo UUID a MINÚSCULAS (`.toLowerCase()`,
  // línea 36) antes de comparar/guardar. Este adaptador no está cableado a
  // producción hoy, pero normalizar distinto aquí sembraba una trampa lista
  // para cuando alguien lo conecte.
  return m ? m[0].toLowerCase() : null;
}
