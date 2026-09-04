#!/usr/bin/env bash
set -euo pipefail
h="${1:?HOST}"; p="${2:?PORT}"; d="${3:?DB}"
q=(psql -h "$h" -p "$p" -U "${PGUSER:-postgres}" -d "$d" -X -v ON_ERROR_STOP=1 -qAt)
t=32900000-0000-0000-0000-000000000002; u=32930000-0000-0000-0000-000000000002
trap '"${q[@]}" -c "delete from public.tenant where id=\x27$t\x27" >/dev/null 2>&1 || true' EXIT
"${q[@]}" -c "delete from public.tenant where id='$t'; insert into public.tenant(id,nombre,zona_horaria) values('$t','shared unit 0329','America/Mexico_City'); insert into public.operador(id,tenant_id,nombre,telefono,aviso_privacidad_en) values('32910000-0000-0000-0000-000000000001','$t','A','529329000001','2026-01-01'),('32910000-0000-0000-0000-000000000002','$t','B','529329000002','2026-01-01'); insert into public.unidad(id,tenant_id,numero_economico) values('$u','$t','shared'); insert into public.viaje(id,tenant_id,operador_id,unidad_id,avisado_en,aceptado_en) values('32920000-0000-0000-0000-000000000001','$t','32910000-0000-0000-0000-000000000001','$u','2026-09-01 11:59+00','2026-09-01 12:00+00'),('32920000-0000-0000-0000-000000000002','$t','32910000-0000-0000-0000-000000000002','$u','2026-09-01 12:59+00','2026-09-01 13:00+00');"
for id in 1 2; do ("${q[@]}" -c "set statement_timeout='10s'; update public.viaje set aceptado_en=aceptado_en + interval '1 second' where id='32920000-0000-0000-0000-00000000000$id';" >"/tmp/329-lock-$id") & done
wait
test "$(wc -l < /tmp/329-lock-1)" -eq 0; test "$(wc -l < /tmp/329-lock-2)" -eq 0
echo "0329_shared_unit_no_deadlock: PASS (ambas mutaciones confirmadas)"
