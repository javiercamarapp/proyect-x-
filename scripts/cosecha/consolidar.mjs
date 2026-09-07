#!/usr/bin/env node
// Junta las fichas cosechadas en un consolidado, agrupado por PORTAL —que es la
// unidad de integración— y separando lo verde de lo que pide cuenta.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
const DIR = join(dirname(new URL(import.meta.url).pathname), '../../docs/investigacion/cosecha');

// ── SOLO FICHAS DE COMERCIO ────────────────────────────────────────────────
//
// LA CAUSA DE CINCO ARTEFACTOS SEGUIDOS, y por fin atacada en la raíz. El
// consolidado metía las páginas de blog, autor, glosario y "acerca de" de los
// directorios. Ésas no tienen portal, así que `portales[0]` agarraba el primer
// enlace externo que hubiera —otro directorio, un rastreador, un CDN— y salía un
// "portal" con cientos de comercios:
//
//   facturaenlineamexico.com   889   ← sitio hermano enlazado en la plantilla
//   stats.g.doubleclick.net    221   ← rastreador
//   static.wixstatic.com       158   ← CDN de imágenes
//   comofacturar.com           107   ← otro directorio
//   rapidofactura.com           98   ← otro directorio
//
// Se filtraban uno por uno y aparecía el siguiente. La regla estructural: una
// ficha sin comercio detrás no puede aportar un portal.
const NO_ES_COMERCIO = /\/blog\/|\/autor\/|\/author\/|\/about|\/glosario|\/herramientas|\/precios|\/categor[íi]a\/|\/categories\/|\/page\/|\/faq|\/recursos|\/preguntas|como-funciona|mapa-del-sitio|\/post\/|calculadora|que-es-|como-sacar|como-imprimir|verificar-factura|guia-cfdi/i;

const todas = readdirSync(DIR).filter(f => f.endsWith('.json') && !f.startsWith('consolidado'))
  .map(f => JSON.parse(readFileSync(join(DIR, f), 'utf8')));
const fichas = todas.filter(f => !NO_ES_COMERCIO.test(f.url));
console.log(`${todas.length} fichas cosechadas · ${fichas.length} son de comercio · ${todas.length - fichas.length} son blog/glosario/autor`);

const nombre = (f) => (f.titulo || f.url.split('/').pop() || '')
  .replace(/^Facturaci[oó]n\s+/i, '').replace(/\s+en L[íi]nea de Tickets$/i, '')
  .replace(/\s+\d{4}$/, '').trim();

// Un portal por ficha: el declarado en "Link para Facturación" manda; si no, el
// primer host externo. Sin portal la ficha no sirve para integrar.
const host = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return null; } };

// ── EL FILTRO DE RUIDO VA AQUÍ, NO SOLO EN EL COSECHADOR ───────────────────
//
// Las fichas se cosecharon con versiones distintas del filtro, así que el
// consolidado heredaba basura: `stats.g.doubleclick.net` salía como el segundo
// "portal" más usado con 221 comercios, y `static.wixstatic.com` con 158. Un
// rastreador y un CDN de imágenes. Filtrar solo al cosechar deja el error
// congelado en los datos ya bajados; filtrar aquí lo corrige sin re-bajar 2,000
// páginas.
// CodeQL (js/regex/missing-regexp-anchor): los tokens que SON un dominio
// completo (`x\.com`, `w\.org`, `wp\.com`, `clara\.com`…) casaban como
// substring en cualquier posición — `x\.com` prendía en `fedex.com` e
// `imex.com`, `w\.org` en cualquier `…w.org`, `clara\.com` en `declara.com`.
// No es un hueco de seguridad (es un filtro de ruido sobre datos de
// investigación), pero SÍ es un bug de datos: portales legítimos descartados
// como ruido. Se separan en dos listas: DOMINIOS se ancla como sufijo de host
// (`(?:^|\.)dominio$`, igual que ya hacía `^gob\.mx$` a propósito abajo);
// FRAGMENTOS son marcas/palabras sin TLD que sí deben casar en cualquier
// posición (aparecen como subdominio, ruta o parte de un host compuesto,
// p.ej. `stats.g.doubleclick.net`).
const DOMINIOS = [
  // los propios directorios y sus dominios de marca
  //
  // `facturaenlineamexico.com` (ver FRAGMENTOS) fue LA CORRECCIÓN MÁS
  // IMPORTANTE del consolidado: salía como el portal de 889 comercios, con
  // diferencia el mayor apalancamiento del catálogo. Se abrió con navegador y
  // NO es una plataforma de facturación: es OTRO DIRECTORIO SEO del mismo
  // dueño que `facturaelectronicamexico.mx`, enlazado desde la plantilla de
  // las 889 fichas. El "hallazgo" era un enlace de pie de página.
  //
  // Es la tercera vez en esta investigación que el dato más llamativo resulta
  // ser un artefacto: antes fueron `doubleclick` con 221 y `wixstatic` con 158.
  // La regla que queda: un portal que aparece en cientos de fichas es
  // sospechoso POR ESO MISMO, no interesante.
  // `comofacturar.com` es el CUARTO artefacto de la misma familia: salía con 107
  // comercios y es otro directorio SEO ("Cómo facturar en cualquier comercio en
  // México"). Verificado abriéndolo.
  'comofacturar\\.com', 'zumma\\.ai', 'clara\\.com',
  // rastreo, CDNs, fuentes, librerías
  'wix\\.com', 'wp\\.com', 'w\\.org',
  // redes y mensajería
  'x\\.com', 'm\\.me', 'wa\\.me',
  // gobierno y normativa: son CITAS, no portales de facturación — un solo
  // sufijo cubre gob.mx y cualquier subdominio (sat., diputados., dof., portal.…).
  'gob\\.mx',
  'schema\\.org', 'w3\\.org', 'apps\\.apple\\.com', 'play\\.google\\.com',
];
const FRAGMENTOS = [
  'facturaenlineamexico', 'facturaelectronicamexico', 'facturasfacil', 'recuperafacturas',
  'rfacturacion', 'gasolinerasmx', 'facturacion-ticket', 'zummafinancial',
  'claraintelligence', 'gastosdeviaje', 'focaltec', 'dirind',
  'doubleclick', 'googletagmanager', 'google-analytics', 'analytics', 'gstatic',
  'wixstatic', 'parastorage', 'cloudflare', 'jsdelivr', 'unpkg',
  'jquery', 'bootstrap', 'fontawesome', 'gravatar',
  'whatsapp', 'facebook', 'twitter', 'instagram', 'youtube',
  'linkedin', 'tiktok', 'pinterest',
  'hubspot', 'calendly', 'meetings\\.',
];
const RUIDO = new RegExp(`(?:^|\\.)(?:${DOMINIOS.join('|')})$|(?:${FRAGMENTOS.join('|')})`, 'i');
const porPortal = new Map();
let sinPortal = 0;

for (const f of fichas) {
  // El declarado manda; si no hay, el primer host externo que NO sea ruido.
  const cand = f.portal_declarado ? [host(f.portal_declarado)] : (f.portales ?? []);
  const p = cand.find((h) => h && !RUIDO.test(h)) ?? null;
  if (!p) { sinPortal++; continue; }
  const g = porPortal.get(p) ?? { portal: p, comercios: [], registro: false, campos: [], pasos: 0, quejas: 0 };
  g.comercios.push(nombre(f));
  // `registro_previo` salió false en TODAS las fichas, lo que es imposible: hay
  // portales que exigen alta (PINFRA, La Gas, Brentec). El detector miraba solo
  // el bloque "Requisitos" y estos sitios lo dicen dentro de los pasos. Se
  // vuelve a decidir aquí, sobre todo el texto que se guardó.
  const texto = [f.requisitos?.join(' '), f.pasos?.map((x) => `${x.titulo} ${x.detalle}`).join(' ')]
    .filter(Boolean).join(' ');
  const exigeAlta = /(?:debes?|tienes que|es necesario|deber[áa]s?)[^.]{0,40}(?:registrar|dar de alta)|estar registrad|\bnuevo usuario\b|reg[íi]strate|crear (?:una )?cuenta|iniciar sesi[óo]n|inicia sesi[óo]n|\blogin\b|contrase[ñn]a/i.test(texto);
  if (f.registro_previo || exigeAlta) g.registro = true;
  if (f.campos_ticket?.length > g.campos.length) g.campos = f.campos_ticket;
  g.pasos += f.pasos?.length ?? 0;
  g.quejas += f.quejas?.length ?? 0;
  porPortal.set(p, g);
}
const salida = [...porPortal.values()].sort((a, b) => b.comercios.length - a.comercios.length);
writeFileSync(join(DIR, 'consolidado-portales.json'), JSON.stringify(salida, null, 1));

const verdes = salida.filter(g => !g.registro);
console.log(`${fichas.length} fichas · ${salida.length} portales · ${sinPortal} sin portal`);
console.log(`  🟢 sin registro: ${verdes.length}   🟡 con registro: ${salida.length - verdes.length}`);
console.log(`  pasos documentados: ${salida.reduce((s, g) => s + g.pasos, 0)} · quejas de usuarios: ${salida.reduce((s, g) => s + g.quejas, 0)}`);
console.log('\nPORTALES QUE CUBREN MÁS DE UN COMERCIO — el apalancamiento:');
for (const g of salida.filter(x => x.comercios.length > 1).slice(0, 22)) {
  console.log(`  ${String(g.comercios.length).padStart(3)} ${g.registro ? '🟡' : '🟢'} ${g.portal.padEnd(42)} ${[...new Set(g.comercios)].slice(0, 4).join(', ').slice(0, 70)}`);
}
