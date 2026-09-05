#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# EL BUS DE MANDO, LADO MAC (0127 · 0135) — el puente entre las rutinas
# launchd y /admin/tu-turno. Cuatro verbos:
#
#   bus.sh corrida-inicio <rutina>                 → imprime el id de la corrida
#   bus.sh corrida-fin <id> <exit> [pr] [veredicto…]
#   bus.sh pieza <rutina> <carpeta-absoluta>       → espeja una pieza de la cola
#   bus.sh sembrar-catalogo                        → encargos/*.md + plists → bus_rutina
#   bus.sh ordenes                                 → ejecuta lo pendiente de bus_orden
#
# ── IDENTIDAD (0135, fase 7): LIKIDA_WORKER_KEY (lkw_…) contra la API del
# producto — la Mac ya NO carga el service role. Si la llave no está en
# .env.local todavía, cae al camino viejo (service role) con un AVISO: el
# fallback existe para no romper las rutinas la noche de la migración, y
# desaparece cuando la llave quede sembrada (crear-worker-llave.py).
#
# Filosofía: este script JAMÁS rompe a la rutina que lo llama — todo error
# aquí es un aviso a stderr y exit 0 (menos en `ordenes`, que corre solo).
# La aprobación sigue donde estaba: las órdenes las creó Javier en /admin;
# aquí solo se ejecutan y se firma el resultado.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COLA="$(dirname "$REPO")/likida-marketing-cola"
export REPO COLA

leer() { grep "^$1=" "$REPO/.env.local" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*//' | tr -d '"' | tr -d "'" | xargs; }
export WORKER_KEY="$(leer LIKIDA_WORKER_KEY)"
# El worker le habla a PRODUCCIÓN: el NEXT_PUBLIC_APP_URL local suele ser
# localhost (dev). LIKIDA_WORKER_URL manda si existe.
export APP_URL="$(leer LIKIDA_WORKER_URL)"
[ -z "$APP_URL" ] && export APP_URL="https://app.likida.ai"
export BUS_URL="$(leer NEXT_PUBLIC_SUPABASE_URL)"
export BUS_KEY="$(leer SUPABASE_SERVICE_ROLE_KEY)"

if [ -n "$WORKER_KEY" ] && [ -n "$APP_URL" ]; then
  export BUS_MODO="worker"
else
  export BUS_MODO="legacy"
  echo "[bus] AVISO: sin LIKIDA_WORKER_KEY — usando service role (migra con crear-worker-llave.py)" >&2
  [ -z "$BUS_URL" ] || [ -z "$BUS_KEY" ] && { echo "[bus] sin credenciales en .env.local — no reporto." >&2; exit 0; }
fi

CMD="${1:-}"; shift || true

# wapi <accion> <json>  → POST a la API de workers; imprime el cuerpo.
wapi() {
  curl -sS -m 30 -X POST "$APP_URL/api/worker/bus/$1" \
    -H "x-worker-key: $WORKER_KEY" -H "Content-Type: application/json" \
    ${2:+-d "$2"}
}

api() { # legacy: api <metodo> <ruta+query> [json] [prefer]
  local m="$1" r="$2" d="${3:-}" p="${4:-}"
  curl -sS -m 20 -X "$m" "$BUS_URL/rest/v1/$r" \
    -H "apikey: $BUS_KEY" -H "Authorization: Bearer $BUS_KEY" \
    -H "Content-Type: application/json" ${p:+-H "Prefer: $p"} ${d:+-d "$d"}
}

case "$CMD" in

corrida-inicio)
  RUTINA="${1:?rutina}"
  if [ "$BUS_MODO" = "worker" ]; then
    wapi corrida-inicio "{\"rutina\":\"$RUTINA\"}" | python3 -c "import json,sys
try: print(json.load(sys.stdin)['id'])
except Exception: pass" 2>/dev/null
  else
    api POST "bus_corrida" "{\"rutina\":\"$RUTINA\"}" "return=representation" \
      | python3 -c "import json,sys
try: print(json.load(sys.stdin)[0]['id'])
except Exception: pass" 2>/dev/null
  fi
  exit 0 ;;

corrida-fin)
  ID="${1:?id}"; CODIGO="${2:-0}"; PR="${3:-}"; shift 3 2>/dev/null || shift $# 2>/dev/null || true
  VERE="${*:-}"
  if [ "$BUS_MODO" = "worker" ]; then
    python3 - "$ID" "$CODIGO" "$PR" "$VERE" <<'PY' 2>/dev/null || true
import json, os, sys, urllib.request
id_, codigo, pr, vere = sys.argv[1:5]
cuerpo = {"id": id_, "exitCode": int(codigo) if codigo.lstrip('-').isdigit() else None,
          "veredicto": (vere or None) and vere[:300]}
if pr: cuerpo["prUrl"] = pr
req = urllib.request.Request(
    f"{os.environ['APP_URL']}/api/worker/bus/corrida-fin",
    data=json.dumps(cuerpo).encode(), method="POST",
    headers={"x-worker-key": os.environ['WORKER_KEY'], "Content-Type": "application/json"})
urllib.request.urlopen(req, timeout=30).read()
PY
  else
    python3 - "$ID" "$CODIGO" "$PR" "$VERE" <<'PY' 2>/dev/null || true
import json, os, sys, urllib.request, datetime
id_, codigo, pr, vere = sys.argv[1:5]
cuerpo = {"fin": datetime.datetime.now(datetime.timezone.utc).isoformat(),
          "exit_code": int(codigo) if codigo.lstrip('-').isdigit() else None,
          "veredicto": (vere or None) and vere[:300]}
if pr: cuerpo["pr_url"] = pr
req = urllib.request.Request(
    f"{os.environ['BUS_URL']}/rest/v1/bus_corrida?id=eq.{id_}",
    data=json.dumps(cuerpo).encode(), method="PATCH",
    headers={"apikey": os.environ['BUS_KEY'], "Authorization": f"Bearer {os.environ['BUS_KEY']}",
             "Content-Type": "application/json", "Prefer": "return=minimal"})
urllib.request.urlopen(req, timeout=20).read()
PY
  fi
  exit 0 ;;

pieza)
  RUTINA="${1:?rutina}"; CARPETA="${2:?carpeta}"
  python3 - "$RUTINA" "$CARPETA" <<'PY' 2>/dev/null || echo '[bus] No se pudo espejar la pieza; revisar el worker y el tamaño de la vista previa.' >&2
import base64, json, os, sys, urllib.request, urllib.parse, mimetypes, pathlib
sys.path.insert(0, str(pathlib.Path(os.environ['REPO']) / 'scripts/mejora-diaria'))
from worker_payloads import codificar, MAX_MEDIA_BYTES
rutina, carpeta = sys.argv[1], pathlib.Path(sys.argv[2])
COLA = pathlib.Path(os.environ["COLA"])
MODO = os.environ.get("BUS_MODO", "legacy")
if not carpeta.is_dir(): sys.exit(0)
try: rel = str(carpeta.relative_to(COLA))
except ValueError: rel = carpeta.name

# El tipo por lo que la carpeta contiene — el video manda sobre la imagen.
archivos = [f for f in carpeta.rglob("*") if f.is_file()]
exts = {f.suffix.lower() for f in archivos}
nombre = carpeta.name.lower()
if ".mp4" in exts or ".webm" in exts: tipo = "video"
elif "sequence" in nombre: tipo = "sequence"
elif "articulo" in nombre or "articulo" in str(carpeta.parent).lower(): tipo = "articulo"
elif {".png", ".jpg", ".jpeg"} & exts: tipo = "imagen"
elif ".md" in exts: tipo = "copy"
else: tipo = "otro"

copy_md = None
for candidato in ("post.md", "guion.md", "copy.md", "META.md"):
    f = carpeta / candidato
    if f.is_file():
        copy_md = f.read_text(errors="replace")[:4000]; break

preview = None
for f in sorted(archivos):
    if f.suffix.lower() in (".png", ".jpg", ".jpeg") and f.stat().st_size <= (MAX_MEDIA_BYTES if MODO == "worker" else 4 * 1024 * 1024):
        preview = f; break

if MODO == "worker":
    cuerpo = {"rutina": rutina, "carpeta": rel, "titulo": carpeta.name, "tipo": tipo, "copyMd": copy_md}
    sin_preview = preview is None and any(f.suffix.lower() in (".png", ".jpg", ".jpeg") for f in archivos)
    if sin_preview:
        print("[bus] Aviso: la pieza se enviará sin vista previa; ninguna imagen cabe en el límite de 3 MiB.")
    if preview:
        cuerpo["mediaBase64"] = base64.b64encode(preview.read_bytes()).decode()
        cuerpo["mediaNombre"] = preview.name
        cuerpo["mediaMime"] = mimetypes.guess_type(preview.name)[0] or "application/octet-stream"
    req = urllib.request.Request(
        f"{os.environ['APP_URL']}/api/worker/bus/pieza",
        data=codificar(cuerpo), method="POST",
        headers={"x-worker-key": os.environ["WORKER_KEY"], "Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=60).read()
    detalle = f"{tipo}; sin vista previa" if sin_preview else tipo
    print(f"[bus] pieza espejada (worker): {rel} ({detalle})")
    sys.exit(0)

# ── legacy (service role) ──
URL, KEY = os.environ["BUS_URL"], os.environ["BUS_KEY"]
def pedir(metodo, ruta, data=None, headers=None):
    h = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}
    h.update(headers or {})
    req = urllib.request.Request(f"{URL}{ruta}", data=data, method=metodo, headers=h)
    return urllib.request.urlopen(req, timeout=30).read()
media_path = None
if preview:
    objeto = f"piezas/{rel}/{preview.name}"
    mime = mimetypes.guess_type(preview.name)[0] or "application/octet-stream"
    try:
        pedir("POST", f"/storage/v1/object/bus/{urllib.parse.quote(objeto)}", data=preview.read_bytes(),
              headers={"Content-Type": mime, "x-upsert": "true"})
        media_path = objeto
    except Exception: pass
fila = {"rutina": rutina, "carpeta": rel, "titulo": carpeta.name, "tipo": tipo,
        "copy_md": copy_md, "media_path": media_path}
pedir("POST", "/rest/v1/bus_pieza?on_conflict=carpeta",
      data=json.dumps(fila).encode(),
      headers={"Content-Type": "application/json",
               "Prefer": "resolution=merge-duplicates,return=minimal"})
print(f"[bus] pieza espejada: {rel} ({tipo})")
PY
  exit 0 ;;

sembrar-catalogo)
  python3 - <<'PY'
import json, os, plistlib, pathlib, urllib.request, datetime
BASE = pathlib.Path(os.environ["REPO"]) / "scripts" / "mejora-diaria"
MODO = os.environ.get("BUS_MODO", "legacy")
DIAS = {0: "dom", 1: "lun", 2: "mar", 3: "mié", 4: "jue", 5: "vie", 6: "sáb", 7: "dom"}

def horario_de(nombre):
    p = BASE / f"com.likida.{nombre}.plist"
    if not p.is_file(): return ""
    try: d = plistlib.loads(p.read_bytes())
    except Exception: return ""
    if "StartInterval" in d: return f"cada {d['StartInterval'] // 60} min"
    cal = d.get("StartCalendarInterval")
    if not cal: return ""
    if isinstance(cal, dict): cal = [cal]
    partes = []
    for c in cal:
        hhmm = f"{c.get('Hour', 0):02d}:{c.get('Minute', 0):02d}"
        pre = ""
        if "Weekday" in c: pre = DIAS.get(c["Weekday"], "") + " "
        if "Day" in c: pre = f"día {c['Day']} "
        partes.append(pre + hhmm)
    return " y ".join(partes)

filas = []
for enc in sorted((BASE / "encargos").glob("*.md")):
    nombre = enc.stem
    texto = enc.read_text(errors="replace")
    desc = next((l.lstrip("# ").strip() for l in texto.splitlines() if l.strip()), "")[:200]
    filas.append({"nombre": nombre, "horario": horario_de(nombre), "descripcion": desc,
                  "encargo_md": texto[:20000]})

if MODO == "worker":
    import sys
    sys.path.insert(0, str(pathlib.Path(os.environ['REPO']) / 'scripts/mejora-diaria'))
    from worker_payloads import lotes_catalogo
    for datos in lotes_catalogo(filas):
        req = urllib.request.Request(
            f"{os.environ['APP_URL']}/api/worker/bus/catalogo",
            data=datos, method="POST",
            headers={"x-worker-key": os.environ['WORKER_KEY'], "Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=30).read()
else:
    for f in filas:
        f["actualizado_en"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    req = urllib.request.Request(
        f"{os.environ['BUS_URL']}/rest/v1/bus_rutina?on_conflict=nombre",
        data=json.dumps(filas).encode(), method="POST",
        headers={"apikey": os.environ['BUS_KEY'], "Authorization": f"Bearer {os.environ['BUS_KEY']}",
                 "Content-Type": "application/json",
                 "Prefer": "resolution=merge-duplicates,return=minimal"})
    urllib.request.urlopen(req, timeout=30).read()
print(f"[bus] catálogo sembrado: {len(filas)} rutinas")
PY
  exit $? ;;

ordenes)
  python3 - <<'PY'
import json, os, subprocess, pathlib, urllib.request, datetime
MODO = os.environ.get("BUS_MODO", "legacy")
REPO = pathlib.Path(os.environ["REPO"])
APAGADO = REPO / ".mejora-diaria" / "APAGADO"
NOTAS = REPO / ".mejora-diaria" / "notas-javier.md"

def ahora(): return datetime.datetime.now(datetime.timezone.utc).isoformat()

if MODO == "worker":
    def wapi(accion, cuerpo=None):
        req = urllib.request.Request(
            f"{os.environ['APP_URL']}/api/worker/bus/{accion}",
            data=json.dumps(cuerpo or {}).encode(), method="POST",
            headers={"x-worker-key": os.environ["WORKER_KEY"], "Content-Type": "application/json"})
        crudo = urllib.request.urlopen(req, timeout=30).read()
        return json.loads(crudo) if crudo else {}
    pendientes = wapi("ordenes").get("ordenes", [])
    tomar = lambda oid: wapi("ordenes-claim", {"id": oid}).get("tomada", False)
    resolver = lambda oid, ok, res: wapi("ordenes-resolver", {"id": oid, "ok": ok, "resultado": res})
else:
    URL, KEY = os.environ["BUS_URL"], os.environ["BUS_KEY"]
    def pedir(metodo, ruta, cuerpo=None, prefer=None):
        h = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
        if prefer: h["Prefer"] = prefer
        req = urllib.request.Request(f"{URL}/rest/v1/{ruta}",
                                     data=json.dumps(cuerpo).encode() if cuerpo is not None else None,
                                     method=metodo, headers=h)
        crudo = urllib.request.urlopen(req, timeout=30).read()
        return json.loads(crudo) if crudo else None
    pendientes = pedir("GET", "bus_orden?estado=eq.pendiente&order=creado_en&limit=10") or []
    tomar = lambda oid: bool(pedir("PATCH", f"bus_orden?id=eq.{oid}&estado=eq.pendiente",
                                   {"estado": "tomada", "tomada_en": ahora()}, "return=representation"))
    resolver = lambda oid, ok, res: pedir("PATCH", f"bus_orden?id=eq.{oid}",
                                          {"estado": "hecha" if ok else "fallida", "resuelta_en": ahora(),
                                           "resultado": res or ("hecha" if ok else "falló sin decir por qué")})

for o in pendientes:
    # Claim anclado a pendiente (mismo patrón que wa_pendientes): si otra
    # instancia la tomó entre el GET y el claim, aquí viene False.
    if not tomar(o["id"]): continue
    tipo, rutina = o["tipo"], o.get("rutina")
    payload = o.get("payload") or {}
    ok, resultado = False, ""
    try:
        if tipo == "correr_ahora":
            plist = pathlib.Path(f"{REPO}/scripts/mejora-diaria/com.likida.{rutina}.plist")
            if not plist.is_file():
                resultado = f"no existe com.likida.{rutina}"
            else:
                uid = os.getuid()
                r = subprocess.run(["launchctl", "kickstart", "-k", f"gui/{uid}/com.likida.{rutina}"],
                                   capture_output=True, text=True, timeout=30)
                ok = r.returncode == 0
                resultado = "corrida disparada" if ok else (r.stderr.strip()[:200] or f"launchctl exit {r.returncode}")
        elif tipo == "kill_switch_on":
            APAGADO.parent.mkdir(parents=True, exist_ok=True); APAGADO.touch()
            ok, resultado = True, "APAGADO puesto — todas las rutinas del repo se detienen"
        elif tipo == "kill_switch_off":
            APAGADO.unlink(missing_ok=True)
            ok, resultado = True, "APAGADO retirado — las rutinas vuelven a su horario"
        elif tipo == "nota":
            NOTAS.parent.mkdir(parents=True, exist_ok=True)
            with open(NOTAS, "a") as f:
                f.write(f"\n## {ahora()}\n{payload.get('texto', '')}\n")
            ok, resultado = True, "anotada en notas-javier.md"
        elif tipo == "editar_encargo":
            # PR CHICO, jamás escritura directa (diseño Fase D). El cambio se
            # arma en un WORKTREE TEMPORAL desde origin/master: el árbol
            # compartido del repo (donde trabajan otras sesiones) ni se toca.
            import re as _re, tempfile, shutil
            contenido = payload.get("contenido") or ""
            nombre = _re.sub(r"[^a-z0-9-]", "", (rutina or "").lower())
            if not nombre or not contenido.strip():
                resultado = "editar_encargo sin rutina o sin contenido"
            elif not (REPO / "scripts" / "mejora-diaria" / "encargos" / f"{nombre}.md").is_file():
                resultado = f"no existe el encargo {nombre}.md — el editor edita, no crea"
            else:
                stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d%H%M%S")
                rama = f"rutinas/encargo-{nombre}-{stamp}"
                wt = pathlib.Path(tempfile.mkdtemp(prefix="encargo-"))
                try:
                    subprocess.run(["git", "-C", str(REPO), "fetch", "origin", "master"],
                                   capture_output=True, timeout=60)
                    r = subprocess.run(["git", "-C", str(REPO), "worktree", "add", str(wt / "w"),
                                        "origin/master", "-b", rama],
                                       capture_output=True, text=True, timeout=60)
                    if r.returncode != 0:
                        raise RuntimeError(f"worktree: {r.stderr.strip()[:150]}")
                    destino = wt / "w" / "scripts" / "mejora-diaria" / "encargos" / f"{nombre}.md"
                    destino.write_text(contenido[:20000])
                    for cmd in (["git", "add", f"scripts/mejora-diaria/encargos/{nombre}.md"],
                                ["git", "commit", "-m",
                                 f"rutinas: encargo de {nombre} editado desde /admin/tu-turno\n\n"
                                 "Orden editar_encargo del bus (0127): el cambio viaja como PR chico\n"
                                 "y Javier lo aprueba en GitHub — jamás escritura directa.\n\n"
                                 "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"],
                                ["git", "push", "origin", rama]):
                        r = subprocess.run(cmd, cwd=wt / "w", capture_output=True, text=True, timeout=120)
                        if r.returncode != 0:
                            raise RuntimeError(f"{cmd[1]}: {(r.stderr or r.stdout).strip()[:150]}")
                    # gh contra la API de GitHub: un 503 transitorio no debe
                    # tirar el PR con la rama ya empujada — un reintento.
                    for intento_pr in (1, 2):
                        r = subprocess.run(["gh", "pr", "create", "--base", "master", "--head", rama,
                                        "--title", f"rutinas: encargo de {nombre} (editor de /admin)",
                                        "--body", "Orden `editar_encargo` del bus de mando — revisa el diff y aprueba.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"],
                                       cwd=wt / "w", capture_output=True, text=True, timeout=120)
                        if r.returncode == 0:
                            break
                        if intento_pr == 2:
                            raise RuntimeError(f"gh pr: {(r.stderr or r.stdout).strip()[:150]}")
                        import time; time.sleep(10)
                    ok, resultado = True, f"PR abierto: {r.stdout.strip().splitlines()[-1]}"
                except Exception as e_pr:
                    resultado = str(e_pr)[:250]
                finally:
                    subprocess.run(["git", "-C", str(REPO), "worktree", "remove", "--force", str(wt / "w")],
                                   capture_output=True, timeout=60)
                    shutil.rmtree(wt, ignore_errors=True)
        else:
            resultado = f"tipo desconocido: {tipo}"
    except Exception as e:
        resultado = str(e)[:200]
    resolver(o["id"], ok, resultado)
    print(f"[bus] orden {tipo}{' · ' + rutina if rutina else ''}: {'✓' if ok else '✗'} {resultado}")
print(f"[bus] órdenes atendidas: {len(pendientes)}")
PY
  exit $? ;;

*)
  echo "uso: bus.sh corrida-inicio|corrida-fin|pieza|sembrar-catalogo|ordenes" >&2
  exit 2 ;;
esac
